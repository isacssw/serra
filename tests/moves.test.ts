// Moves, restores and server updates (SB-34). A move runs between this "Mac" (a temp folder) and a "server" (another
// temp folder behind a real gateway on 127.0.0.1), with a fake service manager in place of launchd and systemd. What
// is checked is what the owner would see on disk: the knowledge, the held requests and the settings arrive, the
// tokens land in the target's own store and nowhere else, only one side can run, and a move that fails leaves the
// source as it was.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { certFingerprint, selfSignedCert } from '../src/gateway/cert.ts';
import { gatewayClient } from '../src/gateway/client.ts';
import { serverEngines } from '../src/gateway/engines.ts';
import { eventLog } from '../src/gateway/events.ts';
import { remoteMoveHost } from '../src/gateway/move-client.ts';
import { startGateway } from '../src/gateway/server.ts';
import { addDevice, gatewayCert, serverIdentity } from '../src/gateway/state.ts';
import { readUpdateState, runServerUpdate, updateProblem } from '../src/gateway/update.ts';
import { heldForMove, holdPath } from '../src/moves/hold.ts';
import { localMoveHost, settleLapsed, type MoveHost } from '../src/moves/host.ts';
import { newJournal, readJournal, runMove, saveJournal, settle, type MoveJournal } from '../src/moves/run.ts';
import { secretPort } from '../src/moves/secret-port.ts';
import { backupProfile, listBackups } from '../src/profile-backup.ts';
import { createProfile } from '../src/setup.ts';
import { startTask } from '../src/tasks.ts';
import type { ServiceDriver, ServiceHost } from '../src/service.ts';
import { startDaemon } from '../src/daemon.ts';
import { loadConfig } from '../src/config.ts';
import { movesRunner } from '../app/main/moves.ts';
import { awayLine, moveEnding, moveSteps, moveTitle, stopLabel } from '../app/renderer/moves.logic.ts';
import { serverDiagnostics, updateAction, updateEnding } from '../app/renderer/servers.logic.ts';
import type { MoveView, ServerHealth } from '../src/api.ts';
import type { PairedServer, ServerPairing } from '../src/gateway/pairing.ts';
import type { ServerHealthFollower } from '../src/gateway/health.ts';

const BOT = 'xoxb-1111-2222-fixturevalue';
const APP = 'xapp-1-A111-2222-fixturevalue';

const folder = (t: TestContext, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A fake launchd/systemd: services are files in `dir`, loaded is a set, ready writes the daemon's marker. */
const fakeService = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const loaded = new Set<string>();
  const started: string[] = [];
  const driver: ServiceDriver = {
    loaded: async (label) => loaded.has(label),
    stop: async (label) => { loaded.delete(label); },
    start: async (path) => { const label = basename(path, '.plist'); loaded.add(label); started.push(label); },
    // Like the real daemon (`startDaemon`), a held profile never comes up.
    ready: async (profileDir) => {
      if (heldForMove(profileDir)) throw new Error('This profile is being moved or restored, so it doesn’t start here.');
      writeFileSync(join(profileDir, 'ready.json'), JSON.stringify({ pid: process.pid }));
    },
    forget: async () => {},
  };
  const host: ServiceHost = { kind: 'launchd', dir, releaseFile: 'service.plist', fileName: (label) => `${label}.plist`, unit: () => '', driver };
  return { loaded, started, driver, host, dir };
};

type Fake = ReturnType<typeof fakeService>;

/** One computer: its profiles folder, its fake service manager, and its side of a move. */
const computer = (t: TestContext, name: string, options: { installFails?: boolean } = {}) => {
  const root = folder(t, `serra-${name.replace(/\s/g, '')}-`);
  const service = fakeService(join(root, '..', `${basename(root)}-services`));
  t.after(() => rmSync(service.dir, { recursive: true, force: true }));
  const trashed: string[] = [];
  const host = localMoveHost({
    root, name,
    service: { host: service.host, driver: service.driver, dir: service.dir },
    secrets: secretPort({ keychain: false }),
    trash: async (path) => {
      const to = join(root, '.test-trash', `${basename(path)}-${trashed.length}`);
      mkdirSync(join(root, '.test-trash'), { recursive: true });
      renameSync(path, to);
      trashed.push(to);
    },
    install: async (dir) => {
      if (options.installFails) throw new Error('It didn’t start: Slack refused the token.');
      const label = loadConfig({ profileDir: dir, env: {} }).serviceLabel;
      const file = join(service.dir, `${label}.plist`);
      writeFileSync(file, 'plist');
      await service.driver.start(file);
      await service.driver.ready(dir);
    },
  });
  return { root, service, host, trashed, name };
};

/** A running profile "friday" with knowledge, a held request, tokens in .env and the files that stay with a host. */
const runningProfile = async (root: string, service: Fake, project: string): Promise<string> => {
  const dir = join(root, 'friday');
  createProfile(dir, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  mkdirSync(join(dir, 'knowledge', 'people'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'people', 'alex.md'), '# Alex\nLikes short answers.\n');
  writeFileSync(join(dir, 'held-requests.jsonl'), '{"text":"deploy the docs"}\n');
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'state.json.lock'), '999999');
  mkdirSync(join(dir, 'releases', 'r1'), { recursive: true });
  writeFileSync(join(dir, 'releases', 'r1', 'service.plist'), 'plist');
  writeFileSync(join(dir, 'active.json'), '{}');
  // An old activation's backup keeps a copy of .env inside the profile: it must not travel either.
  mkdirSync(join(dir, 'backups', '2026-11-01'), { recursive: true });
  writeFileSync(join(dir, 'backups', '2026-11-01', '.env'), `SLACK_BOT_TOKEN=${BOT}\n`);
  const file = join(service.dir, 'dev.serra.friday.plist');
  writeFileSync(file, 'plist');
  await service.driver.start(file);
  return dir;
};

/** A server behind a real gateway on 127.0.0.1, and this Mac's client for it. */
const server = async (t: TestContext, name = 't480', options: { installFails?: boolean } = {}) => {
  const side = computer(t, name, options);
  serverIdentity(side.root, name);
  const events = eventLog();
  const gateway = await startGateway({
    root: side.root, addresses: ['127.0.0.1'], port: 0, events, version: '0.1.0-alpha.9', moves: side.host,
    engines: serverEngines({ root: side.root, runtime: { version: '0.1.0-alpha.9', platform: 'linux' }, events, subscribe: () => ({ close() {} }) }),
    update: {
      problem: (version) => updateProblem({ root: side.root, code: side.root, current: '0.1.0-alpha.9', version }),
      launch: async () => {},
    },
  });
  t.after(() => gateway.close());
  const { cert, fingerprint } = gatewayCert(side.root, name);
  const token = addDevice(side.root, 'Test Mac').token;
  const client = gatewayClient({ endpoint: async () => ({ host: '127.0.0.1', port: gateway.port }), pin: { cert, fingerprint }, token: async () => token, name });
  return { ...side, client, remote: remoteMoveHost(client, name), gateway };
};

const move = (root: string, from: MoveHost, to: MoveHost, plan: Partial<MoveJournal> = {}) => {
  const journal = { ...newJournal({ kind: 'move', profile: 'friday', name: 'Friday', from: 'local', to: 's_test01', fromName: from.name, toName: to.name }), ...plan };
  saveJournal(root, journal);
  return runMove(journal, { root, from, to, pollMs: 10 });
};

/** Everything under a folder, as relative paths. */
const tree = (dir: string, prefix = ''): string[] => readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  return entry.isDirectory() ? [rel, ...tree(dir, rel)] : [rel];
});

const allText = (dir: string): string => tree(dir).map((rel) => {
  try { return statSync(join(dir, rel)).isFile() ? readFileSync(join(dir, rel), 'utf8') : ''; } catch { return ''; }
}).join('\n');

test('a profile moves to a server and back with its knowledge, held requests and tokens, and only one side runs', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  const project = folder(t, 'serra-project-');
  const dir = await runningProfile(mac.root, mac.service, project);
  writeFileSync(join(mac.root, 'profiles.json'), JSON.stringify({ version: 1, order: ['local/scout', 'local/friday'], look: { 'local/friday': { color: '#4f55b8' } } }));

  const run = move(mac.root, mac.host, t480.remote);
  const ended = await run.done;
  assert.equal(ended.state, 'done', ended.error ?? '');
  assert.equal(ended.step, 'archive');

  const there = join(t480.root, 'friday');
  assert.equal(readFileSync(join(there, 'knowledge', 'people', 'alex.md'), 'utf8'), '# Alex\nLikes short answers.\n');
  assert.equal(readFileSync(join(there, 'held-requests.jsonl'), 'utf8'), '{"text":"deploy the docs"}\n', 'held requests are answered on the target');
  // The host's own files stay behind; the tokens arrive in the target's store, private.
  for (const name of ['state.json.lock', 'releases', 'active.json', 'intake-paused.json', 'backups/2026-11-01/.env']) assert.equal(existsSync(join(there, name)), false, name);
  assert.match(readFileSync(join(there, '.env'), 'utf8'), /SLACK_BOT_TOKEN=xoxb-1111-2222-fixturevalue/);
  assert.equal(statSync(join(there, '.env')).mode & 0o777, 0o600);
  assert.ok(t480.service.loaded.has('dev.serra.friday'), 'live on the server');
  assert.equal(mac.service.loaded.has('dev.serra.friday'), false, 'not live here');
  // The Mac's copy left for the Trash; its checked backup stays, without a token.
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(mac.service.dir, 'dev.serra.friday.plist')), false);
  assert.equal(existsSync(holdPath(mac.root, 'friday')), false);
  const backups = listBackups(join(mac.root, 'backups'));
  assert.deepEqual(backups.map((backup) => [backup.profile, backup.kind, backup.detail]), [['friday', 'moved', 't480']]);
  assert.doesNotMatch(allText(join(mac.root, 'backups')), /fixturevalue/);
  assert.doesNotMatch(allText(join(mac.root, 'moves')), /fixturevalue/, 'the journal never holds a token');
  assert.deepEqual(readdirSync(join(t480.root, '.incoming')), [], 'no staging left');

  // Work done on the server since comes back with it (E6).
  writeFileSync(join(there, 'knowledge', 'people', 'alex.md'), '# Alex\nLikes short answers. Uses Linear.\n');
  const back = await move(mac.root, t480.remote, mac.host, { from: 's_test01', to: 'local', fromName: 't480', toName: 'this Mac' }).done;
  assert.equal(back.state, 'done', back.error ?? '');
  assert.equal(readFileSync(join(mac.root, 'friday', 'knowledge', 'people', 'alex.md'), 'utf8'), '# Alex\nLikes short answers. Uses Linear.\n');
  assert.ok(mac.service.loaded.has('dev.serra.friday'));
  assert.equal(t480.service.loaded.has('dev.serra.friday'), false);
  assert.equal(existsSync(there), false, 'the server’s copy went to its trash');
  assert.equal(listBackups(join(t480.root, 'backups')).length, 1);
});

test('the app keeps the profile’s place in the order and its colour after a move', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  writeFileSync(join(mac.root, 'profiles.json'), JSON.stringify({ version: 1, order: ['local/scout', 'local/friday'], look: { 'local/friday': { color: '#4f55b8' } } }));
  const pushed: MoveView[] = [];
  const left: (string | null)[] = [];
  const paired = { id: 's_test01', name: 't480' } as PairedServer;
  const health = { snapshot: () => [{ id: 's_test01', name: 't480', state: 'up', protocol: 2 }], retry: () => {} } as unknown as ServerHealthFollower;
  const runner = movesRunner({
    root: mac.root, pairing: { list: () => [paired] } as unknown as ServerPairing, health, local: mac.host, remote: () => t480.remote,
    push: (view) => pushed.push(view), changed: (dir) => left.push(dir), pollMs: 10,
  });
  const check = await runner.handlers.preflight('local/friday', 's_test01');
  assert.deepEqual(check.blocks, []);
  assert.equal(check.name, 'Friday');
  assert.equal(check.toName, 't480');
  await runner.handlers.start('local/friday', 's_test01');
  await runner.idle();
  assert.equal(pushed.at(-1)?.state, 'done');
  assert.deepEqual(left, [join(mac.root, 'friday')]);
  const file = JSON.parse(readFileSync(join(mac.root, 'profiles.json'), 'utf8')) as { order: string[]; look: Record<string, unknown> };
  assert.deepEqual(file.order, ['local/scout', 's_test01/friday']);
  assert.deepEqual(file.look, { 's_test01/friday': { color: '#4f55b8' } });
  assert.equal((await runner.handlers.list()).length, 1);
  await runner.handlers.dismiss(pushed.at(-1)!.id);
  assert.equal((await runner.handlers.list()).length, 0);
  // Its backups: the one before the move is on this Mac, and the profile is live elsewhere.
  const backups = await runner.handlers.backups('s_test01/friday');
  assert.deepEqual(backups.map((backup) => [backup.hostName, backup.kind, backup.blocked]), [['this Mac', 'moved', 'Live on t480']]);
});

test('a move is blocked while a job waits for the owner, while the server is offline, and while it is too old', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  const paired = { id: 's_test01', name: 't480' } as PairedServer;
  let snapshot: Partial<ServerHealth>[] = [{ id: 's_test01', name: 't480', state: 'up', protocol: 2 }];
  const runner = movesRunner({
    root: mac.root, pairing: { list: () => [paired] } as unknown as ServerPairing,
    health: { snapshot: () => snapshot, retry: () => {} } as unknown as ServerHealthFollower,
    local: mac.host, remote: () => t480.remote, push: () => {}, changed: () => {},
  });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'C1:1.0': { requester: 'U0123456789', channel: 'C1', threadTs: '1.0', threadId: 't', createdAt: '2026-11-28T10:00:00.000Z', phase: { state: 'waiting' } } }));
  const waiting = await runner.handlers.preflight('local/friday', 's_test01');
  assert.deepEqual(waiting.blocks.map((block) => [block.kind, block.text]), [['waiting', '1 job waits for you']]);
  await assert.rejects(async () => runner.handlers.start('local/friday', 's_test01'), /1 job waits for you/);
  rmSync(join(dir, 'state.json'));
  snapshot = [{ id: 's_test01', name: 't480', state: 'offline', protocol: 2 }];
  assert.deepEqual((await runner.handlers.preflight('local/friday', 's_test01')).blocks, [{ kind: 'offline', text: 't480 is offline' }]);
  snapshot = [{ id: 's_test01', name: 't480', state: 'up', protocol: 1 }];
  assert.deepEqual((await runner.handlers.preflight('local/friday', 's_test01')).blocks, [{ kind: 'update', text: 'Update t480 first' }]);
  // A server that already has a profile by that name refuses it.
  snapshot = [{ id: 's_test01', name: 't480', state: 'up', protocol: 2 }];
  createProfile(join(t480.root, 'friday'), {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/tmp', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  assert.deepEqual((await runner.handlers.preflight('local/friday', 's_test01')).blocks.map((block) => block.text), ['t480 already has a profile called friday']);
  rmSync(join(t480.root, 'friday'), { recursive: true });
  // A profile on eve on Vercel stays on this Mac: its bypass secret is in this Mac's Keychain.
  writeFileSync(join(dir, 'agent-backend.json'), JSON.stringify({ backend: 'acp', agent: 'eve-cloud', eve: {
    url: 'https://researcher.vercel.app', notice: { host: 'researcher.vercel.app', version: 1, acceptedAt: '2026-11-28T10:00:00.000Z' },
  } }));
  assert.deepEqual((await runner.handlers.preflight('local/friday', 's_test01')).blocks.map((block) => block.text), ['Remove eve on Vercel first: a server can’t use it yet']);
  rmSync(join(dir, 'agent-backend.json'));
  assert.ok(mac.service.loaded.has('dev.serra.friday'), 'a preflight changes nothing');
  assert.equal(existsSync(join(dir, 'intake-paused.json')), false);
});

test('a copy that fails part way puts the source back as it was and deletes the target’s staging', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  let sent = 0;
  const flaky: MoveHost = { ...t480.remote, writeFile: async (moveId, path, data) => {
    sent += 1;
    if (sent === 2) throw new Error('t480 didn’t answer.');
    return t480.remote.writeFile(moveId, path, data);
  } };
  const ended = await move(mac.root, mac.host, flaky).done;
  assert.equal(ended.state, 'stopped');
  assert.equal(ended.error, 't480 didn’t answer.');
  assert.deepEqual(moveEnding({ ...ended, ref: 'local/friday' } as MoveView), { message: 'Move stopped · Friday is back on this Mac, unchanged.', tone: 'error', moveBack: false });
  assert.ok(mac.service.loaded.has('dev.serra.friday'), 'running here again');
  assert.ok(existsSync(join(mac.service.dir, 'dev.serra.friday.plist')), 'its service file is back');
  assert.equal(existsSync(holdPath(mac.root, 'friday')), false);
  assert.equal(existsSync(join(dir, 'intake-paused.json')), false, 'new jobs start again');
  assert.equal(readFileSync(join(dir, 'held-requests.jsonl'), 'utf8'), '{"text":"deploy the docs"}\n');
  assert.equal(existsSync(join(t480.root, 'friday')), false);
  assert.deepEqual(readdirSync(join(t480.root, '.incoming')), []);
});

test('a file changed on the way is refused, and nothing is moved', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  const corrupt: MoveHost = { ...t480.remote, writeFile: async (moveId, path, data) => {
    if (path !== 'knowledge/people/alex.md') return t480.remote.writeFile(moveId, path, data);
    data.resume();
    return t480.remote.writeFile(moveId, path, Readable.from([Buffer.from('# Alex\nLikes long answers.\n')]));
  } };
  const ended = await move(mac.root, mac.host, corrupt).done;
  assert.equal(ended.state, 'stopped');
  assert.match(ended.error ?? '', /alex\.md arrived changed/);
  assert.equal(existsSync(join(t480.root, 'friday')), false);
  assert.ok(mac.service.loaded.has('dev.serra.friday'));
});

test('a target that doesn’t start sets its copy aside without tokens, and the source runs again', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t, 't480', { installFails: true });
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  const ended = await move(mac.root, mac.host, t480.remote).done;
  assert.equal(ended.state, 'stopped');
  assert.match(ended.error ?? '', /didn’t start/);
  assert.ok(mac.service.loaded.has('dev.serra.friday'));
  assert.ok(existsSync(join(dir, 'profile.json')), 'the source was never archived');
  assert.equal(existsSync(join(t480.root, 'friday')), false);
  const aside = readdirSync(join(t480.root, 'backups')).filter((name) => name.endsWith('-failed-move'));
  assert.equal(aside.length, 1);
  assert.doesNotMatch(allText(join(t480.root, 'backups')), /fixturevalue/, 'no token stays on the target');
});

test('a commit whose answer is lost is undone on the target before the source runs again, so only one side runs', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  // The target commits and starts, then the answer never reaches the Mac.
  const lossy: MoveHost = { ...t480.remote, commit: async (...args) => { await t480.remote.commit(...args); throw new Error('socket hang up'); } };
  const ended = await move(mac.root, mac.host, lossy).done;
  assert.equal(ended.state, 'stopped');
  assert.ok(mac.service.loaded.has('dev.serra.friday'), 'the source runs again');
  assert.ok(existsSync(join(dir, 'profile.json')));
  assert.equal(t480.service.loaded.has('dev.serra.friday'), false, 'the target was stopped first');
  assert.equal(existsSync(join(t480.root, 'friday')), false);
  assert.equal(readdirSync(join(t480.root, 'backups')).filter((name) => name.endsWith('-failed-move')).length, 1);
});

test('a move waits for the app’s own tasks on an ACP agent, and no task starts while the profile is held', async (t) => {
  const mac = computer(t, 'this Mac');
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  const task = (threadId: string) => ({ threadId, backend: 'acp:claude', title: 'x', branch: 'serra/x', requester: 'Alex', createdAt: '2026-11-28T10:00:00.000Z' });
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify([task('s-run'), task('s-ask'), task('s-done')]));
  mkdirSync(join(dir, 'agent-runs'), { recursive: true });
  const record = (sessionId: string, extra: object) => writeFileSync(join(dir, 'agent-runs', `${sessionId}.json`),
    JSON.stringify({ version: 1, sessionId, cwd: dir, entries: [], active: null, ...extra }));
  record('s-run', { active: 'turn-1' });
  record('s-ask', { active: 'turn-1', waiting: [{ requestId: 'q1', questions: [] }] });
  record('s-done', {});
  assert.deepEqual(await mac.host.drain('friday'), { running: 1, waiting: 1 });
  await mac.host.later('friday');
  await mac.host.pause('friday', 'm_abcdefghijkl');
  await assert.rejects(startTask(dir, 'fix the docs', { fetchBase: async () => {} }), /being moved or restored/);
});

test('a hold keeps the daemon from starting; it lapses after 10 minutes and the host starts the profile again', async (t) => {
  const t480 = computer(t, 't480');
  const dir = await runningProfile(t480.root, t480.service, folder(t, 'serra-project-'));
  await t480.host.drain('friday');
  await t480.host.pause('friday', 'm_abcdefghijkl');
  assert.equal(t480.service.loaded.has('dev.serra.friday'), false);
  assert.equal(existsSync(join(t480.service.dir, 'dev.serra.friday.plist')), false, 'set aside, so a reboot doesn’t load it');
  assert.equal(heldForMove(dir), true);
  const config = loadConfig({ profileDir: dir, env: { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP } });
  await assert.rejects(startDaemon({ config, logger: { info() {}, warn() {}, error() {} } as never, knowledge: {} as never, lock: () => () => {} }), /being moved or restored/);
  // Ten minutes on without a refresh: the hold no longer counts, and settling starts it again.
  const later = Date.now() + 11 * 60_000;
  assert.equal(heldForMove(dir, later), false);
  assert.deepEqual(await settleLapsed(t480.host, t480.root, later), ['friday']);
  assert.ok(t480.service.loaded.has('dev.serra.friday'));
  assert.equal(existsSync(join(dir, 'intake-paused.json')), false);
  // A committed hold never lapses: the target may be live.
  await t480.host.pause('friday', 'm_abcdefghijkm');
  await t480.host.hold('friday', 'm_abcdefghijkm', 'committed');
  assert.equal(heldForMove(dir, later + 60 * 60_000), true);
  assert.deepEqual(await settleLapsed(t480.host, t480.root, later + 60 * 60_000), []);
});

test('a move left part way by a quit settles on its own: before start the source comes back, from start it finishes', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  // The app quit in the middle of the copy.
  const journal = newJournal({ kind: 'move', profile: 'friday', name: 'Friday', from: 'local', to: 's_test01', fromName: 'this Mac', toName: 't480' });
  await mac.host.pause('friday', journal.id);
  const files = await mac.host.backup('friday', journal.id, { to: 't480' }, 'moved');
  await t480.remote.receive(journal.id, 'friday', files);
  const first = files.find((file) => file.path === 'profile.json')!;
  await t480.remote.writeFile(journal.id, first.path, await mac.host.readFile(journal.id, first.path));
  saveJournal(mac.root, { ...journal, step: 'copy' });
  const settled = await settle(readJournal(mac.root, journal.id)!, { root: mac.root, from: mac.host, to: t480.remote, pollMs: 10 });
  assert.equal(settled.state, 'stopped');
  assert.ok(mac.service.loaded.has('dev.serra.friday'));
  assert.equal(heldForMove(dir), false);
  assert.deepEqual(readdirSync(join(t480.root, '.incoming')), []);

  // This time it quit after the target started: settling finishes the move.
  const second = newJournal({ kind: 'move', profile: 'friday', name: 'Friday', from: 'local', to: 's_test01', fromName: 'this Mac', toName: 't480' });
  await mac.host.pause('friday', second.id);
  const all = await mac.host.backup('friday', second.id, { to: 't480' }, 'moved');
  for (const path of await t480.remote.receive(second.id, 'friday', all)) await t480.remote.writeFile(second.id, path, await mac.host.readFile(second.id, path));
  await t480.remote.verify(second.id);
  await mac.host.hold('friday', second.id, 'committed');
  await t480.remote.commit(second.id, { secrets: await mac.host.secrets('friday'), mapped: {}, replace: false });
  saveJournal(mac.root, { ...second, step: 'start' });
  const finished = await settle(readJournal(mac.root, second.id)!, { root: mac.root, from: mac.host, to: t480.remote, pollMs: 10 });
  assert.equal(finished.state, 'done');
  assert.equal(existsSync(dir), false);
  assert.ok(t480.service.loaded.has('dev.serra.friday'));
  assert.equal(mac.service.loaded.has('dev.serra.friday'), false);
});

test('Move later while jobs finish leaves everything as it was', async (t) => {
  const mac = computer(t, 'this Mac');
  const t480 = await server(t);
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'C1:1.0': { requester: 'U0123456789', channel: 'C1', threadTs: '1.0', threadId: 't', createdAt: '2026-11-28T10:00:00.000Z', phase: { state: 'following' } } }));
  const run = move(mac.root, mac.host, t480.remote);
  await new Promise((wake) => setTimeout(wake, 50));
  assert.ok(existsSync(join(dir, 'intake-paused.json')), 'no new job starts while it waits');
  assert.equal(run.control.stop(), true);
  const ended = await run.done;
  assert.equal(ended.state, 'later');
  assert.equal(existsSync(join(dir, 'intake-paused.json')), false);
  assert.ok(mac.service.loaded.has('dev.serra.friday'));
});

test('a restore puts a backup back in place, saves today’s copy first, and refuses a backup that changed', async (t) => {
  const mac = computer(t, 'this Mac');
  const dir = await runningProfile(mac.root, mac.service, folder(t, 'serra-project-'));
  const backup = backupProfile(dir, join(mac.root, 'backups'), { profile: 'local/friday' }, new Date('2026-11-20T10:00:00.000Z'), 'removed');
  writeFileSync(join(dir, 'knowledge', 'people', 'alex.md'), '# Alex\nNew today.\n');
  const restore = (backupId: string) => {
    const journal = newJournal({ kind: 'restore', profile: 'friday', name: 'Friday', from: 'local', to: 'local', fromName: 'this Mac', toName: 'this Mac', backup: backupId });
    saveJournal(mac.root, journal);
    return runMove(journal, { root: mac.root, from: mac.host, to: mac.host, pollMs: 10 }).done;
  };
  const done = await restore(basename(backup.path));
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(readFileSync(join(dir, 'knowledge', 'people', 'alex.md'), 'utf8'), '# Alex\nLikes short answers.\n');
  // The bot's code, its tokens and its release record stayed with this Mac.
  assert.ok(existsSync(join(dir, 'releases', 'r1', 'service.plist')));
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /SLACK_BOT_TOKEN/);
  assert.ok(existsSync(join(dir, 'active.json')));
  assert.ok(mac.service.loaded.has('dev.serra.friday'));
  assert.equal(heldForMove(dir), false);
  assert.equal(existsSync(join(dir, 'intake-paused.json')), false, 'the restored bot takes new requests');
  const listed = listBackups(join(mac.root, 'backups'));
  const before = listed.find((entry) => entry.kind === 'restore')!;
  assert.equal(before.detail, basename(backup.path));
  assert.equal(readFileSync(join(mac.root, 'backups', before.id, 'knowledge', 'people', 'alex.md'), 'utf8'), '# Alex\nNew today.\n');

  // Undo is a restore of that copy. A backup with one byte changed is refused before anything is swapped.
  writeFileSync(join(mac.root, 'backups', basename(backup.path), 'knowledge', 'people', 'alex.md'), '# Alex\nLikes short answerz.\n');
  const refused = await restore(basename(backup.path));
  assert.equal(refused.state, 'stopped');
  assert.match(refused.error ?? '', /doesn’t match its manifest/);
  assert.equal(readFileSync(join(dir, 'knowledge', 'people', 'alex.md'), 'utf8'), '# Alex\nLikes short answers.\n', 'today’s copy unchanged');
  assert.ok(mac.service.loaded.has('dev.serra.friday'));
  const undone = await restore(before.id);
  assert.equal(undone.state, 'done', undone.error ?? '');
  assert.equal(readFileSync(join(dir, 'knowledge', 'people', 'alex.md'), 'utf8'), '# Alex\nNew today.\n');
});

test('a restore on a server runs there, through its gateway', async (t) => {
  const t480 = await server(t);
  const dir = await runningProfile(t480.root, t480.service, folder(t, 'serra-project-'));
  const backup = backupProfile(dir, join(t480.root, 'backups'), {}, new Date('2026-11-20T10:00:00.000Z'), 'removed');
  writeFileSync(join(dir, 'knowledge', 'people', 'alex.md'), 'changed\n');
  assert.deepEqual((await t480.remote.backups()).map((entry) => entry.id), [basename(backup.path)]);
  const journal = newJournal({ kind: 'restore', profile: 'friday', name: 'Friday', from: 's_test01', to: 's_test01', fromName: 't480', toName: 't480', backup: basename(backup.path) });
  const mac = folder(t, 'serra-mac-');
  const ended = await runMove(journal, { root: mac, from: t480.remote, to: t480.remote, pollMs: 10 }).done;
  assert.equal(ended.state, 'done', ended.error ?? '');
  assert.equal(readFileSync(join(dir, 'knowledge', 'people', 'alex.md'), 'utf8'), '# Alex\nLikes short answers.\n');
});

test('the gateway refuses a step it doesn’t know and a file outside the move', async (t) => {
  const t480 = await server(t);
  await assert.rejects(t480.client.move('rm', ['friday']), /isn’t a step of a move/);
  await assert.rejects(t480.client.download('m_abcdefghijkl', '../server.json'), /isn’t a file of this move/);
  await assert.rejects(t480.client.move('receive', ['m_abcdefghijkl', '../etc', []]), /isn’t a profile/);
});

test('a server update goes to the app’s version, or back to where it was when the new one doesn’t start', async (t) => {
  const root = folder(t, 'serra-update-');
  mkdirSync(join(root, 'gateway'));
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]): Promise<string> => {
    calls.push(`${cmd} ${args.filter((arg) => arg !== '-C' && arg !== root).join(' ')}`);
    if (args.includes('rev-parse') && args.includes('HEAD')) return 'aaaa111\n';
    if (args.includes('rev-parse')) return 'bbbb222\n';
    if (args.includes('ls-remote')) return 'bbbb222\trefs/tags/v0.1.0-alpha.10^{}\n';
    return '';
  };
  let version = '0.1.0-alpha.9';
  const done = await runServerUpdate({
    root, code: root, version: '0.1.0-alpha.10', exec, restart: async () => { version = calls.some((call) => call.includes('checkout --detach v0.1.0-alpha.10')) ? '0.1.0-alpha.10' : version; },
    answers: async () => version,
  });
  assert.equal(done.state, 'done');
  assert.ok(calls.some((call) => call.startsWith('git fetch --tags origin')));
  assert.equal(readUpdateState(root)?.from, 'aaaa111');

  // The new version never answers: it goes back to the commit it was on.
  calls.length = 0;
  const back = await runServerUpdate({ root, code: root, version: '0.1.0-alpha.11', exec, restart: async () => {}, answers: async () => (calls.some((call) => call.includes('checkout --detach aaaa111')) ? '0.1.0-alpha.9' : null) });
  assert.equal(back.state, 'rolled-back');
  assert.match(back.message ?? '', /went back unchanged/);
  assert.ok(calls.some((call) => call.includes('checkout --detach aaaa111')));
  assert.equal(readUpdateState(root)?.state, 'rolled-back');

  // A tag that isn't origin's is never checked out.
  calls.length = 0;
  const local = await runServerUpdate({ root, code: root, version: '0.1.0-alpha.12', exec: async (cmd, args) => (args.includes('ls-remote') ? '' : exec(cmd, args)), restart: async () => {}, answers: async () => null });
  assert.equal(local.state, 'failed');
  assert.ok(!calls.some((call) => call.includes('checkout')));
});

test('an update is refused for an older version, a branch, or a folder that isn’t a checkout', async (t) => {
  const t480 = await server(t);
  mkdirSync(join(t480.root, '.git'));
  await assert.rejects(t480.client.update('0.1.0-alpha.8'), /already runs that version/);
  await assert.rejects(t480.client.update('main'), /isn’t a Serra version/);
  await t480.client.update('0.1.0-alpha.10');
  assert.equal(updateProblem({ root: folder(t, 'serra-x-'), code: folder(t, 'serra-y-'), current: '0.1.0-alpha.9', version: '0.1.0-alpha.10' }), 'Serra on this server isn’t a git checkout. Update it from its terminal.');
  // The answer already says this update is going, never the last one's ending; a second one waits for it.
  const state = await t480.client.updateState() as { update: { state: string; to: string } | null };
  assert.equal(state.update?.state, 'updating');
  assert.equal(state.update?.to, '0.1.0-alpha.10');
  await assert.rejects(t480.client.update('0.1.0-alpha.10'), /already running/);
  // A gateway that can't launch it leaves the state as it was.
  const away = await server(t, 'x220');
  mkdirSync(join(away.root, '.git'));
  await away.gateway.close();
  const refusing = await startGateway({
    root: away.root, addresses: ['127.0.0.1'], port: 0, version: '0.1.0-alpha.9',
    engines: serverEngines({ root: away.root, runtime: { version: '0.1.0-alpha.9', platform: 'linux' }, events: eventLog(), subscribe: () => ({ close() {} }) }),
    update: { problem: (to) => updateProblem({ root: away.root, code: away.root, current: '0.1.0-alpha.9', version: to }), launch: async () => { throw new Error('Update x220 from its terminal.'); } },
  });
  t.after(() => refusing.close());
  const { cert, fingerprint } = gatewayCert(away.root, 'x220');
  const token = addDevice(away.root, 'Test Mac 2').token;
  const client = gatewayClient({ endpoint: async () => ({ host: '127.0.0.1', port: refusing.port }), pin: { cert, fingerprint }, token: async () => token, name: 'x220' });
  await assert.rejects(client.update('0.1.0-alpha.10'), /from its terminal/);
  assert.equal(readUpdateState(away.root), null);
});

test('the window says it in a few words: titles, steps, the stop button, the away line and the update button', () => {
  assert.deepEqual(moveTitle('Saitama', 't480'), { title: 'Move Saitama to t480', button: 'Move Saitama' });
  assert.deepEqual(moveTitle('Saitama', 'this Mac'), { title: 'Move Saitama back', button: 'Move Saitama back' });
  assert.equal(awayLine('Saitama', 2), 'Saitama is away about 2 minutes.');
  const base: MoveView = {
    id: 'm_abcdefghijkl', kind: 'move', ref: 'local/saitama', name: 'Saitama', from: 'local', to: 's_test01', fromName: 'this Mac', toName: 't480',
    backup: null, step: 'drain', state: 'running', startedAt: '', endedAt: null, error: null, running: 2, waiting: 0, copied: 0, total: 0,
  };
  assert.deepEqual(moveSteps(base).map((step) => [step.text, step.state, step.detail]), [
    ['Finish running jobs', 'now', '2 running'], ['Pause on this Mac', 'todo', null], ['Back up on this Mac', 'todo', null],
    ['Copy and check', 'todo', null], ['Start on t480', 'todo', null], ['Archive this Mac’s copy', 'todo', null],
  ]);
  assert.deepEqual(moveSteps({ ...base, waiting: 1 })[0], { text: 'Finish running jobs', state: 'blocked', detail: '1 job waits for you' });
  assert.equal(moveSteps({ ...base, step: 'copy', copied: 40, total: 148 })[3]!.detail, '40 of 148 files');
  assert.equal(stopLabel(base), 'Move later');
  assert.equal(stopLabel({ ...base, step: 'copy' }), 'Cancel');
  assert.equal(stopLabel({ ...base, step: 'start' }), null);
  assert.deepEqual(moveEnding({ ...base, state: 'done' }), { message: 'Saitama moved to t480', tone: 'success', moveBack: true });
  assert.equal(moveSteps({ ...base, kind: 'restore', fromName: 'this Mac', toName: 'this Mac' }).length, 5);
  const health: ServerHealth = {
    id: 's_test01', name: 't480', via: 'address', address: 't480:47820', state: 'up', skew: null, protocol: 2, version: '0.1.0-alpha.9', behind: 'server',
    lastSeen: null, fingerprint: 'sha256 9f3c…a1', profiles: [],
  };
  assert.deepEqual(updateAction(health), { label: 'Update t480', target: 'server' });
  assert.deepEqual(updateAction({ ...health, behind: 'app' }), { label: 'Update Serra', target: 'app' });
  assert.equal(updateAction({ ...health, behind: null }), null);
  assert.equal(updateAction({ ...health, state: 'offline' }), null);
  assert.equal(serverDiagnostics(health), 't480:47820 · Serra 0.1.0-alpha.9 · protocol 2 · sha256 9f3c…a1');
  assert.deepEqual(updateEnding('t480', 'rolled-back', null), { title: 't480 wasn’t updated', body: 'The new version didn’t start, so t480 went back unchanged.' });
});

test('every gateway certificate is valid DER, whatever its random serial', () => {
  for (let n = 0; n < 400; n += 1) assert.match(certFingerprint(selfSignedCert('t480').cert), /^sha256:[0-9a-f]{64}$/);
});
