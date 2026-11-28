// What the Mac app answers itself, never the engine: the `app` namespace (APP-9: info, prefs and opening links and
// folders outside the window), and the context that holds it. The engine's half of the context is `CoreContext`
// (src/handlers/context.ts); its `host` is this app's `HostPort`.
import type { CoreContext, HostPort } from '../../src/handlers/context.ts';
import type { AppInfo, Handlers } from './bridge.ts';
import type { AppUpdater } from './app-updater.ts';
import { mergePrefs, type PrefsStore } from './prefs.ts';
import { isExternalUrl } from './window-options.ts';

export interface HostContext extends HostPort {
  prefs: PrefsStore;
  /** Versions and platform; `profileDir` is filled in per call. */
  runtime: Omit<AppInfo, 'profileDir'>;
  /** The profile folder in use, or null (the engine's `profileDirOrNull`). */
  profileDirOrNull(): string | null;
  /** Like `profileDirOrNull`, but throws `SetupIncomplete` when there is none. */
  profileDir(): string;
  /** Opens a web link in the default browser. The caller has checked it is `http(s):`. */
  openExternal(url: string): Promise<void>;
  /** The app's updater (SERRA-46). Absent in tests that don't need it. */
  appUpdater?: AppUpdater;
}

export const appHandlers = (context: HostContext): Handlers<'app'> => ({
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

/** The profile in use, as the engine selects it: kept in the app's prefs, so the next launch opens the same one. */
export const selectProfileIn = (prefs: PrefsStore): CoreContext['selectProfile'] => (dir, options) => {
  prefs.set(mergePrefs(prefs.get(), { profileDir: dir, ...(options?.setupFinished ? { setupDraft: null } : {}) }));
};
