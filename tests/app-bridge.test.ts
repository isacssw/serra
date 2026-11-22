import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeMethods, createBridge, invokeChannel, pushChannel, pushChannels, type InvokeResult } from '../app/main/bridge.ts';
import { createHandlers, registerHandlers, type IpcRegistrar } from '../app/main/ipc/index.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { defaultPrefs, memoryPrefs, mergePrefs, readPrefs } from '../app/main/prefs.ts';
import { forwardStatus, stoppedStatusSource, type StatusSource } from '../app/main/status.ts';
import { allowsPermission, isAppUrl, isExternalUrl, windowOptions } from '../app/main/window-options.ts';
import type { BotEvent, BotStatus } from '../src/contracts.ts';

const APP_PAGE = 'file:///Users/you/serra/app/out/renderer/index.html';
const trusted = (url: string): boolean => isAppUrl(url, { fileRoot: '/Users/you/serra/app' });

const fakeContext = (overrides: Partial<HandlerContext> = {}): HandlerContext & { opened: string[] } => {
  const opened: string[] = [];
  return {
    opened,
    profileDirOrNull: () => '/Users/you/profile',
    profileDir: () => '/Users/you/profile',
    prefs: memoryPrefs(),
    status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
    openExternal: async (url) => { opened.push(url); },
    openPath: async (path) => { opened.push(path); },
    ...overrides,
  };
};

/** A fake ipcMain plus a window-side bridge talking to it, as the preload would. */
const wire = (context = fakeContext(), senderUrl = APP_PAGE) => {
  const handlers = new Map<string, Parameters<IpcRegistrar['handle']>[1]>();
  const logs: string[] = [];
  const channels = registerHandlers({ handle: (channel, listener) => { handlers.set(channel, listener); } }, createHandlers(context), trusted, (m) => logs.push(m));
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bridge = createBridge(
    async (channel, args): Promise<InvokeResult> => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      // Structured clone, like Electron's IPC: no functions or class instances cross.
      return structuredClone(await handler({ senderFrame: { url: senderUrl } }, ...structuredClone(args)));
    },
    (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set.add(listener));
      return () => { set.delete(listener); };
    },
  );
  const push = (channel: string, payload: unknown): void => { for (const listener of listeners.get(channel) ?? []) listener(payload); };
  return { bridge, channels, logs, push, context };
};

test('every bridge method has a handler, and no handler is outside the bridge', () => {
  const handlers = createHandlers(fakeContext());
  assert.deepEqual(Object.keys(handlers).sort(), Object.keys(bridgeMethods).sort());
  for (const [namespace, methods] of Object.entries(bridgeMethods)) {
    const set = handlers[namespace as keyof typeof handlers] as Record<string, unknown>;
    assert.deepEqual(Object.keys(set).sort(), [...methods].sort(), `${namespace} handlers`);
    for (const method of methods) assert.equal(typeof set[method], 'function', `${namespace}.${method}`);
  }
});

test('registerHandlers registers one unique channel per bridge method', () => {
  const { channels } = wire();
  const expected = Object.entries(bridgeMethods).flatMap(([namespace, methods]) => methods.map((method) => invokeChannel(namespace, method)));
  assert.deepEqual(channels, expected);
  assert.equal(new Set(channels).size, channels.length);
  assert.ok(channels.every((channel) => channel.startsWith('serra:')));
});

test('the bridge has every namespace and method as a function, plus the push subscriptions', () => {
  const { bridge } = wire();
  for (const [namespace, methods] of Object.entries(bridgeMethods)) {
    for (const method of methods) assert.equal(typeof (bridge as unknown as Record<string, Record<string, unknown>>)[namespace]?.[method], 'function');
  }
  assert.deepEqual(Object.keys(bridge.on).sort(), [...pushChannels].sort());
});

test('a handler error rejects in the window as a plain message', async () => {
  const { bridge } = wire();
  await assert.rejects(bridge.diagnostics.logTail(0), { message: 'Ask for 1 to 2000 log lines.' });
});

test('with the daemon stopped, bot.status is stopped', async () => {
  const { bridge } = wire();
  assert.deepEqual(await bridge.bot.status(), { state: 'stopped' });
});

test('calls from a frame outside the app are refused before any handler runs', async () => {
  const context = fakeContext();
  const { bridge, logs } = wire(context, 'https://example.com/');
  await assert.rejects(bridge.app.openExternal('https://example.com/x'), /may not use the Serra bridge/);
  assert.deepEqual(context.opened, []);
  assert.match(logs[0] ?? '', /refused serra:app\.openExternal from https:\/\/example\.com/);
});

test('app prefs round-trip and reject bad values without saving them', async () => {
  const { bridge, context } = wire();
  assert.deepEqual(await bridge.app.getPrefs(), defaultPrefs);
  const saved = await bridge.app.setPrefs({ theme: 'dark', lastScreen: '/jobs' });
  assert.equal(saved.theme, 'dark');
  assert.equal(context.prefs.get().lastScreen, '/jobs');
  await assert.rejects(bridge.app.setPrefs({ theme: 'neon' as 'dark' }), /theme must be one of/);
  await assert.rejects(bridge.app.setPrefs({ profileDir: 'relative/folder' }), /absolute/);
  await assert.rejects(bridge.app.setPrefs({ nodeIntegration: true } as never), /Unknown preference: nodeIntegration/);
  assert.equal(context.prefs.get().theme, 'dark');
});

test('openExternal only opens web links', async () => {
  const { bridge, context } = wire();
  await bridge.app.openExternal('https://github.com/acme/project/pull/1');
  for (const url of ['file:///etc/hosts', 'javascript:alert(1)', '/Applications/Calculator.app', 'not a url']) {
    await assert.rejects(bridge.app.openExternal(url), /Only http and https/);
  }
  assert.deepEqual(context.opened, ['https://github.com/acme/project/pull/1']);
});

test('app.info and openProfileFolder report a missing profile instead of crashing', async () => {
  const context = fakeContext({ profileDirOrNull: () => null, profileDir: () => { throw new Error('No bot profile selected.'); } });
  const { bridge } = wire(context);
  assert.equal((await bridge.app.info()).profileDir, null);
  await assert.rejects(bridge.app.openProfileFolder(), /No bot profile selected/);
});

test('push subscriptions deliver payloads and unsubscribe', () => {
  const { bridge, push } = wire();
  const seen: BotStatus[] = [];
  const off = bridge.on.status((status) => seen.push(status));
  push(pushChannel('status'), { state: 'stopped' });
  off();
  push(pushChannel('status'), { state: 'stopped' });
  assert.deepEqual(seen, [{ state: 'stopped' }]);
});

test('forwardStatus sends stopped to the window right away when there is no daemon', () => {
  const sent: [string, unknown][] = [];
  forwardStatus(stoppedStatusSource(), { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) });
  assert.deepEqual(sent, [['status', { state: 'stopped' }]]);
});

test('forwardStatus passes on status changes and events, and stops when asked', () => {
  let listener: Parameters<StatusSource['subscribe']>[0] | null = null;
  const source: StatusSource = { current: () => ({ state: 'stopped' }), subscribe: (l) => { listener = l; return () => { listener = null; }; } };
  const sent: [string, unknown][] = [];
  const forwarder = forwardStatus(source, { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) });
  const up: BotStatus = { state: 'up', pid: 42, startedAt: '2026-11-19T10:00:00Z', slackConnected: true, counts: { needsYou: 1, running: 0 } };
  const event: BotEvent = { at: '2026-11-19T10:01:00Z', event: 'needs_owner', key: 'C0123456789:1700000000.000100' };
  listener!.status(up);
  listener!.event(event);
  forwarder.resend();
  forwarder.stop();
  assert.equal(listener, null);
  assert.deepEqual(sent, [['status', { state: 'stopped' }], ['status', up], ['event', event], ['status', { state: 'stopped' }]]);
});

test('forwardStatus survives a failing source and a closed window', () => {
  const logs: string[] = [];
  const broken: StatusSource = { current: () => { throw new Error('socket exploded'); }, subscribe: () => { throw new Error('no socket'); } };
  const sent: unknown[] = [];
  const forwarder = forwardStatus(broken, { isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) }, (m) => logs.push(m));
  assert.deepEqual(sent, [{ state: 'stopped' }]);
  assert.equal(logs.length, 2);
  forwarder.stop();

  let destroyed = false;
  const closing = forwardStatus(stoppedStatusSource(), { isDestroyed: () => destroyed, send: () => { throw new Error('Object has been destroyed'); } }, (m) => logs.push(m));
  destroyed = true;
  closing.resend();
  assert.equal(logs.length, 3, 'one failed send logged, then nothing sent to the destroyed window');
});

test('on macOS the title bar is integrated: traffic lights inset in the sidebar; other systems keep their frame', () => {
  const mac = windowOptions('/p.cjs', defaultPrefs.window, 'darwin');
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 18 });
  const linux = windowOptions('/p.cjs', defaultPrefs.window, 'linux');
  assert.equal(linux.titleBarStyle, undefined);
  assert.equal(linux.trafficLightPosition, undefined);
  // The chrome change leaves the locked-down web preferences alone.
  assert.deepEqual(mac.webPreferences, linux.webPreferences);
});

test('isAppUrl allows only the app folder and the dev server; isExternalUrl only web links', () => {
  const root = { fileRoot: '/Users/you/serra/app', devUrl: 'http://localhost:5173' };
  assert.ok(isAppUrl(APP_PAGE, root));
  assert.ok(isAppUrl('http://localhost:5173/jobs', root));
  assert.ok(!isAppUrl('http://localhost:5174/', root));
  assert.ok(!isAppUrl('file:///Users/you/serra/application/x.html', root));
  assert.ok(!isAppUrl('file:///etc/hosts', root));
  assert.ok(!isAppUrl('https://example.com/', { fileRoot: '/Users/you/serra/app' }));
  assert.ok(!isAppUrl('', root));
  assert.ok(isExternalUrl('https://app.slack.com/client/T0123456789'));
  assert.ok(!isExternalUrl('file:///etc/hosts'));
});

test('the window may write to the clipboard (Copy report, Copy manifest) and nothing else', () => {
  // QA: every permission was refused, so navigator.clipboard.writeText failed with "Write permission denied".
  assert.ok(allowsPermission('clipboard-sanitized-write'));
  for (const permission of ['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal', 'fileSystem', '']) {
    assert.ok(!allowsPermission(permission), permission);
  }
});

test('readPrefs falls back per field; mergePrefs validates window bounds', () => {
  assert.deepEqual(readPrefs(undefined), defaultPrefs);
  assert.deepEqual(readPrefs({ theme: 'light', window: 'huge', extra: 1 }), { ...defaultPrefs, theme: 'light' });
  const moved = mergePrefs(defaultPrefs, { window: { width: 900, height: 600, x: 10, y: 20, maximized: true } });
  assert.deepEqual(moved.window, { width: 900, height: 600, x: 10, y: 20, maximized: true });
  assert.throws(() => mergePrefs(defaultPrefs, { window: { width: 10, height: 600, maximized: false } }), /at least/);
  assert.throws(() => mergePrefs(defaultPrefs, null), /must be an object/);
});
