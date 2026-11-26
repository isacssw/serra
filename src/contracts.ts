/**
 * Shared types for the daemon, the CLI and the desktop app.
 *
 * Every type the app's screens and services pass around lives here, so the daemon, the CLI commands and the app's
 * IPC handlers agree on one shape. Types that already exist elsewhere in `src/` are re-exported, never copied.
 *
 * Rules for later changes:
 * - Import from this file instead of reaching into the module that defines a type.
 * - The Electron renderer imports with `import type` only. The validators and writers re-exported below run in
 *   Node (the CLI, the daemon, the app's main process), not in the window.
 * - A type a later ticket needs and that is missing here goes at the end of the file, in its own block headed
 *   with the ticket, so parallel branches don't edit the same lines.
 */

// ---------------------------------------------------------------------------------------------------------------
// Profile (profile.json)
// ---------------------------------------------------------------------------------------------------------------

export type { AtomicWriteIo, Config, MessageTrigger, Profile, Repository } from './config.ts';
export {
  branchPatternProblem, PROFILE_FILE, readProfileFile, validateProfile, writeFileAtomic, writeProfileFile,
} from './config.ts';
import type { Profile } from './config.ts';

/** A top-level section of `profile.json` the owner can edit as one unit. `version` is not editable. */
export type ProfileSection = Exclude<keyof Profile, 'version'>;

/**
 * When a saved setting takes effect, shown next to it in the app:
 * `now` (the daemon picks it up live), `next job` (read when a job starts), `after restart` (read at daemon start).
 */
export type AppliesWhen = 'now' | 'next job' | 'after restart';

// ---------------------------------------------------------------------------------------------------------------
// Knowledge: pages and proposals (knowledge/ in the profile)
// ---------------------------------------------------------------------------------------------------------------

/** How much the owner can trust a page: confirmed, never confirmed, or confirmed so long ago it needs a look. */
export type PageBadge = 'verified' | 'unverified' | 'stale';

/** A page under `knowledge/` that the index points workers at. */
export interface KnowledgePage {
  /** Path relative to `knowledge/`, like `owner/role.md`. Also the page's ID. */
  path: string;
  /** Header fields. Absent when the header lacks them, which `problems` then reports. */
  type?: string;
  description?: string;
  /** Date the page was written, `YYYY-MM-DD`. */
  written?: string;
  /** Date the owner confirmed the page, `YYYY-MM-DD`, or null while it is unconfirmed. */
  verified: string | null;
  badge: PageBadge;
  /** The area the page belongs to, as the app names it ("How you work", "People"): the list groups by it. */
  area?: string;
  /** A rule on it disagrees with another: it isn't settled, however recently it was confirmed. */
  disputed?: boolean;
  lines: number;
  /** Rule breaks that fail `pnpm knowledge` (missing header field, over the line cap, not indexed). */
  problems: string[];
  /** Things worth a look that don't fail the check (stale verification, a named path that no longer exists). */
  warnings: string[];
}

/** A worker-written page waiting in `knowledge/proposals/` for the owner. */
export interface Proposal {
  /** Path relative to `knowledge/proposals/`, like `2026-11-16-deploys.md`. Also the proposal's ID. */
  path: string;
  /** The date in the file name (`YYYY-MM-DD`), used to group the queue. Null when the name has none. */
  date: string | null;
  description?: string;
  /** The existing page it would replace or extend, relative to `knowledge/`, when there is one. */
  target: string | null;
  /**
   * For a new page: the folder its `target:` header names, relative to `knowledge/`, even when that folder doesn't
   * exist yet. The knowledge interview (APP-26) names one, so promoting into a fresh profile needs no folder first.
   */
  folder?: string;
  /**
   * Who started the thread whose worker wrote it, as Serra recorded when the thread started: not the worker's own
   * `sources:` line. Absent for proposals written outside a recorded thread (the interview, an older brief).
   */
  from?: ProposalSource;
}

/** Where a proposal came from, stamped by Serra on the folder a thread's worker writes proposals to. */
export interface ProposalSource {
  /** The person who started the thread, as Slack names them, or the owner for an app task. */
  who: string;
  /** Whether that person is the owner. */
  owner: boolean;
  /**
   * Where: "Slack", "the app", a meeting the owner sent (SERRA-62), whose edits have their own approval call, or the
   * weekly knowledge review, which only rewrites the owner's own pages.
   */
  via: 'slack' | 'app' | 'meeting' | 'review';
  /** For a meeting's edit: which meeting and item, as the stub names them. The meeting registry decides if it's real. */
  meeting?: { id: string; item: string };
  /** The Slack link to the thread's first message, when there is one. */
  link?: string;
}

/** What the review screen shows side by side. */
export interface ProposalDiff {
  proposal: Proposal;
  /** The target page's text today, or null for a new page. */
  current: string | null;
  proposed: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs (state.json, logs/events.jsonl)
// ---------------------------------------------------------------------------------------------------------------

/** One Slack thread the bot owns, as stored in `state.json`. The app reads it and never writes it. */
export type { Job } from './types.ts';

/** The Jobs screen's groups, in display order: what needs the owner first. */
export type JobGroup = 'needs you' | 'running' | 'done';

/** One row of the Jobs screen, built read-only from `state.json` and `logs/events.jsonl`. */
export interface JobSummary {
  /** The job's `state.json` key, `${channel}:${threadTs}`. */
  key: string;
  group: JobGroup;
  /** The requester's Slack member ID (or the owner's name, for a task started in the app). */
  requester: string;
  /** The Slack channel ID, or `app` for a task started in the app. */
  channel: string;
  /** The requester's Slack display name, once the app has looked it up (APP-29). Absent: show `requester`. */
  requesterName?: string;
  /** The channel as `#name` (or `DM`), once the app has looked it up (APP-29). Absent: show `channel`. */
  channelName?: string;
  title: string;
  createdAt: string;
  /** Last request or reply, falling back to `createdAt`. */
  lastActivityAt: string;
  /** What the owner is asked, for a `needs you` row. */
  ownerQuestion?: string;
  /** Links are absent when unknown, never guessed. */
  /** `transcript`: an ACP run's thread id, opened in the app's transcript view (it has no web link). */
  links: { slack?: string; t3?: string; pr?: string; transcript?: string };
}

// ---------------------------------------------------------------------------------------------------------------
// Live daemon status (status.sock in the profile)
// ---------------------------------------------------------------------------------------------------------------

/** The daemon as the app sees it. `stopped` covers a missing or closed status socket. */
export type BotStatus =
  | { state: 'stopped' }
  | {
    state: 'up';
    pid: number;
    startedAt: string;
    slackConnected: boolean;
    counts: { needsYou: number; running: number };
  };

/**
 * One thing the daemon did. The shape matches a line of `logs/events.jsonl` (`{ at, event, ...fields }`), so the
 * socket and the log carry the same records. The daemon's `events(name, fields)` calls are the source.
 */
export type BotEvent =
  | { at: string; event: 'job_started'; key: string; t3ThreadId: string; requester: string }
  /** `notice`: a setup or withheld notice was posted in place of the run's reply. */
  | { at: string; event: 'reply'; key: string; kind: 'reply' | 'quiet' | 'status_posted' | 'status_edited'; needsOwner?: boolean; notice?: boolean }
  | { at: string; event: 'needs_owner'; key: string }
  | { at: string; event: 'failure'; key: string; error: string };

export type BotEventName = BotEvent['event'];

// ---------------------------------------------------------------------------------------------------------------
// Secrets (Slack tokens)
// ---------------------------------------------------------------------------------------------------------------

/** The tokens the daemon needs. */
export type SecretName = 'SLACK_BOT_TOKEN' | 'SLACK_APP_TOKEN';

/** Where a token's value comes from. The value itself never appears in a contract. */
export type SecretSource =
  | { kind: 'keychain'; service: string; account: string }
  /** A 1Password reference, `op://vault/item/field`. */
  | { kind: '1password'; reference: string }
  /** The profile's `.env`, the CLI fallback. */
  | { kind: 'env' };

/** What the app may know about a token: whether it resolves and when it was last checked. Never the value. */
export interface SecretStatus {
  name: SecretName;
  source: SecretSource;
  set: boolean;
  /** When `auth.test` last passed, or null. */
  verifiedAt: string | null;
  /** Why the last resolve or check failed, without the value. */
  error: string | null;
  /**
   * True when looking for the Keychain item just now failed (locked, timed out), so `set` is unknown rather than
   * false. Absent otherwise. A definite miss is `set: false` without it.
   */
  lookupFailed?: true;
}

// ---------------------------------------------------------------------------------------------------------------
// Releases (prepared.json, active.json)
// ---------------------------------------------------------------------------------------------------------------

/** A release folder made by `pnpm bot prepare`, as recorded in `prepared.json` and `active.json`. */
export type { Prepared as Release } from './deploy.ts';
import type { Prepared } from './deploy.ts';

export interface ReleaseStatus {
  active: Prepared | null;
  /** A prepared release that isn't active yet. */
  prepared: Prepared | null;
  /** Commits on the code's `main` that the active release doesn't have, newest first. */
  newCommits: { sha: string; subject: string }[];
}

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------------------------

/** One `diagnose()` check. */
export type { Diagnostic } from './doctor.ts';

// ---------------------------------------------------------------------------------------------------------------
// Add types for later tickets below, one block per ticket.
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// APP-7: Jobs list and worktree cleanup
// ---------------------------------------------------------------------------------------------------------------

/** Why a job is in Needs you, read from `state.json` and the last event in `logs/events.jsonl`. */
export type NeedsYouReason = 'waiting in T3' | 'question' | 'owner pinged' | 'failed';

/** What `listJobs` returns: the rows to show and every channel that has a job, for the channel filter. */
export interface JobListing {
  jobs: (JobSummary & {
    /** Set on a `needs you` row. */
    needsYouReason?: NeedsYouReason;
    /** The failure message, for a `failed` row. */
    error?: string;
  })[];
  channels: string[];
}

/** One job's worktree and whether cleanup may remove it. */
export type { CleanupReport, Verdict as CleanupVerdict } from './cleanup.ts';

// ---------------------------------------------------------------------------------------------------------------
// APP-6: status socket wire format
// ---------------------------------------------------------------------------------------------------------------

/** One line on `status.sock`: a `BotStatus` snapshot or a `BotEvent`. */
export type { StatusMessage } from './status-socket.ts';
