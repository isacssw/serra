// QA driver helpers: launch the real Electron app with throwaway userData and profile, take screenshots.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The QA folder: profiles, fake binaries, screenshots. Short on purpose: the status socket path must fit in 104 bytes. */
export const QA = '/tmp/serra-qa';
export const REPO = fileURLToPath(new URL('../..', import.meta.url));
// playwright-core is not a dependency of the repo: install it anywhere (see README.md) and point here.
const require = createRequire(process.env.PLAYWRIGHT_CORE_FROM ?? join(QA, 'pw/package.json'));
const { _electron } = require('playwright-core');
export const SHOTS = process.env.QA_SHOTS ?? join(QA, 'shots');
mkdirSync(SHOTS, { recursive: true });
/**
 * The app's HOME: a scratch folder, so it never finds or opens a real profile under ~/.local/share/serra, real T3
 * settings or real app prefs. setup.sh links only ~/Library/Keychains into it, for the fake Keychain items in 03.
 */
export const HOME = join(QA, 'home');
if (!existsSync(join(HOME, 'Library/Keychains'))) throw new Error(`No scratch HOME at ${HOME}: run scripts/qa/setup.sh first.`);

export const launch = async ({ userData = join(QA, 'ud'), profile, env = {} } = {}) => {
  const exe = process.env.QA_EXE; const args = [...(exe ? [] : [REPO]), `--user-data-dir=${userData}`, ...(profile ? ['--profile', profile] : [])];
  const app = await _electron.launch({
    executablePath: exe ?? join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args, cwd: REPO,
    env: {
      ...process.env, HOME, BOT_PROFILE: '', T3CODE_HOME: join(HOME, '.t3'), PATH: `${QA}/bin:${process.env.PATH}`,
      // corepack's cache stays the real one (read only here), so 21 doesn't download pnpm again.
      COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'),
      ...env,
    },
    timeout: 60_000,
  });
  const logs = [];
  app.process().stdout?.on('data', (d) => logs.push(String(d)));
  app.process().stderr?.on('data', (d) => logs.push(String(d)));
  const page = await app.firstWindow();
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.waitForLoadState('domcontentloaded');
  return { app, page, logs };
};

export const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); return name; };

export const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(400); };

export const text = (page) => page.evaluate(() => document.querySelector('[data-serra-main]')?.innerText ?? document.body.innerText);

export const header = (page) => page.evaluate(() => document.querySelector('[data-status-tone]')?.textContent ?? null);

/** Fake daemon on the profile's status socket. */
export const fakeDaemon = async (profile) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('fake-daemon.ts', import.meta.url)), profile], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(); });
    child.on('exit', (c) => reject(new Error('fake daemon exited ' + c)));
  });
  return {
    send: (cmd) => child.stdin.write(JSON.stringify(cmd) + '\n'),
    quit: () => new Promise((r) => { child.on('exit', r); child.stdin.write('{"quit":true}\n'); }),
  };
};

/** Records tray menus and notifications in the main process (patched after launch). */
export const hookMain = (app) => app.evaluate(({ Tray, Notification }) => {
  globalThis.__qa = { menus: [], images: 0, tooltips: [], notes: [] };
  const setContextMenu = Tray.prototype.setContextMenu;
  Tray.prototype.setContextMenu = function (menu) { globalThis.__qa.menus.push(menu.items.map((i) => ({ label: i.label, enabled: i.enabled, type: i.type }))); globalThis.__qa.lastMenu = menu; return setContextMenu.call(this, menu); };
  const setToolTip = Tray.prototype.setToolTip;
  Tray.prototype.setToolTip = function (t) { globalThis.__qa.tooltips.push(t); return setToolTip.call(this, t); };
  const show = Notification.prototype.show;
  Notification.prototype.show = function () { globalThis.__qa.notes.push({ title: this.title, body: this.body }); globalThis.__qa.lastNote = this; return show.call(this); };
});
export const mainQa = (app) => app.evaluate(() => ({ menus: globalThis.__qa.menus, tooltips: globalThis.__qa.tooltips, notes: globalThis.__qa.notes }));
