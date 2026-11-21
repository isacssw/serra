/**
 * Pausing new work before a restart. The app writes `intake-paused.json` in the profile before it restarts itself for
 * an update or switches the bot to a new version. While it is there, the daemon starts no new job: a request that would
 * start one is held in `held-requests.jsonl` (with an hourglass on the message) and started by the next daemon, or by
 * this one once the pause is lifted. Messages for jobs already running still reach them, so those jobs can finish.
 *
 * The daemon acknowledges a pause in `intake-paused.ack.json` with how many requests it is still starting, so the app
 * restarts it only once those have become running jobs. A daemon from before pauses existed writes no acknowledgment;
 * the app then relies on its own job checks, as before.
 *
 * The pause carries a deadline and lapses on its own, so an app that crashed or quit mid-update can't leave the bot
 * ignoring requests. No Slack or Bolt imports: the Electron main process uses this file too.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from './types.ts';

export const INTAKE_PAUSED = 'intake-paused.json';
export const INTAKE_ACK = 'intake-paused.ack.json';
export const HELD_REQUESTS = 'held-requests.jsonl';
/** How long a pause lasts unless lifted or renewed: long enough for running jobs to finish, short enough to recover. */
export const PAUSE_MS = 30 * 60_000;
/** An acknowledgment older than this is stale (the daemon refreshes it on every poll, every 15 seconds). */
export const ACK_FRESH_MS = 60_000;

export interface IntakePause {
  /** Why, for logs: `app-update` (Serra restarting for its own update) or `bot-update` (the bot moving to a new version). */
  reason: 'app-update' | 'bot-update';
  since: string;
  /** The pause lapses at this time even if nobody lifts it. */
  until: string;
}

/** The daemon's word that it holds new requests: its PID, when it wrote this, and the requests it is still starting. */
export interface IntakeAck { pid: number; at: string; starting: number }

const pausePath = (profileDir: string): string => join(profileDir, INTAKE_PAUSED);
const ackPath = (profileDir: string): string => join(profileDir, INTAKE_ACK);
const heldPath = (profileDir: string): string => join(profileDir, HELD_REQUESTS);

const writeAtomic = (path: string, text: string): void => {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

/** Starts (or renews) a pause. Returns it. Throws when it can't be written. */
export const pauseIntake = (profileDir: string, reason: IntakePause['reason'], { now = Date.now(), ms = PAUSE_MS } = {}): IntakePause => {
  const existing = readPause(profileDir, now);
  const pause: IntakePause = { reason, since: existing?.since ?? new Date(now).toISOString(), until: new Date(now + ms).toISOString() };
  writeAtomic(pausePath(profileDir), JSON.stringify(pause, null, 2) + '\n');
  return pause;
};

/** Lifts the pause (and its acknowledgment). Held requests are started by the daemon on its next look. */
export const resumeIntake = (profileDir: string): void => {
  rmSync(pausePath(profileDir), { force: true });
  rmSync(ackPath(profileDir), { force: true });
};

/** The pause file as written, even past its deadline; null when there is none. */
export const readPauseFile = (profileDir: string): IntakePause | null => {
  try { return JSON.parse(readFileSync(pausePath(profileDir), 'utf8')) as IntakePause; } catch { return null; }
};

/** The pause in force now, or null (none, unreadable, or past its deadline). */
export const readPause = (profileDir: string, now = Date.now()): IntakePause | null => {
  const pause = readPauseFile(profileDir);
  return pause && Date.parse(pause.until) > now ? pause : null;
};

/** The daemon acknowledges the pause, saying how many requests it is still starting. */
export const acknowledgePause = (profileDir: string, starting: number, { pid = process.pid, now = Date.now() } = {}): void => {
  writeAtomic(ackPath(profileDir), JSON.stringify({ pid, at: new Date(now).toISOString(), starting } satisfies IntakeAck) + '\n');
};

/** A fresh acknowledgment, or null (none: a daemon from before pauses, or a stale one). */
export const readAck = (profileDir: string, now = Date.now()): IntakeAck | null => {
  try {
    const ack = JSON.parse(readFileSync(ackPath(profileDir), 'utf8')) as IntakeAck;
    return now - Date.parse(ack.at) <= ACK_FRESH_MS ? ack : null;
  } catch { return null; }
};

/**
 * What the daemon does with an incoming message: `handle` it now, or `hold` it for after the restart. Only a message
 * that would start new work is held: one in a thread with no running job. A running job's messages still reach it.
 */
export const admit = (paused: boolean, runningInThread: boolean): 'handle' | 'hold' => (paused && !runningInThread ? 'hold' : 'handle');

const key = (msg: Pick<IncomingMessage, 'channel' | 'messageTs'>): string => `${msg.channel}:${msg.messageTs}`;

/** The held requests, oldest first. Broken lines are skipped. */
export const readHeld = (profileDir: string): IncomingMessage[] => {
  let text: string;
  try { text = readFileSync(heldPath(profileDir), 'utf8'); } catch { return []; }
  const held: IncomingMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { held.push(JSON.parse(line) as IncomingMessage); } catch { /* skip a broken line */ }
  }
  return held;
};

/** Keeps a request to start after the restart. A message held already (Slack delivered it twice) is kept once. */
export const holdRequest = (profileDir: string, msg: IncomingMessage): void => {
  if (readHeld(profileDir).some((held) => key(held) === key(msg))) return;
  appendFileSync(heldPath(profileDir), JSON.stringify(msg) + '\n', { mode: 0o600 });
};

/**
 * Removes one held request, just before it is started: the rest stay on disk, so a crash while starting them loses at
 * most the one being started.
 */
export const dropHeld = (profileDir: string, msg: IncomingMessage): void => {
  const rest = readHeld(profileDir).filter((held) => key(held) !== key(msg));
  if (rest.length) writeAtomic(heldPath(profileDir), rest.map((held) => JSON.stringify(held)).join('\n') + '\n');
  else rmSync(heldPath(profileDir), { force: true });
};

/** A thread with a held request: the bot treats it as its own, so a reply there is held after the request. */
export const heldThread = (profileDir: string, channel: string, threadTs: string): boolean =>
  existsSync(heldPath(profileDir)) && readHeld(profileDir).some((held) => held.channel === channel && held.threadTs === threadTs);
