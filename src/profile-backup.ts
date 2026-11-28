// A checked copy of a profile folder, made before the app removes it (SB-10). The copy goes to
// `<profiles>/backups/<folder>@<date>/` with `manifest.sha256` (one line per file) and `removed.json`, and every file
// is read back and compared before the caller may go on. Secrets never travel in a copy: `.env` is left out (tokens in
// the Keychain or 1Password stay there), and so are `releases/` (the bot's code, made again on install) and sockets.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

/** Left out of every backup, at the top of the profile folder. */
const SKIPPED = new Set(['.env', 'releases']);

export const MANIFEST_FILE = 'manifest.sha256';
const REMOVED_FILE = 'removed.json';

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** `name@2026-11-28`, then `name@2026-11-28-2` and so on: a backup never replaces another. */
const freeFolder = (backups: string, name: string, day: string): string => {
  const first = join(backups, `${name}@${day}`);
  if (!existsSync(first)) return first;
  for (let n = 2; ; n += 1) {
    const next = join(backups, `${name}@${day}-${n}`);
    if (!existsSync(next)) return next;
  }
};

export interface ProfileBackup {
  /** The backup folder. */
  path: string;
  /** Files copied and checked. */
  files: number;
}

/**
 * Copies `profileDir` into `backupsDir` and checks every file's sha256 against the original. Throws, leaving the
 * profile untouched, if anything can't be copied or doesn't match. `about` goes into `removed.json`.
 */
export const backupProfile = (
  profileDir: string,
  backupsDir: string,
  about: Record<string, string>,
  now: Date = new Date(),
): ProfileBackup => {
  const source = resolve(profileDir);
  const target = freeFolder(resolve(backupsDir), basename(source), now.toISOString().slice(0, 10));
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const copy = (from: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const path = join(from, entry.name);
      const rel = relative(source, path);
      if (from === source && SKIPPED.has(entry.name)) continue;
      const to = join(target, rel);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { mkdirSync(to, { recursive: true, mode: 0o700 }); copy(path); }
      else if (stat.isSymbolicLink()) symlinkSync(readlinkSync(path), to);
      else if (stat.isFile()) {
        copyFileSync(path, to);
        lines.push(`${sha256(path)}  ${rel}`);
      }
      // Sockets and other special files are the running bot's, not its data.
    }
  };
  copy(source);
  // Read back: a copy that doesn't match its original is no backup.
  for (const line of lines) {
    const [hash, rel] = [line.slice(0, 64), line.slice(66)];
    if (sha256(join(target, rel)) !== hash) throw new Error(`The backup of ${rel} doesn't match the original, so nothing was removed.`);
  }
  writeFileSync(join(target, MANIFEST_FILE), lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  writeFileSync(join(target, REMOVED_FILE), `${JSON.stringify({ ...about, from: source, at: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return { path: target, files: lines.length };
};
