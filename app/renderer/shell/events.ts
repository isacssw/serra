// Window events between the shell and features that hook into it, so those features don't edit the sidebar.

/** The sidebar's ⌘K hint dispatches this on `window`. The command palette (APP-16) listens for it. */
export const OPEN_COMMAND_PALETTE = 'serra:open-command-palette';

/** A shortcut that opens another screen (⌘N, ⌘,) dispatches this first, so the palette doesn't stay over it. */
export const CLOSE_COMMAND_PALETTE = 'serra:close-command-palette';

/** A screen that changed what a sidebar badge counts (say, promoted a proposal) dispatches this to refresh the counts. */
export const REFRESH_COUNTS = 'serra:refresh-counts';
