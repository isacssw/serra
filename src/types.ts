import type { Phase } from './lifecycle.ts';

/** The fields of `t3 thread show --json` that the bot reads. */
export interface T3Thread {
  threadId: string;
  link: string;
  status: string;
  latestRunId: string | null;
  activeRunId: string | null;
  /** Questions, approvals or secret prompts the run is waiting on in T3's UI. Absent in older T3 versions. */
  pendingRequestCount?: number;
}

export interface T3Message {
  role: string;
  runId?: string;
  text?: string;
}

export interface T3ThreadDetail {
  thread: T3Thread;
  messages: T3Message[];
}

/** One chat thread the bot owns, keyed `${channel}:${threadTs}` in state.json. */
export interface Job {
  t3ThreadId: string;
  channel: string;
  threadTs: string;
  requester: string;
  /** The Slack message carrying the 👀 reaction until its reply is posted. Jobs saved before `pendingReactions` only have this. */
  pendingReactionTs: string | null;
  /** Every Slack message carrying 👀 until the next reply: several can arrive before one turn answers them. */
  pendingReactions?: string[];
  /** An explicitly addressed request is pending, so native Slack loading survives daemon restarts. */
  loadingRequested?: boolean;
  /** The owner sees this thread's replies: they started it, wrote in it, or were cc'd once. */
  ownerFollows?: boolean;
  /** The owner was pinged for a blocker and hasn't written in the thread since, so the same ask isn't pinged again. */
  ownerAskOpen?: boolean;
  lastPostedRunId: string | null;
  /** Where the job is in its lifecycle: idle, following a run, or waiting in T3 (`lifecycle.ts`). */
  phase: Phase;
  createdAt: string;
  /** Last time a request came in or a reply went out. Absent on jobs saved before it existed. */
  lastActivityAt?: string;
  /** Recent thread replies consumed as question answers, so Slack retries cannot answer the next question. */
  answeredQuestionMessages?: string[];
  /** PRs whose review request the bot already posted, so a resumed worker can't post twice. */
  reviewRequestedPrs?: string[];
  /**
   * The message that runs the worker started on its own (following CI, fixing bot findings) keep editing,
   * so a PR's follow-up is one message that changes instead of one post per push. Cleared by any other post,
   * so the next update lands below it.
   */
  statusTs?: string;
  /**
   * The last turn Serra sent answers someone who addressed the bot (a mention, a DM, a request), as opposed to chatter
   * the worker only hears. Recorded when the turn is sent; `t3 thread send` returns no run ID, so it is bound to the
   * run when a poll first sees it.
   */
  nextTurnWaits?: boolean;
  /**
   * The Slack messages this job has taken in, newest last (bounded): a request Slack delivers again, or one replayed
   * after a crash, isn't handed to the worker twice.
   */
  heard?: string[];
  /**
   * A reply Serra is posting: written before the post and cleared after it. Found on a restart, it means the post may
   * have gone out, so Serra looks in the thread for its reply to that run before posting it again (REPLY-009).
   */
  delivering?: {
    runId: string;
    at: string;
    /** The start of the reply's text, to recognise it if Slack doesn't return the metadata. */
    text?: string;
    /** What posting it means for the owner's follow state, applied if the post turns out to have gone out. */
    ownerFollows?: boolean;
    ownerAskOpen?: boolean;
  };
  /** Who sees this thread's replies, as its brief was built for. Absent on jobs from before audiences. */
  visibility?: 'owner' | 'team' | 'external';
  /**
   * Knowledge pages the thread's worker could read, each with who could hear the version it read. A reply only goes
   * where every one of them may be heard; after one is taken back, a follow-up starts a fresh T3 thread.
   */
  knowledgeRead?: Record<string, 'owner' | 'team' | 'external'>;
  /** The snapshot folder the thread's worker reads pages from. When it's gone, the next turn starts a fresh thread. */
  knowledgeDir?: string;
  /** The task branch the thread works on, so a fresh thread can carry on from its committed work. */
  branch?: string;
}

export interface StartThreadInput {
  project: string;
  baseRef: string;
  branch: string;
  title: string;
  brief: string;
  /** Provider instance and model for the worker. T3 uses the project's defaults when absent. */
  provider?: string;
  model?: string;
}

/** A thread that runs in the project's own folder, with no worktree: a meeting run, in Serra's empty meetings folder. */
export type FolderThreadInput = Omit<StartThreadInput, 'baseRef' | 'branch'> & { baseRef?: undefined; branch?: undefined };

export interface IncomingMessage {
  channel: string;
  threadTs: string;
  messageTs: string;
  user: string;
  text: string;
  files?: IncomingFile[];
  /** Present only for a bot message matched to an owner-configured channel trigger. */
  botId?: string;
  /** A human root message admitted by an owner-configured automatic trigger. Revalidated by the handler. */
  automaticTrigger?: boolean;
  /** An @mention, DM, or configured alert. False for a plain message in a thread the bot already owns. */
  direct: boolean;
  /** A message in a one-to-one DM with the bot (Slack's `channel_type: im`), not a mention or a group DM. */
  im?: boolean;
  /**
   * A held request whose start was cut off (the daemon stopped while starting it): when the earlier attempt began.
   * Its T3 thread may exist already, so the bot looks for it before starting another.
   */
  attemptedAt?: string;
}

/** File metadata carried by message and app_mention events, sometimes only an ID. */
export interface IncomingFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  is_external?: boolean;
}
