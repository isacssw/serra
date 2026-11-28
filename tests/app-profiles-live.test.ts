// All profiles live (SB-11, profiles phase 2): every profile's daemon is followed at once, and nothing about one
// profile (status, events, notifications, job text, bot updates and their logs) ever reaches another. The menubar lists
// each profile with its own phrase and shows the worst state; one profile looks exactly as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SerraPushes } from '../app/main/bridge.ts';
import { profilesHandlers } from '../src/handlers/profiles.ts';
import { updatesService } from '../src/handlers/updates.ts';
import type { AppUpdater } from '../app/main/app-updater.ts';
import { burstGate, notificationPlanner, notificationTarget, notificationText } from '../app/main/notifications.logic.ts';
import { defaultPrefs, memoryPrefs } from '../app/main/prefs.ts';
import { presenceMap } from '../src/presence-map.ts';
import { stoppedStatusSource, type StatusSubscriber } from '../src/status-source.ts';
import { avatarLetters, multiTrayView, rowPresence, trayView, worstIcon, type TrayProfile } from '../app/main/tray.logic.ts';
import { presence } from '../app/renderer/presence.logic.ts';
import { lettersFor, othersNeedingYou, profileRows, withPresence } from '../app/renderer/profiles.logic.ts';
import type { BotEvent, BotStatus, StatusMessage } from '../src/contracts.ts';
import type { ServiceDriver } from '../src/service.ts';
import { readPause } from '../src/intake.ts';
import { createProfile } from '../src/setup.ts';
import { startStatusServer, type UpStatus } from '../src/status-socket.ts';
import { engineContext, type AppContext } from './fakes/app-context.ts';

const OWNER = 'U0123456789';
const up = (counts: { needsYou: number; running: number }, slackConnected = true, pid = 4242): UpStatus =>
  ({ state: 'up', pid, startedAt: '2026-11-28T08:00:00.000Z', slackConnected, counts });
const STOPPED: BotStatus = { state: 'stopped' };

/** A fake `subscribeStatus`: each profile folder gets a handle the test drives, and closes are counted. */
const fakeSockets = () => {
  const open = new Map<string, (message: StatusMessage) => void>();
  const closed: string[] = [];
  const connects: string[] = [];
  const subscribe: StatusSubscriber = (dir, listener) => {
    connects.push(dir);
    open.set(dir, listener);
    return { close: () => { closed.push(dir); if (open.get(dir) === listener) open.delete(dir); } };
  };
  const report = (dir: string, status: BotStatus): void => open.get(dir)?.({ type: 'status', status });
  const emit = (dir: string, event: BotEvent): void => open.get(dir)?.({ type: 'event', event });
  return { subscribe, report, emit, open, closed, connects };
};

// ---------------------------------------------------------------------------------------------------------------
// The presence map
// ---------------------------------------------------------------------------------------------------------------

test('every profile is followed at once, each with its own status, and none is guessed before its daemon answers', () => {
  const sockets = fakeSockets();
  const map = presenceMap(sockets.subscribe);
  const heard: string[] = [];
  map.subscribe({ status: (dir, status) => heard.push(`${dir}:${status ? status.state : 'gone'}`), event: (dir, event) => heard.push(`${dir}:${event.event}`) });
  map.follow([{ dir: '/p/saitama', name: 'Saitama' }, { dir: '/p/scout', name: 'Scout' }]);
  assert.deepEqual(sockets.connects, ['/p/saitama', '/p/scout'], 'one connection per profile');
  assert.deepEqual(map.snapshot(), { '/p/saitama': null, '/p/scout': null }, 'checking until each one reports');

  sockets.report('/p/saitama', up({ needsYou: 1, running: 0 }));
  sockets.report('/p/scout', up({ needsYou: 0, running: 2 }, true, 99));
  assert.deepEqual(map.status('/p/saitama'), up({ needsYou: 1, running: 0 }));
  assert.deepEqual(map.status('/p/scout'), up({ needsYou: 0, running: 2 }, true, 99));
  sockets.emit('/p/scout', { at: '2026-11-28T09:00:00.000Z', event: 'needs_owner', key: 'C0123456789:1.000' });
  assert.deepEqual(heard, ['/p/saitama:up', '/p/scout:up', '/p/scout:needs_owner'], 'each report and event names its own profile');

  // The same report again is not news.
  sockets.report('/p/scout', up({ needsYou: 0, running: 2 }, true, 99));
  assert.equal(heard.length, 3);
});

test('following the same profiles again keeps their connections; a removed one is closed and reports gone', () => {
  const sockets = fakeSockets();
  const map = presenceMap(sockets.subscribe);
  const sets: number[] = [];
  const gone: string[] = [];
  map.subscribe({ profiles: (profiles) => sets.push(profiles.length), status: (dir, status) => { if (status === null) gone.push(dir); } });
  map.follow([{ dir: '/p/a', name: 'A' }, { dir: '/p/b', name: 'B' }]);
  sockets.report('/p/a', STOPPED);
  map.follow([{ dir: '/p/a', name: 'A' }, { dir: '/p/b', name: 'B' }]);
  assert.equal(sockets.connects.length, 2, 'no reconnect for a list read again');
  assert.deepEqual(sets, [2], 'an unchanged set is not news');
  assert.deepEqual(map.status('/p/a'), STOPPED, 'the status heard is kept');

  map.follow([{ dir: '/p/b', name: 'B' }]);
  assert.deepEqual(sockets.closed, ['/p/a']);
  assert.deepEqual(gone, ['/p/a']);
  assert.equal(map.status('/p/a'), null);
  assert.deepEqual(sets, [2, 1]);

  // A late message from the dropped connection changes nothing.
  const heard: string[] = [];
  map.subscribe({ status: (dir) => heard.push(dir) });
  sockets.report('/p/a', up({ needsYou: 0, running: 0 }));
  assert.deepEqual(heard, []);

  map.close();
  assert.deepEqual(sockets.closed, ['/p/a', '/p/b'], 'quitting closes every connection');
  assert.deepEqual(map.snapshot(), {});
});

test('several real daemons report through their own sockets, and a daemon going away reads stopped for that profile only', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'serra-live-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = join(base, 'a');
  const b = join(base, 'b');
  mkdirSync(a); mkdirSync(b);
  let aCounts = { needsYou: 0, running: 1 };
  const serverA = await startStatusServer({ profileDir: a, status: () => up(aCounts, true, 1) });
  const serverB = await startStatusServer({ profileDir: b, status: () => up({ needsYou: 2, running: 0 }, true, 2) });
  t.after(async () => { await serverA.close(); await serverB.close(); });
  const map = presenceMap();
  t.after(() => map.close());
  const changed = (check: () => boolean): Promise<void> => new Promise((done, fail) => {
    if (check()) { done(); return; }
    const timer = setTimeout(() => { off(); fail(new Error(`timed out: ${JSON.stringify(map.snapshot())}`)); }, 3_000);
    const off = map.subscribe({ status: () => { if (check()) { clearTimeout(timer); off(); done(); } } });
  });
  map.follow([{ dir: a, name: 'A' }, { dir: b, name: 'B' }]);
  await changed(() => map.status(a)?.state === 'up' && map.status(b)?.state === 'up');
  assert.deepEqual(map.status(a), up({ needsYou: 0, running: 1 }, true, 1));
  assert.deepEqual(map.status(b), up({ needsYou: 2, running: 0 }, true, 2));

  aCounts = { needsYou: 1, running: 0 };
  serverA.refresh();
  await changed(() => map.status(a)?.state === 'up' && (map.status(a) as UpStatus).counts.needsYou === 1);
  assert.deepEqual(map.status(b), up({ needsYou: 2, running: 0 }, true, 2), 'the other profile is untouched');

  await serverB.close();
  await changed(() => map.status(b)?.state === 'stopped');
  assert.equal(map.status(a)?.state, 'up');
});

// ---------------------------------------------------------------------------------------------------------------
// The menubar
// ---------------------------------------------------------------------------------------------------------------

const STATES: (BotStatus | null)[] = [
  null, STOPPED, up({ needsYou: 0, running: 0 }), up({ needsYou: 0, running: 3 }), up({ needsYou: 1, running: 2 }),
  up({ needsYou: 2, running: 0 }), up({ needsYou: 0, running: 0 }, false),
];

test('the menubar rows use the window’s status table: the same dot and phrase for every state', () => {
  for (const status of STATES) {
    for (const setupDone of [true, false]) {
      const mine = rowPresence(status, setupDone);
      const window = presence(status, { setupDone });
      assert.deepEqual(mine, { dot: window.dot, phrase: window.phrase }, JSON.stringify({ status, setupDone }));
    }
  }
  for (const [name, taken] of [['Scout', ['S']], ['Saitama', []], ['Sa', ['S', 'Sa']], ['  ', []], ['Ölund', ['Ö']]] as const) {
    assert.equal(avatarLetters(name, new Set(taken)), lettersFor(name, new Set(taken)), name);
  }
});

const profile = (dir: string, name: string, status: BotStatus | null, extra: Partial<TrayProfile> = {}): TrayProfile =>
  ({ dir, name, color: '#4b6a8a', setupDone: true, status, ...extra });

test('with several profiles the menubar lists each in ⌘ order, with its own phrase and actions', () => {
  const view = multiTrayView([
    profile('/p/saitama', 'Saitama', up({ needsYou: 1, running: 0 })),
    profile('/p/scout', 'Scout', up({ needsYou: 0, running: 2 })),
    profile('/p/ops', 'Ops', STOPPED),
    profile('/p/new', 'Nova', null, { setupDone: false }),
  ]);
  assert.deepEqual(view.rows.map((row) => [row.label, row.sublabel, row.avatar.letters, row.avatar.dot, row.shortcut]), [
    ['Saitama', '1 needs you', 'S', 'warn', '⌘1'],
    ['Scout', '2 running', 'Sc', 'up', '⌘2'],
    ['Ops', 'stopped', 'O', 'down', '⌘3'],
    ['Nova', 'Finish setup', 'N', 'none', '⌘4'],
  ]);
  assert.equal(view.rows[1]!.oneLine, 'Scout — 2 running', 'older macOS: one line');
  const [saitama, , ops, nova] = view.rows;
  assert.equal(saitama!.open, 'Open Saitama');
  assert.equal(saitama!.newTask, 'New task in Saitama…');
  assert.deepEqual(saitama!.restart, { label: 'Restart', enabled: true });
  assert.deepEqual(saitama!.stop, { label: 'Stop', enabled: true });
  assert.deepEqual(ops!.restart, { label: 'Start', enabled: true }, 'a stopped bot starts');
  assert.equal(ops!.stop, null);
  assert.equal(nova!.restart, null, 'a profile left halfway has no bot to run');
  assert.equal(nova!.newTask, null);
  assert.equal(view.icon, 'down', 'the worst state wins: red');

  const busy = multiTrayView([profile('/p/a', 'A', up({ needsYou: 0, running: 0 })), profile('/p/b', 'B', up({ needsYou: 0, running: 0 }))], new Set(['/p/a']));
  assert.deepEqual(busy.rows[0]!.restart, { label: 'Restarting…', enabled: false });
  assert.deepEqual(busy.rows[1]!.restart, { label: 'Restart', enabled: true }, 'one profile’s restart doesn’t hold another’s');
});

test('the menubar icon is the worst state across profiles: red, then amber, then green', () => {
  assert.equal(worstIcon(['up', 'warn', 'down']), 'down');
  assert.equal(worstIcon(['up', 'warn', 'faint']), 'needs-you');
  assert.equal(worstIcon(['up', 'faint', 'none']), 'up');
  assert.equal(worstIcon(['faint', 'none']), 'down', 'nothing up: today’s icon for a bot that isn’t running');
  // Checking (no report yet) never colours the icon.
  assert.equal(multiTrayView([profile('/p/a', 'A', null), profile('/p/b', 'B', up({ needsYou: 0, running: 1 }))]).icon, 'up');
});

test('one profile keeps today’s menubar words', () => {
  const view = trayView({ status: up({ needsYou: 1, running: 2 }), profileSelected: true, restarting: false, restartError: null });
  assert.equal(view.headline, 'Serra is up · Slack connected');
  assert.equal(view.icon, 'needs-you');
  assert.deepEqual(view.restart, { label: 'Restart bot', enabled: true });
});

// ---------------------------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------------------------

test('with several profiles a notification names its profile; with one it reads as today', () => {
  const needs = { kind: 'needs-owner', id: 'x', key: 'k' } as const;
  const failure = { kind: 'failure', id: 'y', key: 'k', error: 'boom' } as const;
  const stopped = { kind: 'stopped', id: 'z' } as const;
  assert.equal(notificationText(needs).title, 'Serra needs you');
  assert.equal(notificationText(failure).title, 'A job failed');
  assert.equal(notificationText(stopped).title, 'Serra stopped');
  assert.equal(notificationText(needs, undefined, 'Scout').title, 'Scout needs you');
  assert.equal(notificationText(failure, undefined, 'Scout').title, 'Scout: a job failed');
  assert.equal(notificationText(stopped, undefined, 'Scout').title, 'Scout stopped');
});

test('a burst within ten seconds becomes one notification per profile, and another profile is never held by it', () => {
  let clock = 0;
  const gate = burstGate({ now: () => clock });
  const needs = (key: string) => ({ kind: 'needs-owner', id: `n:${key}`, key } as const);
  assert.deepEqual(gate.offer('/p/a', needs('1')), needs('1'), 'the first shows at once');
  assert.equal(gate.offer('/p/a', needs('2')), null);
  assert.equal(gate.offer('/p/a', { kind: 'failure', id: 'f', key: '3', error: 'x' }), null);
  assert.deepEqual(gate.offer('/p/b', needs('9')), needs('9'), 'another profile shows at once');
  assert.equal(gate.dueAt('/p/a'), 10_000);
  assert.equal(gate.dueAt('/p/b'), null);
  clock = 10_000;
  const burst = gate.flush('/p/a');
  assert.deepEqual(burst, { kind: 'burst', id: 'burst:n:2,f', needsYou: 1, failed: 1, stopped: false });
  assert.deepEqual(notificationText(burst!, undefined, 'Scout'), { title: 'Scout', body: '1 needs you, 1 failed' });
  assert.equal(notificationTarget(burst!), '/jobs/needs-you');
  // A single held one shows as itself.
  assert.equal(gate.offer('/p/a', needs('4')), null, 'still within the window after the burst');
  clock = 20_000;
  assert.deepEqual(gate.flush('/p/a'), needs('4'));
  clock = 31_000;
  assert.deepEqual(gate.offer('/p/a', needs('5')), needs('5'), 'quiet again: shows at once');
  gate.forget('/p/a');
  assert.equal(gate.dueAt('/p/a'), null);
});

test('each profile has its own planner: one profile’s restart is never another’s stop', () => {
  const at = new Date('2026-11-28T09:00:00.000Z');
  const a = notificationPlanner({ now: () => at });
  const b = notificationPlanner({ now: () => at });
  a.status(up({ needsYou: 0, running: 0 }, true, 1));
  b.status(up({ needsYou: 0, running: 0 }, true, 2));
  a.expectStop();
  assert.equal(a.status(STOPPED), null, 'the app stopped A itself');
  assert.equal(b.status(STOPPED)?.kind, 'stopped', 'B stopping on its own is news');
});

// ---------------------------------------------------------------------------------------------------------------
// The window: the switcher's live phrases and the quiet line in Jobs
// ---------------------------------------------------------------------------------------------------------------

const entry = (dir: string, name: string, active: boolean, status: BotStatus | null = null) => ({
  ref: `local/${name.toLowerCase()}`, dir, name, color: '#4b6a8a', active, setupDone: true, status, agent: 'T3',
});

test('live statuses from main update the other profiles only, and an unchanged push keeps the same view', () => {
  const view = { profiles: [entry('/p/saitama', 'Saitama', true), entry('/p/scout', 'Scout', false), entry('/p/ops', 'Ops', false)], pinned: false, palette: [] };
  const next = withPresence(view, { '/p/saitama': up({ needsYou: 5, running: 0 }), '/p/scout': up({ needsYou: 1, running: 0 }) })!;
  assert.equal(next.profiles[0]!.status, null, 'the profile in use is followed by the window itself');
  assert.deepEqual(next.profiles[1]!.status, up({ needsYou: 1, running: 0 }));
  assert.equal(next.profiles[2], view.profiles[2], 'a profile the push doesn’t name keeps what it had');
  assert.equal(withPresence(next, { '/p/scout': up({ needsYou: 1, running: 0 }) }), next);
  assert.equal(withPresence(null, {}), null);
});

test('the quiet line in Jobs lists other profiles that need you, at most three, then how many more', () => {
  const others = ['Scout', 'Ops', 'Nova', 'Rex', 'Tia'].map((name, index) => entry(`/p/${index}`, name, false, up({ needsYou: index === 1 ? 0 : 1, running: 0 })));
  const view = { profiles: [entry('/p/s', 'Saitama', true), ...others], pinned: false, palette: [] };
  const live = up({ needsYou: 3, running: 0 });
  const { shown, more } = othersNeedingYou(profileRows(view, live));
  assert.deepEqual(shown.map((row) => [row.name, row.presence.phrase, row.shortcut]), [['Scout', '1 needs you', '⌘2'], ['Nova', '1 needs you', '⌘4'], ['Rex', '1 needs you', '⌘5']]);
  assert.equal(more, 1);
  assert.ok(!shown.some((row) => row.active), 'the profile in use is never in its own line');
  assert.deepEqual(othersNeedingYou(profileRows({ ...view, profiles: [view.profiles[0]!] }, live)), { shown: [], more: 0 });
});

// ---------------------------------------------------------------------------------------------------------------
// Main: the list follows every profile; bot updates look after each one, without mixing logs or pauses
// ---------------------------------------------------------------------------------------------------------------

const baseContext = (active: string | null, extra: Partial<AppContext> = {}): AppContext => {
  const prefs = memoryPrefs({ ...defaultPrefs, profileDir: active });
  return {
    profileDir: () => { const dir = prefs.get().profileDir; if (!dir) throw new Error('No bot profile selected.'); return dir; },
    profileDirOrNull: () => prefs.get().profileDir,
    prefs,
    status: stoppedStatusSource(),
    runtime: { version: '0.1.0-alpha.10', electron: '45.4.1', node: '24.22.3', platform: 'darwin' },
    openExternal: async () => {},
    openPath: async () => {},
    ...extra,
  };
};

const newProfile = (root: string, id: string, project = '/Users/you/project'): string => {
  const dir = join(root, id);
  createProfile(dir, {
    version: 1, bot: { id, name: id[0]!.toUpperCase() + id.slice(1) }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  return dir;
};

test('listing profiles follows each one live and shows their reports, without probing or writing', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'serra-live-list-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saitama = newProfile(root, 'saitama');
  const scout = newProfile(root, 'scout');
  const sockets = fakeSockets();
  const map = presenceMap(sockets.subscribe);
  const context = baseContext(saitama, { presence: map });
  const handlers = profilesHandlers(engineContext(context), { root, launchAgentsDir: join(root, 'agents'), probeMs: 1 });
  const first = await handlers.list();
  assert.deepEqual(map.profiles().map((followed) => followed.name), ['Saitama', 'Scout'], 'both are followed, the one in use too');
  assert.equal(first.profiles[1]!.status, null, 'Scout is checking until its daemon answers');
  sockets.report(scout, up({ needsYou: 1, running: 0 }));
  sockets.report(saitama, up({ needsYou: 0, running: 4 }));
  const second = await handlers.list();
  assert.deepEqual(second.profiles[1]!.status, up({ needsYou: 1, running: 0 }));
  assert.equal(second.profiles[0]!.status, null, 'the profile in use is followed by the window');
  assert.equal(existsSync(join(root, 'profiles.json')), false, 'listing writes nothing');

  rmSync(scout, { recursive: true });
  await handlers.list();
  assert.ok(sockets.closed.includes(scout), 'a profile gone from disk is no longer followed');
  map.close();
});

test('pinned to one profile with --profile, only that bot is followed', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'serra-live-pinned-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saitama = newProfile(root, 'saitama');
  newProfile(root, 'scout');
  const sockets = fakeSockets();
  const map = presenceMap(sockets.subscribe);
  t.after(() => map.close());
  await profilesHandlers(engineContext(baseContext(saitama, { presence: map, profilePinned: true })), { root, launchAgentsDir: join(root, 'agents') }).list();
  assert.deepEqual(map.profiles().map((followed) => followed.dir), [saitama]);
  assert.deepEqual(sockets.connects, [saitama]);
});

/** A profile whose bot runs a build from the previous app version, as tests/app-updates.test.ts sets it up. */
const botOnOldVersion = async (t: TestContext, root: string, id: string) => {
  const project = join(root, `${id}-project`);
  mkdirSync(project);
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'git@github.com:acme/project.git']);
  const dir = newProfile(root, id, project);
  writeFileSync(join(dir, '.env'), 'SLACK_APP_TOKEN=xapp-fixture\nSLACK_BOT_TOKEN=xoxb-fixture\n', { mode: 0o600 });
  const agents = join(root, `${id}-agents`);
  mkdirSync(agents);
  const events: string[] = [];
  let installed = false;
  const driver: ServiceDriver = {
    loaded: async () => installed,
    stop: async () => { events.push('stop'); },
    start: async () => { events.push('start'); },
    ready: async () => { events.push('ready'); },
  };
  const deps = {
    findNode: async () => '/opt/homebrew/bin/node',
    prepare: { install: false },
    deploy: { driver, launchAgentsDir: agents, preflight: async (): Promise<void> => {} },
    echo: () => {},
  };
  // Prepared and activated on its own, as an earlier app version left it.
  const { handlers } = updatesService(engineContext(baseContext(dir, { runtime: { version: '0.1.0-alpha.9', electron: '45.4.1', node: '24.22.3', platform: 'darwin' } })), deps);
  const old = await handlers.prepare();
  mkdirSync(join(old.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ ...old, appVersion: '0.1.0-alpha.9', fromApp: true }));
  const activated = await handlers.activate();
  assert.deepEqual(activated.ok ? null : activated, null);
  installed = true;
  // The new app's build is prepared already (a test can't install dependencies), so the update only switches to it.
  const fresh = await handlers.prepare();
  mkdirSync(join(fresh.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ ...fresh, appVersion: '0.1.0-alpha.10', fromApp: true }));
  events.length = 0;
  void t;
  return { dir, deps, events };
};

test('the bot update looks after a profile in the background too, and its log stays with that profile', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'serra-live-sync-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const front = await botOnOldVersion(t, root, 'atlas');
  const back = await botOnOldVersion(t, root, 'vega');
  const pushed: string[] = [];
  const expected: string[] = [];
  const context = baseContext(front.dir, {
    botFollowsApp: true,
    profileDirs: () => [front.dir, back.dir],
    expectStop: (dir) => { expected.push(dir ?? 'active'); },
    push: <P extends keyof SerraPushes>(channel: P, payload: SerraPushes[P]) => { if (channel === 'releaseLog') pushed.push(String(payload)); },
  });
  // Both profiles share one launchd fake here only through their own folders; each driver records its own bot.
  const { handlers, tick } = updatesService(engineContext(context), { ...back.deps, echo: (line) => { if (process.env.DEBUG_LIVE) console.log(line); }, deploy: { ...back.deps.deploy, driver: {
    loaded: async () => true,
    stop: async (label) => { (label.endsWith('atlas') ? front : back).events.push('stop'); },
    start: async (plist) => { (plist.includes('atlas') ? front : back).events.push('start'); },
    ready: async (dir) => { (dir.includes('atlas') ? front : back).events.push('ready'); },
  } } });
  await tick();
  const releaseVersion = (dir: string): unknown => (JSON.parse(readFileSync(join(dir, 'active.json'), 'utf8')) as { appVersion?: unknown }).appVersion;
  assert.equal(releaseVersion(front.dir), '0.1.0-alpha.10', 'the profile in use follows the app');
  assert.equal(releaseVersion(back.dir), '0.1.0-alpha.10', 'so does the one in the background');
  assert.ok(back.events.includes('start'), 'the background bot restarted on the new build');
  assert.deepEqual(expected, [front.dir, back.dir], 'each restart is expected for its own profile');
  assert.equal(readPause(front.dir), null);
  assert.equal(readPause(back.dir), null, 'no pause is left behind in either');

  // The window shows only its profile's log.
  const shown = (await handlers.status()).log;
  assert.ok(shown.length > 0);
  assert.ok(pushed.every((line) => !line.includes(back.dir)), 'the background profile’s lines are never streamed to the window');
  assert.deepEqual(pushed, shown, 'what streamed is the profile in use’s own log');
  context.prefs.set({ ...context.prefs.get(), profileDir: back.dir });
  const theirs = (await handlers.status()).log;
  assert.ok(theirs.length > 0, 'switching shows the background profile’s own log');
  assert.notDeepEqual(theirs, shown);
});

test('installing an app update holds new requests in every profile that follows the app, and lifts them if it doesn’t install', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'serra-live-install-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = newProfile(root, 'saitama');
  const b = newProfile(root, 'scout');
  const c = newProfile(root, 'nova');
  for (const dir of [a, b]) writeFileSync(join(dir, 'active.json'), JSON.stringify({ release: join(dir, 'releases/x'), label: 'dev.serra.x' }));
  let state: 'installing' | 'idle' = 'installing';
  const appUpdater = { view: () => ({ state }), install: () => ({ state }) } as unknown as AppUpdater;
  const context = baseContext(a, { botFollowsApp: true, appUpdater, profileDirs: () => [a, b, c] });
  const { handlers } = updatesService(engineContext(context), { echo: () => {} });
  await handlers.install();
  assert.equal(readPause(a)?.reason, 'app-update');
  assert.equal(readPause(b)?.reason, 'app-update', 'the background bot holds requests too');
  assert.equal(readPause(c), null, 'a profile with no bot installed is left alone');

  for (const dir of [a, b]) rmSync(join(dir, 'intake-paused.json'), { force: true });
  state = 'idle';
  await handlers.install();
  assert.equal(readPause(a), null, 'not installing after all: the pauses are lifted');
  assert.equal(readPause(b), null);
});
