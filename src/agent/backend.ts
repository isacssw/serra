// Serra's agent layer: one interface every agent harness sits behind. T3 Code is the default (src/agent/t3.ts); an
// ACP agent (Claude Code, Codex, OpenCode, Gemini CLI, … through the Agent Client Protocol, src/agent/acp.ts) is the
// owner's other choice. Features call this interface, never a harness's CLI or protocol, so a feature works on any
// backend whose `capabilities` cover what it needs, and says so plainly when one doesn't.
//
// Pure: types and small helpers only, no `node:` values.
import type { T3Answers, T3QuestionRequest } from '../t3-questions.ts';
import type { StartThreadInput } from '../types.ts';

type BackendId = 't3' | 'acp';

/** What a backend can do beyond the basics. A feature checks these, and degrades or refuses, before relying on one. */
export interface BackendCapabilities {
  /** A message can go into a run that is still going, not only queue for the next turn. */
  steer: boolean;
  /** The backend makes git worktrees itself. Without it, Serra makes them (src/agent/worktree.ts). */
  worktrees: boolean;
  /** A run carries on, and can be read again, after Serra restarts. */
  persistentRuns: boolean;
  /** A run has a link the owner can open to see its whole transcript. */
  transcriptLink: boolean;
  /** A run can be started read-only, where any tool that needs approval is refused, and Serra can stop it. */
  readOnly: boolean;
  /** A run's raw tool results can be read back (meeting links read the transcript from the tool, not the model). */
  toolResults: boolean;
}

/** Where a run works: a new worktree of a project (jobs, tasks), or a plain folder (meeting runs). */
type RunWorkspace =
  | { kind: 'worktree'; project: string; baseRef: string; branch: string }
  | { kind: 'folder'; path: string; /** The folder's name where the backend lists it (T3: its project title). */ name: string };

export interface StartRun {
  workspace: RunWorkspace;
  title: string;
  /** The first message. */
  brief: string;
  /** The backend's provider (T3: provider instance) and model. The backend's defaults when absent. */
  provider?: string;
  model?: string;
  /** Read-only: any tool that needs approval is refused and the run stops to say so. Serra can stop it. */
  readOnly?: boolean;
}

/** A run's thread as Serra follows it. The same shape `t3 thread show --json` has, so T3 maps onto it directly. */
interface RunThread {
  threadId: string;
  /** Where the owner opens the thread. Empty when the backend has none (`capabilities.transcriptLink` false). */
  link: string;
  status: string;
  latestRunId: string | null;
  activeRunId: string | null;
  /** Questions or approvals the run waits on. */
  pendingRequestCount?: number;
  /** Why the latest run failed, as a plain sentence a backend made (never the agent's own text). */
  error?: string;
}

interface RunMessage {
  role: string;
  runId?: string;
  text?: string;
}

export interface RunDetail {
  thread: RunThread;
  messages: RunMessage[];
}

/** One tool call as the backend recorded it: what it was given and what it really returned. */
export interface RunToolCall {
  input: unknown;
  output: unknown;
  failed: boolean;
  /** The record was too long or malformed to read whole: never use a part of it. */
  unreadable?: boolean;
}

export interface WaitOptions {
  /** A run id that doesn't count: wait for a run after it. Null waits for the first run to end. */
  after: string | null;
  timeoutMs: number;
  pollMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** How many recent messages each read takes. */
  messages?: number;
}

/** How a wait ended: the run settled, it stopped to ask for something, or time ran out. */
export type WaitOutcome =
  | { kind: 'settled'; runId: string; answer: string | null; detail: RunDetail }
  | { kind: 'pending'; detail: RunDetail }
  | { kind: 'timeout'; detail: RunDetail };

/** Questions and approvals a run waits on, as Slack question cards show them. */
export type QuestionRequest = T3QuestionRequest;
export type QuestionAnswers = T3Answers;

export interface AgentBackend {
  readonly id: BackendId;
  /** Which backend this is, as a job records it: `t3`, or `acp:<agent id>`. */
  readonly key: string;
  /** The backend's name as copy shows it: "T3", or the ACP agent's name. */
  readonly label: string;
  readonly capabilities: BackendCapabilities;
  /** Starts a thread with its first run, and returns the thread's id. */
  start: (input: StartRun) => Promise<string>;
  /**
   * Sends a message. `queue` (default) makes it the thread's next turn; `steer` puts it into the running turn,
   * where `capabilities.steer` allows, else it queues.
   */
  send: (threadId: string, message: string, options?: { mode?: 'queue' | 'steer' }) => Promise<void>;
  /** Stops the thread's running turn. Throws when the backend refuses. */
  interrupt: (threadId: string, reason: string) => Promise<void>;
  /** The thread's state and its latest `messages` messages, oldest first. */
  read: (threadId: string, messages?: number) => Promise<RunDetail>;
  /** Follows a thread, reading it every `pollMs`, until a run after `after` settles, it waits on a request, or time runs out. */
  wait: (threadId: string, options: WaitOptions) => Promise<WaitOutcome>;
  /** The threads in `project` titled `title`, made at or after `since`, newest first: a start a crash cut short. */
  list: (input: { project: string; title: string; since: string }) => Promise<string[]>;
  /** Files a finished thread away (T3: settle). Never throws for a thread already gone. */
  settle: (threadId: string) => Promise<void>;
  /** The last tool call of run `runId` whose record mentions `match`, or null. Only with `capabilities.toolResults`. */
  toolCall?: (threadId: string, runId: string, match: string) => Promise<RunToolCall | null>;
  /** The questions and approvals a thread waits on, and answering one. Absent: the backend has none to show. */
  questions?: {
    list: (threadId: string) => Promise<QuestionRequest[]>;
    answer: (threadId: string, requestId: string, answers: QuestionAnswers) => Promise<void>;
  };
  /** Whether the agent can see an image it's sent. Absent: it can (T3's providers open attached files themselves). */
  images?: () => Promise<boolean>;
  /** Lets go of whatever the backend holds open (a session, an agent process). Never throws. */
  close: () => Promise<void>;
}

/**
 * Whether a thread's latest run, other than `after`, has settled: no run going and a later run on record. This is the
 * contract every backend's `read` meets, and what Slack jobs (src/lifecycle.ts) and meeting runs both rely on.
 */
const settledRun = (thread: RunThread, after: string | null): string | null =>
  thread.activeRunId === null && thread.latestRunId !== null && thread.latestRunId !== after ? thread.latestRunId : null;

/** The final assistant message of run `runId`, or null. */
const runAnswer = (messages: RunMessage[], runId: string): string | null =>
  messages.findLast((message) => message.role === 'assistant' && message.runId === runId)?.text ?? null;

/** `wait` by polling `read`: what every backend does unless it can do better. */
export const pollUntilSettled = async (read: AgentBackend['read'], threadId: string, options: WaitOptions): Promise<WaitOutcome> => {
  const deadline = options.now() + options.timeoutMs;
  for (;;) {
    await options.sleep(options.pollMs);
    const detail = await read(threadId, options.messages ?? 3);
    if ((detail.thread.pendingRequestCount ?? 0) > 0) return { kind: 'pending', detail };
    const runId = settledRun(detail.thread, options.after);
    if (runId !== null) return { kind: 'settled', runId, answer: runAnswer(detail.messages, runId), detail };
    if (options.now() > deadline) return { kind: 'timeout', detail };
  }
};

/** A job's worktree thread (`jobThreadInput` in src/t3.ts) as a run to start. */
export const worktreeRun = ({ project, baseRef, branch, title, brief, provider, model }: StartThreadInput): StartRun => ({
  workspace: { kind: 'worktree', project, baseRef, branch }, title, brief,
  ...(provider ? { provider } : {}), ...(model ? { model } : {}),
});
