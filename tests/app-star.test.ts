// SERRA-53: when the app asks for a GitHub star, how Not now and Don't ask again are kept, and the permanent link.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppPrefs, StarPromptState } from '../app/main/bridge.ts';
import { combineStarPrompt, defaultPrefs, mergePrefs, readPrefs } from '../app/main/prefs.ts';
import { builtinActions } from '../app/renderer/commands/builtin.ts';
import {
  answer, countFinished, finishedWell, MAX_ASKS, markShown, MIN_DAYS, MIN_FINISHED, openRepo, REPO_URL, shouldAsk,
  SNOOZE_DAYS, startClock, updateStarPrompt, type AskContext,
} from '../app/renderer/star.logic.ts';
import type { BotStatus, JobSummary } from '../src/contracts.ts';

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-11-01T09:00:00Z');
const later = (days: number): Date => new Date(start.getTime() + days * DAY);
const fresh: StarPromptState = defaultPrefs.starPrompt;
const idle: BotStatus = { state: 'up', pid: 1, startedAt: start.toISOString(), slackConnected: true, counts: { needsYou: 0, running: 0 } };
/** A user who has had enough jobs finish and enough days pass. */
const ready: StarPromptState = { ...fresh, since: start.toISOString(), finished: MIN_FINISHED };
const at = (now: Date, extra: Partial<AskContext> = {}): AskContext =>
  ({ now, version: '0.1.0', status: idle, jobs: [], path: '/jobs/done', welcomePath: '/welcome', ...extra });
const reason = (state: StarPromptState, context: AskContext): string | null => {
  const verdict = shouldAsk(state, context);
  return verdict.ask ? null : verdict.reason;
};

const job = (key: string, group: JobSummary['group'], channel = 'app'): JobSummary =>
  ({ key, group, requester: 'U1', channel, title: key, createdAt: start.toISOString(), lastActivityAt: start.toISOString(), links: {} });

test('a finish is a reply the daemon posted that does not need the owner; failures and blockers never count', () => {
  const at = start.toISOString();
  assert.equal(finishedWell({ at, event: 'reply', key: 'k', kind: 'reply' }), true);
  assert.equal(finishedWell({ at, event: 'reply', key: 'k', kind: 'status_posted' }), true);
  assert.equal(finishedWell({ at, event: 'reply', key: 'k', kind: 'reply', needsOwner: true }), false);
  assert.equal(finishedWell({ at, event: 'reply', key: 'k', kind: 'quiet' }), false, 'nothing was said');
  assert.equal(finishedWell({ at, event: 'reply', key: 'k', kind: 'reply', notice: true }), false, 'a setup or withheld notice');
  assert.equal(finishedWell({ at, event: 'failure', key: 'k', error: 'boom' }), false);
  assert.equal(finishedWell({ at, event: 'needs_owner', key: 'k' }), false);
  assert.equal(finishedWell({ at, event: 'job_started', key: 'k', t3ThreadId: 't', requester: 'U1' }), false);
});

test('the clock starts once and finished jobs stop counting at the threshold', () => {
  const started = startClock(fresh, start);
  assert.equal(started.since, start.toISOString());
  assert.equal(startClock(started, later(9)).since, start.toISOString());
  assert.equal(countFinished(fresh, 0), fresh, 'no change keeps the same object, so nothing is saved');
  assert.equal(countFinished(fresh, 2).finished, 2);
  assert.equal(countFinished(fresh, 50).finished, MIN_FINISHED);
  const full = countFinished(fresh, MIN_FINISHED);
  assert.equal(countFinished(full, 1), full);
});

test('asks only after a few days and a few finished jobs, never on first launch', () => {
  assert.equal(reason(fresh, at(start)), 'too few jobs');
  assert.equal(reason({ ...fresh, finished: MIN_FINISHED }, at(start)), 'too new', 'no clock yet');
  assert.equal(reason({ ...ready, finished: MIN_FINISHED - 1 }, at(later(30))), 'too few jobs');
  assert.equal(reason(ready, at(later(MIN_DAYS - 0.1))), 'too new');
  assert.equal(shouldAsk(ready, at(later(MIN_DAYS))).ask, true);
});

test('never during setup, while the bot is down, or while a job runs or waits on the owner', () => {
  const now = later(5);
  assert.equal(reason(ready, at(now, { path: '/welcome' })), 'setting up');
  assert.equal(reason(ready, at(now, { status: null })), 'bot not up');
  assert.equal(reason(ready, at(now, { status: { state: 'stopped' } })), 'bot not up');
  assert.equal(reason(ready, at(now, { status: { ...idle, counts: { needsYou: 0, running: 1 } } })), 'a job is running');
  assert.equal(reason(ready, at(now, { status: { ...idle, counts: { needsYou: 2, running: 0 } } })), 'a job needs the owner');
  // Tasks started in the app aren't in the daemon's counts; the jobs list has them.
  assert.equal(reason(ready, at(now, { jobs: [job('t', 'running')] })), 'a job is running');
  assert.equal(reason(ready, at(now, { jobs: [job('t', 'needs you'), job('u', 'done')] })), 'a job needs the owner');
  assert.equal(shouldAsk(ready, at(now, { jobs: [job('u', 'done')] })).ask, true);
  assert.equal(reason(ready, at(now, { jobs: null })), 'app tasks unknown', 'an unloaded list is not a calm one');
  // Slack rows can sit in Needs you for days (a failure, a question to the requester); the daemon's counts decide.
  assert.equal(shouldAsk(ready, at(now, { jobs: [job('s', 'needs you', 'C1'), job('r', 'running', 'C1')] })).ask, true);
});

test('showing it snoozes it: at most once per version, and not again for a long while', () => {
  const now = later(5);
  const shown = markShown(ready, '0.1.0', now);
  assert.equal(shown.asks, 1);
  assert.equal(reason(shown, at(later(60))), 'shown in this version', 'the same version never asks twice');
  assert.equal(reason(shown, at(later(5 + SNOOZE_DAYS - 1), { version: '0.2.0' })), 'snoozed', 'a new version alone is not enough');
  assert.equal(shouldAsk(shown, at(later(5 + SNOOZE_DAYS), { version: '0.2.0' })).ask, true);
});

test('Not now snoozes from when it was clicked; the card closing with the window counts the same', () => {
  const shown = markShown(ready, '0.1.0', later(5));
  const notNow = answer(shown, 'not now', later(8));
  assert.equal(notNow.done, false);
  assert.equal(reason(notNow, at(later(8 + SNOOZE_DAYS - 1), { version: '0.2.0' })), 'snoozed');
  assert.equal(shouldAsk(notNow, at(later(8 + SNOOZE_DAYS), { version: '0.2.0' })).ask, true);
});

test("Don't ask again and starring end it for good, across versions and years", () => {
  const shown = markShown(ready, '0.1.0', later(5));
  for (const choice of ['never', 'star'] as const) {
    const done = answer(shown, choice, later(5));
    assert.equal(reason(done, at(later(900), { version: '9.0.0' })), 'answered');
  }
});

test(`it stops after ${MAX_ASKS} asks even when every answer was Not now`, () => {
  let state = ready;
  for (let ask = 0; ask < MAX_ASKS; ask++) {
    const now = later(5 + ask * (SNOOZE_DAYS + 1));
    const version = `0.${ask + 1}.0`;
    assert.equal(shouldAsk(state, at(now, { version })).ask, true, `ask ${ask + 1}`);
    state = answer(markShown(state, version, now), 'not now', now);
  }
  assert.equal(reason(state, at(later(500), { version: '9.0.0' })), 'asked enough');
});

/** The prefs bridge as main implements it: merged and checked by mergePrefs, kept as JSON like electron-store. */
const prefsBridge = (failSaves = false) => {
  let json = JSON.stringify(defaultPrefs);
  const opened: string[] = [];
  const app = {
    getPrefs: async (): Promise<AppPrefs> => readPrefs(JSON.parse(json)),
    setPrefs: async (patch: Partial<AppPrefs>): Promise<AppPrefs> => {
      if (failSaves) throw new Error('disk full');
      const next = mergePrefs(readPrefs(JSON.parse(json)), patch);
      json = JSON.stringify(next);
      return next;
    },
    openExternal: async (url: string): Promise<void> => { opened.push(url); },
  };
  return { app, opened, saved: () => readPrefs(JSON.parse(json)).starPrompt };
};

test('the state survives a restart through prefs, and a broken saved copy starts over instead of failing', async () => {
  const { app, saved } = prefsBridge();
  await updateStarPrompt(app, (state) => markShown(startClock(state, start), '0.1.0', later(3)));
  assert.equal(saved().shownIn, '0.1.0');
  assert.equal(saved().since, start.toISOString());
  assert.deepEqual(readPrefs({ starPrompt: { ...saved(), asks: -1 } }).starPrompt, fresh);
  assert.deepEqual(readPrefs({ starPrompt: 'yes' }).starPrompt, fresh);
  assert.throws(() => mergePrefs(defaultPrefs, { starPrompt: { ...fresh, snoozedUntil: 'soon' } }), /snoozedUntil/);
  assert.throws(() => mergePrefs(defaultPrefs, { starPrompt: { ...fresh, done: 'yes' } }), /done/);
});

test('a change is made to what is saved now, so a stale copy cannot undo a never', async () => {
  const { app, saved } = prefsBridge();
  await updateStarPrompt(app, (state) => answer(state, 'never', start));
  await updateStarPrompt(app, (state) => countFinished(state, 1));
  assert.equal(saved().done, true);
});

test('main only moves the saved state forward, so a stale or out-of-order write cannot undo an answer', () => {
  const answered = answer(markShown(ready, '0.1.0', later(5)), 'never', later(5));
  const stale = { ...ready, finished: 1 };
  assert.deepEqual(combineStarPrompt(answered, stale), { ...answered, finished: MIN_FINISHED });
  const merged = mergePrefs({ ...defaultPrefs, starPrompt: answered }, { starPrompt: stale }).starPrompt;
  assert.equal(merged.done, true);
  assert.equal(merged.asks, 1);
  assert.equal(merged.since, ready.since, 'the clock keeps its first start');
  assert.equal(combineStarPrompt(ready, { ...ready, since: later(-3).toISOString() }).since, later(-3).toISOString(), 'and an earlier one wins');
  assert.equal(merged.snoozedUntil, answered.snoozedUntil, 'the snooze keeps its latest end');
});

test('changes from the window run one after another, so concurrent ones never lose a write', async () => {
  const { app, saved } = prefsBridge();
  const slow = { ...app, getPrefs: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return app.getPrefs(); } };
  await Promise.all([
    updateStarPrompt(slow, (state) => startClock(state, start)),
    updateStarPrompt(slow, (state) => countFinished(state, 2)),
    updateStarPrompt(slow, (state) => answer(state, 'never', start)),
  ]);
  assert.deepEqual(saved(), { ...fresh, since: start.toISOString(), finished: 2, done: true });
});

test('a save that fails rejects, so the card is never shown with an answer it could not keep', async () => {
  const { app } = prefsBridge(true);
  await assert.rejects(updateStarPrompt(app, (state) => markShown(state, '0.1.0', start)), /disk full/);
});

test('the permanent link and ⌘K open the repo and stop the request; no network, just the browser', async () => {
  const { app, opened, saved } = prefsBridge();
  await openRepo(app, start);
  assert.deepEqual(opened, [REPO_URL]);
  assert.equal(saved().done, true);

  const action = builtinActions.find((item) => item.id === 'app:star-on-github');
  assert.ok(action, 'Star Serra on GitHub is in the palette');
  assert.match(action.button, /Updates › Star on GitHub/);
  const other = prefsBridge();
  await action.run({ bridge: { app: other.app } as never, navigate: () => {}, toast: () => {} });
  assert.deepEqual(other.opened, [REPO_URL]);
  assert.equal(other.saved().done, true);
});

test('the repo link opens even when the answer cannot be saved, and says so', async () => {
  const { app, opened } = prefsBridge(true);
  assert.equal(await openRepo(app, start), false);
  assert.deepEqual(opened, [REPO_URL]);
  assert.equal(await openRepo(prefsBridge().app, start), true);
});
