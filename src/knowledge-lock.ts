// One lock for every change to knowledge (SERRA-62). The app and the daemon are separate processes that both write
// `knowledge/` (page saves, approvals, undo, meeting approvals, Forget meeting) and both build snapshots from it, so
// each takes `knowledge.lock` in the profile first. A reader then never sees half of a change.
//
// The lock is a file holding the holder's PID and start time, made with O_EXCL. It waits (synchronously: knowledge
// services are synchronous) and takes over a lock whose holder process is gone. Nested calls in one process share it.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WAIT_MS = 25;
const DEFAULT_TIMEOUT_MS = 15_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** The lock file for the knowledge folder `knowledgeDir`: next to it, in the profile. */
export const knowledgeLockPath = (knowledgeDir: string): string => join(dirname(resolve(knowledgeDir)), 'knowledge.lock');

const held = new Map<string, number>();

/** Whether process `pid` is running. */
export const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

const holder = (path: string): { pid: number; at: string } | null => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; at?: unknown };
    return typeof value.pid === 'number' ? { pid: value.pid, at: String(value.at ?? '') } : null;
  } catch { return null; }
};

/**
 * Run `work` holding the knowledge lock. Waits up to `timeoutMs` for another process to finish, then refuses with a
 * message the app can show. A lock left by a process that is gone (a crash) is taken over.
 */
export const withKnowledgeLock = <T>(knowledgeDir: string, work: () => T, { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}): T => {
  const path = knowledgeLockPath(knowledgeDir);
  const depth = held.get(path) ?? 0;
  if (depth > 0) {
    held.set(path, depth + 1);
    try { return work(); } finally { held.set(path, (held.get(path) ?? 1) - 1); }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = holder(path);
      // Gone, or unreadable for long enough that it isn't a write in progress: take it over.
      if (!owner ? Date.now() + timeoutMs - deadline > 1000 : !processAlive(owner.pid)) { rmSync(path, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error('Knowledge is busy with another change. Try again in a moment.');
      Atomics.wait(sleeper, 0, 0, WAIT_MS);
    }
  }
  held.set(path, 1);
  try { return work(); } finally {
    held.delete(path);
    if (holder(path)?.pid === process.pid) rmSync(path, { force: true });
  }
};
