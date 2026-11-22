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
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './lib/atomic.ts';
import { isRecord, isTime } from './lib/guards.ts';
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

const writeAtomic = (path: string, text: string): void => writeFileAtomic(path, text, { mode: 0o600 });

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

const isPause = (value: unknown): value is IntakePause =>
  isRecord(value) && (value.reason === 'app-update' || value.reason === 'bot-update') && isTime(value.since) && isTime(value.until);

const isAck = (value: unknown): value is IntakeAck =>
  isRecord(value) && Number.isSafeInteger(value.pid) && isTime(value.at) && Number.isSafeInteger(value.starting) && (value.starting as number) >= 0;

/** A held request as the daemon wrote it. Anything else on a line is skipped, never handed to the bot. */
export const isHeldRequest = (value: unknown): value is IncomingMessage =>
  isRecord(value) && typeof value.channel === 'string' && typeof value.threadTs === 'string' && typeof value.messageTs === 'string'
  && typeof value.user === 'string' && typeof value.text === 'string' && typeof value.direct === 'boolean'
  && (value.files === undefined || (Array.isArray(value.files) && value.files.every(isRecord)))
  && (value.botId === undefined || typeof value.botId === 'string')
  && (value.automaticTrigger === undefined || typeof value.automaticTrigger === 'boolean')
  && (value.attemptedAt === undefined || isTime(value.attemptedAt));

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

/** The pause file as written, even past its deadline; null when there is none or it isn't a pause. */
export const readPauseFile = (profileDir: string): IntakePause | null => {
  const pause = readJson(pausePath(profileDir));
  return isPause(pause) ? pause : null;
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
  const ack = readJson(ackPath(profileDir));
  return isAck(ack) && now - Date.parse(ack.at) <= ACK_FRESH_MS ? ack : null;
};

/**
 * What the daemon does with an incoming message: `handle` it now, or `hold` it for after the restart. Only a message
 * that would start new work is held: one in a thread with no running job. A running job's messages still reach it.
 */
export const admit = (paused: boolean, runningInThread: boolean): 'handle' | 'hold' => (paused && !runningInThread ? 'hold' : 'handle');

const key = (msg: Pick<IncomingMessage, 'channel' | 'messageTs'>): string => `${msg.channel}:${msg.messageTs}`;

/** The held requests, oldest first. Broken lines, and lines that aren't a request, are skipped. */
export const readHeld = (profileDir: string): IncomingMessage[] => {
  let text: string;
  try { text = readFileSync(heldPath(profileDir), 'utf8'); } catch { return []; }
  const held: IncomingMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (isHeldRequest(value)) held.push(value);
  }
  return held;
};

/** Keeps a request to start after the restart. A message held already (Slack delivered it twice) is kept once. */
export const holdRequest = (profileDir: string, msg: IncomingMessage): void => {
  if (readHeld(profileDir).some((held) => key(held) === key(msg))) return;
  appendFileSync(heldPath(profileDir), JSON.stringify(msg) + '\n', { mode: 0o600 });
};

/**
 * Removes one held request once it has been handed to the bot: started as a job (recorded in `state.json`), refused,
 * or reported as failed. Until then it stays on disk, so a crash while starting it loses nothing: the next daemon
 * starts it again, and the job's record of the messages it took in (`Job.heard`) stops a second start (INTAKE-010).
 */
export const dropHeld = (profileDir: string, msg: IncomingMessage): void => {
  const rest = readHeld(profileDir).filter((held) => key(held) !== key(msg));
  if (rest.length) writeAtomic(heldPath(profileDir), rest.map((held) => JSON.stringify(held)).join('\n') + '\n');
  else rmSync(heldPath(profileDir), { force: true });
};

/**
 * Records, on disk, that starting this held request has begun. If the daemon stops before the request is dropped, the
 * next one knows a T3 thread may already exist for it (`IncomingMessage.attemptedAt`). Returns the request as marked.
 */
export const markAttempt = (profileDir: string, msg: IncomingMessage, at: string): IncomingMessage => {
  const marked = { ...msg, attemptedAt: msg.attemptedAt ?? at };
  const held = readHeld(profileDir).map((line) => (key(line) === key(msg) ? marked : line));
  writeAtomic(heldPath(profileDir), held.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return marked;
};
