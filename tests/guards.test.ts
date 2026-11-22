// SERRA-61: every JSON read of a file or a socket line goes through a type guard. A malformed or old-shape file or
// line is skipped or reported where it is read, never thrown as a TypeError deep in a caller.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  isArrayOf, isOneOf, isOptional, isRecord, isRecordOf, isString, parseJson, readJsonFile, readJsonOrNull,
} from '../src/lib/guards.ts';
import {
  isBotEvent, isBotStatus, isNamesReply, parseNamesRequest, requestNames, statusSocketPath, subscribeStatus, toBotEvent,
  type StatusMessage,
} from '../src/status-socket.ts';
import { readStoredNames, SLACK_NAMES_FILE } from '../src/slack-names-store.ts';

/** A short folder: Unix socket paths are limited to about 100 bytes. */
const shortDir = (t: TestContext): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sg-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const UP = { state: 'up', pid: 4242, startedAt: '2026-11-19T09:00:00.000Z', slackConnected: true, counts: { needsYou: 1, running: 2 } };

// ---------------------------------------------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------------------------------------------

test('guards: records are plain objects, combinators check every element', () => {
  assert.equal(isRecord({}), true);
  for (const value of [null, [], 'x', 1, undefined]) assert.equal(isRecord(value), false);
  assert.equal(isArrayOf(isString)(['a', 'b']), true);
  assert.equal(isArrayOf(isString)(['a', 1]), false);
  assert.equal(isArrayOf(isString)('a'), false);
  assert.equal(isOptional(isString)(undefined), true);
  assert.equal(isOptional(isString)(null), false);
  assert.equal(isOneOf('a', 'b')('b'), true);
  assert.equal(isOneOf('a', 'b')('c'), false);
  assert.equal(isRecordOf(isString)({ a: 'x' }), true);
  assert.equal(isRecordOf(isString)({ a: {} }), false);
  assert.equal(parseJson('{"a":1}') !== undefined, true);
  assert.equal(parseJson('not json'), undefined);
});

test('readJsonFile: absent, invalid (not JSON or the wrong shape), or the value; never throws', (t) => {
  const dir = shortDir(t);
  const path = join(dir, 'file.json');
  const guard = (value: unknown): value is { n: number } => isRecord(value) && typeof value.n === 'number';
  assert.deepEqual(readJsonFile(path, guard), { state: 'absent' });
  writeFileSync(path, '{"n":');
  assert.deepEqual(readJsonFile(path, guard), { state: 'invalid' });
  writeFileSync(path, '{"n":"1"}');
  assert.deepEqual(readJsonFile(path, guard), { state: 'invalid' });
  assert.equal(readJsonOrNull(path, guard), null);
  writeFileSync(path, '{"n":1,"extra":true}');
  assert.deepEqual(readJsonFile(path, guard), { state: 'ok', value: { n: 1, extra: true } }, 'extra fields from a newer writer are kept');
  assert.deepEqual(readJsonFile(dir, guard), { state: 'invalid' }, 'a folder in its place is unreadable, not a crash');
});

// ---------------------------------------------------------------------------------------------------------------
// status.sock: the daemon's side
// ---------------------------------------------------------------------------------------------------------------

test('socket server: a names request whose lists are the wrong type is ignored', () => {
  assert.equal(parseNamesRequest('{"type":"names","users":{"U0EXAMPLE01":1},"channels":null}'), null);
  assert.equal(parseNamesRequest('{"type":"names","users":[{"id":"U0EXAMPLE01"}],"channels":[1]}'), null);
  assert.equal(parseNamesRequest('"names"'), null);
  assert.deepEqual(parseNamesRequest('{"type":"names","users":["U0EXAMPLE01",7],"channels":"C0EXAMPLE01"}'), { users: ['U0EXAMPLE01'], channels: [] });
});

test('socket server: an event field that is not text never becomes "[object Object]"', () => {
  const at = '2026-11-19T10:00:00.000Z';
  assert.deepEqual(toBotEvent('failure', { key: 'C1:1.0', error: { message: 'boom' } }, at), { at, event: 'failure', key: 'C1:1.0', error: '' });
  assert.deepEqual(toBotEvent('job_started', { key: { channel: 'C1' }, t3ThreadId: 42, requester: null }, at),
    { at, event: 'job_started', key: '', t3ThreadId: '42', requester: '' });
});

// ---------------------------------------------------------------------------------------------------------------
// status.sock: the app's side
// ---------------------------------------------------------------------------------------------------------------

test('socket client: status and events are checked field by field', () => {
  assert.equal(isBotStatus(UP), true);
  assert.equal(isBotStatus({ state: 'stopped' }), true);
  assert.equal(isBotStatus({ state: 'up' }), false, 'an up status without its fields');
  assert.equal(isBotStatus({ ...UP, counts: null }), false);
  assert.equal(isBotStatus({ ...UP, counts: { needsYou: '1', running: 0 } }), false);
  assert.equal(isBotStatus({ ...UP, pid: 'x' }), false);
  assert.equal(isBotEvent({ at: 'x', event: 'needs_owner', key: 'C1:1.0' }), true);
  assert.equal(isBotEvent({ at: 'x', event: 'failure', key: 'C1:1.0', error: { message: 'boom' } }), false);
  assert.equal(isBotEvent({ at: 'x', event: 'reply', key: 'C1:1.0', kind: 'shout' }), false);
  assert.equal(isBotEvent({ at: 'x', event: 'reply', key: 'C1:1.0', kind: 'reply', needsOwner: 'yes' }), false);
  assert.equal(isBotEvent({ at: 'x', event: 'something_new', key: 'C1:1.0' }), false, 'an event the app does not know yet');
  assert.equal(isNamesReply({ type: 'names', users: { U1: 'Ada' }, channels: {} }), true);
  assert.equal(isNamesReply({ type: 'names', users: { U1: { name: 'Ada' } }, channels: {} }), false);
  assert.equal(isNamesReply({ type: 'names', users: [], channels: {} }), false);
});

/** A fake daemon on the profile's socket that sends `lines` to each client and records what clients send. */
const fakeDaemon = async (t: TestContext, dir: string, lines: (socket: Socket) => string[]) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', () => { for (const line of lines(socket)) socket.write(`${line}\n`); });
    for (const line of lines(socket)) socket.write(`${line}\n`);
  });
  await new Promise<void>((resolve) => server.listen(statusSocketPath(dir), resolve));
  t.after(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
};

test('socket client: malformed lines from the daemon are skipped, and the well-formed ones still arrive', async (t) => {
  const dir = shortDir(t);
  let sent = false;
  await fakeDaemon(t, dir, () => {
    if (sent) return [];
    sent = true;
    return [
      '{"type":"status","status":{"state":"up"}}',
      JSON.stringify({ type: 'status', status: { ...UP, counts: null } }),
      JSON.stringify({ type: 'event', event: { at: 'x', event: 'failure', key: 'C1:1.0', error: { message: 'boom' } } }),
      JSON.stringify({ type: 'event', event: { at: 'x', event: 'something_new', key: 'C1:1.0' } }),
      'not json',
      JSON.stringify({ type: 'status', status: UP }),
      JSON.stringify({ type: 'event', event: { at: 'x', event: 'needs_owner', key: 'C1:1.0' } }),
    ];
  });
  const seen: StatusMessage[] = [];
  const subscription = subscribeStatus(dir, (message) => {
    // A listener that trusts the contract: a malformed status would throw here.
    if (message.type === 'status' && message.status.state === 'up') assert.equal(typeof message.status.counts.needsYou, 'number');
    seen.push(message);
  }, { retryMs: 0 });
  t.after(() => subscription.close());
  await settle();
  assert.deepEqual(seen, [
    { type: 'status', status: UP },
    { type: 'event', event: { at: 'x', event: 'needs_owner', key: 'C1:1.0' } },
  ]);
});

test('requestNames: a reply whose names are not text is skipped, and a well-formed one after it is used', async (t) => {
  const dir = shortDir(t);
  await fakeDaemon(t, dir, (socket) => socket.bytesRead === 0 ? [JSON.stringify({ type: 'status', status: UP })] : [
    JSON.stringify({ type: 'names', users: { U0EXAMPLE01: { toString: 'x' } }, channels: {} }),
    JSON.stringify({ type: 'names', users: null, channels: {} }),
    JSON.stringify({ type: 'names', users: { U0EXAMPLE01: 'Sam Rivera' }, channels: {} }),
  ]);
  assert.deepEqual(await requestNames(dir, { users: ['U0EXAMPLE01'] }, { timeoutMs: 2_000 }), { type: 'names', users: { U0EXAMPLE01: 'Sam Rivera' }, channels: {} });
});

// ---------------------------------------------------------------------------------------------------------------
// slack-names.json
// ---------------------------------------------------------------------------------------------------------------

test('slack-names.json: entries that are not records are skipped, the rest still read', (t) => {
  const dir = shortDir(t);
  writeFileSync(join(dir, SLACK_NAMES_FILE), JSON.stringify({
    version: 1, names: { U0EXAMPLE01: 'Sam', U0OTHER0001: null, C0EXAMPLE01: { name: '#ops', at: 5 }, U0BADAT0001: { name: 'Ada', at: '5' } },
  }));
  assert.deepEqual([...readStoredNames(dir)], [['C0EXAMPLE01', { name: '#ops', at: 5 }]]);
  writeFileSync(join(dir, SLACK_NAMES_FILE), '[1,2]');
  assert.equal(readStoredNames(dir).size, 0);
});
