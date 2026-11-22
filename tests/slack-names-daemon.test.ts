// SERRA-55: the app never reads the bot token for Slack names. The bot names IDs over the status socket, and the app
// keeps the names in the profile's slack-names.json. Opening the app (jobs.list) runs no `op` and no `security`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { jobsHandlers } from '../app/main/ipc/jobs.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { answerNameRequests, createSlackNames, DM_LABEL, type SlackNameLookup } from '../src/slack-names.ts';
import { createStoredSlackNames, MAX_STORED_NAMES, readStoredNames, SLACK_NAMES_FILE } from '../src/slack-names-store.ts';
import {
  MAX_NAME_IDS, MAX_REQUEST_BYTES, requestNames, startStatusServer, subscribeStatus,
  type NamesResolver, type StatusMessage, type UpStatus,
} from '../src/status-socket.ts';

const TOKEN = 'xoxb-1111-2222-fixturevalue';
const REF = 'op://Vault/serra/bot-token';
const NAMES: Record<string, string> = { U0EXAMPLE01: 'Sam Rivera', U0OTHER0001: 'Ada', B0MONITOR01: 'Acme Monitor', C0EXAMPLE01: '#billing-alerts' };
const MINUTE = 60_000;
const NOW = new Date(2026, 10, 19, 15, 0, 0);
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * MINUTE).toISOString();

const up = (): UpStatus => ({ state: 'up', pid: 4242, startedAt: '2026-11-19T09:00:00.000Z', slackConnected: true, counts: { needsYou: 0, running: 0 } });
const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A short folder: Unix socket paths are limited to about 100 bytes. */
const shortDir = (t: TestContext): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sn-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A resolver like the bot's, on a fake Slack that answers from `NAMES`, recording what it was asked. */
const fakeResolver = (asked: string[][] = []): NamesResolver => {
  const lookup = async (): Promise<SlackNameLookup> => {
    const answer = async (id: string): Promise<string | null> => NAMES[id] ?? null;
    return { user: answer, channel: answer, bot: answer };
  };
  const answer = answerNameRequests(createSlackNames({ token: async () => TOKEN, lookup }));
  return async (ids) => { asked.push([...ids.users, ...ids.channels]); return answer(ids); };
};

/** A raw client: sends lines, collects every parsed line it gets back. */
const rawClient = (path: string) => {
  const lines: unknown[] = [];
  const raw: string[] = [];
  let buffer = '';
  let closed = false;
  const socket: Socket = createConnection(path);
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    raw.push(chunk);
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => { closed = true; });
  const connected = new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return {
    lines, raw, socket, connected, closed: () => closed,
    send: (text: string) => socket.write(text),
    names: () => lines.filter((line) => (line as { type?: string }).type === 'names'),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// The daemon's side: name requests on the status socket
// ---------------------------------------------------------------------------------------------------------------

test('daemon: a names request gets the names of valid IDs, to that client only, never the token', async (t) => {
  const dir = shortDir(t);
  const asked: string[][] = [];
  const server = await startStatusServer({ profileDir: dir, status: up, names: fakeResolver(asked) });
  t.after(() => server.close());
  const asking = rawClient(server.path);
  const other = rawClient(server.path);
  await Promise.all([asking.connected, other.connected]);
  asking.send(`${JSON.stringify({ type: 'names', users: ['U0EXAMPLE01', 'B0MONITOR01', 'U0UNKNOWN01', 'not-an-id', 42], channels: ['C0EXAMPLE01', 'D0EXAMPLE01', '../../etc'] })}\n`);
  await settle(50);
  assert.deepEqual(asking.names(), [{
    type: 'names',
    users: { U0EXAMPLE01: 'Sam Rivera', B0MONITOR01: 'Acme Monitor' },
    channels: { C0EXAMPLE01: '#billing-alerts', D0EXAMPLE01: DM_LABEL },
  }]);
  assert.deepEqual(asked, [['U0EXAMPLE01', 'B0MONITOR01', 'U0UNKNOWN01', 'C0EXAMPLE01', 'D0EXAMPLE01']], 'only valid IDs reach the resolver');
  assert.deepEqual(other.names(), [], 'the other client gets no reply');
  assert.ok(!asking.raw.join('').includes('xoxb'), 'the token never crosses the socket');
  asking.socket.destroy();
  other.socket.destroy();
});

test('daemon: garbage, unknown and invalid requests are ignored, and status/event delivery carries on', async (t) => {
  const dir = shortDir(t);
  const asked: string[][] = [];
  const server = await startStatusServer({ profileDir: dir, status: up, names: fakeResolver(asked), now: () => NOW });
  t.after(() => server.close());
  const seen: StatusMessage[] = [];
  const subscription = subscribeStatus(dir, (message) => seen.push(message), { retryMs: 0 });
  t.after(() => subscription.close());
  const client = rawClient(server.path);
  await client.connected;
  client.send('not json\n{"type":"hello"}\n[]\nnull\n{"type":"names","users":"U0EXAMPLE01"}\n{"type":"names","users":["U0;rm -rf"],"channels":[]}\n');
  client.send(`${JSON.stringify({ type: 'names', users: ['x'.repeat(MAX_REQUEST_BYTES + 10)] })}\n`);
  await settle(50);
  assert.deepEqual(client.names(), []);
  assert.deepEqual(asked, [], 'nothing reached the resolver');
  assert.equal(client.closed(), false, 'complete lines are ignored, the client stays');

  server.publish('needs_owner', { key: 'C0123:1.0' });
  await settle(50);
  const events = (messages: unknown[]) => messages.filter((line) => (line as { type?: string }).type === 'event');
  assert.equal(events(client.lines).length, 1, 'the asking client still gets events');
  assert.equal(events(seen).length, 1, 'other clients still get events');

  client.send(`${JSON.stringify({ type: 'names', users: ['U0EXAMPLE01'], channels: [] })}\n`);
  await settle(50);
  assert.deepEqual(client.names(), [{ type: 'names', users: { U0EXAMPLE01: 'Sam Rivera' }, channels: {} }], 'and its next valid request is answered');
  client.socket.destroy();
});

test('daemon: a request names at most MAX_NAME_IDS IDs, and an unfinished line past the cap drops the client', async (t) => {
  const dir = shortDir(t);
  const asked: string[][] = [];
  const server = await startStatusServer({ profileDir: dir, status: up, names: fakeResolver(asked) });
  t.after(() => server.close());
  const many = rawClient(server.path);
  await many.connected;
  const users = Array.from({ length: MAX_NAME_IDS + 50 }, (_, index) => `U${String(index).padStart(9, '0')}`);
  many.send(`${JSON.stringify({ type: 'names', users, channels: ['C0EXAMPLE01'] })}\n`);
  await settle(50);
  assert.equal(asked[0]!.length, MAX_NAME_IDS);
  assert.equal(many.names().length, 1);
  many.socket.destroy();

  const flood = rawClient(server.path);
  const bystander = rawClient(server.path);
  await Promise.all([flood.connected, bystander.connected]);
  flood.send('{"type":"names","users":["' + 'U'.repeat(MAX_REQUEST_BYTES + 1));
  await settle(50);
  assert.equal(flood.closed(), true, 'a line that never ends is cut off');
  server.publish('needs_owner', { key: 'C0123:1.0' });
  await settle(50);
  assert.ok(bystander.lines.some((line) => (line as { type?: string }).type === 'event'), 'other clients are unaffected');
  bystander.socket.destroy();
});

test('daemon: a resolver that throws answers with no names and never breaks the server', async (t) => {
  const dir = shortDir(t);
  const server = await startStatusServer({
    profileDir: dir, status: up,
    names: async () => { throw new Error(`invalid_auth for ${TOKEN}`); },
  });
  t.after(() => server.close());
  assert.deepEqual(await requestNames(dir, { users: ['U0EXAMPLE01'] }), { type: 'names', users: {}, channels: {} });
  const leaky = await startStatusServer({ profileDir: shortDir(t), status: up, names: async () => ({ users: { U0EXAMPLE01: 'Sam', U0NOTASKED1: TOKEN }, channels: { C0EXAMPLE01: 42 as unknown as string } }) });
  t.after(() => leaky.close());
  const reply = await requestNames(join(leaky.path, '..'), { users: ['U0EXAMPLE01'], channels: ['C0EXAMPLE01'] });
  assert.deepEqual(reply, { type: 'names', users: { U0EXAMPLE01: 'Sam' }, channels: {} }, 'only names for the IDs asked go out');
});

test('requestNames: null without a daemon, and from an older daemon that never answers', async (t) => {
  const dir = shortDir(t);
  assert.equal(await requestNames(dir, { users: ['U0EXAMPLE01'] }), null);
  const old = await startStatusServer({ profileDir: dir, status: up }); // No resolver: reads nothing, like an old bot.
  t.after(() => old.close());
  const started = Date.now();
  assert.equal(await requestNames(dir, { users: ['U0EXAMPLE01'] }, { timeoutMs: 100 }), null);
  assert.ok(Date.now() - started < 1_000);
});

// ---------------------------------------------------------------------------------------------------------------
// The app's side: names kept on disk
// ---------------------------------------------------------------------------------------------------------------

test('disk cache: names survive a relaunch with no request, the file is 600, holds names only', async (t) => {
  const dir = shortDir(t);
  const asks: string[][] = [];
  const ask = async ({ users, channels }: { users: string[]; channels: string[] }) => {
    asks.push([...users, ...channels]);
    const pick = (ids: string[]) => Object.fromEntries(ids.filter((id) => NAMES[id]).map((id) => [id, NAMES[id]!]));
    return { type: 'names' as const, users: pick(users), channels: pick(channels) };
  };
  let resolved = 0;
  const first = createStoredSlackNames({ profileDir: dir, ask, onResolved: () => { resolved += 1; } });
  assert.equal(first.userName('U0EXAMPLE01'), undefined);
  assert.equal(await first.request({ users: ['U0EXAMPLE01', 'B0MONITOR01'], channels: ['C0EXAMPLE01', 'D0EXAMPLE01'] }), true);
  assert.equal(resolved, 1);
  const path = join(dir, SLACK_NAMES_FILE);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const text = readFileSync(path, 'utf8');
  assert.ok(!text.includes('xoxb') && !text.includes('op://'), 'no token in the file');
  assert.deepEqual(Object.keys(JSON.parse(text).names).sort(), ['B0MONITOR01', 'C0EXAMPLE01', 'U0EXAMPLE01']);

  // Relaunch: a new store on the same profile knows the names and asks for nothing.
  const second = createStoredSlackNames({ profileDir: dir, ask });
  assert.deepEqual([second.userName('U0EXAMPLE01'), second.userName('B0MONITOR01'), second.channelName('C0EXAMPLE01'), second.channelName('D0EXAMPLE01')],
    ['Sam Rivera', 'Acme Monitor', '#billing-alerts', DM_LABEL]);
  assert.equal(await second.request({ users: ['U0EXAMPLE01', 'B0MONITOR01'], channels: ['C0EXAMPLE01'] }), false);
  assert.equal(asks.length, 1, 'fresh names need no request');

  // Expired: still shown, and refreshed.
  const later = createStoredSlackNames({ profileDir: dir, ask, now: () => Date.now() + 7 * 60 * MINUTE });
  assert.equal(later.userName('U0EXAMPLE01'), 'Sam Rivera');
  await later.request({ users: ['U0EXAMPLE01'] });
  assert.equal(asks.length, 2);
});

test('disk cache: a corrupt or missing file is empty, and the file stays bounded', async (t) => {
  const dir = shortDir(t);
  const path = join(dir, SLACK_NAMES_FILE);
  assert.equal(readStoredNames(dir).size, 0);
  writeFileSync(path, '{not json');
  assert.equal(readStoredNames(dir).size, 0);
  writeFileSync(path, JSON.stringify({ version: 1, names: { U0EXAMPLE01: { name: 'Sam', at: 1 }, '../x': { name: 'bad', at: 1 }, U0OTHER0001: { name: 7, at: 1 } } }));
  assert.deepEqual([...readStoredNames(dir).keys()], ['U0EXAMPLE01']);
  const corrupt = createStoredSlackNames({ profileDir: dir, ask: async () => null });
  writeFileSync(path, '\u0000garbage');
  const fresh = createStoredSlackNames({ profileDir: dir, ask: async () => null });
  assert.equal(fresh.userName('U0EXAMPLE01'), undefined);
  assert.equal(corrupt.userName('U0EXAMPLE01'), undefined, 'the file is read at first use');

  const big = Object.fromEntries(Array.from({ length: MAX_STORED_NAMES + 20 }, (_, index) => [`U${String(index).padStart(9, '0')}`, { name: `n${index}`, at: index }]));
  writeFileSync(path, JSON.stringify({ version: 1, names: big }));
  const store = createStoredSlackNames({ profileDir: dir, ask: async () => ({ type: 'names', users: { U0EXAMPLE01: 'Sam' }, channels: {} }) });
  await store.request({ users: ['U0EXAMPLE01'] });
  const kept = readStoredNames(dir);
  assert.equal(kept.size, MAX_STORED_NAMES);
  assert.ok(kept.has('U0EXAMPLE01'), 'the newest name is kept');
  assert.ok(!kept.has('U000000000'), 'the oldest go first');
});

test('no answer: rows keep cached names, one log line, and the bot is asked again only after a backoff', async (t) => {
  const dir = shortDir(t);
  let now = 1_000_000;
  let calls = 0;
  const logs: string[] = [];
  const store = createStoredSlackNames({ profileDir: dir, ask: async () => { calls += 1; return null; }, now: () => now, backoffMs: 1_000, log: (line) => logs.push(line) });
  assert.equal(await store.request({ users: ['U0EXAMPLE01'] }), false);
  assert.equal(await store.request({ users: ['U0EXAMPLE01'] }), false);
  assert.equal(calls, 1, 'not asked again during the backoff');
  now += 1_001;
  await store.request({ users: ['U0EXAMPLE01'] });
  assert.equal(calls, 2);
  now += 1_001;
  await store.request({ users: ['U0EXAMPLE01'] });
  assert.equal(calls, 2, 'the backoff doubled');
  assert.equal(logs.length, 1, 'logged once');
  assert.equal(existsSync(join(dir, SLACK_NAMES_FILE)), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Opening the app: jobs.list never runs `op` or `security`, whatever the token's source
// ---------------------------------------------------------------------------------------------------------------

/** A profile with jobs whose requester and channel aren't named yet, and fake `op`/`security` that record every call. */
const launchFixture = (t: TestContext, source: 'onepassword' | 'keychain' | 'env', { op = true }: { op?: boolean } = {}) => {
  const dir = shortDir(t);
  const example = JSON.parse(readFileSync(new URL('../examples/profile.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...example, t3Bin: join(dir, 'missing-t3') }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    'C0EXAMPLE01:1700000000.000001': { t3ThreadId: 'a', channel: 'C0EXAMPLE01', threadTs: '1700000000.000001', requester: 'U0EXAMPLE01', ownerAskOpen: true, createdAt: ago(30), lastActivityAt: ago(12) },
    'D0EXAMPLE01:1700000000.000002': { t3ThreadId: 'b', channel: 'D0EXAMPLE01', threadTs: '1700000000.000002', requester: 'B0MONITOR01', createdAt: ago(20), lastActivityAt: ago(5) },
  }));
  if (source === 'onepassword') writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, sources: { SLACK_BOT_TOKEN: { kind: '1password', reference: REF } }, checks: {} }));
  if (source === 'keychain') writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, sources: { SLACK_BOT_TOKEN: { kind: 'keychain', service: 'dev.serra.friday', account: 'SLACK_BOT_TOKEN' } }, checks: {} }));
  if (source === 'env') writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${TOKEN}\n`);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  const tool = (name: string): void => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write(${JSON.stringify(TOKEN)});\n`);
    chmodSync(path, 0o755);
  };
  tool('security');
  if (op) tool('op');
  // Only the fake tools are on the PATH: a real `op` or `security` can't be reached either.
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = previous; });
  const recorded = (): string[] => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  // The harness can see a call: the fake tools on this PATH record it.
  execFileSync('security', ['probe']);
  assert.deepEqual(recorded(), ['security probe']);
  writeFileSync(calls, '');
  return { dir, recorded };
};

const launchContext = (profileDir: string, pushes: string[]): HandlerContext => ({
  profileDirOrNull: () => profileDir,
  profileDir: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
  push: (channel) => { pushes.push(channel); },
});

/** Opens the app on the profile: a fresh Jobs handler, as at launch, that asks the real socket. */
const openApp = (dir: string, pushes: string[] = []) => jobsHandlers(launchContext(dir, pushes), {
  run: async () => { throw new Error('no t3'); }, now: () => NOW, slackNames: { timeoutMs: 300, log: () => {} },
});

for (const source of ['onepassword', 'keychain', 'env'] as const) {
  test(`launch (${source}): with the bot answering, names arrive from it and no secret tool runs`, async (t) => {
    const { dir, recorded } = launchFixture(t, source);
    const server = await startStatusServer({ profileDir: dir, status: up, names: fakeResolver() });
    t.after(() => server.close());
    const pushes: string[] = [];
    const app = openApp(dir, pushes);
    const first = await app.list();
    assert.deepEqual(first.map((row) => [row.requesterName, row.channelName]), [[undefined, undefined], [undefined, DM_LABEL]], 'raw IDs first: the list never waits');
    await settle(100);
    assert.deepEqual(pushes, ['jobs']);
    const rows = await app.list();
    assert.deepEqual(rows.map((row) => [row.requesterName, row.channelName]), [['Sam Rivera', '#billing-alerts'], ['Acme Monitor', DM_LABEL]]);
    assert.ok(!JSON.stringify(rows).includes('xoxb'));
    // Relaunch: names come from the file, before and without any lookup.
    await server.close();
    const relaunched = await openApp(dir).list();
    assert.deepEqual(relaunched.map((row) => [row.requesterName, row.channelName]), [['Sam Rivera', '#billing-alerts'], ['Acme Monitor', DM_LABEL]]);
    await settle(500);
    assert.deepEqual(recorded(), [], 'no op and no security call');
  });

  test(`launch (${source}): with no bot, rows keep raw IDs, nothing throws, no secret tool runs`, async (t) => {
    const { dir, recorded } = launchFixture(t, source);
    const pushes: string[] = [];
    const app = openApp(dir, pushes);
    for (let index = 0; index < 3; index += 1) {
      const rows = await app.list();
      assert.deepEqual(rows.map((row) => [row.requesterName, row.channelName]), [[undefined, undefined], [undefined, DM_LABEL]]);
      await settle(20);
    }
    await openApp(dir).list(); // A relaunch.
    // Long enough for a spawned tool to have started and recorded its call (the code before SERRA-55 fails here).
    await settle(1_000);
    assert.deepEqual(pushes, []);
    assert.deepEqual(recorded(), [], 'no op and no security call');
  });
}

test('launch: a 1Password profile on a Mac without op lists jobs and gets names from the bot', async (t) => {
  const { dir, recorded } = launchFixture(t, 'onepassword', { op: false });
  const server = await startStatusServer({ profileDir: dir, status: up, names: fakeResolver() });
  t.after(() => server.close());
  const app = openApp(dir);
  await app.list();
  await settle(100);
  assert.deepEqual((await app.list()).map((row) => row.requesterName), ['Sam Rivera', 'Acme Monitor']);
  assert.deepEqual(recorded(), []);
});
