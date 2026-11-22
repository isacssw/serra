// The Electron main process: one window, the menubar item, the typed bridge, app prefs and the daemon's status
// forwarded to both. The daemon itself keeps running under launchd and survives the window and the app closing.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, Notification, shell } from 'electron';
import { defaultProfileRoot, profileArgument } from '../../src/config.ts';
import { pushChannel } from './bridge.ts';
import { createHandlers, registerHandlers } from './ipc/index.ts';
import type { HandlerContext } from './ipc/context.ts';
import { electronPrefs } from './prefs-store.ts';
import { followTheme } from './native-theme.ts';
import { profilesUnder, profileToRemember, startupProfile } from './profile-location.ts';
import { forwardStatus, socketStatusSource } from './status.ts';
import { createTray, type SerraTray } from './tray.ts';
import { createMainWindow } from './window.ts';
import { expectStopsFrom, jobFrom, startNotifications, type SerraNotifications } from './notifications.ts';
import { targetScreen } from './notifications.logic.ts';
import { isAppUrl } from './window-options.ts';
import { runSmokeChecks } from './smoke.ts';
import { followProposals, type ProposalsFollower } from './proposals-watch.ts';
import { toolPath } from './tool-path.ts';
import { stopAll as stopToolChecks } from '../../src/exec.ts';
import { releasesUrl } from '../../src/app-updates.ts';
import { createAppUpdater, type AppUpdater } from './app-updater.ts';
import { menuTemplate } from './menu.ts';
import { SetupIncomplete } from '../../src/setup-incomplete.ts';

// The build rewrites `import.meta.url` to this source file, so this is `app/` in the checkout (see app/build.ts).
const appDir = fileURLToPath(new URL('..', import.meta.url));
const preload = join(appDir, 'out/preload.cjs');
/** APP-10's Vite dev server, when running the renderer in dev mode. */
const devUrl = process.env.SERRA_RENDERER_URL || undefined;
const isAppPage = (url: string): boolean => isAppUrl(url, { fileRoot: appDir, devUrl });

/** The renderer's page: the dev server, the built renderer (APP-10), or a placeholder until it exists. */
const pageUrl = (): string => {
  if (devUrl) return devUrl;
  const built = join(appDir, 'out/renderer/index.html');
  return pathToFileURL(existsSync(built) ? built : join(appDir, 'main/placeholder.html')).href;
};

// Opened from Finder, the packaged app has launchd's short PATH; add where Homebrew installs `op` and friends.
if (app.isPackaged) process.env.PATH = toolPath(process.env.PATH, homedir());

// `--smoke` checks the window's isolation and the bridge, then quits. It uses throwaway prefs.
const smoke = process.argv.includes('--smoke');
const smokeUserData = smoke ? mkdtempSync(join(tmpdir(), 'serra-app-smoke-')) : null;
if (smokeUserData) app.setPath('userData', smokeUserData);

/** The menubar item. While it exists, closing the window leaves the app (and the daemon) running. */
let tray: SerraTray | null = null;
/** macOS notifications (APP-24). */
let notifications: SerraNotifications | null = null;
/** Watches the profile's `knowledge/proposals/` and tells the window (APP-26). */
let proposals: ProposalsFollower | null = null;

const start = async (): Promise<void> => {
  // The saved theme applies to native parts before any window opens, and follows every save (APP-28).
  const stored = followTheme(electronPrefs(), nativeTheme);
  // `electron . --profile x` has the app folder at argv[1]; the packaged app (APP-17) starts its arguments there.
  const argument = profileArgument(process.argv.slice(app.isPackaged ? 1 : 2)) || undefined;
  if (!smoke) {
    // Opened from Finder there is no argument: remember the profile so later launches find it (docs/app/install.md).
    const saved = stored.get().profileDir;
    const discovered = argument || saved ? [] : profilesUnder(defaultProfileRoot);
    const remember = profileToRemember(startupProfile({ argument, saved, discovered }), saved);
    if (remember) stored.set({ ...stored.get(), profileDir: remember });
  }
  const profileDirOrNull = (): string | null => argument ?? stored.get().profileDir;
  // Live status from the profile's status.sock; it follows the profile when Settings picks another one.
  const status = socketStatusSource(profileDirOrNull());
  const prefs: typeof stored = {
    get: () => stored.get(),
    set: (next) => {
      const before = profileDirOrNull();
      stored.set(next);
      // Switching profiles reports `stopped`; that isn't the daemon stopping.
      if (profileDirOrNull() !== before) notifications?.reset();
      status.follow(profileDirOrNull());
      proposals?.follow(profileDirOrNull());
      tray?.refresh();
    },
  };
  const push: NonNullable<HandlerContext['push']> = (channel, payload) => {
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send(pushChannel(channel), payload);
    }
  };
  /** The running Serra.app: `.../Serra.app/Contents/MacOS/Serra`, three folders up. */
  const bundlePath = app.isPackaged ? join(app.getPath('exe'), '../../..') : null;
  // SERRA_UPDATES_FEED (QA's fake feed) turns updates on in a copy run from source; installing then opens the disk image.
  // In a packaged app only a feed on this Mac is accepted, so an environment variable can't point updates elsewhere.
  const loopback = (value: string): boolean => {
    try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return false; }
  };
  const feed = process.env.SERRA_UPDATES_FEED && (!app.isPackaged || loopback(process.env.SERRA_UPDATES_FEED))
    ? process.env.SERRA_UPDATES_FEED : undefined;
  const appUpdater: AppUpdater = createAppUpdater({
    current: app.getVersion(),
    arch: process.arch,
    unavailable: smoke ? 'Updates are off in the smoke test.' : app.isPackaged || feed ? null : 'This copy runs from source. Pull the repository to update it.',
    dir: join(app.getPath('userData'), 'updates'),
    // Electron's net follows the system's proxy settings. Files it writes carry no quarantine flag.
    fetch: (url, init) => net.fetch(url, init),
    feedUrl: releasesUrl({ SERRA_UPDATES_FEED: feed }),
    relaunchArgs: process.argv.slice(1),
    bundlePath,
    getChoice: () => stored.get().includePrereleases,
    setChoice: (choice) => stored.set({ ...stored.get(), includePrereleases: choice }),
    quit: () => app.quit(),
    openPath: async (path) => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    push: (view) => push('appUpdate', view),
    log: (line) => console.log(`[serra] app update: ${line}`),
  });
  const timers: NodeJS.Timeout[] = [];
  const every = (firstMs: number, everyMs: number, task: () => void): void => {
    if (smoke) return;
    timers.push(setTimeout(() => { task(); timers.push(setInterval(task, everyMs)); }, firstMs));
  };
  // Look for a new release 15 seconds after launch, then every 6 hours. Nothing downloads without a click.
  every(15_000, 6 * 60 * 60_000, () => { void appUpdater.check(); });
  const quitGuards: (() => Promise<unknown> | null)[] = [];
  const context: HandlerContext = {
    appUpdater,
    botFollowsApp: app.isPackaged,
    guardQuit: (pending) => { quitGuards.push(pending); },
    every,
    expectStop: () => notifications?.expectStop(),
    profileDirOrNull,
    profileDir: () => {
      const directory = profileDirOrNull();
      // The window shows its setup state for this, never the message.
      if (!directory) throw new SetupIncomplete();
      return directory;
    },
    profilePinned: argument !== undefined,
    chooseFolder: async ({ title, buttonLabel, defaultPath }) => {
      const options = { title, buttonLabel, properties: ['openDirectory' as const, 'createDirectory' as const], ...(defaultPath && existsSync(defaultPath) ? { defaultPath } : {}) };
      const owner = BrowserWindow.getFocusedWindow();
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    prefs,
    status,
    runtime: { version: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node, platform: process.platform },
    openExternal: (url) => shell.openExternal(url),
    openPath: async (path) => {
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
    push,
  };
  proposals = followProposals(() => context.push?.('proposals', null));
  proposals.follow(profileDirOrNull());
  const handlers = createHandlers(context);
  // Stops the app causes itself don't notify; wrapped before registering so the window and menubar share it.
  expectStopsFrom(handlers, () => notifications?.expectStop());
  registerHandlers(ipcMain, handlers, isAppPage);

  let window: BrowserWindow | null = null;
  let resendStatus = (): void => {};
  const open = async (): Promise<BrowserWindow> => {
    const created = createMainWindow({ preload, prefs, isAppUrl: isAppPage });
    window = created;
    const forwarder = forwardStatus(status, {
      isDestroyed: () => created.isDestroyed() || created.webContents.isDestroyed(),
      send: (channel, payload) => created.webContents.send(pushChannel(channel), payload),
    });
    // A (re)load drops what the page was sent, so send the current status again once it is ready.
    created.webContents.on('did-finish-load', () => forwarder.resend());
    created.on('closed', () => { forwarder.stop(); if (window === created) window = null; });
    resendStatus = () => forwarder.resend();
    await created.loadURL(pageUrl());
    return created;
  };

  const show = (): void => {
    if (!window) { void open(); return; }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  /** Shows the window on a route (clicking a notification). A window opened fresh starts on that screen. */
  const showAt = async (target: string): Promise<void> => {
    if (!window) {
      prefs.set({ ...prefs.get(), lastScreen: targetScreen(target) });
      await open();
    } else show();
    app.focus({ steal: true });
    context.push?.('navigate', target);
  };
  app.on('second-instance', show);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(() => {
    void showAt('/setup').catch((error: unknown) => console.error('[serra] could not open setup:', error));
  })));
  // A bot switch stops the old bot before starting the new one: quitting halfway would leave none running.
  let waitingToQuit = false;
  app.on('before-quit', (event) => {
    const pending = quitGuards.map((guard) => guard()).filter((p): p is Promise<unknown> => p !== null);
    if (!pending.length) return;
    event.preventDefault();
    console.log('[serra] waiting for the bot switch to finish before quitting');
    // Without a word, Quit would look ignored for the few seconds the switch takes.
    if (!waitingToQuit && Notification.isSupported()) new Notification({ title: 'Serra', body: 'Finishing the bot restart, then quitting.' }).show();
    waitingToQuit = true;
    void Promise.allSettled(pending).then(() => app.quit());
  });
  app.on('will-quit', () => {
    for (const timer of timers) clearTimeout(timer);
    stopToolChecks();
    notifications?.stop(); notifications = null; tray?.destroy(); tray = null; proposals?.close(); proposals = null; status.close();
  });
  try {
    tray = createTray({
      iconsDir: join(appDir, '../assets/brand'),
      status,
      profileSelected: () => profileDirOrNull() !== null,
      restart: async () => { await handlers.bot.restart(); },
      openWindow: () => { show(); app.focus({ steal: true }); },
    });
  } catch (error) {
    // The window still works without the menubar item; `--smoke` fails on it.
    if (smoke) throw error;
    console.error('[serra] could not create the menubar item:', error);
  }
  try {
    notifications = startNotifications({
      status,
      describe: jobFrom(handlers),
      open: (target) => { void showAt(target).catch((error: unknown) => console.error('[serra] could not open the window:', error)); },
    });
  } catch (error) {
    if (smoke) throw error;
    console.error('[serra] could not start notifications:', error);
  }
  // macOS keeps the app open with no window; clicking the Dock icon brings one back.
  app.on('activate', () => { if (!window) void open(); });
  const first = await open();
  if (smokeUserData) {
    const ok = await runSmokeChecks(first, () => resendStatus());
    // `app.exit` skips `will-quit`, so clean up here.
    notifications?.stop();
    tray?.destroy();
    proposals?.close();
    status.close();
    rmSync(smokeUserData, { recursive: true, force: true });
    app.exit(ok ? 0 : 1);
  }
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // The menubar item keeps the app running with no window, so the owner can still see and restart the bot.
  app.on('window-all-closed', () => { if (smoke || (process.platform !== 'darwin' && !tray)) app.quit(); });
  // Don't `await app.whenReady()` at top level: Electron emits `ready` only after the ESM entry finishes evaluating.
  app.whenReady().then(start).catch((error: unknown) => { console.error('[serra] failed to start:', error); app.exit(1); });
}
