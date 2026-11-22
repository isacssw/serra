// When Serra asks for a GitHub star (SERRA-53). Borrowed from T3 Code's GitHubStarPrompt: ask only after real use,
// at most once per session, wait until the window is idle, and treat a failed save as "never ask". Serra asks right
// after a job finishes, with nothing running or waiting on the owner, and only after a few days and a few jobs.
// Everything is local (app prefs): no network, no GitHub sign-in, no telemetry. Finishes are the daemon's own reply
// events over its local socket, never extra job-list loads (those can look up Slack names).
// Pure data and functions: imported by `node --test` as well as the renderer.
import type { StarPromptState } from '../main/bridge.ts';
import type { BotEvent, BotStatus, JobSummary } from '../../src/contracts.ts';

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
 * Whether a daemon event is a job finishing well: its reply was posted (or its status message updated), it doesn't
 * need the owner, and it isn't a notice posted in its place (a Slack setup problem, a withheld answer). A failure is
 * its own `failure` event. A clarifying question to the requester still counts; the calm check and the idle wait
 * make that a fine moment anyway. Events come over the local status socket: nothing is fetched.
 */
export const finishedWell = (event: BotEvent): boolean =>
  event.event === 'reply' && event.kind !== 'quiet' && event.needsOwner !== true && event.notice !== true;

/** What the owner is told after opening the repo from anywhere: thanks, or that the answer wasn't kept. */
export const openedMessage = (saved: boolean): { message: string; tone: 'success' | 'info' } => saved
  ? { message: 'Opened Serra on GitHub. Thanks for the support!', tone: 'success' }
  : { message: 'Opened Serra on GitHub. Couldn’t save your answer, so it may ask again.', tone: 'info' };

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
  /** The jobs list the sidebar loaded. Only its app tasks are read: the daemon doesn't count those. Null: unknown. */
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

/** Tasks started in the app: T3 reports them live, the daemon doesn't count them (src/jobs.ts). */
const APP_TASKS = 'app';

/**
 * Whether this is a calm moment: not setting up, the bot up, nothing running or waiting on the owner by the daemon's
 * own counts, and no app task running or waiting in T3. Slack rows in the jobs list are left out: a failed job or a
 * question to the requester stays in Needs you there for days, and the daemon's counts already cover Slack jobs.
 * Checked when the card would show and while it is open.
 */
export const calmMoment = (context: Omit<AskContext, 'now' | 'version'>): AskVerdict => {
  if (context.path === context.welcomePath) return no('setting up');
  const { status, jobs } = context;
  if (status?.state !== 'up') return no('bot not up');
  if (!jobs) return no('app tasks unknown');
  const appTasks = jobs.filter((job) => job.channel === APP_TASKS);
  if (status.counts.running > 0 || appTasks.some((job) => job.group === 'running')) return no('a job is running');
  if (status.counts.needsYou > 0 || appTasks.some((job) => job.group === 'needs you')) return no('a job needs the owner');
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

/**
 * Opens the repository and, once the browser has it, stops asking. Used by the card, Updates and ⌘K. Rejects when
 * the browser can't open it; resolves false when it opened but the answer couldn't be saved.
 */
export const openRepo = async (app: StarPrefs & { openExternal(url: string): Promise<void> }, now = new Date()): Promise<boolean> => {
  await app.openExternal(REPO_URL);
  return updateStarPrompt(app, (state) => (state.done ? state : answer(state, 'star', now))).then(() => true, () => false);
};
