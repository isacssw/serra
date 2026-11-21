/**
 * Pausing new work before a restart. The app writes `intake-paused.json` in the profile before it restarts itself for
 * an update or switches the bot to a new version. While it is there, the daemon starts no new job: a request that would
 * start one is held in `held-requests.jsonl` (with an hourglass on the message) and started by the next daemon, or by
 * this one once the pause is lifted. Messages for jobs already running still reach them, so those jobs can finish.
 *
 * The pause carries a deadline and lapses on its own, so an app that crashed or quit mid-update can't leave the bot
 * ignoring requests. No Slack or Bolt imports: the Electron main process uses this file too.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from './types.ts';

export const INTAKE_PAUSED = 'intake-paused.json';
export const HELD_REQUESTS = 'held-requests.jsonl';
/** How long a pause lasts unless lifted or renewed: long enough for running jobs to finish, short enough to recover. */
export const PAUSE_MS = 30 * 60_000;

export interface IntakePause {
  /** Why, for logs: `app-update` (Serra restarting for its own update) or `bot-update` (the bot moving to a new version). */
  reason: 'app-update' | 'bot-update';
  since: string;
  /** The pause lapses at this time even if nobody lifts it. */
  until: string;
}

const pausePath = (profileDir: string): string => join(profileDir, INTAKE_PAUSED);
const heldPath = (profileDir: string): string => join(profileDir, HELD_REQUESTS);

/** Starts (or renews) a pause. Returns it. */
export const pauseIntake = (profileDir: string, reason: IntakePause['reason'], { now = Date.now(), ms = PAUSE_MS } = {}): IntakePause => {
  const existing = readPause(profileDir, now);
  const pause: IntakePause = { reason, since: existing?.since ?? new Date(now).toISOString(), until: new Date(now + ms).toISOString() };
  writeFileSync(`${pausePath(profileDir)}.tmp`, JSON.stringify(pause, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${pausePath(profileDir)}.tmp`, pausePath(profileDir));
  return pause;
};

/** Lifts the pause. Held requests are started by the daemon on its next look. */
export const resumeIntake = (profileDir: string): void => { rmSync(pausePath(profileDir), { force: true }); };

/** The pause in force now, or null (none, unreadable, or past its deadline). */
export const readPause = (profileDir: string, now = Date.now()): IntakePause | null => {
  try {
    const pause = JSON.parse(readFileSync(pausePath(profileDir), 'utf8')) as IntakePause;
    return Date.parse(pause.until) > now ? pause : null;
  } catch { return null; }
};

/**
 * What the daemon does with an incoming message: `handle` it now, or `hold` it for after the restart. Only a message
 * that would start new work is held: one in a thread with no running job. A running job's messages still reach it.
 */
export const admit = (paused: boolean, runningInThread: boolean): 'handle' | 'hold' => (paused && !runningInThread ? 'hold' : 'handle');

/** Keeps a request to start after the restart. */
export const holdRequest = (profileDir: string, msg: IncomingMessage): void => {
  appendFileSync(heldPath(profileDir), JSON.stringify(msg) + '\n', { mode: 0o600 });
};

/** The held requests, oldest first, removed from the file so each is started once. Broken lines are skipped. */
export const takeHeld = (profileDir: string): IncomingMessage[] => {
  const path = heldPath(profileDir);
  if (!existsSync(path)) return [];
  // Renamed first: a request held while these are being started goes to a fresh file and waits for the next take.
  const taking = `${path}.taking`;
  renameSync(path, taking);
  const held: IncomingMessage[] = [];
  for (const line of readFileSync(taking, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { held.push(JSON.parse(line) as IncomingMessage); } catch { /* skip a broken line */ }
  }
  rmSync(taking, { force: true });
  return held;
};

export const heldCount = (profileDir: string): number => {
  try { return readFileSync(heldPath(profileDir), 'utf8').split('\n').filter((line) => line.trim()).length; } catch { return 0; }
};
