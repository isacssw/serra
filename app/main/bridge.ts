/**
 * The typed bridge between the window and the main process: `window.serra` in the renderer.
 *
 * The window has no Node, `require` or file access. Everything it can do is a method below. Each namespace is one
 * screen or area, and its handlers live in `app/main/ipc/<namespace>.ts`. Screen tickets fill in their own handler
 * file and touch this file only when a stub's signature turns out wrong.
 *
 * This module is loaded in three places, so it imports types only, plus one pure module (`setup-incomplete.ts`):
 * - the sandboxed preload (bundled to one CommonJS file; `createBridge` below builds `window.serra`),
 * - the main process (`bridgeMethods` and `invokeChannel` register the handlers),
 * - the renderer (`import type { SerraBridge }`).
 */
import type { Verdict } from '../../src/cleanup.ts';
import type { SectionSetting } from '../../src/profile-settings.ts';
import type { CliOverview } from '../../src/clis.ts';
import type { McpOverview } from '../../src/mcp.ts';
import type { ProposalTargets, Reviewed } from '../../src/proposals.ts';
import type { AboutMe, Visibility } from '../../src/owner-model.ts';
import type { ActivationOutcome, ReleaseOverview, RollbackOutcome, RunningJob } from '../../src/releases.ts';
import type { Prepared } from '../../src/deploy.ts';
import type { AppUpdateView } from './app-updater.ts';
import type { BotSync } from './bot-sync.ts';
import type { InterviewPreview, StartedTask } from '../../src/tasks.ts';
import type { DetectedProject, OwnerConfirmed, ProfileDraft, ProfileSummary, SetupProgress, SlackManifest } from '../../src/setup.ts';
// The one value import: a pure module, so the preload bundle stays free of Node.
import { SETUP_INCOMPLETE, SetupIncomplete } from '../../src/setup-incomplete.ts';
import type {
  AppliesWhen, BotEvent, BotStatus, Diagnostic, JobListing, JobSummary, KnowledgePage, Profile, ProfileSection, Proposal,
  ProposalDiff, ReleaseStatus, SecretName, SecretSource, SecretStatus,
} from '../../src/contracts.ts';

// ---------------------------------------------------------------------------------------------------------------
// App-only types (not about the bot, so they stay out of src/contracts.ts)
// ---------------------------------------------------------------------------------------------------------------

export type Theme = 'system' | 'light' | 'dark';

/** App preferences, kept by the app (electron-store), never in the bot's profile. */
export interface AppPrefs {
  theme: Theme;
  /** The route the window showed last, restored on launch. */
  lastScreen: string | null;
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean };
  /** The bot profile folder the app manages, when `--profile` or `BOT_PROFILE` don't name one. */
  profileDir: string | null;
  /** Offer prerelease versions of the app (Updates). Null: the default, on while the installed version is a prerelease. */
  includePrereleases: boolean | null;
  /** The setup's profile form as typed, so quitting halfway loses nothing. Cleared when the profile is created. */
  setupDraft: Record<string, string> | null;
  /** When to ask for a GitHub star (SERRA-53). Local only: nothing about it leaves the Mac. */
  starPrompt: StarPromptState;
}

/** What setup found on this Mac: the profile in use and any others, each summarised (SERRA-51). */
export interface SetupDetection {
  /** The profile the app uses now, or null. */
  selected: ProfileSummary | null;
  /** Other profiles under the default folder, which the owner can switch to. */
  others: ProfileSummary[];
  /** True when `--profile` or `BOT_PROFILE` names the profile, so the window can't switch it. */
  pinned: boolean;
  /** Where new profiles go. */
  profileRoot: string;
  /** The home folder, so paths can show as `~/…`. */
  home: string;
}

/** The star request's memory (SERRA-53). The rules that read it are in app/renderer/star.logic.ts. */
export interface StarPromptState {
  /** When the app first saw a working bot: the start of "a few days of use". Null until then. */
  since: string | null;
  /** Jobs the window saw finish (running, then done), counted up to the threshold. */
  finished: number;
  /** How many times the card has shown, so it can stop asking for good. */
  asks: number;
  /** The app version the card last showed in. It shows at most once per version. */
  shownIn: string | null;
  /** Not before this time: set when the card shows, so Not now (or closing the window) snoozes it. */
  snoozedUntil: string | null;
  /** Starred, opened the repo, or Don't ask again: never ask again. */
  done: boolean;
}

export interface AppInfo {
  version: string;
  /** Electron's own versions. `node` is the Node inside Electron, not the one the daemon runs on. */
  electron: string;
  node: string;
  platform: string;
  /** The profile folder in use, or null when none is selected. */
  profileDir: string | null;
}

/** What a reversible knowledge action returns, so the screen can offer Undo. */
export interface UndoHandle { undoId: string }

export type BriefDocument = 'brief' | 'policy';

/** The result of saving one profile section, with when it takes effect. `changed` is false for a no-op save. */
export interface SavedSection { profile: Profile; applies: AppliesWhen; changed: boolean }

/** The result of allowing a Slack member (APP-16). `changed` is false when they already had access. */
export interface PersonAdded { slackUserId: string; changed: boolean; applies: AppliesWhen }

// ---------------------------------------------------------------------------------------------------------------
// Request/response surface
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every bridge call, as the main process implements it. Arguments and results must be structured-clone safe
 * (plain data, no functions or class instances). The renderer sees each method returning a Promise.
 * The ticket named on each namespace fills in its handlers.
 */
export interface SerraApi {
  /** App-level (APP-9): preferences, app info, opening links and folders outside the window. */
  app: {
    info(): AppInfo;
    getPrefs(): AppPrefs;
    /** Merges a partial update and returns the saved prefs. Rejects unknown keys and bad values. */
    setPrefs(patch: Partial<AppPrefs>): AppPrefs;
    /** Opens an `https:` or `http:` link (Slack, T3, a PR) in the default browser. */
    openExternal(url: string): void;
    openProfileFolder(): void;
    /** The window drew its first screen. A launch that finishes an update confirms it with this (SERRA-46). */
    rendered(): void;
  };
  /** Setup (APP-27, SERRA-51): find what exists, create the profile, the Slack app, the owner and the service. Tokens use `secrets`. */
  setup: {
    /** Which steps are done, read from the profile's files; the last needs the bot answering. Works with no profile. */
    progress(): SetupProgress;
    /** The profile in use and the others found, with their tokens (presence only) and whether the service runs. */
    detect(): SetupDetection;
    /** Makes an existing profile folder the app's profile. Refuses a folder without a valid profile.json. */
    useProfile(directory: string): SetupDetection;
    /** A folder picked in the system's dialog (a repository, or a profile kept elsewhere), or null when cancelled. */
    chooseFolder(purpose: 'repository' | 'profile'): string | null;
    /** Suggestions for the form: the `gh` login, the Git name, and where new profiles go. */
    defaults(): { githubLogin: string; ownerName: string; profileRoot: string };
    /** The repository's base branch and GitHub name, as the form's suggestions. */
    detectProject(path: string, remote?: string): DetectedProject;
    /** Creates the profile folder and makes it the app's profile. Refuses a folder that has one. */
    create(draft: ProfileDraft): SetupProgress;
    /** The bot's Slack app manifest and the link that creates the app from it. */
    manifest(): SlackManifest;
    /** Confirms the owner's member ID with Slack (bot token) and saves it as the owner. */
    confirmOwner(slackUserId: string): OwnerConfirmed;
    /** Prepares a release and activates it under launchd; `diagnose()` must pass first. Streams on `on.releaseLog`. */
    installService(): ActivationOutcome;
  };
  /** The daemon (APP-11 for start/stop/restart; status from APP-6's socket). */
  bot: {
    status(): BotStatus;
    start(): void;
    stop(): void;
    restart(): void;
  };
  /** Jobs screen (APP-12, services from APP-7). */
  jobs: {
    /** Needs you, Running and Done today, with why a job needs the owner (APP-7's `listJobs` rows). */
    list(): JobListing['jobs'];
    /** Worktree cleanup. Without `apply` it is the dry run the screen shows first. */
    cleanupWorktrees(options: { apply: boolean; days?: number }): Verdict[];
  };
  /** Knowledge proposals (APP-13, services from APP-3). */
  proposals: {
    list(): Proposal[];
    diff(path: string): ProposalDiff;
    /** Folders to promote into and pages to merge into, for the screen's pickers. */
    targets(): ProposalTargets;
    /** Moves the proposal into `folder` (relative to `knowledge/`; defaults to its target page's folder) and indexes it. */
    /** `reviewed`: the proposal and page text the screen showed; refused when either changed since. */
    promote(path: string, folder: string | undefined, reviewed: Reviewed, audience?: Visibility): UndoHandle;
    /** Replaces `target` with `text` (the page as the owner edited it), or with the proposal when it is the whole page for `target`. */
    mergeInto(path: string, target: string, text: string | undefined, reviewed: Reviewed, audience?: Visibility): UndoHandle;
    discard(path: string): UndoHandle;
    undo(undoId: string): void;
  };
  /** Knowledge pages (APP-20). */
  pages: {
    list(): KnowledgePage[];
    read(path: string): string;
    /** `expected`: the text the editor loaded; refused when the page changed since. */
    save(path: string, text: string, expected?: string): KnowledgePage;
    /** Each file under `knowledge/` that changed outside Serra since the owner approved it: its approved text and its text now (null: none). */
    drift(): { path: string; approved: string | null; current: string | null }[];
    /** The owner made this change: the file, exactly as they reviewed it (`current`), becomes approved. */
    acceptDrift(path: string, current: string | null): void;
    /** Put back the approved text of one file, keeping a backup of what was there. */
    restoreDrift(path: string): void;
    /** What every brief carries about the owner for a reply this audience sees, and the owner pages left out. */
    aboutMe(visibility: Visibility): AboutMe;
    /** Pages without an `audience:`, which only the owner's own replies use. */
    untagged(): { path: string; description: string; offlimits: boolean; preview: string; text: string }[];
    /**
     * Set who may hear these pages, each with the text the owner previewed (saved like edits). All or nothing: a page
     * that changed since refuses the whole share.
     */
    share(pages: { path: string; text: string }[], audience: Visibility): { shared: string[] };
  };
  /** Brief and policy (APP-21). */
  brief: {
    read(document: BriefDocument): string;
    /** Validates (placeholders) before an atomic write; a rejected text leaves the file untouched. */
    save(document: BriefDocument, text: string): void;
    /** What would stop `save`, as sentences; empty when the text can be saved. */
    check(document: BriefDocument, text: string): string[];
    /** The brief a worker would get for this sample request: the saved brief, or `draft` when given. */
    preview(request: string, draft?: string): string;
    /** Folder names under the profile's `proposed/`. */
    listProposed(): string[];
    /** A proposal's brief and/or policy text, to compare before applying. */
    readProposed(name: string): Partial<Record<BriefDocument, string>>;
    applyProposed(name: string): void;
  };
  /** Settings pages (APP-14, services from APP-4). */
  settings: {
    read(): Profile;
    /** When a change to each section applies, whether it is required, and any note (APP-4's table). */
    sections(): Record<ProfileSection, SectionSetting>;
    /** Replaces one section; `null` removes an optional one. Validated with `validateProfile` before the write. */
    saveSection(section: ProfileSection, value: unknown): SavedSection;
    /** Allows a Slack member. Adding someone already allowed changes nothing. */
    addPerson(slackUserId: string): SavedSection;
    /** Stops allowing a Slack member. The owner can't be removed. */
    removePerson(slackUserId: string): SavedSection;
  };
  /** Secrets (APP-15, sources from APP-8). Never returns a token's value. */
  secrets: {
    list(): SecretStatus[];
    /** `value` is only for a Keychain source; it is stored and never sent back. */
    setSource(name: SecretName, source: SecretSource, value?: string): SecretStatus;
    /** Resolves the token and runs Slack's `auth.test`. */
    check(name: SecretName): SecretStatus;
  };
  /** Tools (APP-23, SERRA-39), read-only: what the worker can use. MCP servers by name, never their config. */
  tools: {
    /**
     * The MCP servers each provider gives the worker, from `claude mcp list` / `codex mcp list` (or the config
     * files when a CLI is missing), and a warning for each tool an alert trigger needs that the worker won't have.
     */
    overview(request?: { fresh?: boolean }): McpOverview;
    /** The command-line tools Serra knows: installed, version, signed in. And why each recommendation fits. */
    clis(request?: { fresh?: boolean }): CliOverview;
  };
  /**
   * Updates (APP-19, SERRA-46). The app updates from GitHub Releases; the bot follows the app's version on its own
   * (release mode), or, when the profile names a Serra checkout, the owner builds and switches releases by hand
   * (developer mode). Bot actions stream lines on `on.releaseLog`; the app's update state arrives on `on.appUpdate`.
   */
  updates: {
    /** The app's and the bot's state. `fetch` runs `git fetch` first (developer mode). Reads files and git only. */
    status(options?: { fetch?: boolean }): {
      /** The installed app's version. */
      appVersion: string;
      /** The app's update state; null where the app can't update itself (tests). */
      app: AppUpdateView | null;
      /** The bot's releases; null without a profile. */
      releases: ReleaseOverview | null;
      /** Where the bot stands against the app's version. */
      bot: BotSync;
      /** The bot action this app is running now, if any. Only one runs at a time. */
      running: 'prepare' | 'activate' | 'rollback' | 'sync' | null;
      /** The lines of the running or last bot action, so the log survives leaving the screen. */
      log: string[];
    };
    /** Jobs the bot is following, which a restart pauses, for the confirm dialogs. */
    runningJobs(): RunningJob[];
    /** Developer mode: snapshots the code into a new release with a real Node binary (never Electron's). The live bot is untouched. */
    prepare(): Prepared;
    /** Never throws for a failed cutover: the outcome says whether the old release is back and whether to roll back. */
    activate(): ActivationOutcome;
    rollback(): RollbackOutcome;
    /** Brings the bot to the app's version now, even with jobs running (they continue after the restart). */
    syncBot(): { ok: true; waiting: boolean } | { ok: false; error: string };
    /** Looks for a newer release on GitHub. */
    check(): AppUpdateView;
    /** Starts downloading the available update; progress arrives on `on.appUpdate`. */
    download(): AppUpdateView;
    cancelDownload(): AppUpdateView;
    /** Quits, replaces the app with the verified download and opens it again. */
    install(): AppUpdateView;
    /** Opens the verified disk image in Finder, when the app can't replace itself. */
    openInstaller(): AppUpdateView;
    /** Whether to offer prereleases; null is the default (on while the installed version is a prerelease). */
    setPrereleases(choice: boolean | null): AppUpdateView;
  };
  /** Diagnostics (APP-22). */
  diagnostics: {
    run(): Diagnostic[];
    logTail(lines: number): string[];
  };
  /** People (APP-16 for Add allowed user from ⌘K; the People screen's Add button uses the same call). */
  people: {
    /** Allows a Slack member ID through APP-4's `addAllowedUser`. Already allowed (or the owner) is a no-op. */
    add(slackUserId: string): PersonAdded;
  };
  /** New task (APP-25): start a T3 thread with the bot's brief and knowledge, without Slack. */
  tasks: {
    /** The brief the task's worker would get, filled exactly as the daemon fills it. */
    preview(request: string): string;
    /** Starts the thread and records it in the profile's `tasks.json`, so it shows in Jobs. */
    start(request: string): StartedTask;
    /** The knowledge interview's brief (APP-26), and whether it carries on from an earlier interview's notes. */
    previewInterview(): InterviewPreview;
    /** Starts the knowledge interview as a T3 thread, recorded like a task. Its proposals arrive on `on.proposals`. */
    startInterview(): StartedTask;
  };
}

export type Namespace = keyof SerraApi;

/** What main implements for one namespace: the same methods, sync or async. */
export type Handlers<N extends Namespace> = {
  [M in keyof SerraApi[N]]: SerraApi[N][M] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
};

type Promisified<T> = { [M in keyof T]: T[M] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never };

// ---------------------------------------------------------------------------------------------------------------
// Push channels (main → window)
// ---------------------------------------------------------------------------------------------------------------

/** What main pushes to the window, by channel name. */
export interface SerraPushes {
  /** The daemon's status, sent on every change and once when the window loads. `stopped` when the socket is gone. */
  status: BotStatus;
  /** One daemon event (job started, reply, needs owner, failure). */
  event: BotEvent;
  /** One line from a running prepare, activate, rollback or bot update. */
  releaseLog: string;
  /** The app's update state changed: checking, download progress, ready, error. */
  appUpdate: AppUpdateView;
  /** A route to show, with an optional `?job=<key>` (APP-24: clicking a notification). */
  navigate: string;
  /** Something under the profile's `knowledge/proposals/` changed (APP-26): the Proposals queue rereads its list. */
  proposals: null;
  /** Job rows have new details to show (APP-29: Slack names that just resolved): the Jobs screen rereads its list. */
  jobs: null;
}

export type Unsubscribe = () => void;

/** `window.serra`. */
export type SerraBridge = { [N in Namespace]: Promisified<SerraApi[N]> } & {
  on: { [P in keyof SerraPushes]: (listener: (payload: SerraPushes[P]) => void) => Unsubscribe };
};

// ---------------------------------------------------------------------------------------------------------------
// Runtime method list and channels
// ---------------------------------------------------------------------------------------------------------------

/** A method list that fails to type check when it misses or adds a method of `T`. */
type Exactly<T, L extends readonly string[]> =
  [Exclude<keyof T, L[number]>] extends [never]
    ? [Exclude<L[number], keyof T>] extends [never] ? L : { unknownMethods: Exclude<L[number], keyof T> }
    : { missingMethods: Exclude<keyof T, L[number]> };
const methods = <N extends Namespace>() => <const L extends readonly string[]>(list: L & Exactly<SerraApi[N], L>): L => list;

/** Every bridge method by namespace. The type check keeps it equal to `SerraApi`; the preload and main loop over it. */
export const bridgeMethods = {
  app: methods<'app'>()(['info', 'getPrefs', 'setPrefs', 'openExternal', 'openProfileFolder', 'rendered']),
  setup: methods<'setup'>()([
    'progress', 'detect', 'useProfile', 'chooseFolder', 'defaults', 'detectProject', 'create', 'manifest', 'confirmOwner', 'installService',
  ]),
  bot: methods<'bot'>()(['status', 'start', 'stop', 'restart']),
  jobs: methods<'jobs'>()(['list', 'cleanupWorktrees']),
  proposals: methods<'proposals'>()(['list', 'diff', 'targets', 'promote', 'mergeInto', 'discard', 'undo']),
  pages: methods<'pages'>()(['list', 'read', 'save', 'drift', 'acceptDrift', 'restoreDrift', 'aboutMe', 'untagged', 'share']),
  brief: methods<'brief'>()(['read', 'save', 'check', 'preview', 'listProposed', 'readProposed', 'applyProposed']),
  settings: methods<'settings'>()(['read', 'sections', 'saveSection', 'addPerson', 'removePerson']),
  secrets: methods<'secrets'>()(['list', 'setSource', 'check']),
  tools: methods<'tools'>()(['overview', 'clis']),
  updates: methods<'updates'>()([
    'status', 'runningJobs', 'prepare', 'activate', 'rollback', 'syncBot',
    'check', 'download', 'cancelDownload', 'install', 'openInstaller', 'setPrereleases',
  ]),
  diagnostics: methods<'diagnostics'>()(['run', 'logTail']),
  people: methods<'people'>()(['add']),
  tasks: methods<'tasks'>()(['preview', 'start', 'previewInterview', 'startInterview']),
} satisfies { [N in Namespace]: readonly (keyof SerraApi[N])[] };

export const pushChannels = ['status', 'event', 'releaseLog', 'appUpdate', 'navigate', 'proposals', 'jobs'] as const satisfies readonly (keyof SerraPushes)[];

export const invokeChannel = (namespace: string, method: string): string => `serra:${namespace}.${method}`;
export const pushChannel = (name: keyof SerraPushes): string => `serra:on.${name}`;

/**
 * What crosses IPC for an invoke. Main never throws across IPC: Electron would wrap the message in
 * "Error invoking remote method…". The preload turns `ok: false` back into an Error with just the message.
 */
export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: string; code?: typeof SETUP_INCOMPLETE };

/**
 * Builds `window.serra` from two transport functions (the preload passes `ipcRenderer.invoke` and a wrapper of
 * `ipcRenderer.on`). Kept free of Electron so tests can build a bridge over fake transports.
 */
export const createBridge = (
  invoke: (channel: string, args: unknown[]) => Promise<InvokeResult>,
  listen: (channel: string, listener: (payload: unknown) => void) => Unsubscribe,
): SerraBridge => {
  const bridge: Record<string, Record<string, unknown>> = {};
  for (const [namespace, names] of Object.entries(bridgeMethods)) {
    const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of names) {
      api[method] = async (...args: unknown[]) => {
        const result = await invoke(invokeChannel(namespace, method), args);
        if (!result.ok) throw result.code === SETUP_INCOMPLETE ? new SetupIncomplete() : new Error(result.error);
        return result.value;
      };
    }
    bridge[namespace] = api;
  }
  const on: Record<string, (listener: (payload: unknown) => void) => Unsubscribe> = {};
  for (const name of pushChannels) on[name] = (listener) => listen(pushChannel(name), listener);
  bridge.on = on;
  return bridge as unknown as SerraBridge;
};
