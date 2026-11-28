// What the engine's handlers get from whoever runs them: the Mac app today (app/main/index.ts), a server later.
// Handlers only parse input, call a service in `src/` and return its result (spike, Architecture). The context splits
// in two: the core (`CoreContext`: the profile in use, its status, pushes, timers) and the host (`HostPort`: what only
// the person's own computer can do, such as a dialog or the Finder). `context.host` is every place the engine reaches
// back to that computer, so a remote engine knows what to forward or hide.
import type { AppUpdateView } from '../app-updates.ts';
import type { SerraPushes } from '../api.ts';
import type { PresenceMap } from '../presence-map.ts';
import type { StatusSource } from '../status-source.ts';

/** What only the person's computer can do for the engine: dialogs, the Finder and the Trash. */
export interface HostPort {
  /** Asks for a folder in the system's dialog. Null when cancelled. Absent in tests that don't need it. */
  chooseFolder?(options: { title: string; buttonLabel: string; defaultPath?: string }): Promise<string | null>;
  /**
   * Asks the owner in a native dialog, outside the window, before something the window asked for runs a command.
   * True only when they confirm. Absent: nothing that needs it goes ahead.
   */
  confirm?(options: { message: string; detail: string; confirmLabel: string }): Promise<boolean>;
  /** Opens a file or folder in the Finder (or the app that opens it). */
  openPath(path: string): Promise<void>;
  /** Moves a file or folder to the macOS Trash. Absent: nothing that needs it goes ahead. */
  trashItem?(path: string): Promise<void>;
}

/** The installed Serra's own updater (the Mac app's, SERRA-46). The bot follows its version. */
interface AppUpdaterPort {
  view(): AppUpdateView;
  check(): AppUpdateView | Promise<AppUpdateView>;
  download(): AppUpdateView | Promise<AppUpdateView>;
  cancel(): AppUpdateView | Promise<AppUpdateView>;
  /** Synchronous: by the time it returns, the view says whether Serra is quitting to install. */
  install(): AppUpdateView;
  openInstaller(): AppUpdateView | Promise<AppUpdateView>;
  setPrereleases(choice: boolean | null): AppUpdateView | Promise<AppUpdateView>;
}

export interface CoreContext {
  /** The profile folder in use. Throws `SetupIncomplete` (src/setup-incomplete.ts) when none is selected. */
  profileDir(): string;
  /** Like `profileDir()`, but null instead of throwing. */
  profileDirOrNull(): string | null;
  /**
   * The folder profiles are made and found in (default `~/.local/share/serra`). The packaged `--smoke` gives a
   * throwaway one, so it never sees, or changes, the profiles on the Mac it runs on.
   */
  profileRoot?: string;
  /** True when `--profile` or `BOT_PROFILE` names the profile, so the window can't switch to another. */
  profilePinned?: boolean;
  /**
   * Makes `dir` the profile in use (null: none). `setupFinished`: the setup form that made it is done, so its saved
   * draft is cleared with the same write.
   */
  selectProfile(dir: string | null, options?: { setupFinished?: boolean }): void;
  /** The live status of the profile in use. */
  status: StatusSource;
  /** The installed Serra's version, which the bot follows, and the platform the engine runs on. */
  runtime: { version: string; platform: string };
  /** What only the person's computer can do. */
  host: HostPort;
  /** Sends a push to the open window, if any (APP-19 streams release log lines). Absent in tests that don't need it. */
  push?<P extends keyof SerraPushes>(channel: P, payload: SerraPushes[P]): void;
  /** The installed Serra's updater (SERRA-46). Absent where it can't update itself, and in tests that don't need it. */
  appUpdater?: AppUpdaterPort;
  /** Runs `task` after `firstMs`, then every `everyMs` (the bot's version check). Absent in tests: nothing is scheduled. */
  every?(firstMs: number, everyMs: number, task: () => void): void;
  /** Tells notifications that a bot is about to be restarted on purpose (default: the profile in use), so the stop isn't reported. */
  expectStop?(profileDir?: string): void;
  /** Every profile's live status (SB-11). Absent in tests that don't need it: the list reads each daemon once instead. */
  presence?: PresenceMap;
  /** Every profile folder listed, in ⌘ order (the bot update looks after each one). Absent: only the one in use. */
  profileDirs?(): string[];
  /** The bot follows the installed Serra's version: a packaged build (release-source). A copy run from source doesn't lead it. */
  botFollowsApp?: boolean;
  /** Registers what quitting must wait for: a promise while a bot switch is under way, else null. */
  guardQuit?(pending: () => Promise<unknown> | null): void;
  /** Why the profile in use can't change right now (a bot update is switching releases), or null. */
  switchBlocked?(): string | null;
}
