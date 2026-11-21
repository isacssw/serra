// App updates from GitHub Releases (SERRA-46): check, download, verify, then replace Serra.app and relaunch, or open
// the installer when the app can't replace itself. Free of Electron imports: `index.ts` passes in `net.fetch`, the
// app's paths and `app.quit`, and tests pass fakes. The release logic itself is in `src/app-updates.ts`.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  download, downloadText, fetchReleases, includePrereleases, pickUpdate, verifyChecksum,
  type AppRelease, type Fetch,
} from '../../src/app-updates.ts';
import { run } from '../../src/t3.ts';

/** How a downloaded update gets installed: Serra swaps itself, or the owner drags it from the opened disk image. */
export type InstallPlan = { kind: 'replace' } | { kind: 'installer'; reason: string };

export type AppUpdatePhase =
  /** Updates can't run here (a copy run from source). */
  | { state: 'unavailable'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; checkedAt: string }
  | { state: 'available'; release: AppRelease; checkedAt: string }
  /** A newer release has no build for this Mac. */
  | { state: 'no-build'; version: string; url: string; checkedAt: string }
  | { state: 'downloading'; release: AppRelease; received: number; total: number | null }
  | { state: 'verifying'; release: AppRelease }
  | { state: 'ready'; release: AppRelease; install: InstallPlan }
  | { state: 'installing'; release: AppRelease }
  | { state: 'error'; stage: 'check' | 'download' | 'verify' | 'install'; message: string; release?: AppRelease };

/** What the Updates screen shows about the app. */
export type AppUpdateView = AppUpdatePhase & {
  /** The installed version, `app.getVersion()`. */
  current: string;
  /** Whether prereleases are offered now, and the owner's choice (null: the default, on while on a prerelease). */
  prereleases: { on: boolean; choice: boolean | null };
  /** Set on the first launch after an update: the version it came from. */
  updatedFrom: string | null;
};

export interface AppUpdaterDeps {
  current: string;
  arch: string;
  /** Null when updates work here; otherwise why not, shown on the screen. */
  unavailable: string | null;
  /** Where downloads, the staged app and the install marker live (`<userData>/updates`). */
  dir: string;
  fetch: Fetch;
  feedUrl: string;
  /** The running `Serra.app`, or null when not packaged. */
  bundlePath: string | null;
  getChoice: () => boolean | null;
  setChoice: (choice: boolean | null) => void;
  /** Checks the downloaded disk image and copies its app out. Returns the staged app's path. */
  stage?: (dmg: string, expected: { version: string; bundleId: string }, into: string) => Promise<string>;
  /** Decides whether the app at `bundlePath` can replace itself. */
  plan?: (bundlePath: string | null) => InstallPlan;
  /** Starts the detached script that swaps the app once this process exits, then relaunches it. */
  launchSwap?: (script: string, args: string[]) => void;
  quit: () => void;
  openPath: (path: string) => Promise<void>;
  push?: (view: AppUpdateView) => void;
  log?: (line: string) => void;
}

/** The bundle identifier the update must carry (electron-builder.yml `appId`). */
export const BUNDLE_ID = 'dev.serra.app';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Whether the running app can swap itself: it must be a real `.app` outside a disk image or App Translocation,
 * in a folder this user can write. Otherwise the owner installs from the opened disk image.
 */
export const installPlan = (bundlePath: string | null, writable: (path: string) => boolean = canWrite): InstallPlan => {
  if (!bundlePath || !bundlePath.endsWith('.app')) return { kind: 'installer', reason: "This copy of Serra doesn't run from an app bundle." };
  if (bundlePath.startsWith('/Volumes/')) return { kind: 'installer', reason: 'Serra is running from its disk image. Drag it to Applications first.' };
  if (bundlePath.includes('/AppTranslocation/')) return { kind: 'installer', reason: 'macOS is running Serra from a temporary location. Move it to Applications and open it from there.' };
  if (!writable(dirname(bundlePath)) || !writable(bundlePath)) return { kind: 'installer', reason: `Serra can't replace itself in ${dirname(bundlePath)} without an administrator.` };
  return { kind: 'replace' };
};

const canWrite = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
};

/** Mounts the disk image read-only, checks the app inside (bundle ID, version, intact signature) and copies it out. */
export const stageFromDmg = async (dmg: string, expected: { version: string; bundleId: string }, into: string): Promise<string> => {
  const mount = mkdtempSync(join(dirname(into), 'mount-'));
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg], { timeoutMs: 120_000 });
  try {
    const app = readdirSync(mount).find((name) => name.endsWith('.app'));
    if (!app) throw new Error('The disk image has no app in it.');
    const plist = join(mount, app, 'Contents/Info.plist');
    const read = async (key: string): Promise<string> => (await run('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, plist])).trim();
    const [bundleId, version] = [await read('CFBundleIdentifier'), await read('CFBundleShortVersionString')];
    if (bundleId !== expected.bundleId) throw new Error(`The disk image holds ${bundleId}, not Serra.`);
    if (version !== expected.version) throw new Error(`The disk image holds version ${version}, not ${expected.version}.`);
    // Ad hoc signed for now: this proves the bundle is intact, not who built it.
    await run('codesign', ['--verify', '--deep', '--strict', join(mount, app)], { timeoutMs: 120_000 });
    rmSync(into, { recursive: true, force: true });
    await run('ditto', [join(mount, app), into], { timeoutMs: 300_000 });
    return into;
  } finally {
    await run('hdiutil', ['detach', mount, '-quiet'], { timeoutMs: 60_000 }).catch(() => run('hdiutil', ['detach', mount, '-force', '-quiet']).catch(() => {}));
    rmSync(mount, { recursive: true, force: true });
  }
};

/**
 * The swap, run by bash after Serra quits: wait for the old process to exit, move the old app aside, move the new one
 * in, open it. When the move fails the old app goes back and opens again. The old copy is kept as
 * `Serra.app.previous` until the new one starts (see `pending.json`).
 */
export const SWAP_SCRIPT = `#!/bin/bash
set -u
pid="$1"; target="$2"; staged="$3"; log="$4"
exec >>"$log" 2>&1
echo "$(date) swap: waiting for $pid"
for _ in $(seq 1 600); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then echo "Serra is still running; not replacing it"; exit 1; fi
previous="$target.previous"
rm -rf "$previous"
if ! mv "$target" "$previous"; then echo "couldn't move the old app aside"; open "$target"; exit 1; fi
if ! mv "$staged" "$target"; then echo "couldn't move the new app in; restoring the old one"; mv "$previous" "$target"; open "$target"; exit 1; fi
echo "$(date) swap: done, opening $target"
open "$target"
`;

interface Pending { from: string; to: string; target: string }

/** The app's updater. One check, download or install at a time; every change is pushed to the window. */
export const createAppUpdater = (deps: AppUpdaterDeps) => {
  const log = deps.log ?? (() => {});
  const stage = deps.stage ?? stageFromDmg;
  const plan = deps.plan ?? ((path: string | null) => installPlan(path));
  const launchSwap = deps.launchSwap ?? ((script: string, args: string[]) => {
    spawn('/bin/bash', [script, ...args], { detached: true, stdio: 'ignore' }).unref();
  });
  const pendingPath = join(deps.dir, 'pending.json');
  let phase: AppUpdatePhase = deps.unavailable ? { state: 'unavailable', reason: deps.unavailable } : { state: 'idle' };
  let updatedFrom: string | null = null;
  let controller: AbortController | null = null;

  // The first launch after a swap: the new version started, so the old copy can go. Same version: it didn't apply.
  if (existsSync(pendingPath)) {
    try {
      const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as Pending;
      if (pending.to === deps.current) {
        updatedFrom = pending.from;
        rmSync(`${pending.target}.previous`, { recursive: true, force: true });
        log(`updated from ${pending.from} to ${pending.to}`);
      } else if (!deps.unavailable) {
        phase = { state: 'error', stage: 'install', message: `The update to ${pending.to} didn't finish, so Serra is still on ${deps.current}. Check again to retry.` };
      }
    } catch { /* a broken marker is dropped */ }
    rmSync(pendingPath, { force: true });
  }
  // Nothing is downloaded or staged at launch: earlier downloads and staged apps are left over, so they go.
  if (existsSync(deps.dir)) {
    for (const entry of readdirSync(deps.dir, { withFileTypes: true })) if (entry.isDirectory()) rmSync(join(deps.dir, entry.name), { recursive: true, force: true });
  }

  const view = (): AppUpdateView => {
    const choice = deps.getChoice();
    return { ...phase, current: deps.current, prereleases: { on: includePrereleases(choice, deps.current), choice }, updatedFrom };
  };
  const set = (next: AppUpdatePhase): void => { phase = next; deps.push?.(view()); };
  const busy = (): boolean => ['checking', 'downloading', 'verifying', 'installing'].includes(phase.state);
  const now = (): string => new Date().toISOString();

  const check = async (): Promise<AppUpdateView> => {
    if (phase.state === 'unavailable' || busy()) return view();
    // A verified download stays ready; checking again would only hide it.
    if (phase.state === 'ready') return view();
    set({ state: 'checking' });
    try {
      const releases = await fetchReleases(deps.fetch, deps.feedUrl);
      const result = pickUpdate(releases, { current: deps.current, arch: deps.arch, prereleases: includePrereleases(deps.getChoice(), deps.current) });
      const checkedAt = now();
      if (result.kind === 'available') set({ state: 'available', release: result.release, checkedAt });
      else if (result.kind === 'no-build') set({ state: 'no-build', version: result.version, url: result.url, checkedAt });
      else set({ state: 'up-to-date', checkedAt });
    } catch (error) {
      set({ state: 'error', stage: 'check', message: message(error) });
    }
    return view();
  };

  const startDownload = async (): Promise<AppUpdateView> => {
    if (phase.state !== 'available' && !(phase.state === 'error' && phase.release && phase.stage !== 'install')) return view();
    const release = phase.release!;
    const folder = join(deps.dir, release.version);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const dmg = join(folder, release.dmg.name);
    controller = new AbortController();
    set({ state: 'downloading', release, received: 0, total: release.dmg.size || null });
    try {
      const sums = await downloadText(deps.fetch, release.sums.url);
      await download(deps.fetch, release.dmg.url, dmg, {
        signal: controller.signal,
        progress: ({ received, total }) => set({ state: 'downloading', release, received, total: total ?? (release.dmg.size || null) }),
      });
      set({ state: 'verifying', release });
      try {
        await verifyChecksum(dmg, release.dmg.name, sums);
        await stage(dmg, { version: release.version, bundleId: BUNDLE_ID }, join(folder, 'Serra.app'));
      } catch (error) {
        rmSync(folder, { recursive: true, force: true });
        set({ state: 'error', stage: 'verify', message: `${message(error)} The download was deleted.`, release });
        return view();
      }
      set({ state: 'ready', release, install: plan(deps.bundlePath) });
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      if (controller.signal.aborted) set({ state: 'available', release, checkedAt: now() });
      else set({ state: 'error', stage: 'download', message: `The download stopped: ${message(error)}`, release });
    } finally { controller = null; }
    return view();
  };

  return {
    view,
    check,
    /** Starts the download and returns at once; progress arrives as pushes. */
    download: (): AppUpdateView => {
      if (phase.state === 'available' || (phase.state === 'error' && phase.release && phase.stage !== 'install')) {
        void startDownload();
        return view();
      }
      return view();
    },
    cancel: (): AppUpdateView => { controller?.abort(); return view(); },
    /** Replaces the app and relaunches it. Only for a `replace` plan; the installer plan uses `openInstaller`. */
    install: (): AppUpdateView => {
      if (phase.state !== 'ready' || phase.install.kind !== 'replace' || !deps.bundlePath) return view();
      const release = phase.release;
      const staged = join(deps.dir, release.version, 'Serra.app');
      if (!existsSync(staged)) { set({ state: 'error', stage: 'install', message: 'The downloaded update is gone. Check again to download it.', release }); return view(); }
      set({ state: 'installing', release });
      try {
        const script = join(deps.dir, 'swap.sh');
        writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
        writeFileSync(pendingPath, JSON.stringify({ from: deps.current, to: release.version, target: deps.bundlePath } satisfies Pending));
        launchSwap(script, [String(process.pid), deps.bundlePath, staged, join(deps.dir, 'swap.log')]);
        log(`installing ${release.version}; quitting so the swap can run`);
        deps.quit();
      } catch (error) {
        rmSync(pendingPath, { force: true });
        set({ state: 'error', stage: 'install', message: message(error), release });
      }
      return view();
    },
    /** Opens the verified disk image in Finder, for the owner to drag Serra to Applications. */
    openInstaller: async (): Promise<AppUpdateView> => {
      if (phase.state !== 'ready') return view();
      const dmg = join(deps.dir, phase.release.version, phase.release.dmg.name);
      await deps.openPath(dmg);
      return view();
    },
    setPrereleases: async (choice: boolean | null): Promise<AppUpdateView> => {
      deps.setChoice(choice);
      // A different channel can change the answer, unless a download is under way or ready.
      if (!busy() && phase.state !== 'ready' && phase.state !== 'unavailable' && phase.state !== 'idle') return check();
      deps.push?.(view());
      return view();
    },
  };
};

export type AppUpdater = ReturnType<typeof createAppUpdater>;
