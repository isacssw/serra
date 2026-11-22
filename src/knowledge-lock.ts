// One lock for every change to knowledge (SERRA-62). The app and the daemon are separate processes that both write
// `knowledge/` (page saves, approvals, undo, meeting approvals, Forget meeting) and both build snapshots from it, so
// each takes `knowledge.lock` in the profile first. A reader then never sees half of a change.
//
// The lock is a file holding the holder's PID and start time, made with O_EXCL. It waits (synchronously: knowledge
// services are synchronous) and takes over a lock whose holder process is gone. Nested calls in one process share it.
import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { errorCode, isRecord, parseJson, stringField } from './json-guards.ts';

const WAIT_MS = 25;
const DEFAULT_TIMEOUT_MS = 15_000;
/** No knowledge change takes this long: a lock older than this is abandoned, whoever has its PID now. */
const STALE_MS = 10 * 60_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** The lock file for the knowledge folder `knowledgeDir`: next to it, in the profile. */
const knowledgeLockPath = (knowledgeDir: string): string => join(dirname(resolve(knowledgeDir)), 'knowledge.lock');

const held = new Map<string, number>();

/** Whether process `pid` is running. */
export const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) === 'EPERM'; }
};

const holder = (path: string): { pid: number; at: string } | null => {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const value = parseJson(text);
  return isRecord(value) && typeof value.pid === 'number' ? { pid: value.pid, at: stringField(value.at) ?? '' } : null;
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
      if (errorCode(error) !== 'EEXIST') throw error;
      const owner = holder(path);
      const age = (() => { try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; } })();
      // Gone, too old to be live (a reused PID), or unreadable for long enough that it isn't a write in progress.
      // Unreadable: judged on the file's own age, so a lock opened a moment ago and not yet written is never taken.
      if (!owner ? age > 1000 : !processAlive(owner.pid) || age > STALE_MS) {
        // Taken over by renaming it away. If what was renamed isn't the lock judged abandoned (another waiter took it
        // over and a new holder made its own in between), it's put back: link fails rather than overwrite a lock.
        const stale = `${path}.stale-${randomBytes(4).toString('hex')}`;
        try { renameSync(path, stale); } catch { continue; }
        const moved = holder(stale);
        // Judged unreadable, anything readable now is a new holder's; judged dead, anything else is.
        const fresh = (() => { try { return Date.now() - statSync(stale).mtimeMs < 1000; } catch { return false; } })();
        // Still unreadable but brand new: a holder caught between creating and writing it. Put back too.
        const someoneElse = owner ? moved?.pid !== owner.pid || moved.at !== owner.at : moved !== null || fresh;
        if (someoneElse) { try { linkSync(stale, path); } catch { /* a newer lock is there */ } }
        rmSync(stale, { force: true });
        continue;
      }
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
