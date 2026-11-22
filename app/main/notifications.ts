// macOS notifications (APP-24): a job that needs the owner, a failed job and the daemon stopping, from the status
// stream. What to show comes from `notifications.logic.ts`; this file only shows it with Electron. Clicking opens
// the job (on the Jobs screen) or Diagnostics.
import { Notification } from 'electron';
import type { BotEvent, BotStatus, JobSummary } from '../../src/contracts.ts';
import type { AllHandlers } from './ipc/index.ts';
import {
  notificationPlanner, notificationTarget, notificationText, type NotificationPlanner, type PlannedNotification,
} from './notifications.logic.ts';

interface NotificationFeed {
  current(): BotStatus;
  subscribe(listener: { status(status: BotStatus): void; event(event: BotEvent): void }): () => void;
}

export interface SerraNotificationsOptions {
  status: NotificationFeed;
  /** The job's row, for the notification's text. Best effort: a failure falls back to a plain sentence. */
  describe(key: string): Promise<JobSummary | undefined>;
  /** Shows the window on `target` (a route, maybe with `?job=`). */
  open(target: string): void;
  log?: (message: string) => void;
}

export interface SerraNotifications {
  /** The app is about to stop or restart the daemon itself. */
  expectStop(): void;
  /** Call before following another profile. */
  reset(): void;
  stop(): void;
}

export const startNotifications = ({ status, describe, open, log = console.error }: SerraNotificationsOptions): SerraNotifications => {
  const planner: NotificationPlanner = notificationPlanner();
  // macOS drops the click handler of a notification that was garbage collected, so keep each until it's done with.
  const shown = new Set<Notification>();
  let stopped = false;
  const supported = Notification.isSupported();

  const show = async (plan: PlannedNotification | null): Promise<void> => {
    if (!plan || stopped || !supported) return;
    let job: JobSummary | undefined;
    if (plan.kind !== 'stopped') {
      try { job = await describe(plan.key); } catch { job = undefined; }
    }
    if (stopped) return;
    const { title, body } = notificationText(plan, job);
    const notification = new Notification({ title, body });
    const done = (): void => { shown.delete(notification); };
    notification.on('click', () => { done(); open(notificationTarget(plan)); });
    notification.on('close', done);
    notification.on('failed', (_event, error) => { done(); log(`[serra] could not show a notification: ${error}`); });
    shown.add(notification);
    notification.show();
  };
  const safely = (plan: () => PlannedNotification | null): void => {
    try { void show(plan()).catch((error: unknown) => log(`[serra] could not show a notification: ${String(error)}`)); }
    catch (error) { log(`[serra] notification planning failed: ${String(error)}`); }
  };

  // The status at launch is where things start; only what changes after it is news.
  planner.status(status.current());
  const unsubscribe = status.subscribe({
    status: (next) => safely(() => planner.status(next)),
    event: (event) => safely(() => planner.event(event)),
  });

  return {
    expectStop: () => planner.expectStop(),
    reset: () => planner.reset(),
    stop: () => {
      stopped = true;
      unsubscribe();
      for (const notification of shown) notification.close();
      shown.clear();
    },
  };
};

/**
 * Marks the stops the app causes itself (Stop, Restart, Activate, Roll back) as expected, so they don't notify.
 * Wraps the handlers in place, before they are registered, so the window and the menubar both go through it.
 */
export const expectStopsFrom = (handlers: AllHandlers, expectStop: () => void): void => {
  const wrap = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => { expectStop(); return call(...args); };
  handlers.bot.stop = wrap(handlers.bot.stop);
  handlers.bot.restart = wrap(handlers.bot.restart);
  handlers.updates.activate = wrap(handlers.updates.activate);
  handlers.updates.rollback = wrap(handlers.updates.rollback);
};

/** The job's row from the Jobs list, by key. */
export const jobFrom = (handlers: AllHandlers) => async (key: string): Promise<JobSummary | undefined> => {
  const jobs = await handlers.jobs.list();
  return jobs.find((job) => job.key === key);
};
