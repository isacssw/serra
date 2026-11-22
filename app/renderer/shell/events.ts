// Window events between the shell and features that hook into it, so those features don't edit the sidebar.

/** The sidebar's ⌘K hint dispatches this on `window`. The command palette (APP-16) listens for it. */
export const OPEN_COMMAND_PALETTE = 'serra:open-command-palette';

/** A shortcut that opens another screen (⌘N, ⌘,) dispatches this first, so the palette doesn't stay over it. */
export const CLOSE_COMMAND_PALETTE = 'serra:close-command-palette';

/** A screen that changed what a sidebar badge counts (say, promoted a proposal) dispatches this to refresh the counts. */
export const REFRESH_COUNTS = 'serra:refresh-counts';

/**
 * A screen that starts a T3 task (New task, the knowledge interview) dispatches TASK_STARTING before it sends and
 * TASK_SETTLED once T3 answered or the start failed. The star request holds off in between, and until the jobs
 * list loaded after TASK_SETTLED has the task.
 */
export const TASK_STARTING = 'serra:task-starting';
export const TASK_SETTLED = 'serra:task-settled';

/** Wraps a task start in TASK_STARTING and TASK_SETTLED, and reloads the sidebar's counts once it settles. */
export const announceTaskStart = <T,>(start: () => Promise<T>): Promise<T> => {
  window.dispatchEvent(new Event(TASK_STARTING));
  return start().finally(() => {
    window.dispatchEvent(new Event(TASK_SETTLED));
    window.dispatchEvent(new Event(REFRESH_COUNTS));
  });
};
