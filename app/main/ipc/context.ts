// What every IPC handler gets from the main process. Handlers only parse input, call a service in `src/` and
// return its result (spike, Architecture); this context is how they reach the profile and the app.
import type { PrefsStore } from '../prefs.ts';
import type { StatusSource } from '../status.ts';
import type { AppInfo, SerraPushes } from '../bridge.ts';
import type { AppUpdater } from '../app-updater.ts';

export interface HandlerContext {
  /** The profile folder in use. Throws `SetupIncomplete` (src/setup-incomplete.ts) when none is selected. */
  profileDir(): string;
  /** True when `--profile` or `BOT_PROFILE` names the profile, so the window can't switch to another. */
  profilePinned?: boolean;
  /** Asks for a folder in the system's dialog. Null when cancelled. Absent in tests that don't need it. */
  chooseFolder?(options: { title: string; buttonLabel: string; defaultPath?: string }): Promise<string | null>;
  /** Like `profileDir()`, but null instead of throwing. */
  profileDirOrNull(): string | null;
  prefs: PrefsStore;
  status: StatusSource;
  /** Versions and platform; `profileDir` is filled in per call. */
  runtime: Omit<AppInfo, 'profileDir'>;
  /** Opens a web link in the default browser. The caller has checked it is `http(s):`. */
  openExternal(url: string): Promise<void>;
  /** Opens a folder in Finder. */
  openPath(path: string): Promise<void>;
  /** Sends a push to the open window, if any (APP-19 streams release log lines). Absent in tests that don't need it. */
  push?<P extends keyof SerraPushes>(channel: P, payload: SerraPushes[P]): void;
  /** The app's updater (SERRA-46). Absent in tests that don't need it. */
  appUpdater?: AppUpdater;
  /** Runs `task` after `firstMs`, then every `everyMs` (the bot's version check). Absent in tests: nothing is scheduled. */
  every?(firstMs: number, everyMs: number, task: () => void): void;
  /** Tells notifications that the app is about to restart the bot itself, so the stop isn't reported. */
  expectStop?(): void;
  /** The bot follows this app's version: a packaged build (release-source). A copy run from source doesn't lead it. */
  botFollowsApp?: boolean;
  /** Registers what quitting must wait for: a promise while a bot switch is under way, else null. */
  guardQuit?(pending: () => Promise<unknown> | null): void;
}
