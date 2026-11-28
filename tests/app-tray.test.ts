import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { botHandlers, type BotService } from '../src/handlers/bot.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { socketStatusSource, STOPPED, type StatusSubscriber } from '../src/status-source.ts';
import { trayController, trayView, type TrayView } from '../app/main/tray.logic.ts';
import type { BotEvent, BotStatus, StatusMessage } from '../src/contracts.ts';
import { startStatusServer, type UpStatus } from '../src/status-socket.ts';
import { engineContext, type AppContext } from './fakes/app-context.ts';

const up = (counts = { needsYou: 0, running: 0 }, slackConnected = true): BotStatus => (
  { state: 'up', pid: 4242, startedAt: '2026-11-19T09:00:00.000Z', slackConnected, counts }
);
const view = (status: BotStatus, extra: Partial<Parameters<typeof trayView>[0]> = {}): TrayView => (
  trayView({ status, profileSelected: true, restarting: false, restartError: null, ...extra })
);

test('the menubar maps each daemon status to its icon and labels', () => {
  const stopped = view(STOPPED);
  assert.equal(stopped.icon, 'down');
  assert.equal(stopped.headline, 'Serra is stopped');
  assert.deepEqual(stopped.details, [], 'no counts are guessed while the daemon is stopped');
  assert.deepEqual(stopped.restart, { label: 'Restart bot', enabled: true });

  const idle = view(up());
  assert.equal(idle.icon, 'up');
  assert.equal(idle.headline, 'Serra is up · Slack connected');
  assert.deepEqual(idle.details.map((detail) => detail.label), ['0 need you', '0 running']);

  const busy = view(up({ needsYou: 2, running: 1 }));
  assert.equal(busy.icon, 'needs-you');
  assert.deepEqual(busy.details.map((detail) => detail.label), ['2 need you', '1 running']);
  assert.equal(busy.tooltip, 'Serra is up · Slack connected · 2 need you · 1 running');
  assert.equal(view(up({ needsYou: 1, running: 0 })).details[0]?.label, '1 needs you');

  const disconnected = view(up({ needsYou: 3, running: 0 }, false));
  assert.equal(disconnected.icon, 'down', 'a disconnected Slack is down even with jobs waiting');
  assert.equal(disconnected.headline, 'Serra is up · Slack disconnected');
});

test('the menubar shows a missing profile, a restart in progress and the last failure', () => {
  const none = view(STOPPED, { profileSelected: false });
  assert.equal(none.headline, 'No bot profile selected');
  assert.equal(none.restart.enabled, false);

  assert.deepEqual(view(STOPPED, { restarting: true }).restart, { label: 'Restarting…', enabled: false });

  const failed = view(STOPPED, { restartError: `launchctl bootstrap exited 5:\n${'x'.repeat(200)}` });
  const error = failed.details.find((detail) => detail.kind === 'error');
  assert.ok(error);
  assert.ok(error.label.startsWith('Restart failed: launchctl bootstrap exited 5: x'));
  assert.ok(!error.label.includes('\n'));
  assert.ok(error.label.length < 120);
});

/** A status feed the test drives by hand. */
const feed = (initial: BotStatus = STOPPED) => {
  let current = initial;
  const listeners = new Set<{ status(status: BotStatus): void }>();
  return {
    current: () => current,
    subscribe: (listener: { status(status: BotStatus): void; event(event: unknown): void }) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push: (status: BotStatus) => { current = status; for (const listener of listeners) listener.status(status); },
    listeners,
  };
};

test('with the daemon stopped the icon is down and Restart starts it', async () => {
  const status = feed();
  const views: TrayView[] = [];
  let restarts = 0;
  const controller = trayController({
    status,
    profileSelected: () => true,
    restart: async () => { restarts += 1; status.push(up({ needsYou: 0, running: 1 })); },
    render: (next) => views.push(next),
  });
  assert.equal(views.at(-1)?.icon, 'down');
  await controller.restart();
  assert.equal(restarts, 1);
  assert.ok(views.some((next) => next.restart.label === 'Restarting…'), 'the menu shows the restart while it runs');
  assert.equal(views.at(-1)?.icon, 'up');
  assert.equal(views.at(-1)?.restart.label, 'Restart bot');
  controller.stop();
  assert.equal(status.listeners.size, 0);
});

test('a failed restart shows in the menu and a second click while restarting is ignored', async () => {
  const status = feed();
  const views: TrayView[] = [];
  let release: () => void = () => {};
  let calls = 0;
  const controller = trayController({
    status,
    profileSelected: () => true,
    restart: () => { calls += 1; return new Promise((_, reject) => { release = () => reject(new Error('Service dev.serra.test isn\'t installed.')); }); },
    render: (next) => views.push(next),
    log: () => {},
  });
  const first = controller.restart();
  await controller.restart();
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(views.at(-1)?.details.at(-1)?.label, 'Restart failed: Service dev.serra.test isn\'t installed.');
  assert.equal(views.at(-1)?.icon, 'down');
});

test('the status source follows the profile socket and drops a previous profile', () => {
  const opened: { profileDir: string; listener: (message: StatusMessage) => void; closed: boolean }[] = [];
  const subscribe: StatusSubscriber = (profileDir, listener) => {
    const entry = { profileDir, listener, closed: false };
    opened.push(entry);
    return { close: () => { entry.closed = true; } };
  };
  const source = socketStatusSource(null, subscribe);
  assert.deepEqual(source.current(), STOPPED);
  assert.equal(opened.length, 0, 'no profile, no socket');

  const statuses: BotStatus[] = [];
  const events: BotEvent[] = [];
  source.subscribe({ status: (status) => statuses.push(status), event: (event) => events.push(event) });

  source.follow('/Users/you/profile-a');
  const a = opened[0]!;
  a.listener({ type: 'status', status: up({ needsYou: 1, running: 0 }) });
  a.listener({ type: 'event', event: { at: '2026-11-19T09:01:00.000Z', event: 'needs_owner', key: 'C1:1' } });
  assert.equal(source.current().state, 'up');
  assert.equal(events.length, 1);

  source.follow('/Users/you/profile-a');
  assert.equal(opened.length, 1, 'following the same profile again keeps the socket');

  source.follow('/Users/you/profile-b');
  assert.equal(a.closed, true);
  assert.deepEqual(source.current(), STOPPED, 'the old profile\'s state does not linger');
  a.listener({ type: 'status', status: up() });
  assert.deepEqual(source.current(), STOPPED, 'late messages from the old socket are ignored');

  opened[1]!.listener({ type: 'status', status: up() });
  assert.deepEqual(statuses.map((status) => status.state), ['up', 'stopped', 'up']);

  source.close();
  assert.equal(opened[1]!.closed, true);
});

test('the status source reports the real daemon over status.sock, then stopped when it goes away', async (t) => {
  const profileDir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-tray-')));
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));
  const server = await startStatusServer({ profileDir, status: () => up({ needsYou: 2, running: 1 }) as UpStatus });
  const source = socketStatusSource(profileDir);
  t.after(() => source.close());
  const next = (state: BotStatus['state']): Promise<BotStatus> => new Promise((resolve) => {
    if (source.current().state === state) { resolve(source.current()); return; }
    const off = source.subscribe({ status: (status) => { if (status.state === state) { off(); resolve(status); } }, event: () => {} });
  });
  const live = await next('up');
  assert.deepEqual(live.state === 'up' && live.counts, { needsYou: 2, running: 1 });
  await server.close();
  assert.deepEqual(await next('stopped'), STOPPED);
});

const context = (overrides: Partial<AppContext> = {}): AppContext => ({
  profileDirOrNull: () => '/Users/you/profile',
  profileDir: () => '/Users/you/profile',
  prefs: memoryPrefs(),
  status: socketStatusSource(null),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
  ...overrides,
});

test('bot handlers call the service for the selected profile, one at a time', async () => {
  const calls: string[] = [];
  let release: () => void = () => {};
  const service: BotService = {
    start: async (dir) => { calls.push(`start ${dir}`); },
    stop: async (dir) => { calls.push(`stop ${dir}`); },
    restart: (dir) => { calls.push(`restart ${dir}`); return new Promise((resolve) => { release = resolve; }); },
  };
  const handlers = botHandlers(engineContext(context()), service);
  assert.deepEqual(await handlers.status(), STOPPED);
  const restarting = handlers.restart();
  await assert.rejects(Promise.resolve(handlers.stop()), /already starting, stopping or restarting/);
  release();
  await restarting;
  await handlers.start();
  assert.deepEqual(calls, ['restart /Users/you/profile', 'start /Users/you/profile']);
});

test('bot handlers refuse without a profile or off macOS, before touching the service', async () => {
  const service: BotService = { start: async () => assert.fail(), stop: async () => assert.fail(), restart: async () => assert.fail() };
  const noProfile = botHandlers(engineContext(context({ profileDir: () => { throw new Error('No bot profile selected.'); } })), service);
  await assert.rejects(Promise.resolve(noProfile.restart()), /No bot profile selected/);
  const linux = botHandlers(engineContext(context({ runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'linux' } })), service);
  await assert.rejects(Promise.resolve(linux.restart()), /macOS only/);
});
