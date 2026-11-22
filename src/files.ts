/**
 * Leaf file helpers with no Serra imports, so config.ts and secrets.ts can both use them without importing each other.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

/** A `.env` file's variables, or none when the file is missing. */
export const readEnv = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) if (typeof value === 'string') env[key] = value;
  return env;
};

/** The file operations an atomic write uses. Tests swap them to simulate a crash part way through. */
export interface AtomicWriteIo {
  writeFileSync: (fd: number, data: string) => void;
  renameSync: (from: string, to: string) => void;
}
const realIo: AtomicWriteIo = { writeFileSync, renameSync };

/**
 * Replace `path` with `data` so a reader sees either the old file or the new one, never a partial write.
 * The data goes to a uniquely named temp file next to `path`, is flushed to disk, then renamed over it.
 * A crash before the rename leaves the old file untouched (and at worst a stray `.tmp` file that the next write ignores).
 */
export const writeFileAtomic = (path: string, data: string, { mode = 0o600, io = realIo }: { mode?: number; io?: AtomicWriteIo } = {}): void => {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temp, 'wx', mode);
    try {
      io.writeFileSync(fd, data);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    io.renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  // Make the rename itself durable. Not every platform can fsync a directory, and the file is already in place.
  try {
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* best effort */ }
};
