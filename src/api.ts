/**
 * The engine's API: every call a window can make, by namespace, and what each answers (`SerraApi`). The handlers that
 * implement it live in `src/handlers/<namespace>.ts` (the engine), except `app` and `servers`, which the Mac app
 * answers itself (`app/main/host.ts`, `app/main/servers.ts`). The app's bridge (`app/main/bridge.ts`) builds
 * `window.serra` from it; a server's gateway (`src/gateway/server.ts`) serves the engine's calls.
 *
 * Pure and types only, but for `bridgeMethods`: the app's sandboxed preload bundles this module, so it may not import
 * a Node value.
 */
import type { Verdict } from './cleanup.ts';
import type { SectionSetting } from './profile-settings.ts';
import type { CliOverview } from './clis.ts';
import type { McpOverview } from './mcp.ts';
import type { ProposalTargets, Reviewed } from './proposals.ts';
import type { AboutMe, Visibility } from './owner-model.ts';
import type { KnowledgeGraph } from './knowledge-graph.ts';
import type { KnowledgeOverview } from './knowledge-overview.ts';
import type { KnowledgeReview } from './knowledge-review-store.ts';
import type { ActivationOutcome, ReleaseOverview, RollbackOutcome, RunningJob } from './releases.ts';
import type { Prepared } from './deploy.ts';
import type { ClearedSource } from './update-migration.ts';
import type { AppUpdateView } from './app-updates.ts';
import type { BotSync } from './bot-sync.ts';
import type { InterviewPreview, StartedTask } from './tasks.ts';
import type { MeetingReviewed, MeetingView } from './meeting-store.ts';
import type { MeetingSettings } from './meeting-settings.ts';
import type { MeetingRunner } from './meeting-runs.ts';
import type { AgentBackendView, CustomAcpAgentInput } from './agent/acp-agents.ts';
import type { EveCheckView, EveInput } from './agent/eve-connect.ts';
import type { RunChat } from './agent/runs-view.ts';
import type { MeetingProvider, ProviderStatus } from './meeting-sources.ts';
import type { T3Providers } from './t3-providers.ts';
import type { PairOutcome, PairProbe, ServerView } from './gateway/pairing.ts';
import type { ServerHealth } from './gateway/health.ts';
import type { DetectedProject, OwnerConfirmed, ProfileDraft, ProfileSummary, SetupProgress, SlackManifest } from './setup.ts';
// Pure: the app's preload bundles this module, so it imports types only, plus this one pure module.
import type { SETUP_INCOMPLETE } from './setup-incomplete.ts';
import type {
  AppliesWhen, BotEvent, BotStatus, ChannelsView, Diagnostic, JobListing, KnowledgePage, Profile, ProfileSection, Proposal,
  ProposalDiff, SecretName, SecretSource, SecretStatus,
} from './contracts.ts';

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

/** One profile as the switcher and Settings › Profiles show it (SB-10). The window derives letters, colours and ⌘ numbers. */
export interface ProfileEntry {
  /** `local/<folder>` for a profile folder in the profiles folder; the folder path for one kept elsewhere. */
  ref: string;
  dir: string;
  /** The bot's name from profile.json, or the folder's name when that can't be read. */
  name: string;
  /** Its avatar colour: the one kept in profiles.json, else the first one free. */
  color: string;
  /** The profile the window shows. */
  active: boolean;
  /** Every setup step is done. A profile left halfway shows "Finish setup". */
  setupDone: boolean;
  /**
   * The daemon's last report, as main follows every profile live (SB-11); `presence` pushes each change. Null for the
   * active profile (the window follows it live) and before a daemon's first report (`checking`).
   */
  status: BotStatus | null;
  /** The agent new work uses: T3, or the ACP agent's name. */
  agent: string;
  /** The host of its agent on Vercel (eve), for the small cloud mark; null when its agent is on this Mac. */
  cloud?: string | null;
}

export interface ProfilesView {
  profiles: ProfileEntry[];
  /** `--profile` names the profile: no switcher, no Add. */
  pinned: boolean;
  /** The avatar colours to pick from. */
  palette: string[];
}

/** A device that can reach a paired server, as Settings › Servers lists it. Never its token. */
export interface ServerDevice {
  id: string;
  name: string;
  addedAt: string;
  lastUsed: string | null;
  /** This Mac: it has Forget instead of Revoke. */
  thisMac: boolean;
}

export type { ServerHealth };

/** What Add… › Profile creates: the setup form, plus the colour and agent picked first. */
export interface NewProfile {
  draft: ProfileDraft;
  color: string | null;
  /** An ACP agent's id, or null for T3. `eve-cloud` with `eve`: the agent on Vercel. */
  agent: string | null;
  /** The agent on Vercel, with the host whose notice the owner accepted. Saved with the new profile. */
  eve?: EveInput | null;
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
interface PersonAdded { slackUserId: string; changed: boolean; applies: AppliesWhen }

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
  /**
   * Servers this Mac is paired with (SB-32), answered by the Mac app itself, like `app`: the pairing and the Keychain
   * are this Mac's. Pair with a code (probe, compare the words, then the code) or over SSH with the owner's keys.
   */
  servers: {
    /** Reaches the address and reads its certificate: the server's name, and the three words for it and the code. Sends no secret. */
    probe(address: string, code: string): PairProbe;
    /** Sends the code to the probed server, once the owner said the words match. */
    pair(probeId: string, code: string): PairOutcome;
    /** Drops a probe: the words didn't match, or the dialog closed. */
    cancel(probeId: string): void;
    /** Pairs over SSH with the owner's own keys. `detail` says in a few words why it failed. */
    pairOverSsh(target: string): { ok: true; server: ServerView } | { ok: false; detail: string; message: string };
    /** The servers this Mac is paired with. */
    list(): { id: string; name: string }[];
    /** Every paired server's state and profiles, as main follows them live (SB-33); `on.servers` pushes each change. */
    status(): ServerHealth[];
    /** Connects to the server again now, without waiting (Retry). */
    retry(serverId: string): void;
    /** The devices that can reach the server, this Mac marked. Needs the server up. */
    devices(serverId: string): ServerDevice[];
    /** Cuts another device off the server. This Mac is refused: Forget is how it leaves. */
    revoke(serverId: string, deviceId: string): ServerDevice[];
    /** Unpairs: revokes this Mac on the server when it can, then drops its entry and key here. Deletes no data. */
    forget(serverId: string): { revoked: boolean };
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
  /** Profiles (SB-10): the list in ⌘ order, switching, order, colour, Add and a remove that keeps a backup. */
  profiles: {
    /** Every profile in the profiles folder (and the one in use, if it is kept elsewhere). Writes nothing. */
    list(): ProfilesView;
    /** Makes the profile the one the window shows. Refused while pinned, or while a bot update is switching. */
    switch(ref: string): ProfilesView;
    /** Moves a profile to `index` in the order, which is ⌘1…⌘9. */
    move(ref: string, index: number): ProfilesView;
    setColor(ref: string, color: string): ProfilesView;
    /** Creates the profile, last in the order, and makes it the one in use. Setup goes on from its Slack step. */
    create(input: NewProfile): SetupProgress;
    /** Stops it, saves a checked backup, then moves the folder to the Trash. Its Slack app and Keychain tokens stay. */
    remove(ref: string): { backup: string; view: ProfilesView };
    /** Opens a backup folder `remove` made in Finder. */
    showBackup(path: string): void;
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
    /**
     * A job's run as the chat view shows it (`JobSummary.chat`): an ACP run from its record, with the turn streaming
     * and what it waits on; a T3 run's messages and state through its backend. Null when Serra has no record of it.
     */
    chat(run: { threadId: string; backend: 'acp' | 't3'; title?: string }): RunChat | null;
    /** An image a run's messages name, as a data URL, from Serra's attachments or agent images only. Null otherwise. */
    image(path: string): string | null;
    /** Sends a follow-up to a run, through the bot. On ACP it queues behind a turn that's going. */
    reply(run: { threadId: string; backend: 'acp' | 't3' }, message: string): void;
    /** Answers a question an ACP run waits on, through the bot. */
    answer(threadId: string, requestId: string, answers: Record<string, unknown>): void;
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
    /** Moves a page to `archive/` and takes its index row out. `reviewed`: the page's text as the owner saw it. */
    retire(page: string, reviewed: string): UndoHandle;
    /** True when this proposal is a weekly-review rewrite of a page that changed since the review saw it. */
    staleRewrite(path: string): boolean;
    /** Pages retired to the archive, with their descriptions. */
    archived(): { path: string; description: string }[];
    /** Bring a retired page back where it was, with an index row. */
    restore(page: string): UndoHandle;
    /** Existing pages the proposal looks like, with the lines they share: where it may belong instead of a new page. */
    similar(path: string): { path: string; similarity: number; shared: string[]; disagrees: { page: string; proposal: string } | null }[];
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
    /** Knowledge › Overview: health, how it grew, and what replies used. */
    overview(): KnowledgeOverview;
    /** Knowledge › Graph: the pages the bot reads and how they link (mentions, sources, used together, disagreements). */
    graph(): KnowledgeGraph;
    /** Run the weekly knowledge review now, through T3, and return its digest. */
    runReview(): Promise<KnowledgeReview>;
    /** Turn the weekly review on or off. */
    setReviewWeekly(weekly: boolean): void;
    /** "Both hold, not a conflict": the pair (by `PairInfo.id`) is no longer listed. Kept in the profile; no page changes. */
    bothHold(id: string): void;
    /** List a pair set aside with `bothHold` again. */
    undoBothHold(id: string): void;
    /** Whether "Still true" may be offered for this page: false when a rule on it disagrees, or a newer page on its topic may have changed it. */
    canConfirm(path: string): boolean;
    /** Rules on this page that disagree with or repeat another, as the page is on disk now, for the editor. */
    issues(path: string): KnowledgeOverview['health']['issues'];
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
    /**
     * The Slack names known for these member IDs, by ID; IDs without one are left out. Never waits: the running bot is
     * asked for the rest, and a `names` push says when they arrive. The app never reads the bot token for this.
     */
    peopleNames(slackUserIds: string[]): Record<string, string>;
    /** T3's provider instances on this Mac, for Worker's provider picker; null when T3's settings can't be read. */
    t3Providers(): T3Providers | null;
  };
  /** Secrets (APP-15, sources from APP-8). Never returns a token's value. */
  secrets: {
    list(): SecretStatus[];
    /** `value` is only for a Keychain source; it is stored and never sent back. */
    setSource(name: SecretName, source: SecretSource, value?: string): SecretStatus;
    /** Resolves the token and runs Slack's `auth.test`. */
    check(name: SecretName): SecretStatus;
  };
  /** Channels (SB-5): chats the bot serves beside Slack. Telegram and Discord. Tokens go through `secrets`' sources, never back to the window. */
  channels: {
    status(): ChannelsView;
    /**
     * Checks a Telegram bot token with Telegram and keeps it in the Keychain, or points at a 1Password reference
     * (`op://…`) to one, then connects the bot. It is served once the bot restarts; the owner pairs by opening the link.
     */
    connectTelegram(tokenOrReference: string): ChannelsView;
    /** Forgets the Telegram bot and its owner. Applies when the bot restarts. */
    disconnectTelegram(): ChannelsView;
    /**
     * Checks a Discord bot token with Discord (and that its Message Content intent is on) and keeps it like Telegram's,
     * then connects the bot. The owner adds it to a server and DMs it the pairing code.
     */
    connectDiscord(tokenOrReference: string): ChannelsView;
    /** Forgets the Discord bot and its owner. Applies when the bot restarts. */
    disconnectDiscord(): ChannelsView;
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
      /** The bot can follow this app's version (a packaged app), so developer mode is a choice the owner can leave. */
      followsApp: boolean;
      /** The last update source Serra cleared on its own for this profile in the past week, for a one-line notice. Null in developer mode. */
      sourceCleared: ClearedSource | null;
    };
    /** Jobs the bot is following, which a restart pauses, for the confirm dialogs. */
    runningJobs(): RunningJob[];
    /** Developer mode: snapshots the code into a new release with a real Node binary (never Electron's). The live bot is untouched. */
    prepare(): Prepared;
    /** Never throws for a failed cutover: the outcome says whether the old release is back and whether to roll back. */
    activate(): ActivationOutcome;
    rollback(): RollbackOutcome;
    /** Leaves developer mode: backs up profile.json, then removes `updates` so the bot follows the app again. */
    followApp(): ClearedSource | null;
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
  /** Meetings (SERRA-62): the opt-in, which transcript sources work, and each meeting's edits for review. */
  meetings: {
    /** Whether capture is on, and the notice the owner acknowledges by turning it on. */
    settings(): MeetingSettings & { notice: string };
    setEnabled(enabled: boolean): MeetingSettings & { notice: string };
    /**
     * Which T3 provider and model meeting runs use, and each transcript source with its last Test's answer (untested
     * after a week or a change of provider or model). Reads files only: no model call, no T3 run.
     */
    sources(): { runner: MeetingRunner; sources: ProviderStatus[] };
    /** The owner's Test button: one read-only T3 run asks the provider whether it could read this source. Kept. */
    testSource(provider: MeetingProvider): ProviderStatus;
    /** Meetings with edits waiting, each rendered against the page as it is now. */
    list(): MeetingView[];
    /** Every meeting Serra kept anything from, for Forget meeting. */
    history(): Pick<MeetingView, 'id' | 'title' | 'date' | 'source' | 'createdAt' | 'pages' | 'state'>[];
    /** Approve one edit as the screen showed it. Undo goes through `proposals.undo`. */
    approve(id: string, item: string, reviewed: MeetingReviewed): UndoHandle;
    discard(id: string, item: string): void;
    /** Discard every pending edit of a meeting and its evidence. Can't be undone. */
    discardMeeting(id: string): void;
    /** Remove everything a meeting added, everywhere. Can't be undone. */
    forget(id: string): { pages: string[]; backups: number; snapshots: number };
    /** Which agent backend new work uses (T3 by default), and the ACP agents found on this Mac. Reads files and PATH only. */
    agentBackend(): AgentBackendView;
    /** Picks T3, or an installed ACP agent and its model, for new work. */
    setAgentBackend(choice: { backend: 't3' | 'acp'; agent?: string | null; model?: string }): AgentBackendView;
    /** Adds a custom ACP agent to `agent-backend.json` and returns the refreshed view. */
    addAcpAgent(input: CustomAcpAgentInput): AgentBackendView;
    /** Removes a custom ACP agent from `agent-backend.json` and returns the refreshed view. */
    removeAcpAgent(id: string): AgentBackendView;
    /** Starts eve at the URL and opens a session, no prompt, once the notice for its host was accepted. Saves nothing new. */
    checkEve(input: EveInput): EveCheckView;
    /** Checks, then saves eve as the profile's agent (its secret in the Keychain). A failed Check changes nothing. */
    connectEve(input: EveInput): AgentBackendView;
    /** Removes eve and its Keychain item; new work goes back to T3. */
    disconnectEve(): AgentBackendView;
    /** Creates `agent-backend.json` if missing and opens it outside the app for manual editing. */
    openAgentBackendConfig(): void;
  };
}

export type Namespace = keyof SerraApi;

/** What the engine implements for one namespace: the same methods, sync or async. */
export type Handlers<N extends Namespace> = {
  [M in keyof SerraApi[N]]: SerraApi[N][M] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
};

// ---------------------------------------------------------------------------------------------------------------
// Pushes (to the window)
// ---------------------------------------------------------------------------------------------------------------

/** What the engine and the app push to the window, by channel name. */
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
  /** Slack names just resolved: screens that show people (Settings › People) ask for them again. */
  names: null;
  /** `agent-backend.json` changed on disk: Settings › Worker rereads its ACP agent list. */
  agentBackend: null;
  /** The profiles changed: another one is in use, or one was added, moved, recoloured or removed. */
  profiles: null;
  /** Every listed profile's live status, by folder, whenever one changes (SB-11). Null: no report yet. */
  presence: Record<string, BotStatus | null>;
  /** Every paired server's state and profiles, whenever one changes (SB-33). */
  servers: ServerHealth[];
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime method list
// ---------------------------------------------------------------------------------------------------------------

/** A method list that fails to type check when it misses or adds a method of `T`. */
type Exactly<T, L extends readonly string[]> =
  [Exclude<keyof T, L[number]>] extends [never]
    ? [Exclude<L[number], keyof T>] extends [never] ? L : { unknownMethods: Exclude<L[number], keyof T> }
    : { missingMethods: Exclude<keyof T, L[number]> };
const methods = <N extends Namespace>() => <const L extends readonly string[]>(list: L & Exactly<SerraApi[N], L>): L => list;

/** Every method by namespace. The type check keeps it equal to `SerraApi`; the app's preload and router loop over it. */
export const bridgeMethods = {
  app: methods<'app'>()(['info', 'getPrefs', 'setPrefs', 'openExternal', 'openProfileFolder', 'rendered']),
  servers: methods<'servers'>()(['probe', 'pair', 'cancel', 'pairOverSsh', 'list', 'status', 'retry', 'devices', 'revoke', 'forget']),
  setup: methods<'setup'>()([
    'progress', 'detect', 'useProfile', 'chooseFolder', 'defaults', 'detectProject', 'create', 'manifest', 'confirmOwner', 'installService',
  ]),
  profiles: methods<'profiles'>()(['list', 'switch', 'move', 'setColor', 'create', 'remove', 'showBackup']),
  bot: methods<'bot'>()(['status', 'start', 'stop', 'restart']),
  jobs: methods<'jobs'>()(['list', 'cleanupWorktrees', 'chat', 'image', 'reply', 'answer']),
  proposals: methods<'proposals'>()(['list', 'diff', 'targets', 'promote', 'mergeInto', 'discard', 'undo', 'retire', 'similar', 'archived', 'restore', 'staleRewrite']),
  pages: methods<'pages'>()(['list', 'read', 'save', 'drift', 'acceptDrift', 'restoreDrift', 'aboutMe', 'untagged', 'share', 'overview', 'graph', 'issues', 'canConfirm', 'bothHold', 'undoBothHold', 'runReview', 'setReviewWeekly']),
  brief: methods<'brief'>()(['read', 'save', 'check', 'preview', 'listProposed', 'readProposed', 'applyProposed']),
  settings: methods<'settings'>()(['read', 'sections', 'saveSection', 'addPerson', 'removePerson', 'peopleNames', 't3Providers']),
  secrets: methods<'secrets'>()(['list', 'setSource', 'check']),
  channels: methods<'channels'>()(['status', 'connectTelegram', 'disconnectTelegram', 'connectDiscord', 'disconnectDiscord']),
  tools: methods<'tools'>()(['overview', 'clis']),
  updates: methods<'updates'>()([
    'status', 'runningJobs', 'prepare', 'activate', 'rollback', 'syncBot', 'followApp',
    'check', 'download', 'cancelDownload', 'install', 'openInstaller', 'setPrereleases',
  ]),
  diagnostics: methods<'diagnostics'>()(['run', 'logTail']),
  people: methods<'people'>()(['add']),
  tasks: methods<'tasks'>()(['preview', 'start', 'previewInterview', 'startInterview']),
  meetings: methods<'meetings'>()(['settings', 'setEnabled', 'sources', 'testSource', 'list', 'history', 'approve', 'discard', 'discardMeeting', 'forget', 'agentBackend', 'setAgentBackend', 'addAcpAgent', 'removeAcpAgent', 'checkEve', 'connectEve', 'disconnectEve', 'openAgentBackendConfig']),
} satisfies { [N in Namespace]: readonly (keyof SerraApi[N])[] };

/**
 * What one call answers, as it crosses to the window (Electron's IPC today, a gateway later). A handler never throws
 * across it: Electron would wrap the message in "Error invoking remote method…". The client turns `ok: false` back
 * into an Error with just the message, and `code` into `SetupIncomplete`.
 */
export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: string; code?: typeof SETUP_INCOMPLETE };
