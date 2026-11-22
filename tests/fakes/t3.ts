/**
 * A scriptable T3: threads with runs, the worker's messages, and questions waiting in T3's UI. It stands in for the
 * `t3` CLI and the question bridge behind the bot's `t3` and `questions` seams, and the test plays the worker:
 * `reply` ends the running turn, `note` writes a line mid-run, `startRun` begins a run of the worker's own.
 * Each thread's runs are `run-1`, `run-2`, ... in order; a user message opens each run Serra started.
 */
import type { BotDeps } from '../../src/bot.ts';
import type { T3Answers, T3QuestionRequest } from '../../src/t3-questions.ts';
import type { StartThreadInput, T3Message, T3ThreadDetail } from '../../src/types.ts';

interface FakeThread {
  id: string;
  createdAt: string;
  input: StartThreadInput;
  runs: number;
  active: string | null;
  transcript: Required<Pick<T3Message, 'role' | 'runId' | 'text'>>[];
  questions: T3QuestionRequest[];
  /** Requests T3's UI holds that aren't questions Slack can show (secrets, approvals). */
  otherRequests: number;
}

export interface FakeT3Options {
  /** Thread IDs in start order. Defaults to `t3-1`, `t3-2`, ... */
  threadId?: (n: number) => string;
  failStart?: () => Error | null;
  failAnswer?: () => Error | null;
  failShow?: () => Error | null;
  /** The time, for when threads are created. Defaults to the real clock. */
  now?: () => number;
}

export const createFakeT3 = (options: FakeT3Options = {}) => {
  const threads = new Map<string, FakeThread>();
  const order: string[] = [];
  const started: StartThreadInput[] = [];
  const sends: { threadId: string; message: string }[] = [];
  const answered: { threadId: string; requestId: string; answers: T3Answers }[] = [];
  /** Every call, in order: `start`, `send`, `show`, `list`, `questions`, `answer`. */
  const log: string[] = [];
  const now = options.now ?? Date.now;
  /** A `start` call to hold, counted from the first: the CLI never returns (the daemon died waiting), after T3 made the thread or before. */
  let holdStart: { nth: number; made: boolean } | null = null;
  let markHung = (): void => {};
  let hungSignal = new Promise<void>((resolve) => { markHung = resolve; });

  const thread = (id?: string): FakeThread => {
    const found = threads.get(id ?? order.at(-1) ?? '');
    if (!found) throw new Error(`No fake T3 thread ${id ?? '(none started)'}`);
    return found;
  };
  const newRun = (current: FakeThread): string => {
    current.runs += 1;
    current.active = `run-${current.runs}`;
    return current.active;
  };

  const t3: NonNullable<BotDeps['t3']> = {
    startThread: async (input) => {
      log.push('start');
      started.push(input);
      if (holdStart && started.length === holdStart.nth && !holdStart.made) {
        markHung();
        return new Promise<never>(() => {});
      }
      const failure = options.failStart?.();
      if (failure) throw failure;
      const id = options.threadId?.(order.length + 1) ?? `t3-${order.length + 1}`;
      const created: FakeThread = { id, createdAt: new Date(now()).toISOString(), input, runs: 0, active: null, transcript: [], questions: [], otherRequests: 0 };
      threads.set(id, created); order.push(id);
      created.transcript.push({ role: 'user', runId: newRun(created), text: input.brief });
      if (holdStart && started.length === holdStart.nth) {
        markHung();
        return new Promise<never>(() => {});
      }
      return id;
    },
    findThreads: async (project, title, since) => {
      log.push('list');
      const from = Date.parse(since);
      return [...threads.values()].filter((found) => found.input.project === project && found.input.title === title && Date.parse(found.createdAt) >= from)
        .map((found) => found.id).reverse();
    },
    sendToThread: async (threadId, message) => {
      log.push('send');
      sends.push({ threadId, message });
      const current = thread(threadId);
      current.transcript.push({ role: 'user', runId: newRun(current), text: message });
    },
    showThread: async (threadId, _bin, count): Promise<T3ThreadDetail> => {
      log.push('show');
      const failure = options.failShow?.();
      if (failure) throw failure;
      const current = thread(threadId);
      return {
        thread: {
          threadId, link: `https://t3.test/${threadId}`, status: current.active ? 'running' : 'idle',
          latestRunId: current.runs ? `run-${current.runs}` : null, activeRunId: current.active,
          pendingRequestCount: current.questions.length + current.otherRequests,
        },
        messages: current.transcript.slice(-(count ?? 1)).map((message) => ({ ...message })),
      };
    },
  };

  const questions: NonNullable<BotDeps['questions']> = {
    listQuestions: async (threadId) => { log.push('questions'); return structuredClone(thread(threadId).questions); },
    answerQuestion: async (threadId, requestId, answers) => {
      log.push('answer');
      const failure = options.failAnswer?.();
      if (failure) throw failure;
      answered.push({ threadId, requestId, answers });
      const current = thread(threadId);
      const index = current.questions.findIndex((request) => request.requestId === requestId);
      if (index !== -1) current.questions.splice(index, 1);
      else current.otherRequests = Math.max(0, current.otherRequests - 1);
    },
  };

  return {
    t3, questions, started, sends, answered, log,
    /** The `later`-th `thread start` from now (1 is the next) never returns: after T3 made its thread (`made`), or before. */
    hangStart: (later = 1, made = true): void => { holdStart = { nth: started.length + later, made }; },
    whenHung: (): Promise<void> => hungSignal,
    resetHung: (): void => { hungSignal = new Promise<void>((resolve) => { markHung = resolve; }); },
    threadIds: (): string[] => [...order],
    /** The brief of the latest (or given) thread. */
    brief: (threadId?: string): string => thread(threadId).input.brief,
    activeRun: (threadId?: string): string | null => thread(threadId).active,
    runCount: (threadId?: string): number => thread(threadId).runs,
    /** The worker ends its running turn with `text`. */
    reply: (text: string, threadId?: string): void => {
      const current = thread(threadId);
      current.transcript.push({ role: 'assistant', runId: current.active ?? `run-${current.runs}`, text });
      current.active = null;
    },
    /** The worker ends its running turn without writing anything. */
    endSilently: (threadId?: string): void => { thread(threadId).active = null; },
    /** A line the worker writes while its run goes on. */
    note: (text: string, threadId?: string): void => {
      const current = thread(threadId);
      current.transcript.push({ role: 'assistant', runId: current.active ?? `run-${current.runs}`, text });
    },
    /** The worker starts a run of its own (following CI), with no user message. */
    startRun: (threadId?: string): string => newRun(thread(threadId)),
    /** A run Serra didn't send: someone wrote in T3 directly. */
    userRun: (text: string, threadId?: string): string => {
      const current = thread(threadId);
      const runId = newRun(current);
      current.transcript.push({ role: 'user', runId, text });
      return runId;
    },
    /** The running turn asks a question in T3's UI. */
    ask: (request: T3QuestionRequest, threadId?: string): void => { thread(threadId).questions.push(request); },
    /** The questions waiting in T3's UI for a thread, live: tests may push to it. */
    questionsOf: (threadId?: string): T3QuestionRequest[] => thread(threadId).questions,
    otherRequestsOf: (threadId?: string): number => thread(threadId).otherRequests,
    /** The running turn waits on something Slack can't show (a secret, an approval); 0 when it was answered in T3. */
    waitOnOther: (count: number, threadId?: string): void => { thread(threadId).otherRequests = count; },
  };
};

export type FakeT3 = ReturnType<typeof createFakeT3>;
