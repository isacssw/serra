// Checked copies of a profile folder (SB-10, SB-34): made before the app removes a profile, before a move and before
// a restore. A copy goes to `<profiles>/backups/<folder>@<date>/` with `manifest.sha256` (one line per file) and a
// note saying why it was made (`removed.json`, `moved.json` or `restore.json`). Every file is read back and compared
// before the caller may go on, and the copy is built under a `.partial` name and renamed at the end, so a crash never
// leaves a folder that looks like a backup but isn't one.
//
// What a copy holds is the profile's data: knowledge, settings, sessions, jobs, held requests, logs. It leaves out
// what belongs to the computer the bot runs on, which is made again there: secrets (`.env`, at any depth: tokens
// stay in the Keychain, 1Password or the host's own `.env`), locks, the bot's code (`releases/` and the files that
// point at it), its ready marker and an update's intake pause, and sockets.
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { isRecord, isString } from './lib/guards.ts';

/** Left out at the top of a profile folder: the running bot's own files, made again on the computer it runs on. */
const HOST_FILES = new Set([
  'releases', 'prepared.json', 'active.json', 'activation.json', 'ready.json', 'intake-paused.json', 'intake-paused.ack.json',
]);

/** Left out anywhere: secrets and locks. A lock names a process on this computer only. */
const isSecretOrLock = (name: string): boolean => name === '.env' || name.endsWith('.lock');

/**
 * True for a top-level entry of a profile folder that stays with the computer: never copied, and kept in place when
 * a restore puts older data back.
 */
export const staysWithHost = (name: string): boolean => HOST_FILES.has(name) || isSecretOrLock(name);

export const MANIFEST_FILE = 'manifest.sha256';

/** Why a backup was made, and the note that says so. */
export type BackupKind = 'removed' | 'moved' | 'restore';
const NOTE_FILES: Record<BackupKind, string> = { removed: 'removed.json', moved: 'moved.json', restore: 'restore.json' };

export const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** One file of a profile's data, as a manifest lists it. `path` is relative, with `/` between folders. */
export interface DataFile { path: string; size: number; sha256: string }

/** A profile's data files, sorted, and the symbolic links among them (which another computer couldn't follow). */
export const profileData = (profileDir: string): { files: DataFile[]; links: string[] } => {
  const source = resolve(profileDir);
  const files: DataFile[] = [];
  const links: string[] = [];
  const walk = (from: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(from, entry.name);
      if (from === source ? staysWithHost(entry.name) : isSecretOrLock(entry.name)) continue;
      const rel = relative(source, path).split(sep).join('/');
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) links.push(rel);
      else if (stat.isFile()) files.push({ path: rel, size: stat.size, sha256: sha256File(path) });
    }
  };
  walk(source);
  return { files, links };
};

/** `name@2026-11-28`, then `name@2026-11-28-2` and so on: a backup never replaces another, finished or not. */
const freeFolder = (backups: string, name: string, day: string): string => {
  const taken = (path: string): boolean => existsSync(path) || existsSync(`${path}.partial`);
  const first = join(backups, `${name}@${day}`);
  if (!taken(first)) return first;
  for (let n = 2; ; n += 1) {
    const next = join(backups, `${name}@${day}-${n}`);
    if (!taken(next)) return next;
  }
};

export interface ProfileBackup {
  /** The backup folder. */
  path: string;
  /** Files copied and checked. */
  files: number;
}

const manifestText = (lines: string[]): string => (lines.length ? `${lines.join('\n')}\n` : '');

/**
 * Copies `profileDir`'s data into `backupsDir` and checks every file's sha256 against the original. Throws, leaving
 * the profile untouched and no backup behind, if anything can't be copied or doesn't match. `about` goes into the
 * note for `kind` (`removed.json` by default), with where it came from and when.
 */
export const backupProfile = (
  profileDir: string,
  backupsDir: string,
  about: Record<string, string>,
  now: Date = new Date(),
  kind: BackupKind = 'removed',
): ProfileBackup => {
  const source = resolve(profileDir);
  const target = freeFolder(resolve(backupsDir), basename(source), now.toISOString().slice(0, 10));
  const partial = `${target}.partial`;
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    const lines: string[] = [];
    const copy = (from: string): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (from === source ? staysWithHost(entry.name) : isSecretOrLock(entry.name)) continue;
        const path = join(from, entry.name);
        const rel = relative(source, path);
        const to = join(partial, rel);
        const stat = lstatSync(path);
        if (stat.isDirectory()) { mkdirSync(to, { recursive: true, mode: 0o700 }); copy(path); }
        else if (stat.isSymbolicLink()) symlinkSync(readlinkSync(path), to);
        else if (stat.isFile()) {
          copyFileSync(path, to);
          lines.push(`${sha256File(path)}  ${rel.split(sep).join('/')}`);
        }
        // Sockets and other special files are the running bot's, not its data.
      }
    };
    copy(source);
    // Read back: a copy that doesn't match its original is no backup.
    for (const line of lines) {
      const [hash, rel] = [line.slice(0, 64), line.slice(66)];
      if (sha256File(join(partial, rel)) !== hash) throw new Error(`The backup of ${rel} doesn't match the original, so nothing changed.`);
    }
    writeFileSync(join(partial, MANIFEST_FILE), manifestText(lines), { mode: 0o600 });
    writeFileSync(join(partial, NOTE_FILES[kind]), `${JSON.stringify({ ...about, from: source, at: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
    renameSync(partial, target);
    return { path: target, files: lines.length };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
};

/** A backup's manifest, read and checked line by line. Throws when it is missing or malformed. */
export const readManifest = (backupDir: string): DataFile[] => {
  let text: string;
  try { text = readFileSync(join(backupDir, MANIFEST_FILE), 'utf8'); } catch { throw new Error('This backup has no manifest, so it can’t be checked.'); }
  return text.split('\n').filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    const path = match?.[2] ?? '';
    if (!match || !isDataPath(path)) throw new Error('This backup’s manifest can’t be read.');
    let size = 0;
    try { size = lstatSync(join(backupDir, path)).size; } catch { /* checked by checkBackup */ }
    return { path, size, sha256: match[1]! };
  });
};

/** A relative path inside a profile: no `..`, no absolute part, no empty or dot segments, no backslashes. */
export const isDataPath = (path: string): boolean =>
  path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
  && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** Checks every file of a backup against its manifest. Returns the files; throws naming the first that differs. */
export const checkBackup = (backupDir: string): DataFile[] => {
  const files = readManifest(backupDir);
  for (const file of files) {
    const path = join(backupDir, file.path);
    if (!existsSync(path) || sha256File(path) !== file.sha256) throw new Error(`The backup’s copy of ${file.path} doesn’t match its manifest.`);
  }
  return files;
};

/** A finished backup as the app lists it. */
export interface BackupEntry {
  /** The backup folder's name, `scout@2026-11-28`: how a restore names it. */
  id: string;
  /** The profile folder it was made from. */
  profile: string;
  kind: BackupKind;
  /** When it was made (ISO). */
  at: string;
  files: number;
  /** For a move: where the profile went (`t480`, `this Mac`). For a restore: the backup it went back to. */
  detail: string | null;
}

/** A backup folder name: a profile folder name, `@`, a day, and a number when there were several that day. */
const BACKUP_ID = /^([\w][\w.-]{0,63})@(\d{4}-\d\d-\d\d(?:-\d+)?)$/;

export const isBackupId = (id: string): boolean => BACKUP_ID.test(id);

/** The finished backups in `backupsDir`, newest first. Folders without a manifest or a note are skipped. */
export const listBackups = (backupsDir: string): BackupEntry[] => {
  let names: string[];
  try { names = readdirSync(backupsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
  const found: BackupEntry[] = [];
  for (const name of names) {
    const match = BACKUP_ID.exec(name);
    if (!match) continue;
    const dir = join(backupsDir, name);
    if (!existsSync(join(dir, MANIFEST_FILE))) continue;
    for (const kind of ['moved', 'restore', 'removed'] as const) {
      let note: unknown;
      try { note = JSON.parse(readFileSync(join(dir, NOTE_FILES[kind]), 'utf8')); } catch { continue; }
      if (!isRecord(note) || !isString(note.at) || Number.isNaN(Date.parse(note.at))) continue;
      const lines = readFileSync(join(dir, MANIFEST_FILE), 'utf8').split('\n').filter(Boolean).length;
      const detail = kind === 'moved' && isString(note.to) ? note.to : kind === 'restore' && isString(note.restoring) ? note.restoring : null;
      found.push({ id: name, profile: match[1]!, kind, at: note.at, files: lines, detail });
      break;
    }
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
};
