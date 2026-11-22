/**
 * Leaving developer mode behind on a packaged app (SERRA-63).
 *
 * alpha.2's Updates screen told owners to set `updates.source` in profile.json (Settings › Worker › Update source).
 * From alpha.3 that setting means developer mode: the bot builds from that checkout and no longer follows the app.
 * An owner who set it under alpha.2 would stay there without knowing. This module:
 *
 * - classifies the profile's update source;
 * - clears one that can never work (nothing at the path, a folder with neither git nor Serra's code, or a path inside
 *   an app bundle), but only in a packaged app, after copying profile.json to `<profile>/backups/`;
 * - leaves Serra's code and anything it can't read alone (the owner may be working on Serra): the Updates screen
 *   offers Follow app updates, which clears it the same way.
 *
 * Nothing else in the profile changes: knowledge, jobs, tokens and bot builds aren't touched.
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROFILE_FILE, validateProfile, writeProfileFile } from './config.ts';
import { isRecord, isString, isTime, parseJson, readJsonOrNull } from './lib/guards.ts';

/** What the profile's `updates.source` points at. Only the last three are cleared on their own. */
export type SourceKind =
  /** Serra's own code (a clone, a worktree or a plain copy): developer mode can build from it. */
  | 'checkout'
  /** Couldn't tell: unreadable (macOS privacy, permissions), a link to something absent, a disk not connected, or a
   * git repository whose package.json isn't readable as Serra's. Left to the owner. */
  | 'unknown'
  /** Nothing there: no file or folder at that path. */
  | 'missing'
  /** Inside an app bundle (like alpha.2's own `Serra.app/Contents/Resources/app`): no git, and replaced on update. */
  | 'inside-app'
  /** A folder with neither git nor Serra's package.json. */
  | 'not-a-checkout';

const code = (error: unknown): string | undefined => (isRecord(error) && isString(error.code) ? error.code : undefined);
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Reads the source folder, never git, so it is quick. Fails closed: only positive evidence that the source can't work
 * gives `missing`, `inside-app` or `not-a-checkout`; any error that isn't "no such file" gives `unknown`.
 */
export const classifySource = (source: string): SourceKind => {
  // An app bundle's contents, by the path alone: no read needed, and alpha.2's own folder there had no git.
  if (/\.app\/Contents(\/|$)/.test(source)) return 'inside-app';
  // A disk that isn't connected isn't gone; and a network mount could hang the read.
  if (/^\/(Volumes|Network|net)\//.test(source)) return 'unknown';
  // The folders above it must be readable, and a link among them must lead to a folder that exists, not on a disk:
  // a link to a disk that isn't connected, like the source itself, may come back.
  for (let up = dirname(source); up !== dirname(up); up = dirname(up)) {
    let linked = false;
    try { linked = lstatSync(up).isSymbolicLink(); } catch (error) { if (ABSENT.has(code(error) ?? '')) continue; return 'unknown'; }
    if (!linked) continue;
    try { if (realpathSync(up).startsWith('/Volumes/')) return 'unknown'; } catch { return 'unknown'; }
  }
  let link: boolean;
  try { link = lstatSync(source).isSymbolicLink(); } catch (error) {
    if (!ABSENT.has(code(error) ?? '')) return 'unknown';
    // Gone, unless the nearest folder that exists looks like a mount point waiting for its disk.
    let at = dirname(source);
    while (at !== dirname(at)) { try { statSync(at); break; } catch { at = dirname(at); } }
    return unmounted(at) ? 'unknown' : 'missing';
  }
  try { if (!statSync(source).isDirectory()) return link ? 'unknown' : 'not-a-checkout'; } catch { return 'unknown'; }
  if (unmounted(source)) return 'unknown';
  let name: unknown;
  try {
    // Text that isn't JSON (a package.json mid-conflict) is unknown, like a read that fails.
    const pkg = parseJson(readFileSync(join(source, 'package.json'), 'utf8'));
    if (!isRecord(pkg)) return 'unknown';
    name = pkg.name;
  } catch (error) { if (!ABSENT.has(code(error) ?? '')) return 'unknown'; }
  if (name === 'serra') return 'checkout';
  // A clone has a `.git` folder, a worktree a `.git` file, here or above. A repository we can't recognise stays.
  for (let at = source; ; at = dirname(at)) {
    try { lstatSync(join(at, '.git')); return 'unknown'; } catch (error) { if (!ABSENT.has(code(error) ?? '')) return 'unknown'; }
    if (at === dirname(at)) break;
  }
  return 'not-a-checkout';
};

/**
 * A folder that may be a mount point (an empty folder, or one on another device than its parent): a disk image,
 * sshfs or a NAS mounted outside /Volumes, possibly not connected yet. Errors count as yes.
 */
const unmounted = (folder: string): boolean => {
  try {
    if (folder === dirname(folder)) return false;
    if (readdirSync(folder).filter((name) => name !== '.DS_Store').length === 0) return true;
    return statSync(folder).dev !== statSync(dirname(folder)).dev;
  } catch { return true; }
};

/** Why a source was cleared, in the owner's words. */
export const sourceProblem = (kind: 'missing' | 'inside-app' | 'not-a-checkout'): string => ({
  missing: 'the folder is gone',
  'inside-app': 'it pointed inside the Serra app',
  'not-a-checkout': "it isn't a copy of Serra",
} as const)[kind];

export interface ClearedSource {
  /** The `updates.source` that was removed. */
  source: string;
  /** Why (empty when the owner asked). */
  reason: string;
  /** The folder holding the copy of profile.json from before the change. */
  backup: string;
  at: string;
}

/** Copies profile.json into `<profile>/backups/<stamp>-<label>/` (private, like deploy's backups). Returns the folder. */
const backupProfile = (profileDir: string, label: string, now = new Date()): string => {
  const directory = resolve(profileDir);
  const backup = join(directory, 'backups', `${now.toISOString().replace(/[:.]/g, '-')}-${label}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const copy = join(backup, PROFILE_FILE);
  try { copyFileSync(join(directory, PROFILE_FILE), copy); chmodSync(copy, 0o600); }
  catch (error) { rmSync(backup, { recursive: true, force: true }); throw error; }
  return backup;
};

const currentSource = (profileDir: string): string | null => {
  const raw = readJsonOrNull(join(resolve(profileDir), PROFILE_FILE), isRecord);
  return raw && isRecord(raw.updates) && isString(raw.updates.source) ? raw.updates.source : null;
};

/**
 * Removes `updates` from profile.json after backing it up, so the bot follows the app again. Null when there was
 * nothing to clear, or when `expected` is given and the source is no longer that one (the owner changed it since it
 * was looked at). Throws, with profile.json unchanged, when the backup or the write fails.
 */
export const clearUpdateSource = (profileDir: string, reason = '', now = new Date(), expected?: string): ClearedSource | null => {
  const path = join(resolve(profileDir), PROFILE_FILE);
  const raw = parseJson(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error(`${path} must contain a JSON object`);
  if (!isRecord(raw.updates) || !isString(raw.updates.source)) return null;
  const source = raw.updates.source;
  if (expected !== undefined && source !== expected) return null;
  const { updates: _cleared, ...next } = raw;
  // Checked before anything is written, so a profile that doesn't validate gets no backup and no change.
  validateProfile(next);
  const backup = backupProfile(profileDir, 'update-source', now);
  try { writeProfileFile(profileDir, next); }
  catch (error) { rmSync(backup, { recursive: true, force: true }); throw error; }
  const done: ClearedSource = { source, reason, backup, at: now.toISOString() };
  // Kept beside the backup, so Updates can say what happened after a restart too (`lastCleared`). Not when the owner
  // asked: they know.
  if (reason) try { writeFileSync(join(backup, NOTICE), JSON.stringify(done, null, 2) + '\n', { mode: 0o600 }); } catch { /* the notice is a nicety */ }
  return done;
};

const NOTICE = 'cleared.json';
const isClearedSource = (value: unknown): value is ClearedSource =>
  isRecord(value) && isString(value.source) && isString(value.reason) && isString(value.backup) && isTime(value.at);
/** How long Updates mentions a cleared source. */
const NOTICE_DAYS = 7;

/** Drops the notices (not the backups): the owner set a source again, so an earlier clear no longer applies. */
export const forgetCleared = (profileDir: string): void => {
  const root = join(resolve(profileDir), 'backups');
  try {
    for (const name of readdirSync(root)) if (name.endsWith('-update-source')) rmSync(join(root, name, NOTICE), { force: true });
  } catch { /* no backups */ }
};

/** The latest clear of this profile's update source, if it was in the last `NOTICE_DAYS` days. */
export const lastCleared = (profileDir: string, now = new Date()): ClearedSource | null => {
  const root = join(resolve(profileDir), 'backups');
  let names: string[];
  try { names = readdirSync(root).filter((name) => name.endsWith('-update-source')).sort().reverse(); } catch { return null; }
  // Only the latest clear counts: after Follow app updates (no notice), an older automatic one no longer applies.
  const latest = names[0];
  if (!latest) return null;
  const notice = readJsonOrNull(join(root, latest, NOTICE), isClearedSource);
  if (!notice) return null;
  const age = now.getTime() - Date.parse(notice.at);
  return age >= 0 && age <= NOTICE_DAYS * 24 * 60 * 60_000 ? notice : null;
};

/**
 * The profile's update source, when a packaged app may clear it on its own: only `missing`, `inside-app` and
 * `not-a-checkout`. Null for Serra's code, anything uncertain, a profile without one, or a copy run from source.
 */
export const staleSource = (profileDir: string, packaged: boolean): { source: string; kind: 'missing' | 'inside-app' | 'not-a-checkout' } | null => {
  if (!packaged) return null;
  const source = currentSource(profileDir);
  if (source === null) return null;
  const kind = classifySource(source);
  return kind === 'checkout' || kind === 'unknown' ? null : { source, kind };
};

/**
 * In a packaged app, clears an update source that can never work, so an owner who set one under alpha.2 isn't left
 * in developer mode. A real Serra checkout is kept: that is a choice only the owner can undo. Never throws; returns
 * what it cleared, or null, and passes a failure to `log`. One look: the app itself (app/main/ipc/updates.ts) uses
 * `staleSource` and `clearUpdateSource` directly, looking twice before clearing a `missing` one in case it was moving.
 */
export const migrateStaleUpdateSource = (profileDir: string, { packaged, now = new Date(), log }: { packaged: boolean; now?: Date; log?: (line: string) => void }): ClearedSource | null => {
  const stale = staleSource(profileDir, packaged);
  if (!stale) return null;
  try { return clearUpdateSource(profileDir, sourceProblem(stale.kind), now, stale.source); }
  catch (error) { log?.(`Couldn't clear the update source ${stale.source}: ${error instanceof Error ? error.message : String(error)}`); return null; }
};
