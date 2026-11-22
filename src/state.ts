/**
 * `state.json`: the jobs the bot follows, keyed `${channel}:${threadTs}`. Every reader (the bot, the Jobs screen, the
 * release switch, cleanup) goes through `readState`, which checks each job's shape instead of trusting a cast and
 * migrates what older builds wrote, so one bad entry can't crash the bot or mislead a reader. Only the bot writes the
 * file, atomically, and backs it up first when reading it changed anything.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './lib/atomic.ts';
import type { Job } from './types.ts';
import { isArrayOf, isBoolean, isOneOf, isRecord, isString, isStringOrNull } from './lib/guards.ts';

const isStrings = isArrayOf(isString);
const isAudience = isOneOf('owner', 'team', 'external');

/** Each optional field and the shape it must have. A field of the wrong shape is dropped, not the job. */
const OPTIONAL: { [K in keyof Job]?: (value: unknown) => boolean } = {
  pendingReactions: isStrings, loadingRequested: isBoolean, ownerFollows: isBoolean, ownerAskOpen: isBoolean,
  lastActivityAt: isString, waitingInT3: isBoolean,
  question: (x) => isRecord(x) && isString(x.ts) && isString(x.requestId) && isString(x.nonce) && Array.isArray(x.questions)
    && Number.isSafeInteger(x.index) && isRecord(x.answers),
  answeredQuestionMessages: isStrings, reviewRequestedPrs: isStrings, statusTs: isString,
  progress: (x) => isRecord(x) && isString(x.ts) && isString(x.runId) && isString(x.text),
  runSeen: (x) => isRecord(x) && isString(x.runId) && isString(x.at) && (x.waits === undefined || isBoolean(x.waits)),
  nextTurnWaits: isBoolean, heard: isStrings,
  delivering: (x) => isRecord(x) && isString(x.runId) && isString(x.at),
  visibility: isAudience,
  knowledgeRead: (x) => isRecord(x) && Object.values(x).every(isAudience),
  knowledgeDir: isString, branch: isString,
};

/**
 * Reads one saved job, migrating what older builds wrote: a field an older build didn't write gets its neutral
 * default, and an optional field of the wrong shape is dropped. Only a value with no T3 thread to follow is no job.
 * `repaired` says whether anything was filled in or dropped.
 */
export const migrateJob = (key: string, value: unknown): { job: Job; repaired: boolean } | null => {
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
    watching: pick('watching', isBoolean, false),
    createdAt: pick('createdAt', isString, isString(value.lastActivityAt) ? value.lastActivityAt : ''),
  };
  for (const [field, guard] of Object.entries(OPTIONAL)) {
    if (value[field] === undefined) continue;
    if (guard(value[field])) Object.assign(job, { [field]: value[field] });
    else repaired = true;
  }
  return { job, repaired };
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
export const readState = (file: string): SavedState => {
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
    const read = migrateJob(key, value);
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
  const { jobs, invalid, repaired } = readState(file);
  let backedUp = invalid.length === 0 && repaired.length === 0;
  if (invalid.length) warn(`state.json has ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} that aren't jobs (${invalid.slice(0, 3).join(', ')}): they are kept in a backup and left out.`);

  const save = (): void => {
    if (!backedUp) {
      const backup = `${file}.backup-${now().toISOString().replaceAll(':', '-')}`;
      if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
      backedUp = true;
    }
    writeFileAtomic(file, JSON.stringify(jobs, null, 2));
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
