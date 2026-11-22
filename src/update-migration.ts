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
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROFILE_FILE, validateProfile, writeProfileFile } from './config.ts';

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

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Reads the source folder, never git, so it is quick. Fails closed: only positive evidence that the source can't work
 * gives `missing`, `inside-app` or `not-a-checkout`; any error that isn't "no such file" gives `unknown`.
 */
export const classifySource = (source: string): SourceKind => {
  // Only the path's text: safe before any read.
  if (/\.app\/Contents(\/|$)/.test(source)) return 'inside-app';
  // A disk that isn't connected isn't gone; and a network mount could hang the read.
  if (source.startsWith('/Volumes/')) return 'unknown';
  // The folders above it must be readable, and a link among them must lead to a folder that exists, not on a disk:
  // a link to a disk that isn't connected, like the source itself, may come back.
  for (let up = dirname(source); up !== dirname(up); up = dirname(up)) {
    let linked = false;
    try { linked = lstatSync(up).isSymbolicLink(); } catch (error) { if (ABSENT.has(code(error) ?? '')) continue; return 'unknown'; }
    if (!linked) continue;
    try { if (realpathSync(up).startsWith('/Volumes/')) return 'unknown'; } catch { return 'unknown'; }
  }
  let link: boolean;
  try { link = lstatSync(source).isSymbolicLink(); } catch (error) { return ABSENT.has(code(error) ?? '') ? 'missing' : 'unknown'; }
  try { if (!statSync(source).isDirectory()) return link ? 'unknown' : 'not-a-checkout'; } catch { return 'unknown'; }
  let name: unknown;
  try { name = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name?: unknown }).name; }
  catch (error) { if (!ABSENT.has(code(error) ?? '')) return 'unknown'; }
  if (name === 'serra') return 'checkout';
  // A clone has a `.git` folder, a worktree a `.git` file, here or above. A repository we can't recognise stays.
  for (let at = source; ; at = dirname(at)) {
    try { lstatSync(join(at, '.git')); return 'unknown'; } catch (error) { if (!ABSENT.has(code(error) ?? '')) return 'unknown'; }
    if (at === dirname(at)) break;
  }
  return 'not-a-checkout';
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
export const backupProfile = (profileDir: string, label: string, now = new Date()): string => {
  const directory = resolve(profileDir);
  const backup = join(directory, 'backups', `${now.toISOString().replace(/[:.]/g, '-')}-${label}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const copy = join(backup, PROFILE_FILE);
  try { copyFileSync(join(directory, PROFILE_FILE), copy); chmodSync(copy, 0o600); }
  catch (error) { rmSync(backup, { recursive: true, force: true }); throw error; }
  return backup;
};

const currentSource = (profileDir: string): string | null => {
  try {
    const raw = JSON.parse(readFileSync(join(resolve(profileDir), PROFILE_FILE), 'utf8')) as { updates?: { source?: unknown } };
    return typeof raw.updates?.source === 'string' ? raw.updates.source : null;
  } catch { return null; }
};

/**
 * Removes `updates` from profile.json after backing it up, so the bot follows the app again. Null when there was
 * nothing to clear, or when `expected` is given and the source is no longer that one (the owner changed it since it
 * was looked at). Throws, with profile.json unchanged, when the backup or the write fails.
 */
export const clearUpdateSource = (profileDir: string, reason = '', now = new Date(), expected?: string): ClearedSource | null => {
  const path = join(resolve(profileDir), PROFILE_FILE);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { updates?: { source?: unknown } };
  if (typeof raw.updates?.source !== 'string') return null;
  const source = raw.updates.source;
  if (expected !== undefined && source !== expected) return null;
  const { updates: _cleared, ...next } = raw;
  // Checked before anything is written, so a profile that doesn't validate gets no backup and no change.
  validateProfile(next);
  const backup = backupProfile(profileDir, 'update-source', now);
  try { writeProfileFile(profileDir, next); }
  catch (error) { rmSync(backup, { recursive: true, force: true }); throw error; }
  return { source, reason, backup, at: now.toISOString() };
};

/**
 * In a packaged app, clears an update source that can never work, so an owner who set one under alpha.2 isn't left
 * in developer mode. A real Serra checkout is kept: that is a choice only the owner can undo. Never throws; returns
 * what it cleared, or null, and passes a failure to `log`.
 */
export const migrateStaleUpdateSource = (profileDir: string, { packaged, now = new Date(), log }: { packaged: boolean; now?: Date; log?: (line: string) => void }): ClearedSource | null => {
  if (!packaged) return null;
  const source = currentSource(profileDir);
  if (source === null) return null;
  const kind = classifySource(source);
  if (kind === 'checkout' || kind === 'unknown') return null;
  try { return clearUpdateSource(profileDir, sourceProblem(kind), now, source); }
  catch (error) { log?.(`Couldn't clear the update source ${source}: ${error instanceof Error ? error.message : String(error)}`); return null; }
};
