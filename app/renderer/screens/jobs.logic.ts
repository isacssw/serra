// What the Jobs screen shows, as pure functions over the rows `jobs.list()` returns. No React, no bridge: imported
// by `node --test` as well as the renderer.
import type { BotStatus, CleanupVerdict, JobGroup, JobListing, NeedsYouReason } from '../../../src/contracts.ts';
import type { Action } from '../commands/registry.ts';

export type JobRow = JobListing['jobs'][number];

/** The channel of a task started in the app (APP-25), the same as `APP_TASK_CHANNEL` in src/tasks.ts (a test checks). */
const APP_TASK_CHANNEL = 'app';

/** Whether a row is a task the owner started in the app, which T3 reports on rather than the daemon. */
const isAppTask = (job: JobRow): boolean => job.channel === APP_TASK_CHANNEL;

export interface JobSection {
  group: JobGroup;
  /** The heading without its count: "Needs you", "Running", "Done today". */
  title: string;
  rows: JobRow[];
}

const ORDER: JobGroup[] = ['needs you', 'running', 'done'];
const TITLES: Record<JobGroup, string> = { 'needs you': 'Needs you', running: 'Running', done: 'Done today' };

/** What a task started in the app shows where a Slack job shows its channel. */
export const APP_TASK_CHANNEL_LABEL = 'Serra app';

/** A channel as the screen shows it: `#name` once Slack named it, else the raw ID (APP-29). */
const channelLabel = (channel: string, name?: string): string =>
  channel === APP_TASK_CHANNEL ? APP_TASK_CHANNEL_LABEL : name || channel;

/** The channel filter's options: every channel with a job, plus the one picked if its jobs are gone, sorted. */
export const channelOptions = (jobs: readonly JobRow[], selected: string | null = null): string[] =>
  [...new Set([...jobs.map((job) => job.channel), ...(selected ? [selected] : [])])].sort();

/** The filter's options with their labels, sorted by what they show. The value stays the channel ID. */
export const channelChoices = (jobs: readonly JobRow[], selected: string | null = null): { value: string; label: string }[] => {
  const names = new Map(jobs.filter((job) => job.channelName).map((job) => [job.channel, job.channelName!]));
  return channelOptions(jobs, selected)
    .map((value) => ({ value, label: channelLabel(value, names.get(value)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

/** Jobs in one channel, or every job when `channel` is null ("All channels"). */
export const filterJobs = (jobs: readonly JobRow[], channel: string | null): JobRow[] =>
  channel ? jobs.filter((job) => job.channel === channel) : [...jobs];

const time = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

/** Always the three sections in screen order, each newest activity first, whatever order the rows came in. */
export const groupJobs = (jobs: readonly JobRow[]): JobSection[] =>
  ORDER.map((group) => ({
    group,
    title: TITLES[group],
    rows: jobs.filter((job) => job.group === group).sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt)),
  }));

/** How long ago a job last moved, as the mockup shows it: `now`, `12m`, `3h`, `2d`. Empty for a bad date. */
export const ageLabel = (since: string, now: Date): string => {
  const minutes = Math.floor((now.getTime() - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
};

/**
 * The row's status icon. The spinner means "working right now", so it shows only while the daemon is up and reports
 * the job running; from the files alone a running job is `paused` (the bot is stopped or hasn't reported yet). An app
 * task is only ever `running` when T3 itself reported an active run.
 */
export type RowIcon = 'needs-you' | 'failed' | 'running' | 'paused' | 'done';

export const rowIcon = (job: JobRow, status: BotStatus | null): RowIcon => {
  if (job.group === 'needs you') return job.needsYouReason === 'failed' ? 'failed' : 'needs-you';
  // An app task's running state comes from T3 itself, so it is really running whether or not the daemon is up.
  if (job.group === 'running') return status?.state === 'up' || isAppTask(job) ? 'running' : 'paused';
  return 'done';
};

export const ICON_LABELS: Record<RowIcon, string> = {
  'needs-you': 'Needs you',
  failed: 'Failed',
  running: 'Running',
  paused: 'Was running when the bot stopped',
  done: 'Done',
};

const REASON_TEXT: Record<NeedsYouReason, string> = {
  'waiting in T3': 'Waiting on you in T3',
  question: 'A question is open in Slack',
  'owner pinged': 'Blocked, waiting on you in Slack',
  failed: 'Failed',
};

/** The line under a Needs-you row: the owner's question, else the failure, else why it waits. One line only. */
export const rowDetail = (job: JobRow): string | undefined => {
  if (job.group !== 'needs you') return undefined;
  const detail = job.ownerQuestion ?? job.error ?? (job.needsYouReason ? REASON_TEXT[job.needsYouReason] : undefined);
  return detail?.split('\n').find((line) => line.trim())?.trim();
};

/**
 * "requester · channel · title" parts. Slack names show once main has looked them up, raw IDs until then (APP-29).
 * A job T3 couldn't name says so; its key goes in the tooltip.
 */
export const rowParts = (job: JobRow): { requester: string; channel: string; title: string; tooltip: string } => ({
  requester: job.requesterName || job.requester || 'Someone',
  channel: channelLabel(job.channel, job.channelName),
  title: job.title || 'Untitled',
  tooltip: job.title ? `${job.title} (${job.key})` : `T3 had no title for this job (${job.key})`,
});

export type LinkKind = 'slack' | 't3' | 'transcript' | 'pr';

export interface LinkButton {
  kind: LinkKind;
  label: string;
  /** Absent when the job has no such link: the button shows disabled. Links are never guessed. */
  url?: string;
  /** Tooltip, saying why a disabled button is disabled. */
  hint: string;
  /** An ACP run's thread id: the button opens its transcript in the app. */
  transcript?: string;
}

const LINK_HINTS: Record<LinkKind, { label: string; open: string; none: string }> = {
  slack: { label: 'Slack', open: 'Open the Slack thread', none: 'No Slack link: check the bot token in Secrets so the app knows the workspace' },
  t3: { label: 'T3', open: 'Open the T3 thread', none: "T3 didn't return a link for this thread" },
  transcript: { label: 'Transcript', open: 'Open the transcript', none: 'No transcript yet' },
  pr: { label: 'PR', open: 'Open the pull request', none: 'No pull request yet' },
};

/** Only `https:` links become buttons: the main process opens them in the browser. */
const safe = (url: string | undefined): string | undefined => (url && /^https:\/\//.test(url) ? url : undefined);

export const linkButtons = (job: JobRow): LinkButton[] =>
  // An ACP run has no web link: its transcript opens in the app, in the T3 button's place.
  (job.links.transcript ? (['slack', 'transcript', 'pr'] as const) : (['slack', 't3', 'pr'] as const)).map((kind): LinkButton => {
    if (kind === 'transcript') return { kind, label: LINK_HINTS.transcript.label, hint: LINK_HINTS.transcript.open, transcript: job.links.transcript! };
    const url = safe(job.links[kind as 'slack' | 't3' | 'pr']);
    const { label, open, none } = LINK_HINTS[kind];
    const missing = kind === 'slack' && isAppTask(job) ? 'Started in the app: there is no Slack thread' : none;
    return { kind, label, hint: url ? open : missing, ...(url ? { url } : {}) };
  });

export interface CleanupView {
  /** Worktrees that go (dry run) or that were tried (apply). */
  remove: CleanupVerdict[];
  keep: CleanupVerdict[];
  /** One sentence for the dialog or a toast. */
  summary: string;
  /** The apply results that failed. */
  failed: CleanupVerdict[];
}

const worktrees = (count: number): string => `${count} worktree${count === 1 ? '' : 's'}`;

/** The cleanup dialog's lists and summary, for the dry run (`applied` false) or after applying. */
export const cleanupView = (verdicts: readonly CleanupVerdict[], applied: boolean): CleanupView => {
  const remove = verdicts.filter((v) => v.removable);
  const keep = verdicts.filter((v) => !v.removable);
  const failed = applied ? remove.filter((v) => v.removed !== true) : [];
  let summary: string;
  if (!applied) {
    summary = remove.length === 0 ? `Nothing to clean up. ${keep.length} kept.` : `${worktrees(remove.length)} can go. ${keep.length} kept.`;
  } else {
    const removed = remove.length - failed.length;
    summary = `Removed ${worktrees(removed)}.${failed.length ? ` ${failed.length} failed.` : ''}`;
  }
  return { remove, keep, summary, failed };
};

/** Where a verdict's worktree is, for the dialog: the folder name, else the T3 thread. */
export const verdictLabel = (verdict: CleanupVerdict): string =>
  verdict.path?.split('/').filter(Boolean).slice(-2).join('/') || verdict.branch || verdict.threadId;

// ---------------------------------------------------------------------------------------------------------------
// ⌘K (APP-16): the screen's own action, registered by Jobs.tsx
// ---------------------------------------------------------------------------------------------------------------

/** `?cleanup=1` on a Jobs route opens the worktree cleanup dry run, as the Clean up worktrees button does. */
export const CLEANUP_PARAM = 'cleanup';

export const cleanupWorktreesAction: Action = {
  id: 'jobs:cleanup',
  title: 'Clean up worktrees',
  group: 'Actions',
  keywords: ['worktree', 'remove', 'disk', 'prune', 'jobs'],
  button: 'Jobs › Clean up worktrees',
  run: (context) => context.navigate(`/jobs/needs-you?${CLEANUP_PARAM}=1`),
};
