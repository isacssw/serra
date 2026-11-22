/**
 * A job's lifecycle, as one value instead of six flags. Until now `watching`, `waitingInT3`, `question`, `runSeen` and
 * `progress` could be set in any combination, and some combinations meant nothing: a seen run kept on a job nothing
 * followed any more listed it as running forever (SERRA-54). Here a job is in exactly one phase, and what a phase holds
 * goes when the job leaves it.
 *
 * `step` is the poll's decision, from the saved job and what T3 shows, with no side effects: the bot (the shell)
 * performs what it says, through the chat port and T3, and applies the transitions below to the saved job.
 */
import type { QuestionCard } from './questions.ts';
import type { T3QuestionRequest } from './t3-questions.ts';
import type { T3Message, T3Thread } from './types.ts';

/** A run the bot saw going: since when, and whether someone in the chat waits on it. */
export interface SeenRun {
  id: string;
  /** When a poll first saw it. */
  at: string;
  /** Someone addressed the bot for the turn this run answers (bound from `nextTurnWaits` at first sight). */
  waits?: boolean;
  /** The "still working" line shown while it goes, edited as the worker's note changes. */
  progress?: { ts: string; text: string };
}

export type Phase =
  /**
   * Nothing to follow: no run goes, and every run is posted. Checked now and then, since the worker starts runs itself.
   * `leftover`: a progress line an older build left in the chat for a run nobody follows any more; taken down at start.
   */
  | { state: 'idle'; leftover?: { ts: string; runId: string; text: string } }
  /** Checked every poll: a turn was sent, a run goes (`run`, once seen), or a reply was just posted. */
  | { state: 'following'; run?: SeenRun }
  /**
   * The run waits on someone in T3. `card`: the question shown in the chat for it. Without one, the owner was told to
   * answer in T3. `run`: the run that waits, when it was seen.
   */
  | { state: 'waiting'; run?: SeenRun; card?: QuestionCard };

export const IDLE: Phase = { state: 'idle' };

/** How long after its last activity an idle job is still checked now and then. */
export const FOLLOW_UP_MS = 14 * 24 * 60 * 60_000;

/** The run the job last saw, in any phase that has one. */
export const seenRun = (phase: Phase): SeenRun | undefined => (phase.state === 'idle' ? undefined : phase.run);

/** Followed every poll (rather than now and then). */
export const followed = (phase: Phase): boolean => phase.state !== 'idle';

// Transitions. Each takes the phase as saved last and returns the next one. ------------------------------------------

/**
 * Follow the job every poll from now on. A job already followed or waiting stays as it is. A leftover line goes with
 * the run it was for, seen long ago, so the poll still takes it down.
 */
export const follow = (phase: Phase): Phase => {
  if (phase.state !== 'idle') return phase;
  if (!phase.leftover) return { state: 'following' };
  const { ts, runId, text } = phase.leftover;
  return { state: 'following', run: { id: runId, at: new Date(0).toISOString(), progress: { ts, text } } };
};

/** The run waits on someone in T3: with a card shown in the chat, or with the owner told to answer in T3. */
export const waitFor = (phase: Phase, card?: QuestionCard): Phase => {
  const run = seenRun(follow(phase));
  return { state: 'waiting', ...(run ? { run } : {}), ...(card ? { card } : {}) };
};

/** The wait is over (answered, closed or gone): follow the job again. */
export const stopWaiting = (phase: Phase): Phase => {
  if (phase.state !== 'waiting') return phase;
  return { state: 'following', ...(phase.run ? { run: phase.run } : {}) };
};

/** The seen run was posted and has no line left: it tells nothing more. */
export const forgetRun = (phase: Phase): Phase => {
  if (phase.state === 'idle' || !phase.run) return phase;
  return phase.state === 'following' ? { state: 'following' } : { state: 'waiting', ...(phase.card ? { card: phase.card } : {}) };
};

/** A poll saw `run` going: a new run replaces the one seen before, with its progress line. */
export const seeRun = (run: SeenRun): Phase => ({ state: 'following', run });

/** The progress line of the run being followed, or none. Ignored for any other run. */
export const withProgress = (phase: Phase, runId: string, progress: SeenRun['progress']): Phase => {
  const run = seenRun(phase);
  if (!run || run.id !== runId || phase.state === 'idle') return phase;
  const next: SeenRun = { id: run.id, at: run.at, ...(run.waits === undefined ? {} : { waits: run.waits }), ...(progress ? { progress } : {}) };
  return { ...phase, run: next };
};

/**
 * A reply was posted: the job stays followed for one more poll, so a follow-up queued while the run was busy is picked
 * up. The seen run is forgotten unless it is the one going now: a run that started and ended between two polls is posted
 * without ever being seen, and a seen run that never matches the last posted one would look running forever (SERRA-54).
 * A job waiting in T3 (a reply the worker's paused run left behind) keeps waiting, with its card.
 */
export const replied = (phase: Phase, activeRunId: string | null): Phase => {
  const run = seenRun(phase);
  const kept = run && run.id === activeRunId ? { run } : {};
  return phase.state === 'waiting' ? { state: 'waiting', ...kept, ...(phase.card ? { card: phase.card } : {}) } : { state: 'following', ...kept };
};

/** Nothing runs and every run is posted: nothing is left to follow. */
export const settle = (): Phase => IDLE;

// The poll's decision. --------------------------------------------------------------------------------------------------

/** How many of a thread's latest messages a poll reads: enough to see what started the run and its latest note. */
export const RECENT_MESSAGES = 40;

/** What T3 shows for the job's thread. */
export interface Observation {
  thread: Pick<T3Thread, 'activeRunId' | 'latestRunId' | 'pendingRequestCount' | 'status'>;
  messages: T3Message[];
}

/** The fields of a saved job the poll decides from. */
export interface Followed { phase: Phase; lastPostedRunId: string | null; nextTurnWaits?: boolean }

/**
 * Whether the worker started a run on its own, to follow CI or a bot's review, rather than for a message from the
 * chat. Such runs have no user message. When the messages read don't reach back to the run's start, it can't be told,
 * and the run counts as someone's: their reply is never hidden in an edit.
 */
const startedByWorker = (runId: string, messages: T3Message[]): boolean => {
  const reachesStart = messages.length < RECENT_MESSAGES || messages[0]?.runId !== runId;
  return reachesStart && !messages.some((message) => message.role === 'user' && message.runId === runId);
};

/**
 * Whether someone in the chat is waiting on this run: it answers them, and they addressed the bot. Serra records that
 * when it sends the turn (`nextTurnWaits`) and binds it to the run the first time a poll sees it, because `t3 thread
 * send` returns no run ID. A turn sent before Serra recorded this counts as someone's.
 */
const someoneWaits = (job: Followed, runId: string, messages: T3Message[]): boolean => {
  if (startedByWorker(runId, messages)) return false;
  const run = seenRun(job.phase);
  if (run?.id === runId && run.waits !== undefined) return run.waits;
  return job.nextTurnWaits ?? true;
};

/**
 * A run that answered someone and finished, but was never posted because the worker started another run before the
 * next poll. Runs are read in order; only those after the last posted one count.
 */
const missedReply = (messages: T3Message[], lastPosted: string | null, current: string): { runId: string; text: string } | null => {
  const runs = [...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : [])))];
  const from = lastPosted === null ? -1 : runs.indexOf(lastPosted);
  // The last posted run is out of the window read: what came after it can't be told apart, so nothing is guessed.
  if (lastPosted !== null && from === -1) return null;
  for (const runId of runs.slice(from + 1).toReversed()) {
    if (runId === current || !messages.some((message) => message.role === 'user' && message.runId === runId)) continue;
    const text = messages.findLast((message) => message.role === 'assistant' && message.runId === runId)?.text;
    return text === undefined ? null : { runId, text };
  }
  return null;
};

const replyText = (thread: Observation['thread'], last: T3Message | undefined): string =>
  last?.role === 'assistant' && last.runId === thread.latestRunId
    ? (last.text ?? '')
    : `The run ended without a reply (status: ${thread.status}).`;

export type PollStep =
  /** A reply to someone that the worker's next run started before the bot saw it end: post it, then step again. */
  | { do: 'post'; runId: string; text: string; byWorker: boolean; missed: true }
  /** T3 waits on someone: read its requests, then `waitStep`. */
  | { do: 'wait' }
  /**
   * A run goes: follow it. `firstSight`: the poll sees it for the first time, so it becomes the seen run (`seen`), and
   * the turn Serra sent is spent unless the worker started the run itself. `waits`: someone in the chat waits on it.
   */
  | { do: 'follow'; runId: string; waits: boolean; firstSight: boolean; byWorker: boolean }
  /** The newest run ended and isn't posted: post its reply. A run the worker started that wrote nothing posts `(quiet)`. */
  | { do: 'post'; runId: string; text: string; byWorker: boolean; missed: false }
  /** Nothing runs and every run is posted: clear what's left (progress line, loading) and stop following. */
  | { do: 'settle' };

/**
 * The poll's next step for a job, from what T3 shows. Pure: the same job and observation always give the same step.
 * `missed: false` skips missed replies: a poll posts at most one, then goes on.
 */
export const step = (job: Followed, { thread, messages }: Observation, { missed: lookForMissed = true }: { missed?: boolean } = {}): PollStep => {
  const current = thread.activeRunId ?? thread.latestRunId;
  const missed = lookForMissed && current && current !== job.lastPostedRunId ? missedReply(messages, job.lastPostedRunId, current) : null;
  if (missed) return { do: 'post', runId: missed.runId, text: missed.text, byWorker: false, missed: true };
  if ((thread.pendingRequestCount ?? 0) > 0) return { do: 'wait' };
  if (thread.activeRunId) {
    const runId = thread.activeRunId;
    return { do: 'follow', runId, waits: someoneWaits(job, runId, messages), firstSight: seenRun(job.phase)?.id !== runId, byWorker: startedByWorker(runId, messages) };
  }
  const runId = thread.latestRunId;
  if (runId !== null && runId !== job.lastPostedRunId) {
    const byWorker = startedByWorker(runId, messages);
    const last = messages.at(-1);
    // A run the worker started that wrote nothing has nothing to tell anyone; it mustn't overwrite the status message.
    const silent = byWorker && !(last?.role === 'assistant' && last.runId === runId);
    return { do: 'post', runId, text: silent ? '(quiet)' : replyText(thread, last), byWorker, missed: false };
  }
  return { do: 'settle' };
};

export type WaitStep =
  /** Show this request as a card (a new one replaces an open card). */
  | { do: 'card'; request: T3QuestionRequest }
  /** None can be shown in the chat: close any card, and tell the owner to answer in T3 (they weren't told yet). */
  | { do: 'in-t3'; closeCard: boolean; unsupported: T3QuestionRequest[] }
  /** Nothing to change: the card or the notice is up, or T3's requests couldn't be read and one of them is. */
  | { do: 'nothing' };

/**
 * What a job waiting in T3 shows. `requests`: what T3 waits on, or null when they couldn't be read. `canShow`: whether
 * the chat can show a request as a card.
 */
export const waitStep = (phase: Phase, requests: T3QuestionRequest[] | null, canShow: (request: T3QuestionRequest) => boolean): WaitStep => {
  const card = phase.state === 'waiting' ? phase.card : undefined;
  const told = phase.state === 'waiting' && !card;
  const request = requests?.find(canShow);
  if (request) return { do: 'card', request };
  if (requests !== null) return card || !told ? { do: 'in-t3', closeCard: card !== undefined, unsupported: requests } : { do: 'nothing' };
  return card || told ? { do: 'nothing' } : { do: 'in-t3', closeCard: false, unsupported: [] };
};

/** What the Jobs screen and the bot read as running, from the saved job alone. */
export const looksRunning = (job: Followed & { loadingRequested?: boolean; pendingReactions?: string[] }): boolean => {
  const run = seenRun(job.phase);
  return job.loadingRequested === true || (job.pendingReactions ?? []).length > 0 || (job.phase.state === 'idle' && job.phase.leftover !== undefined)
    || run?.progress !== undefined || (run !== undefined && run.id !== job.lastPostedRunId);
};
