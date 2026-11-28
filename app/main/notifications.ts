// macOS notifications (APP-24): a job that needs the owner, a failed job and the daemon stopping, from every
// profile's status stream (SB-11). What to show comes from `notifications.logic.ts`; this file only shows it with
// Electron. Each profile has its own planner, so one profile's news never answers for another's, and at most one
// notification per profile per 10 seconds (a burst becomes one). Clicking switches to that profile and opens the job
// (on the Jobs screen) or Diagnostics.
import { resolve } from 'node:path';
import { Notification } from 'electron';
import type { BotEvent, BotStatus, JobSummary } from '../../src/contracts.ts';
import { listJobs } from '../../src/jobs.ts';
import type { AllHandlers } from './router.ts';
import type { FollowedProfile } from '../../src/presence-map.ts';
import {
  burstGate, notificationPlanner, notificationTarget, notificationText, type NotificationPlanner, type PlannedNotification,
} from './notifications.logic.ts';

/** Every profile's stream, as `presence-map.ts` gives it. */
interface NotificationFeeds {
  profiles(): readonly FollowedProfile[];
  status(dir: string): BotStatus | null;
  subscribe(listener: {
    status?(dir: string, status: BotStatus | null): void;
    event?(dir: string, event: BotEvent): void;
    profiles?(profiles: readonly FollowedProfile[]): void;
  }): () => void;
}

export interface SerraNotificationsOptions {
  feeds: NotificationFeeds;
  /** The job's row in that profile, for the notification's text. Best effort: a failure falls back to a plain sentence. */
  describe(dir: string, key: string): Promise<JobSummary | undefined>;
  /** Shows the window on `target` (a route, maybe with `?job=`), switched to the profile of `dir`. */
  open(dir: string, target: string): void;
  /** Titles name the profile once there are two or more, unless the app is pinned to one. */
  namesProfiles(): boolean;
  log?: (message: string) => void;
}

export interface SerraNotifications {
  /** The app is about to stop or restart the daemon of `dir` itself. */
  expectStop(dir: string): void;
  stop(): void;
}

export const startNotifications = ({ feeds, describe, open, namesProfiles, log = console.error }: SerraNotificationsOptions): SerraNotifications => {
  const planners = new Map<string, NotificationPlanner>();
  const gate = burstGate();
  const timers = new Map<string, NodeJS.Timeout>();
  // macOS drops the click handler of a notification that was garbage collected, so keep each until it's done with.
  const shown = new Set<Notification>();
  let stopped = false;
  const supported = Notification.isSupported();

  const nameOf = (dir: string): string | null => {
    if (!namesProfiles()) return null;
    return feeds.profiles().find((profile) => profile.dir === dir)?.name ?? null;
  };

  const show = async (dir: string, plan: PlannedNotification): Promise<void> => {
    if (stopped || !supported) return;
    let job: JobSummary | undefined;
    if (plan.kind === 'needs-owner' || plan.kind === 'failure') {
      try { job = await describe(dir, plan.key); } catch { job = undefined; }
    }
    if (stopped) return;
    const { title, body } = notificationText(plan, job, nameOf(dir));
    const notification = new Notification({ title, body });
    const done = (): void => { shown.delete(notification); };
    notification.on('click', () => { done(); open(dir, notificationTarget(plan)); });
    notification.on('close', done);
    notification.on('failed', (_event, error) => { done(); log(`[serra] could not show a notification: ${error}`); });
    shown.add(notification);
    notification.show();
  };
  const display = (dir: string, plan: PlannedNotification | null): void => {
    if (!plan) return;
    void show(dir, plan).catch((error: unknown) => log(`[serra] could not show a notification: ${String(error)}`));
  };
  const schedule = (dir: string): void => {
    const due = gate.dueAt(dir);
    if (due === null || timers.has(dir) || stopped) return;
    timers.set(dir, setTimeout(() => {
      timers.delete(dir);
      display(dir, gate.flush(dir));
    }, Math.max(0, due - Date.now())));
  };
  const offer = (dir: string, plan: () => PlannedNotification | null): void => {
    try {
      const planned = plan();
      if (!planned || planned.kind === 'burst') { display(dir, planned); return; }
      const now = gate.offer(dir, planned);
      if (now) display(dir, now);
      else schedule(dir);
    } catch (error) { log(`[serra] notification planning failed: ${String(error)}`); }
  };

  /** A profile's planner, made when it is first seen: the status it has then is where things start. */
  const planner = (dir: string): NotificationPlanner => {
    let found = planners.get(dir);
    if (!found) {
      found = notificationPlanner();
      const status = feeds.status(dir);
      if (status) found.status(status);
      planners.set(dir, found);
    }
    return found;
  };
  const forget = (dir: string): void => {
    planners.delete(dir);
    gate.forget(dir);
    clearTimeout(timers.get(dir));
    timers.delete(dir);
  };

  for (const profile of feeds.profiles()) planner(profile.dir);
  const unsubscribe = feeds.subscribe({
    status: (dir, status) => {
      if (status === null) { forget(dir); return; }
      // A profile's first report is where it starts, not news.
      if (!planners.has(dir)) { planner(dir); return; }
      offer(dir, () => planner(dir).status(status));
    },
    event: (dir, event) => offer(dir, () => planner(dir).event(event)),
    profiles: (profiles) => {
      const dirs = new Set(profiles.map((profile) => profile.dir));
      for (const dir of [...planners.keys()]) if (!dirs.has(dir)) forget(dir);
    },
  });

  return {
    expectStop: (dir) => planner(dir).expectStop(),
    stop: () => {
      stopped = true;
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const notification of shown) notification.close();
      shown.clear();
    },
  };
};

/**
 * Marks the stops the app causes itself (Stop, Restart, Activate, Roll back) as expected, so they don't notify.
 * Wraps the handlers in place, before they are registered, so the window and the menubar both go through it.
 * These act on the profile in use.
 */
export const expectStopsFrom = (handlers: AllHandlers, expectStop: () => void): void => {
  const wrap = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => { expectStop(); return call(...args); };
  handlers.bot.stop = wrap(handlers.bot.stop);
  handlers.bot.restart = wrap(handlers.bot.restart);
  handlers.updates.activate = wrap(handlers.updates.activate);
  handlers.updates.rollback = wrap(handlers.updates.rollback);
};

/**
 * The job's row by key: from the Jobs list (with Slack names) for the profile in use, else read from that profile's
 * own files, so one profile's notification never describes another's job.
 */
export const jobFrom = (handlers: AllHandlers, activeDir: () => string | null) => async (dir: string, key: string): Promise<JobSummary | undefined> => {
  const active = activeDir();
  const jobs = active !== null && resolve(dir) === resolve(active) ? await handlers.jobs.list() : (await listJobs(dir)).jobs;
  return jobs.find((job) => job.key === key);
};
