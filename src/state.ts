/**
 * `state.json`: the jobs the bot follows, keyed `${channel}:${threadTs}`. Every reader (the bot, the Jobs screen, the
 * release switch, cleanup) goes through `readState`, which checks each job's shape instead of trusting a cast and
 * migrates what older builds wrote, so one bad entry can't crash the bot or mislead a reader. Only the bot writes the
 * file, atomically, and backs it up first when reading it changed anything.
 *
 * A job's lifecycle is saved as `phase` (`lifecycle.ts`). Each write also saves the flags builds before it read
 * (`watching`, `waitingInT3`, `question`, `runSeen`, `progress`), made from the phase, so a rolled-back bot or app
 * reads the same state. A file whose flags don't match its phase was written by such an older build since: the phase
 * is made from the flags again.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './lib/atomic.ts';
import { FOLLOW_UP_MS, IDLE, type Phase, type SeenRun } from './lifecycle.ts';
import type { QuestionCard } from './questions.ts';
import type { Job } from './types.ts';
import { isArrayOf, isBoolean, isOneOf, isRecord, isString, isStringOrNull, isTime } from './lib/guards.ts';

const isStrings = isArrayOf(isString);
const isAudience = isOneOf('owner', 'team', 'external');

/** The fields a job may leave out. */
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
/** The fields every job has. Listed here so a new required field must be given a default in `migrateJob`. */
const REQUIRED = ['t3ThreadId', 'channel', 'threadTs', 'requester', 'pendingReactionTs', 'lastPostedRunId', 'phase', 'createdAt'] as const satisfies readonly Exclude<keyof Job, OptionalKeys<Job>>[];
/** Compiles only while `REQUIRED` lists every required field of `Job`. */
const requiredComplete: [Exclude<Exclude<keyof Job, OptionalKeys<Job>>, (typeof REQUIRED)[number]>] extends [never] ? true : never = true;
void requiredComplete;
/** Keys that would change an object's prototype if copied onto it. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Each optional field and the shape it must have. A field of the wrong shape is dropped, not the job. The type makes
 * this list complete: a field added to `Job` without a guard here is a compile error, not a field lost on restart.
 */
const OPTIONAL: { [K in OptionalKeys<Job>]: (value: unknown) => boolean } = {
  pendingReactions: isStrings, loadingRequested: isBoolean, ownerFollows: isBoolean, ownerAskOpen: isBoolean,
  lastActivityAt: isString,
  answeredQuestionMessages: isStrings, reviewRequestedPrs: isStrings, statusTs: isString,
  nextTurnWaits: isBoolean, heard: isStrings,
  delivering: (x) => isRecord(x) && isString(x.runId) && isTime(x.at) && (x.text === undefined || isString(x.text))
    && (x.ownerFollows === undefined || isBoolean(x.ownerFollows)) && (x.ownerAskOpen === undefined || isBoolean(x.ownerAskOpen)),
  visibility: isAudience,
  knowledgeRead: (x) => isRecord(x) && Object.values(x).every(isAudience),
  knowledgeDir: isString, branch: isString, request: isString,
};

const isCard = (x: unknown): x is QuestionCard => isRecord(x) && isString(x.ts) && isString(x.requestId) && isString(x.nonce) && Array.isArray(x.questions)
  && Number.isSafeInteger(x.index) && isRecord(x.answers);
const isProgress = (x: unknown): x is { ts: string; text: string } => isRecord(x) && isString(x.ts) && isString(x.text);
const isSeenRun = (x: unknown): x is SeenRun => isRecord(x) && isString(x.id) && isString(x.at) && (x.waits === undefined || isBoolean(x.waits))
  && (x.progress === undefined || isProgress(x.progress));
const isLeftover = (x: unknown): boolean => isRecord(x) && isString(x.ts) && isString(x.runId) && isString(x.text);
const isPhase = (x: unknown): x is Phase => isRecord(x) && ((x.state === 'idle' && (x.leftover === undefined || isLeftover(x.leftover)))
  || (x.state === 'following' && (x.run === undefined || isSeenRun(x.run)))
  || (x.state === 'waiting' && (x.run === undefined || isSeenRun(x.run)) && (x.card === undefined || isCard(x.card))));

/** The flags builds before `phase` read, as they would have saved them. */
const LEGACY = ['watching', 'waitingInT3', 'question', 'runSeen', 'progress'] as const;
const legacyOf = (phase: Phase): Record<(typeof LEGACY)[number], unknown> => {
  const run = phase.state === 'idle' ? undefined : phase.run;
  return {
    watching: phase.state !== 'idle',
    waitingInT3: phase.state === 'waiting',
    question: phase.state === 'waiting' ? phase.card : undefined,
    runSeen: run ? { runId: run.id, at: run.at, ...(run.waits === undefined ? {} : { waits: run.waits }) } : undefined,
    progress: run?.progress ? { ts: run.progress.ts, runId: run.id, text: run.progress.text } : phase.state === 'idle' ? phase.leftover : undefined,
  };
};

/**
 * Whether the saved flags are what `phase` saves: no older build changed them since. Every older build writes
 * `watching`, so a file without it was written by a build that saves `phase` alone, and the phase stands.
 */
const flagsMatch = (value: Record<string, unknown>, phase: Phase): boolean => {
  if (value.watching === undefined) return true;
  const expected = legacyOf(phase);
  // `waitingInT3: false` and no field mean the same.
  const flag = (field: (typeof LEGACY)[number], found: unknown): unknown => (field === 'waitingInT3' && found === undefined ? false : found);
  return LEGACY.every((field) => JSON.stringify(flag(field, value[field])) === JSON.stringify(flag(field, expected[field])));
};

/**
 * The phase older builds' flags describe. A card means waiting with it, `waitingInT3` waiting without one, `watching`
 * following. A job not watched that still has a seen run nobody posted, or a progress line, is followed too, so the next
 * poll settles it properly (posting what's owed, clearing the line) instead of it being dropped here. Not one that went
 * quiet `FOLLOW_UP_MS` ago, which older builds stopped looking at: a reply then would come from nowhere, so it is idle.
 */
const phaseFromFlags = (value: Record<string, unknown>, now: number): Phase => {
  const lastActive = Date.parse(isString(value.lastActivityAt) ? value.lastActivityAt : isString(value.createdAt) ? value.createdAt : '');
  const line = isRecord(value.progress) && isString(value.progress.ts) && isString(value.progress.runId) && isString(value.progress.text)
    ? { ts: value.progress.ts, runId: value.progress.runId, text: value.progress.text } : undefined;
  // An open card still works whatever its age (answering it never waited for a poll), so it keeps its wait. Otherwise
  // the line, if any, is still taken down: `leftover`.
  if (value.watching !== true && !isCard(value.question) && !(now - lastActive <= FOLLOW_UP_MS)) return line ? { state: 'idle', leftover: line } : IDLE;
  const seen = isRecord(value.runSeen) && isString(value.runSeen.runId) && isString(value.runSeen.at) ? value.runSeen : undefined;
  const runId = seen ? seen.runId : line?.runId;
  const run: SeenRun | undefined = isString(runId) ? {
    id: runId,
    at: seen && isString(seen.at) ? seen.at : isString(value.createdAt) ? value.createdAt : new Date(0).toISOString(),
    ...(seen && isBoolean(seen.waits) ? { waits: seen.waits } : {}),
    // A line left from another run than the one seen is dropped: it can't be told apart from the seen run's any more.
    ...(line && isString(line.ts) && isString(line.text) && line.runId === runId ? { progress: { ts: line.ts, text: line.text } } : {}),
  } : undefined;
  const withRun = run ? { run } : {};
  if (isCard(value.question)) return { state: 'waiting', ...withRun, card: value.question };
  if (value.waitingInT3 === true) return { state: 'waiting', ...withRun };
  const unposted = run !== undefined && (run.id !== value.lastPostedRunId || run.progress !== undefined);
  if (value.watching === true || unposted) return { state: 'following', ...withRun };
  return IDLE;
};

/**
 * Reads one saved job, migrating what older builds wrote: a field an older build didn't write gets its neutral
 * default, and an optional field of the wrong shape is dropped. Only a value with no T3 thread to follow is no job.
 * `repaired` says whether anything was filled in or dropped.
 */
const migrateJob = (key: string, value: unknown, now: number): { job: Job; repaired: boolean } | null => {
  if (!isRecord(value) || !isString(value.t3ThreadId)) return null;
  const split = key.indexOf(':');
  const [keyChannel, keyThread] = split === -1 ? [key, key] : [key.slice(0, split), key.slice(split + 1)];
  let repaired = false;
  const pick = <T>(field: string, guard: (x: unknown) => x is T, fallback: T): T => {
    const found = value[field];
    if (guard(found)) return found;
    repaired = true;
    return fallback;
  };
  const job: Job = {
    t3ThreadId: value.t3ThreadId,
    channel: pick('channel', isString, keyChannel),
    threadTs: pick('threadTs', isString, keyThread),
    requester: pick('requester', isString, ''),
    pendingReactionTs: pick('pendingReactionTs', isStringOrNull, null),
    lastPostedRunId: pick('lastPostedRunId', isStringOrNull, null),
    phase: isPhase(value.phase) && flagsMatch(value, value.phase) ? value.phase : ((repaired = true), phaseFromFlags(value, now)),
    createdAt: pick('createdAt', isString, isString(value.lastActivityAt) ? value.lastActivityAt : ''),
  };
  for (const [field, found] of Object.entries(value)) {
    if (found === undefined || UNSAFE_KEYS.has(field) || (REQUIRED as readonly string[]).includes(field) || (LEGACY as readonly string[]).includes(field)) continue;
    const guard = (OPTIONAL as Record<string, ((value: unknown) => boolean) | undefined>)[field];
    // A field this build doesn't know (written by a newer one) is kept as it is, so a rollback loses nothing.
    if (!guard || guard(found)) Object.assign(job, { [field]: found });
    else repaired = true;
  }
  return { job, repaired };
};

/** A job as saved: its phase, and the flags older builds read made from it. */
const toDisk = (job: Job): Record<string, unknown> => {
  const flags = Object.fromEntries(Object.entries(legacyOf(job.phase)).filter(([, value]) => value !== undefined));
  return { ...job, ...flags };
};

export interface SavedState {
  jobs: Record<string, Job>;
  /** Keys whose saved value isn't a job at all (no T3 thread). They are left out of `jobs`. */
  invalid: string[];
  /** Keys of jobs read with a default filled in or a bad field dropped. */
  repaired: string[];
}

/**
 * Reads `state.json`, migrating each job on read. No file is no jobs. A file that isn't a JSON object throws: the bot
 * must not start over it and then overwrite it.
 */
export const readState = (file: string, { now = Date.now() }: { now?: number } = {}): SavedState => {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: {}, invalid: [], repaired: [] };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON`); }
  if (!isRecord(parsed)) throw new Error(`${file} is not an object`);
  const jobs: Record<string, Job> = {};
  const invalid: string[] = [];
  const repaired: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const read = migrateJob(key, value, now);
    if (!read) { invalid.push(key); continue; }
    jobs[key] = read.job;
    if (read.repaired) repaired.push(key);
  }
  return { jobs, invalid, repaired };
};

/**
 * The bot's store. When reading migrated anything, the next write changes the file in a way an older build can't
 * undo, so before that first write the original is copied once to `state.json.backup-<time>`.
 */
export const createStore = (file: string, { warn = (_message: string): void => {}, now = () => new Date() }: { warn?: (message: string) => void; now?: () => Date } = {}) => {
  const { jobs, invalid, repaired } = readState(file, { now: now().getTime() });
  let backedUp = invalid.length === 0 && repaired.length === 0;
  if (invalid.length) warn(`state.json has ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} that aren't jobs (${invalid.slice(0, 3).join(', ')}): they are kept in a backup and left out.`);

  const save = (): void => {
    if (!backedUp) {
      const backup = `${file}.backup-${now().toISOString().replaceAll(':', '-')}`;
      if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
      backedUp = true;
    }
    writeFileAtomic(file, JSON.stringify(Object.fromEntries(Object.entries(jobs).map(([key, job]) => [key, toDisk(job)])), null, 2));
  };

  const getJob = (key: string): Job | undefined => jobs[key];
  const allJobs = (): [string, Job][] => Object.entries(jobs);
  const putJob = (key: string, job: Job): void => {
    jobs[key] = job;
    save();
  };
  return { getJob, allJobs, putJob };
};

export const slackKey = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;
