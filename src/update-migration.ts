/**
 * Leaving developer mode behind on a packaged app (SERRA-63).
 *
 * alpha.2's Updates screen told owners to set `updates.source` in profile.json (Settings › Worker › Update source).
 * From alpha.3 that setting means developer mode: the bot builds from that checkout and no longer follows the app.
 * An owner who set it under alpha.2 would stay there without knowing. This module:
 *
 * - classifies the profile's update source;
 * - clears one that can never work (a missing folder, a folder that isn't a Serra checkout, or a path inside an app
 *   bundle), but only in a packaged app, after copying profile.json to `<profile>/backups/`;
 * - leaves a real Serra checkout alone (the owner may be working on Serra) and lets the owner clear it in one step.
 *
 * Nothing else in the profile changes: knowledge, jobs, tokens and bot builds aren't touched.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROFILE_FILE } from './config.ts';
import { updateProfileSection } from './profile-settings.ts';

/** What the profile's `updates.source` points at. */
export type SourceKind =
  /** A git checkout of the Serra repository: developer mode can build from it. */
  | 'checkout'
  /** Nothing there any more. */
  | 'missing'
  /** Inside an app bundle (like alpha.2's own `Serra.app/Contents/Resources/app`): it has no git and is replaced on update. */
  | 'inside-app'
  /** A folder, but not a git checkout of Serra. */
  | 'not-a-checkout';

/** Reads the source folder. Only files: no git, so it is fast enough for every status call. */
export const classifySource = (source: string): SourceKind => {
  if (/\.app(\/|$)/.test(source)) return 'inside-app';
  try { if (!statSync(source).isDirectory()) return 'not-a-checkout'; } catch { return 'missing'; }
  // A clone has a `.git` folder; a worktree a `.git` file. Either way it must be Serra's own package.
  if (!existsSync(join(source, '.git'))) return 'not-a-checkout';
  try {
    const name = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name?: unknown }).name;
    return name === 'serra' ? 'checkout' : 'not-a-checkout';
  } catch { return 'not-a-checkout'; }
};

/** Why a source was cleared, in the owner's words. */
export const sourceProblem = (kind: Exclude<SourceKind, 'checkout'>): string => ({
  missing: "the folder doesn't exist any more",
  'inside-app': 'it pointed inside the Serra app, which has no git and is replaced on every update',
  'not-a-checkout': "it isn't a git checkout of Serra",
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
  copyFileSync(join(directory, PROFILE_FILE), copy);
  chmodSync(copy, 0o600);
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
 * nothing to clear. Throws, with profile.json unchanged, when the backup or the write fails.
 */
export const clearUpdateSource = (profileDir: string, reason = '', now = new Date()): ClearedSource | null => {
  const source = currentSource(profileDir);
  if (source === null) return null;
  const backup = backupProfile(profileDir, 'update-source', now);
  updateProfileSection(profileDir, 'updates', undefined);
  return { source, reason, backup, at: now.toISOString() };
};

/**
 * In a packaged app, clears an update source that can never work, so an owner who set one under alpha.2 isn't left
 * in developer mode. A real Serra checkout is kept: that is a choice only the owner can undo. Never throws; returns
 * what it cleared, or null.
 */
export const migrateStaleUpdateSource = (profileDir: string, { packaged, now = new Date() }: { packaged: boolean; now?: Date }): ClearedSource | null => {
  if (!packaged) return null;
  const source = currentSource(profileDir);
  if (source === null) return null;
  const kind = classifySource(source);
  // A checkout on a disk that isn't connected right now isn't gone.
  if (kind === 'checkout' || (kind === 'missing' && source.startsWith('/Volumes/'))) return null;
  try { return clearUpdateSource(profileDir, sourceProblem(kind), now); } catch { return null; }
};
