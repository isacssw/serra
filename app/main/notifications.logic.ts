// Which macOS notifications the app shows (APP-24), from the daemon's status stream only: a job that needs the
// owner, a job that failed, and the daemon stopping. Kept free of Electron so it can be tested; `notifications.ts`
// shows them.
//
// Each thing notifies once. The status socket doesn't replay events, but a reconnect, a second subscriber or a
// profile switch must never bring an old notification back, so the planner remembers what it has shown:
// - events by identity (`event`, `key`, `at`), and anything from before the app started is old;
// - a job that needs the owner (or failed) once per episode, until the job moves on;
// - the daemon stopping once per run (`pid` + `startedAt`), and not when the app itself stopped or restarted it.
import type { BotEvent, BotStatus, JobSummary } from '../../src/contracts.ts';
import { DM_LABEL } from '../../src/slack-names.ts';

export type PlannedNotification =
  | { kind: 'needs-owner'; id: string; key: string }
  | { kind: 'failure'; id: string; key: string; error: string }
  | { kind: 'stopped'; id: string };

export interface NotificationPlannerOptions {
  now?: () => Date;
  /** How long a stop the app asked for (stop, restart, activate, roll back) stays expected. */
  expectedStopMs?: number;
  /** How many event identities to remember. Older ones are also older than anything a reconnect could resend. */
  memory?: number;
}

export interface NotificationPlanner {
  /** A status change. Returns the notification to show, if any. */
  status(status: BotStatus): PlannedNotification | null;
  /** A daemon event. Returns the notification to show, if any. */
  event(event: BotEvent): PlannedNotification | null;
  /** The app is about to stop or restart the daemon itself: the next stop isn't news. */
  expectStop(): void;
  /** Another profile is followed: the stop that the switch reports isn't the daemon stopping. */
  reset(): void;
}

const runId = (status: Extract<BotStatus, { state: 'up' }>): string => `${status.pid}@${status.startedAt}`;

export const notificationPlanner = ({ now = () => new Date(), expectedStopMs = 60_000, memory = 1000 }: NotificationPlannerOptions = {}): NotificationPlanner => {
  const since = now().getTime();
  const seen = new Set<string>();
  /** Jobs already notified as needing the owner, until they move on. */
  const owing = new Set<string>();
  /** Jobs already notified as failed, until they move on. */
  const failed = new Set<string>();
  /** Runs whose stop was already handled (notified or expected). */
  const stoppedRuns = new Set<string>();
  let run: string | null = null;
  let expected: { until: number; run: string | null } | null = null;

  const remember = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > memory) seen.delete(seen.values().next().value as string);
    return true;
  };

  return {
    status: (status) => {
      if (status.state === 'up') {
        const current = runId(status);
        // A new run came up: an expected restart is over, whether or not its stop was seen.
        if (expected && expected.run !== current) expected = null;
        run = current;
        return null;
      }
      const ended = run;
      run = null;
      if (ended === null || stoppedRuns.has(ended)) return null;
      stoppedRuns.add(ended);
      const wasExpected = expected !== null && expected.until >= now().getTime();
      expected = null;
      return wasExpected ? null : { kind: 'stopped', id: `stopped:${ended}` };
    },
    event: (event) => {
      const at = Date.parse(event.at);
      if (!Number.isFinite(at) || at < since) return null;
      if (!remember(`${event.event}:${event.key}:${event.at}`)) return null;
      switch (event.event) {
        case 'needs_owner':
          if (owing.has(event.key)) return null;
          owing.add(event.key);
          return { kind: 'needs-owner', id: `needs-owner:${event.key}:${event.at}`, key: event.key };
        case 'failure':
          if (failed.has(event.key)) return null;
          failed.add(event.key);
          return { kind: 'failure', id: `failure:${event.key}:${event.at}`, key: event.key, error: event.error };
        case 'job_started':
          owing.delete(event.key);
          failed.delete(event.key);
          return null;
        case 'reply':
          // The reply that asks the owner comes just before its `needs_owner`; only a real answer moves the job on.
          if (event.kind === 'reply' && event.needsOwner !== true) { owing.delete(event.key); failed.delete(event.key); }
          return null;
        default:
          return null;
      }
    },
    expectStop: () => { expected = { until: now().getTime() + expectedStopMs, run }; },
    reset: () => { run = null; expected = null; },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// What a notification says and where clicking it goes
// ---------------------------------------------------------------------------------------------------------------

/** Notification text goes to Notification Center, so anything shaped like a credential is cut out first. */
const SECRET_PATTERNS: RegExp[] = [
  /\bxox[a-z]-[A-Za-z0-9-]+/g,
  /\bxapp-[A-Za-z0-9-]+/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]+/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bop:\/\/\S+/g,
  /\b(Bearer|token|password|secret)([=:\s]+)\S+/gi,
];

export const redact = (text: string): string => SECRET_PATTERNS.reduce(
  (out, pattern) => out.replace(pattern, (_match, label?: string, separator?: string) => (
    typeof label === 'string' && typeof separator === 'string' ? `${label}${separator}[hidden]` : '[hidden]'
  )),
  text,
);

const MAX_BODY = 140;
const oneLine = (text: string): string => {
  const line = redact(text).replace(/\s+/g, ' ').trim();
  return line.length > MAX_BODY ? `${line.slice(0, MAX_BODY - 1)}…` : line;
};

/**
 * The job's title, with who asked and where once the app knows their Slack names (APP-29): "Sam Rivera in
 * #billing-alerts · Fix the invoice total". Raw Slack IDs stay out. Null when the job isn't in the list (yet).
 */
const describeJob = (job: JobSummary | undefined): string | null => {
  const title = job?.title.trim();
  if (!job || !title) return null;
  const where = job.channelName && job.channelName !== DM_LABEL ? `in ${job.channelName}` : '';
  const who = [job.requesterName?.trim(), where].filter(Boolean).join(' ');
  return who ? `${who} · ${title}` : title;
};

export const notificationText = (plan: PlannedNotification, job?: JobSummary): { title: string; body: string } => {
  switch (plan.kind) {
    case 'needs-owner':
      return { title: 'Serra needs you', body: oneLine(describeJob(job) ?? 'A job is waiting for you.') };
    case 'failure': {
      const what = describeJob(job);
      const error = plan.error.trim() ? plan.error : 'no error message';
      return { title: 'A job failed', body: oneLine(what ? `${what} — ${error}` : error) };
    }
    case 'stopped':
      return { title: 'Serra stopped', body: 'The bot is no longer running. Open Diagnostics to see why.' };
  }
};

/** The window route a click opens: the job on the Jobs screen, or Diagnostics. */
export const notificationTarget = (plan: PlannedNotification): string => (
  plan.kind === 'stopped' ? '/settings/diagnostics' : `/jobs/needs-you?job=${encodeURIComponent(plan.key)}`
);

/** The route part of a target, for a window that opens fresh on the saved screen. */
export const targetScreen = (target: string): string => target.split('?')[0] ?? target;
