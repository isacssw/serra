// What every IPC handler gets from the main process. Handlers only parse input, call a service in `src/` and
// return its result (spike, Architecture); this context is how they reach the profile and the app.
import type { PrefsStore } from '../prefs.ts';
import type { StatusSource } from '../status.ts';
import type { AppInfo, SerraPushes } from '../bridge.ts';
import type { AppUpdater } from '../app-updater.ts';
import type { PresenceMap } from '../presence-map.ts';

export interface HandlerContext {
  /** The profile folder in use. Throws `SetupIncomplete` (src/setup-incomplete.ts) when none is selected. */
  profileDir(): string;
  /** True when `--profile` or `BOT_PROFILE` names the profile, so the window can't switch to another. */
  profilePinned?: boolean;
  /** Asks for a folder in the system's dialog. Null when cancelled. Absent in tests that don't need it. */
  chooseFolder?(options: { title: string; buttonLabel: string; defaultPath?: string }): Promise<string | null>;
  /**
   * Asks the owner in a native dialog, outside the window, before something the window asked for runs a command.
   * True only when they confirm. Absent: nothing that needs it goes ahead.
   */
  confirm?(options: { message: string; detail: string; confirmLabel: string }): Promise<boolean>;
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
  /** Tells notifications that the app is about to restart a bot itself (default: the profile in use), so the stop isn't reported. */
  expectStop?(profileDir?: string): void;
  /** Every profile's live status (SB-11). Absent in tests that don't need it: the list reads each daemon once instead. */
  presence?: PresenceMap;
  /** Every profile folder the window can list, in ⌘ order (the bot update looks after each one). Absent: only the one in use. */
  profileDirs?(): string[];
  /** The bot follows this app's version: a packaged build (release-source). A copy run from source doesn't lead it. */
  botFollowsApp?: boolean;
  /** Registers what quitting must wait for: a promise while a bot switch is under way, else null. */
  guardQuit?(pending: () => Promise<unknown> | null): void;
  /** Why the window can't switch profiles right now (a bot update is switching releases), or null. */
  switchBlocked?(): string | null;
  /** Moves a file or folder to the macOS Trash. Absent: nothing that needs it goes ahead. */
  trashItem?(path: string): Promise<void>;
}
