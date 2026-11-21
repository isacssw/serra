// App-level bridge calls (APP-9): info, prefs and opening things outside the window.
import type { Handlers } from '../bridge.ts';
import { mergePrefs } from '../prefs.ts';
import { isExternalUrl } from '../window-options.ts';
import type { HandlerContext } from './context.ts';

export const appHandlers = (context: HandlerContext): Handlers<'app'> => ({
  info: () => ({ ...context.runtime, profileDir: context.profileDirOrNull() }),
  getPrefs: () => context.prefs.get(),
  setPrefs: (patch) => {
    const next = mergePrefs(context.prefs.get(), patch);
    context.prefs.set(next);
    return next;
  },
  openExternal: async (url) => {
    if (typeof url !== 'string' || !isExternalUrl(url)) throw new Error('Only http and https links can be opened.');
    await context.openExternal(url);
  },
  openProfileFolder: async () => { await context.openPath(context.profileDir()); },
  rendered: () => { context.appUpdater?.started(); },
});
