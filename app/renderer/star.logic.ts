// When Serra asks for a GitHub star (SERRA-53). Borrowed from T3 Code's GitHubStarPrompt: ask only after real use,
// at most once per session, wait until the window is idle, and treat a failed save as "never ask". Serra asks right
// after a job finishes, with nothing running or waiting on the owner, and only after a few days and a few jobs.
// Everything is local (app prefs): no network, no GitHub sign-in, no telemetry. Finishes are read from the daemon's
// live status pushes, never from extra job-list loads (those can look up Slack names).
// Pure data and functions: imported by `node --test` as well as the renderer.
import type { StarPromptState } from '../main/bridge.ts';
import type { BotStatus, JobSummary } from '../../src/contracts.ts';

export const REPO_URL = 'https://github.com/isacssw/serra';

/** Jobs the window must see finish before it asks. */
export const MIN_FINISHED = 3;
/** Days since the app first saw a working bot. */
export const MIN_DAYS = 2;
/** How long showing the card (and Not now) keeps it away. A new version is needed too. */
export const SNOOZE_DAYS = 30;
/** After this many asks it stops for good, whatever the answer was. */
export const MAX_ASKS = 3;
/** The owner's input must pause this long before the card slides in, so it never lands mid-typing. */
export const IDLE_MS = 4000;

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (now: Date, days: number): string => new Date(now.getTime() + days * DAY_MS).toISOString();

/** The owner must come back within this long of a finish; a card that waited longer would be about nothing. */
export const MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * How many jobs finished well between two status pushes from the same daemon: the running count fell, minus any
 * that moved to Needs you (a failure or a question lands there). The daemon pushes every change, so none is missed.
 */
export const finishedBetween = (before: BotStatus | null, after: BotStatus | null): number => {
  if (before?.state !== 'up' || after?.state !== 'up' || before.pid !== after.pid) return 0;
  const left = before.counts.running - after.counts.running;
  const waiting = Math.max(0, after.counts.needsYou - before.counts.needsYou);
  return Math.max(0, left - waiting);
};

/** Starts the "days of use" clock the first time the bot is seen up. */
export const startClock = (state: StarPromptState, now: Date): StarPromptState =>
  state.since ? state : { ...state, since: now.toISOString() };

/** Counts finished jobs, stopping at the threshold: the number has no other use. */
export const countFinished = (state: StarPromptState, count: number): StarPromptState =>
  count <= 0 || state.finished >= MIN_FINISHED ? state : { ...state, finished: Math.min(MIN_FINISHED, state.finished + count) };

export interface AskContext {
  now: Date;
  /** The installed app version. */
  version: string;
  status: BotStatus | null;
  /** The jobs list the sidebar loaded, which also has tasks started in the app (the daemon doesn't count those). */
  jobs: readonly JobSummary[] | null;
  /** The route on screen. */
  path: string;
  /** The first-run wizard's route. */
  welcomePath: string;
}

export type AskVerdict = { ask: true } | { ask: false; reason: string };

const no = (reason: string): AskVerdict => ({ ask: false, reason });

/** Whether the owner is due an ask at all: the saved answers, the thresholds, the version and the snooze. */
export const dueToAsk = (state: StarPromptState, context: Pick<AskContext, 'now' | 'version'>): AskVerdict => {
  if (state.done) return no('answered');
  if (state.asks >= MAX_ASKS) return no('asked enough');
  if (state.finished < MIN_FINISHED) return no('too few jobs');
  if (!state.since || context.now.getTime() - Date.parse(state.since) < MIN_DAYS * DAY_MS) return no('too new');
  if (state.shownIn === context.version) return no('shown in this version');
  if (state.snoozedUntil && context.now.getTime() < Date.parse(state.snoozedUntil)) return no('snoozed');
  return { ask: true };
};

/**
 * Whether this is a calm moment: not setting up, the bot up, and nothing running or waiting on the owner, by the
 * daemon's counts or the jobs list. Checked again when the card would show and while it is open.
 */
export const calmMoment = (context: Omit<AskContext, 'now' | 'version'>): AskVerdict => {
  if (context.path === context.welcomePath) return no('setting up');
  const { status, jobs } = context;
  if (status?.state !== 'up') return no('bot not up');
  if (status.counts.running > 0 || jobs?.some((job) => job.group === 'running')) return no('a job is running');
  if (status.counts.needsYou > 0 || jobs?.some((job) => job.group === 'needs you')) return no('a job needs the owner');
  return { ask: true };
};

/** Whether to ask now. Only called after a job finished, so the moment is a happy one; this checks the rest. */
export const shouldAsk = (state: StarPromptState, context: AskContext): AskVerdict => {
  const due = dueToAsk(state, context);
  return due.ask ? calmMoment(context) : due;
};

/** Saved before the card shows: if the window closes with it open, that counts as Not now. */
export const markShown = (state: StarPromptState, version: string, now: Date): StarPromptState =>
  ({ ...state, asks: state.asks + 1, shownIn: version, snoozedUntil: addDays(now, SNOOZE_DAYS) });

export type StarChoice = 'star' | 'not now' | 'never';

/** The answer. Not now keeps the snooze from `markShown`; starring or Don't ask again ends it. */
export const answer = (state: StarPromptState, choice: StarChoice, now: Date): StarPromptState =>
  choice === 'not now' ? { ...state, snoozedUntil: addDays(now, SNOOZE_DAYS) } : { ...state, done: true };

/** The prefs calls the star request needs: `window.serra.app`, or a stand-in in tests. */
export interface StarPrefs {
  getPrefs(): Promise<{ starPrompt: StarPromptState }>;
  setPrefs(patch: { starPrompt: StarPromptState }): Promise<{ starPrompt: StarPromptState }>;
}

// Every change from this window runs after the one before, so two can't read the same state and lose one write.
// Main also merges `starPrompt` so it only moves forward (`combineStarPrompt`), which covers anything else.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Changes the saved state from what is saved now, never from a copy the window held: the card and the permanent
 * link can both write, and a stale copy must not undo a "never". Rejects when the save fails.
 */
export const updateStarPrompt = (app: StarPrefs, change: (state: StarPromptState) => StarPromptState): Promise<StarPromptState> => {
  const run = async (): Promise<StarPromptState> => {
    const current = (await app.getPrefs()).starPrompt;
    const next = change(current);
    if (next === current) return current;
    return (await app.setPrefs({ starPrompt: next })).starPrompt;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
};

/** Opens the repository and, once the browser has it, stops asking. Used by the card, Updates and ⌘K. */
export const openRepo = async (app: StarPrefs & { openExternal(url: string): Promise<void> }, now = new Date()): Promise<void> => {
  await app.openExternal(REPO_URL);
  await updateStarPrompt(app, (state) => (state.done ? state : answer(state, 'star', now))).catch(() => {});
};
