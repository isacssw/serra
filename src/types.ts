import type { SlackQuestion } from './questions.ts';

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

/** One Slack thread the bot owns, keyed `${channel}:${threadTs}` in state.json. */
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
  /** Polled until a finished run has been posted and nothing new started. */
  watching: boolean;
  createdAt: string;
  /** Last time a request came in or a reply went out. Absent on jobs saved before it existed. */
  lastActivityAt?: string;
  /** The run is waiting on a request in T3's UI and the owner was told in Slack, so it isn't posted twice. */
  waitingInT3?: boolean;
  /** The current native T3 question shown in Slack. Saved so answers and buttons survive daemon restarts. */
  question?: SlackQuestion;
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
  /** The "still working" line shown during a long run someone is waiting on. Deleted when the run's reply is posted. */
  progress?: { ts: string; runId: string; text: string };
  /** The run the bot last saw running, and when it first saw it: how long a run has been going. */
  runSeen?: { runId: string; at: string };
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
