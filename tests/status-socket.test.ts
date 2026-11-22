import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Job } from '../src/contracts.ts';
import {
  jobCounts, startStatusServer, statusSocketPath, subscribeStatus, toBotEvent, type StatusMessage, type UpStatus,
} from '../src/status-socket.ts';

const at = () => new Date('2026-11-19T10:00:00.000Z');

/** A short folder: Unix socket paths are limited to about 100 bytes. */
const profile = (t: TestContext): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-sock-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const up = (overrides: Partial<UpStatus> = {}): UpStatus => ({
  state: 'up', pid: 4242, startedAt: '2026-11-19T09:00:00.000Z', slackConnected: true, counts: { needsYou: 0, running: 0 }, ...overrides,
});

/** Collects what a subscriber sees and waits for the nth message. */
const recorder = () => {
  const messages: StatusMessage[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const listener = (message: StatusMessage): void => {
    messages.push(message);
    for (const waiter of waiters.filter((w) => messages.length >= w.count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const until = (count: number): Promise<StatusMessage[]> => (messages.length >= count
    ? Promise.resolve(messages)
    : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} messages, got ${JSON.stringify(messages)}`)), 2_000);
      waiters.push({ count, resolve: () => { clearTimeout(timer); resolve(messages); } });
    }));
  return { messages, listener, until };
};

test('the socket is created with mode 600 and removed on shutdown', async (t) => {
  const dir = profile(t);
  const server = await startStatusServer({ profileDir: dir, status: () => up() });
  const stat = lstatSync(statusSocketPath(dir));
  assert.ok(stat.isSocket());
  assert.equal(stat.mode & 0o777, 0o600);
  await server.close();
  assert.equal(existsSync(statusSocketPath(dir)), false);
  await server.close(); // Closing twice is harmless.
});

test('a client receives a snapshot, then events and status changes', async (t) => {
  const dir = profile(t);
  let current = up();
  const server = await startStatusServer({ profileDir: dir, status: () => current, now: at });
  t.after(() => server.close());
  const seen = recorder();
  const subscription = subscribeStatus(dir, seen.listener, { retryMs: 0 });
  t.after(() => subscription.close());

  await seen.until(1);
  assert.deepEqual(seen.messages[0], { type: 'status', status: up() });

  current = up({ counts: { needsYou: 0, running: 1 } });
  server.publish('job_started', { key: 'C0123:1.0', t3ThreadId: 'thread-1', requester: 'U0123456789' });
  server.publish('progress_shown', { key: 'C0123:1.0', runId: 'run-1', afterMs: 1 }); // Not shown in the app.
  server.publish('reply', { key: 'C0123:1.0', runId: 'run-1', kind: 'reply', needsOwner: true, reviewRequested: false });
  server.publish('needs_owner', { key: 'C0123:1.0' });
  server.publish('failure', { key: 'C0123:2.0', error: 'boom' });
  current = up({ slackConnected: false, counts: { needsYou: 0, running: 1 } });
  server.refresh();
  server.refresh(); // Unchanged: not sent again.

  await seen.until(7);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen.messages.slice(1), [
    { type: 'event', event: { at: '2026-11-19T10:00:00.000Z', event: 'job_started', key: 'C0123:1.0', t3ThreadId: 'thread-1', requester: 'U0123456789' } },
    { type: 'status', status: up({ counts: { needsYou: 0, running: 1 } }) },
    { type: 'event', event: { at: '2026-11-19T10:00:00.000Z', event: 'reply', key: 'C0123:1.0', kind: 'reply', needsOwner: true } },
    { type: 'event', event: { at: '2026-11-19T10:00:00.000Z', event: 'needs_owner', key: 'C0123:1.0' } },
    { type: 'event', event: { at: '2026-11-19T10:00:00.000Z', event: 'failure', key: 'C0123:2.0', error: 'boom' } },
    { type: 'status', status: up({ slackConnected: false, counts: { needsYou: 0, running: 1 } }) },
  ]);
});

test('the client reports stopped when the socket is missing, and when the server goes away', async (t) => {
  const dir = profile(t);
  const seen = recorder();
  const subscription = subscribeStatus(dir, seen.listener, { retryMs: 20 });
  t.after(() => subscription.close());
  await seen.until(1);
  assert.deepEqual(seen.messages[0], { type: 'status', status: { state: 'stopped' } });

  // Retries while missing say "stopped" only once, then the daemon comes up and is picked up.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(seen.messages.length, 1);
  const server = await startStatusServer({ profileDir: dir, status: () => up() });
  await seen.until(2);
  assert.deepEqual(seen.messages[1], { type: 'status', status: up() });

  await server.close();
  await seen.until(3);
  assert.deepEqual(seen.messages[2], { type: 'status', status: { state: 'stopped' } });
});

test('a stale socket file from a crash does not block startup', async (t) => {
  const dir = profile(t);
  const path = statusSocketPath(dir);
  // A daemon killed with SIGKILL leaves its socket file behind.
  const crashed = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`]);
  await new Promise((resolve) => crashed.stdout.once('data', resolve));
  crashed.kill('SIGKILL');
  await new Promise((resolve) => crashed.once('exit', resolve));
  assert.ok(lstatSync(path).isSocket());

  const server = await startStatusServer({ profileDir: dir, status: () => up() });
  t.after(() => server.close());
  const seen = recorder();
  const subscription = subscribeStatus(dir, seen.listener, { retryMs: 0 });
  t.after(() => subscription.close());
  await seen.until(1);
  assert.deepEqual(seen.messages[0], { type: 'status', status: up() });
});

test('startup refuses a live socket owned by another daemon, or a file that is not a socket', async (t) => {
  const dir = profile(t);
  const first = await startStatusServer({ profileDir: dir, status: () => up() });
  await assert.rejects(startStatusServer({ profileDir: dir, status: () => up() }), /Another process is serving/);
  assert.ok(existsSync(statusSocketPath(dir)), 'the live socket is left alone');
  await first.close();

  writeFileSync(statusSocketPath(dir), 'not a socket');
  await assert.rejects(startStatusServer({ profileDir: dir, status: () => up() }), /is not a socket/);
});

test('a status that cannot be read is skipped, never thrown into the bot', async (t) => {
  const dir = profile(t);
  const server = await startStatusServer({ profileDir: dir, status: () => { throw new Error('state.json unreadable'); } });
  t.after(() => server.close());
  const seen = recorder();
  const subscription = subscribeStatus(dir, seen.listener, { retryMs: 0 });
  t.after(() => subscription.close());
  // The connection is dropped without a snapshot, which the client reports as stopped.
  await seen.until(1);
  assert.deepEqual(seen.messages[0], { type: 'status', status: { state: 'stopped' } });
  assert.doesNotThrow(() => server.publish('failure', { key: 'k', error: 'x' }));
  assert.doesNotThrow(() => server.refresh());
});

test('daemon events map to the app contract, and others are dropped', () => {
  const when = '2026-11-19T10:00:00.000Z';
  assert.deepEqual(toBotEvent('reply', { key: 'k', kind: 'quiet', runId: 'r' }, when), { at: when, event: 'reply', key: 'k', kind: 'quiet' });
  assert.equal(toBotEvent('reply', { key: 'k', kind: 'unknown' }, when), null);
  // A notice in place of the reply is marked, so the app doesn't take it for a result (SERRA-53).
  assert.deepEqual(toBotEvent('reply', { key: 'k', kind: 'reply', notice: true }, when), { at: when, event: 'reply', key: 'k', kind: 'reply', notice: true });
  assert.equal(toBotEvent('question_shown', { key: 'k' }, when), null);
});

test('counts: an open owner ask or a T3-only wait needs the owner; a waiting request is running', () => {
  const job = (fields: Partial<Job>): Job => ({
    t3ThreadId: 't', channel: 'C0123', threadTs: '1.0', requester: 'U0123456789', pendingReactionTs: null,
    lastPostedRunId: null, watching: true, createdAt: '2026-11-19T09:00:00.000Z', ...fields,
  });
  assert.deepEqual(jobCounts([
    job({ ownerAskOpen: true }),
    job({ waitingInT3: true }),
    job({ waitingInT3: true, loadingRequested: true, question: { requestId: 'q' } as Job['question'] }), // Waits on the requester in Slack.
    job({ loadingRequested: true }),
    job({ waitingInT3: true, loadingRequested: true }),
    job({}),
  ]), { needsYou: 3, running: 1 });
});
