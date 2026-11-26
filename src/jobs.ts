import { looksRunning } from './lifecycle.ts';
import type { Job } from './types.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, type Runner } from './cleanup.ts';
import type { JobGroup, JobListing, NeedsYouReason } from './contracts.ts';
import { slackPlainText } from './slack-names.ts';
import { GITHUB_PR_URL, threadPullRequest } from './t3.ts';
import { readState } from './state.ts';
import { APP_TASK_CHANNEL, readTasks, type TaskState, type TaskStateLookup } from './tasks.ts';
import { acpRunState } from './agent/runs-view.ts';

/** One row of `listJobs`. */
type JobRow = JobListing['jobs'][number];

/**
 * The Jobs screen and `pnpm bot jobs`, built from the profile's files. `state.json` and `logs/events.jsonl` are only
 * read, never written, so this is safe while the daemon runs and still works when it is stopped.
 */

/** What T3 knows about a job's thread and the files don't: its title, link and pull request. */
export interface ThreadInfo {
  title?: string;
  link?: string;
  /** The PR the thread opened or was linked to, from T3's `pullRequests` / `linkedPullRequest`. */
  pr?: string;
}

/** Looks a T3 thread up. Resolves null when it can't, so one missing thread never fails the list. */
export type ThreadLookup = (threadId: string) => Promise<ThreadInfo | null>;

export interface ListJobsOptions {
  /** Only jobs in this Slack channel ID. */
  channel?: string;
  /** Done jobs from today only (local day), as on the Jobs screen. False lists every done job. Default true. */
  doneTodayOnly?: boolean;
  now?: Date;
  /** Adds the T3 title and link. Without it both are left out, since `state.json` doesn't carry them. */
  threads?: ThreadLookup;
  /**
   * The Slack workspace URL, like `https://acme.slack.com`, to build thread links. Without it the Slack link is
   * left out: a channel and a timestamp aren't enough to open a thread.
   */
  slackUrl?: string;
  /**
   * Reads each app task's thread in T3 (`tasks.json`, APP-25): the daemon doesn't follow tasks, so T3 says whether
   * one runs or waits. Without it, or when T3 can't be read, a task is listed as done with no T3 link.
   */
  tasks?: TaskStateLookup;
  /**
   * Reads a Slack job's thread in T3 when `state.json` says it runs. T3 has the last word: a thread with no run going,
   * nothing waiting and its newest run posted is done, whatever flags were left in the file (SERRA-54). Without it,
   * or when T3 can't be read, the file decides.
   */
  runs?: TaskStateLookup;
}

const GROUP_ORDER: JobGroup[] = ['needs you', 'running', 'done'];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const readOptional = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** The last thing `events.jsonl` says about each job. Lines that don't parse are skipped: the log is append-only. */
const lastEvents = (raw: string | null): Map<string, { at: string; event: string; error?: string }> => {
  const last = new Map<string, { at: string; event: string; error?: string }>();
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try { parsed = record(JSON.parse(line)); } catch { continue; }
    const key = text(parsed.key);
    const at = text(parsed.at);
    const event = text(parsed.event);
    if (!key || !at || !event) continue;
    const error = text(parsed.error);
    last.set(key, { at, event, ...(error ? { error } : {}) });
  }
  return last;
};

const later = (a: string, b: string | undefined): string => (b && Date.parse(b) > Date.parse(a) ? b : a);

/** A Slack thread link, `https://acme.slack.com/archives/C123/p1700000000123456`. */
export const slackThreadLink = (slackUrl: string, channel: string, threadTs: string): string | undefined => {
  if (!/^\d+\.\d+$/.test(threadTs) || !/^[A-Z0-9]+$/.test(channel)) return undefined;
  return `${slackUrl.replace(/\/+$/, '')}/archives/${channel}/p${threadTs.replace('.', '')}`;
};

/** The bot titles threads `<bot name>: <request>`. The screen already says which bot, so the prefix goes. */
const shortTitle = (title: string): string => title.replace(/^[^:\n]{1,40}:\s+/, '');

const startOfDay = (now: Date): number => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

interface Classified {
  group: JobGroup;
  reason?: NeedsYouReason;
  ownerQuestion?: string;
  error?: string;
}

/**
 * Which group a job is in, from what the bot saved. Needs you: the owner was pinged and hasn't answered, a run waits
 * on them in T3, a question is open in Slack, or the job's last event is a failure. Running: a request is pending or
 * a seen run hasn't been posted yet. Everything else is done.
 */
const classify = (job: Job, last: { event: string; error?: string } | undefined): Classified => {
  const card = job.phase.state === 'waiting' ? job.phase.card : undefined;
  const asked = text(card?.questions[card.index]?.question);
  if (job.phase.state === 'waiting' && !card) return { group: 'needs you', reason: 'waiting in T3' };
  if (asked) return { group: 'needs you', reason: 'question', ownerQuestion: asked };
  if (job.ownerAskOpen === true) return { group: 'needs you', reason: 'owner pinged' };
  if (last?.event === 'failure') return { group: 'needs you', reason: 'failed', ...(last.error ? { error: last.error } : {}) };

  if (looksRunning(job) || text(job.pendingReactionTs) !== undefined) return { group: 'running' };
  return { group: 'done' };
};

/**
 * How long a request may wait for its first run. A message the bot just received sits a few seconds before it reaches
 * T3 (the follow-up batcher's quiet time), so until then an idle thread with 👀 or loading is still about to run.
 */
const REQUEST_GRACE_MS = 2 * 60_000;

/**
 * A job the file lists as running that T3 shows idle, with nothing waiting and its newest run already posted. A 👀 or
 * loading status counts as stale only once its request had time to reach T3.
 */
const idleInT3 = (live: TaskState | null, job: Record<string, unknown>, lastActivityAt: string, now: Date): boolean => {
  if (live === null || live.running || live.waiting || (live.latestRunId ?? null) !== (text(job.lastPostedRunId) ?? null)) return false;
  const requested = job.loadingRequested === true || texts(job.pendingReactions).length > 0 || text(job.pendingReactionTs) !== undefined;
  return !requested || now.getTime() - Date.parse(lastActivityAt) > REQUEST_GRACE_MS;
};

/** A task's group, from what T3 says now. Nothing to read means nothing is known to run: it counts as done. */
const taskGroup = (live: TaskState | null, acp = false): Pick<JobRow, 'group' | 'needsYouReason'> => {
  // An ACP task's question is answered in the app's transcript view.
  if (live?.waiting) return { group: 'needs you', needsYouReason: acp ? 'question' : 'waiting in T3' };
  return { group: live?.running ? 'running' : 'done' };
};

/** The newest GitHub PR the bot posted a review request for. Absent when it never did: the PR is never guessed. */
const prLink = (job: Record<string, unknown>): string | undefined =>
  texts(job.reviewRequestedPrs).filter((url) => GITHUB_PR_URL.test(url)).at(-1);


/**
 * Builds the Jobs screen from `state.json` and `logs/events.jsonl`: Needs you, then Running, then Done (today by
 * default), newest activity first in each group, with the channels seen for the filter. Never writes a file.
 */
export const listJobs = async (profileDir: string, {
  channel, doneTodayOnly = true, now = new Date(), threads, slackUrl, tasks, runs,
}: ListJobsOptions = {}): Promise<JobListing> => {
  const state = readState(join(profileDir, 'state.json')).jobs;
  const events = lastEvents(readOptional(join(profileDir, 'logs', 'events.jsonl')));
  const today = startOfDay(now);

  /** An ACP run's state, from its record (src/agent/runs-view.ts): the lookups below only know T3. */
  const onAcp = (backend: string | undefined): boolean => backend !== undefined && backend !== 't3';
  const all = (await Promise.all(Object.entries(state).map(async ([key, value]): Promise<(JobRow & { t3ThreadId?: string })[]> => {
    const job = value;
    const jobChannel = text(job.channel);
    const createdAt = text(job.createdAt);
    if (!jobChannel || !createdAt) return [];
    const last = events.get(key);
    const saved = classify(value, last);
    const acp = onAcp(job.backend) ? acpRunState(profileDir, job.threadId) : null;
    const t3ThreadId = onAcp(job.backend) ? undefined : text(job.threadId);
    const live = acp ?? (saved.group === 'running' && runs && t3ThreadId ? await runs(t3ThreadId).catch(() => null) : null);
    const lastActivityAt = later(later(createdAt, text(job.lastActivityAt)), last?.at);
    const { group, reason, ownerQuestion, error } = idleInT3(live, { ...job }, lastActivityAt, now) ? { group: 'done' as const } : saved;
    const threadTs = text(job.threadTs);
    const slack = slackUrl && threadTs ? slackThreadLink(slackUrl, jobChannel, threadTs) : undefined;
    const pr = prLink({ ...job }) ?? acp?.pr;
    return [{
      key,
      group,
      requester: text(job.requester) ?? '',
      channel: jobChannel,
      title: acp ? shortTitle(acp.title) : '',
      createdAt,
      lastActivityAt,
      ...(ownerQuestion ? { ownerQuestion } : {}),
      ...(reason ? { needsYouReason: reason } : {}),
      ...(error ? { error } : {}),
      links: { ...(slack ? { slack } : {}), ...(pr ? { pr } : {}), ...(acp ? { transcript: job.threadId } : {}) },
      ...(t3ThreadId ? { t3ThreadId } : {}),
    }];
  }))).flat();

  const taskRows = await Promise.all(readTasks(profileDir).map(async (task): Promise<JobRow> => {
    const acp = onAcp(task.backend) ? acpRunState(profileDir, task.threadId) : null;
    const live = acp ?? (tasks && !onAcp(task.backend) ? await tasks(task.threadId).catch(() => null) : null);
    return {
      key: `${APP_TASK_CHANNEL}:${task.threadId}`,
      ...taskGroup(live, acp !== null),
      requester: task.requester,
      channel: APP_TASK_CHANNEL,
      title: task.title,
      createdAt: task.createdAt,
      lastActivityAt: later(task.createdAt, live?.updatedAt),
      links: { ...(live?.link ? { t3: live.link } : {}), ...(live?.pr ? { pr: live.pr } : {}), ...(acp ? { transcript: task.threadId } : {}) },
    };
  }));
  all.push(...taskRows);

  const channels = [...new Set(all.map((job) => job.channel))].sort();
  const shown = all
    .filter((job) => !channel || job.channel === channel)
    .filter((job) => job.group !== 'done' || !doneTodayOnly || Date.parse(job.lastActivityAt) >= today)
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
      || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

  const jobs = await Promise.all(shown.map(async ({ t3ThreadId, ...job }): Promise<JobRow> => {
    if (!threads || !t3ThreadId) return job;
    const info = await threads(t3ThreadId).catch(() => null);
    return {
      ...job,
      title: info?.title ? shortTitle(info.title) : job.title,
      // A PR the bot asked a review for wins; else the PR T3 recorded for the thread.
      links: { ...job.links, ...(info?.link ? { t3: info.link } : {}), ...(!job.links.pr && info?.pr ? { pr: info.pr } : {}) },
    };
  }));
  return { jobs, channels };
};

/** A `ThreadLookup` through `t3 thread show --json`. T3 answers whether or not the daemon runs. */
export const t3ThreadLookup = (t3Bin: string, run: Runner = runCommand): ThreadLookup => async (threadId) => {
  try {
    const thread = record(record(JSON.parse(await run(t3Bin, ['thread', 'show', '--messages', '1', '--json', threadId]))).thread);
    const title = text(thread.title);
    const link = text(thread.link);
    const pr = threadPullRequest(thread);
    return { ...(title ? { title } : {}), ...(link ? { link } : {}), ...(pr ? { pr } : {}) };
  } catch {
    return null;
  }
};

/** How old a job's last activity is, as the screen shows it: `now`, `12m`, `3h`, `2d`. */
export const ageLabel = (since: string, now: Date = new Date()): string => {
  const minutes = Math.floor((now.getTime() - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
};

const GROUP_TITLES: Record<JobGroup, string> = { 'needs you': 'Needs you', running: 'Running', done: 'Done' };

/** The CLI's report: one block per group, one line per job with its age and links. */
export const formatJobs = ({ jobs }: JobListing, { now = new Date(), doneTodayOnly = true } = {}): string => {
  if (jobs.length === 0) return 'No jobs.';
  return GROUP_ORDER.flatMap((group) => {
    const rows = jobs.filter((job) => job.group === group);
    if (rows.length === 0) return [];
    const heading = `${group === 'done' && doneTodayOnly ? 'Done today' : GROUP_TITLES[group]} (${rows.length})`;
    return [heading, ...rows.flatMap((job) => {
      const links = [job.links.slack, job.links.t3, job.links.pr].filter(Boolean);
      const what = [job.requester || 'unknown', job.channel, slackPlainText(job.title) || job.key].join(' · ');
      const detail = job.ownerQuestion ?? job.error ?? (job.needsYouReason ? NEEDS_YOU_TEXT[job.needsYouReason] : undefined);
      return [
        `  ${ageLabel(job.lastActivityAt, now).padStart(4)}  ${what}`,
        ...(detail ? [`        ${detail.split('\n')[0]}`] : []),
        ...links.map((link) => `        ${link}`),
      ];
    }), ''];
  }).join('\n').trimEnd();
};

const NEEDS_YOU_TEXT: Record<NeedsYouReason, string> = {
  'waiting in T3': 'Waiting on you in T3',
  question: 'A question is open in Slack',
  'owner pinged': 'Blocked, waiting on you in Slack',
  failed: 'Failed',
};
