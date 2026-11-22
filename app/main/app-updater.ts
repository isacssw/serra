// App updates from GitHub Releases (SERRA-46): check, download, verify, then replace Serra.app and relaunch, or open
// the installer when the app can't replace itself. Free of Electron imports: `index.ts` passes in `net.fetch`, the
// app's paths and `app.quit`, and tests pass fakes. The release logic itself is in `src/app-updates.ts`.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  compareVersions, download, downloadText, fetchReleases, includePrereleases, isAppRelease, parseVersion, pickUpdate, verifyChecksum,
  type AppRelease, type Fetch,
} from '../../src/app-updates.ts';
import { isOptional, isRecord, isString, readJsonFile, readJsonOrNull } from '../../src/lib/guards.ts';
import { run } from '../../src/t3.ts';

/** How a downloaded update gets installed: Serra swaps itself, or the owner drags it from the opened disk image. */
export type InstallPlan = { kind: 'replace' } | { kind: 'installer'; reason: string; folder: string };

export type AppUpdatePhase =
  /** Updates can't run here (a copy run from source). */
  | { state: 'unavailable'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; checkedAt: string }
  | { state: 'available'; release: AppRelease; checkedAt: string }
  /** A newer release has no build for this Mac. */
  | { state: 'no-build'; version: string; url: string; reason: 'arch' | 'checksum'; checkedAt: string }
  | { state: 'downloading'; release: AppRelease; received: number; total: number | null }
  | { state: 'verifying'; release: AppRelease }
  | { state: 'ready'; release: AppRelease; install: InstallPlan }
  | { state: 'installing'; release: AppRelease }
  | { state: 'error'; stage: 'check' | 'download' | 'verify' | 'install'; message: string; release?: AppRelease };

/** What the Updates screen shows about the app. */
export type AppUpdateView = AppUpdatePhase & {
  /** The installed version, `app.getVersion()`. */
  current: string;
  /** Whether prereleases are offered now, the owner's choice (null: the default) and the default (on while on a prerelease). */
  prereleases: { on: boolean; choice: boolean | null; byDefault: boolean };
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
  /** The arguments to open the new version with: the ones this process was started with (profile, user data). */
  relaunchArgs?: string[];
  openPath: (path: string) => Promise<void>;
  push?: (view: AppUpdateView) => void;
  log?: (line: string) => void;
}

const helperAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};

/** The bundle identifier the update must carry (electron-builder.yml `appId`). */
const BUNDLE_ID = 'dev.serra.app';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Whether the running app can swap itself: it must be a real `.app` outside a disk image or App Translocation,
 * in a folder this user can write. Otherwise the owner installs from the opened disk image.
 */
export const installPlan = (bundlePath: string | null, writable: (path: string) => boolean = canWrite): InstallPlan => {
  const applications = 'Applications';
  if (!bundlePath || !bundlePath.endsWith('.app')) return { kind: 'installer', reason: "This copy of Serra can't replace itself.", folder: applications };
  if (bundlePath.startsWith('/Volumes/')) return { kind: 'installer', reason: "Serra is running from its disk image, so it can't replace itself.", folder: applications };
  if (bundlePath.includes('/AppTranslocation/')) return { kind: 'installer', reason: "macOS is running Serra from a temporary location, so it can't replace itself.", folder: applications };
  const folder = dirname(bundlePath);
  const name = folder === '/Applications' ? applications : folder;
  if (!writable(folder) || !writable(bundlePath)) return { kind: 'installer', reason: `Serra needs an administrator to replace itself in ${name}.`, folder: name };
  return { kind: 'replace' };
};

const canWrite = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
};

/** Mounts the disk image read-only, checks the app inside (bundle ID, version, intact signature) and copies it out. */
const stageFromDmg = async (dmg: string, expected: { version: string; bundleId: string }, into: string): Promise<string> => {
  // Mounted outside the updates folder, so clearing that folder at launch never meets a disk image left mounted.
  const mount = mkdtempSync(join(tmpdir(), 'serra-update-mount-'));
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
    try { rmSync(mount, { recursive: true, force: true }); } catch { /* still mounted; the system clears tmp */ }
  }
};

/**
 * The swap, run by bash after Serra quits: wait for the old process to exit, move the old app aside, move the new one
 * in and open it, then wait for the new version to say it started (it writes `started`). When a move fails, or the new
 * version doesn't start within two minutes, the old app goes back and opens again. The old copy is removed only after
 * the new one started.
 */
export const SWAP_SCRIPT = `#!/bin/bash
set -u
pid="$1"; target="$2"; staged="$3"; log="$4"; started="$5"; version="$6"
shift 6
# The rest are the arguments Serra was started with, so it opens again the same way.
relaunch() { if [ "$#" -gt 0 ]; then open -n "$target" --args "$@"; else open -n "$target"; fi; }
exec >>"$log" 2>&1
# One swap at a time: the app refuses to start another while this lock names a live helper.
lock="$(dirname "$log")/swap.lock"
echo "$$ $pid" > "$lock"
trap 'rm -f "$lock"' EXIT
echo "$(date) swap: waiting for $pid"
# Quitting can wait for a bot restart to finish, so allow it ten minutes.
for _ in $(seq 1 6000); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then echo "Serra is still running; not replacing it"; exit 1; fi
previous="$target.previous"; incoming="$target.incoming"
rm -rf "$previous" "$started" "$incoming"
# Put the new app beside the old one first (a copy when the volumes differ), so the switch is two renames in a row.
if ! mv "$staged" "$incoming"; then echo "couldn't place the new app next to the old one"; rm -rf "$incoming"; relaunch "$@"; exit 1; fi
if ! mv "$target" "$previous"; then echo "couldn't move the old app aside"; rm -rf "$incoming"; relaunch "$@"; exit 1; fi
if ! mv "$incoming" "$target"; then echo "couldn't move the new app in; restoring the old one"; mv "$previous" "$target"; rm -rf "$incoming"; relaunch "$@"; exit 1; fi
echo "$(date) swap: done, opening $target"
relaunch "$@"
# The new version writes its version to "started" once its window drew its first screen.
confirmed() { [ "$(cat "$started" 2>/dev/null)" = "$version" ]; }
for _ in $(seq 1 1200); do confirmed && break; sleep 0.1; done
if confirmed; then echo "$(date) swap: the new version started"; rm -rf "$previous" "$started"; exit 0; fi
sleep 1; if confirmed; then echo "$(date) swap: the new version started (late)"; rm -rf "$previous" "$started"; exit 0; fi
if [ ! -d "$previous" ]; then echo "$(date) swap: the new version didn't confirm its start, and there is no old copy to restore; keeping it"; exit 1; fi
echo "$(date) swap: the new version didn't start; restoring the old one"
pkill -f "$target/Contents/MacOS/" 2>/dev/null; sleep 2
rm -rf "$target.failed"
if mv "$target" "$target.failed"; then
  if mv "$previous" "$target"; then rm -rf "$target.failed"; else mv "$target.failed" "$target"; fi
fi
relaunch "$@"
exit 1
`;

interface Pending { from: string; to: string; target: string; release?: AppRelease }
const isPending = (value: unknown): value is Pending =>
  isRecord(value) && isString(value.from) && isString(value.to) && isString(value.target) && isOptional(isAppRelease)(value.release);

interface FailedStart { version: string; from: string }
/** Both are versions: `version` is compared with each newer release, and a non-version would make every check fail. */
const isFailedStart = (value: unknown): value is FailedStart =>
  isRecord(value) && isString(value.version) && parseVersion(value.version) !== null && isString(value.from);

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
  let downloading: Promise<AppUpdateView> | null = null;
  /** Written once this version's window is up, so the swap script keeps it (see `SWAP_SCRIPT`). */
  const startedPath = join(deps.dir, 'started');

  // The first launch after a swap: this version opened, and `started()` confirms it once the window is up. Opened on
  // the old version instead: the swap didn't take, or the script put the old app back.
  let pendingSwap = false;
  /** A version that was installed but didn't start here: not offered again until a newer one is out. */
  const failedStartPath = join(deps.dir, 'failed-start.json');
  let failedStart: FailedStart | null = readJsonOrNull(failedStartPath, isFailedStart);
  const didNotStart = (failed: FailedStart): string =>
    `Serra ${failed.version} didn't start on this Mac, so Serra put ${failed.from} back. It isn't offered again; a newer version will be.`;
  // A helper whose process is gone (killed, or the Mac restarted) leaves its lock behind.
  try {
    const [helper] = readFileSync(join(deps.dir, 'swap.lock'), 'utf8').trim().split(' ').map(Number);
    if (!helper || !helperAlive(helper)) rmSync(join(deps.dir, 'swap.lock'), { force: true });
  } catch { /* no lock */ }
  /** A verified download kept for the installer after Serra couldn't replace itself. */
  let keep: string | null = null;
  const marker = readJsonFile(pendingPath, isPending);
  if (marker.state === 'invalid') log('dropped an unreadable pending.json');
  if (marker.state === 'ok') {
    try {
      const pending = marker.value;
      if (pending.to === deps.current) {
        updatedFrom = pending.from;
        pendingSwap = true;
        log(`updated from ${pending.from} to ${pending.to}`);
      } else if (!deps.unavailable) {
        // The swap script's last line says why (a move refused, or the new version didn't start).
        let why = '';
        try { why = readFileSync(join(deps.dir, 'swap.log'), 'utf8').trimEnd().split('\n').pop()?.replace(/^.*swap: /, '') ?? ''; } catch { /* no log */ }
        const dmg = pending.release ? join(deps.dir, pending.release.version, pending.release.dmg.name) : null;
        if (/didn't start; restoring/.test(why)) {
          // Serra did replace itself, but the new version didn't start: offering it again would only repeat that.
          // Remembered (a file, so the launch cleanup keeps it) until a newer release comes out.
          failedStart = { version: pending.to, from: deps.current };
          try { writeFileSync(failedStartPath, JSON.stringify(failedStart)); } catch { /* shown for this launch only */ }
          phase = { state: 'error', stage: 'install', message: didNotStart(failedStart), ...(pending.release ? { release: pending.release } : {}) };
        } else if (pending.release && dmg && existsSync(dmg)) {
          // The verified disk image is still here: offer it to install by hand instead of starting over.
          keep = pending.release.version;
          const folder = dirname(pending.target) === '/Applications' ? 'Applications' : dirname(pending.target);
          phase = {
            state: 'ready', release: pending.release,
            install: { kind: 'installer', reason: `Serra couldn't replace itself${why ? ` (${why})` : ''}.`, folder },
          };
        } else {
          phase = { state: 'error', stage: 'install', message: `The update to ${pending.to} didn't finish, so Serra is still on ${deps.current}.${why ? ` (${why})` : ''} Check again to retry.` };
        }
      }
    } catch { /* a broken marker is dropped */ }
  }
  if (marker.state !== 'absent' && !pendingSwap) rmSync(pendingPath, { force: true });
  // Nothing is downloaded or staged at launch: earlier downloads and staged apps are left over, so they go.
  // A cleanup that fails (a file in use) never stops the app from starting.
  try {
    if (existsSync(deps.dir)) {
      for (const entry of readdirSync(deps.dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === keep) continue;
        try { rmSync(join(deps.dir, entry.name), { recursive: true, force: true }); } catch (error) { log(`couldn't remove ${entry.name}: ${message(error)}`); }
      }
    }
  } catch (error) { log(`couldn't clear old downloads: ${message(error)}`); }

  const view = (): AppUpdateView => {
    const choice = deps.getChoice();
    return { ...phase, current: deps.current, prereleases: { on: includePrereleases(choice, deps.current), choice, byDefault: includePrereleases(null, deps.current) }, updatedFrom };
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
      if (result.kind === 'available' && failedStart && compareVersions(result.release.version, failedStart.version) <= 0) {
        set({ state: 'error', stage: 'install', message: didNotStart(failedStart), release: result.release });
      } else if (result.kind === 'available') {
        if (failedStart) { failedStart = null; rmSync(failedStartPath, { force: true }); }
        set({ state: 'available', release: result.release, checkedAt });
      }
      else if (result.kind === 'no-build') set({ state: 'no-build', version: result.version, url: result.url, reason: result.reason, checkedAt });
      else set({ state: 'up-to-date', checkedAt });
    } catch (error) {
      set({ state: 'error', stage: 'check', message: message(error) });
    }
    return view();
  };

  const startDownload = async (): Promise<AppUpdateView> => {
    if (phase.state !== 'available' && !(phase.state === 'error' && phase.release && phase.stage !== 'install')) return view();
    const release = phase.release!;
    const aborted = controller = new AbortController();
    const folder = join(deps.dir, release.version);
    const dmg = join(folder, release.dmg.name);
    const clear = (): void => { try { rmSync(folder, { recursive: true, force: true }); } catch (error) { log(`couldn't remove ${folder}: ${message(error)}`); } };
    set({ state: 'downloading', release, received: 0, total: release.dmg.size || null });
    try {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      const sums = await downloadText(deps.fetch, release.sums.url);
      await download(deps.fetch, release.dmg.url, dmg, {
        signal: aborted.signal,
        progress: ({ received, total }) => set({ state: 'downloading', release, received, total: total ?? (release.dmg.size || null) }),
      });
      set({ state: 'verifying', release });
      try {
        await verifyChecksum(dmg, release.dmg.name, sums);
        await stage(dmg, { version: release.version, bundleId: BUNDLE_ID }, join(folder, 'Serra.app'));
      } catch (error) {
        clear();
        set({ state: 'error', stage: 'verify', message: `${message(error)} The download was deleted.`, release });
        return view();
      }
      set({ state: 'ready', release, install: plan(deps.bundlePath) });
    } catch (error) {
      clear();
      if (aborted.signal.aborted) set({ state: 'available', release, checkedAt: now() });
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
        downloading = startDownload().finally(() => { downloading = null; });
        return view();
      }
      return view();
    },
    cancel: (): AppUpdateView => { controller?.abort(); return view(); },
    /** The window is up: tells the swap script this version started, so it keeps it. */
    started: (): void => {
      if (!pendingSwap) return;
      pendingSwap = false;
      try { writeFileSync(startedPath, deps.current); rmSync(pendingPath, { force: true }); } catch (error) { log(`couldn't confirm the start: ${message(error)}`); }
    },
    /** Replaces the app and relaunches it. Only for a `replace` plan; the installer plan uses `openInstaller`. */
    install: (): AppUpdateView => {
      if (phase.state !== 'ready' || phase.install.kind !== 'replace' || !deps.bundlePath) return view();
      const release = phase.release;
      const staged = join(deps.dir, release.version, 'Serra.app');
      if (!existsSync(staged)) { set({ state: 'error', stage: 'install', message: 'The downloaded update is gone. Check again to download it.', release }); return view(); }
      // A helper from an earlier click may still be waiting for Serra to quit: never start a second one.
      try {
        const [helper, waitsFor] = readFileSync(join(deps.dir, 'swap.lock'), 'utf8').trim().split(' ').map(Number);
        if (helper && helperAlive(helper) && waitsFor === process.pid) { log('a swap is already waiting for Serra to quit'); deps.quit(); return view(); }
        // A lock from another process (a stale one, or a reused PID): not ours to wait on.
        rmSync(join(deps.dir, 'swap.lock'), { force: true });
      } catch { /* no helper */ }
      set({ state: 'installing', release });
      try {
        const script = join(deps.dir, 'swap.sh');
        writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
        writeFileSync(pendingPath, JSON.stringify({ from: deps.current, to: release.version, target: deps.bundlePath, release } satisfies Pending));
        // If the helper gives up (Serra didn't quit within its wait) and exits, offer Restart again.
        const watch = setInterval(() => {
          if (phase.state !== 'installing') { clearInterval(watch); return; }
          let alive = false;
          try { alive = helperAlive(Number(readFileSync(join(deps.dir, 'swap.lock'), 'utf8').trim().split(' ')[0])); } catch { /* gone */ }
          if (!alive) { clearInterval(watch); set({ state: 'ready', release, install: { kind: 'replace' } }); }
        }, 5_000);
        watch.unref();
        launchSwap(script, [String(process.pid), deps.bundlePath, staged, join(deps.dir, 'swap.log'), startedPath, release.version, ...(deps.relaunchArgs ?? [])]);
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
      // Not while the swap is about to take the staged app, or while it's being checked.
      if (phase.state === 'installing' || phase.state === 'verifying') return view();
      deps.setChoice(choice);
      const on = includePrereleases(choice, deps.current);
      // A pre-release on offer, downloading or downloaded no longer fits: drop it, then look again.
      const offered = 'release' in phase ? phase.release : undefined;
      if (offered?.prerelease && !on) {
        controller?.abort();
        await downloading;
        try { rmSync(join(deps.dir, offered.version), { recursive: true, force: true }); } catch { /* cleared at the next launch */ }
        phase = { state: 'idle' };
        return check();
      }
      if (phase.state === 'unavailable' || phase.state === 'idle' || busy() || phase.state === 'ready') { deps.push?.(view()); return view(); }
      return check();
    },
  };
};

export type AppUpdater = ReturnType<typeof createAppUpdater>;
