// The job lifecycle (src/lifecycle.ts): the poll's decision is a pure function of the saved job and what T3 shows, and
// the phase can't hold what the old flags could (a seen run on a job nothing follows, a card without a wait).
import assert from 'node:assert/strict';
import test from 'node:test';
import { follow, looksRunning, replied, seeRun, settle, step, stopWaiting, waitFor, waitStep, withProgress, type Followed, type Observation, type Phase } from '../src/lifecycle.ts';
import type { QuestionCard } from '../src/questions.ts';
import type { T3Message } from '../src/types.ts';

const thread = (activeRunId: string | null, latestRunId: string | null, pendingRequestCount = 0): Observation['thread'] =>
  ({ activeRunId, latestRunId, pendingRequestCount, status: activeRunId ? 'running' : 'idle' });
const user = (runId: string): T3Message => ({ role: 'user', runId, text: 'do it' });
const said = (runId: string, text: string): T3Message => ({ role: 'assistant', runId, text });
const job = (phase: Phase, lastPostedRunId: string | null = null, nextTurnWaits?: boolean): Followed =>
  ({ phase, lastPostedRunId, ...(nextTurnWaits === undefined ? {} : { nextTurnWaits }) });
const card = { requestId: 'q1', questions: [], ts: '5.0', nonce: 'n', index: 0, answers: {}, runId: 'run-1' } satisfies QuestionCard;

test('[JOBS-003] the poll posts a run that started and ended between two polls, then settles: nothing is left looking like it runs', () => {
  const start = job(follow(settle()), null, true);
  const ended = step(start, { thread: thread(null, 'run-1'), messages: [user('run-1'), said('run-1', 'Done.')] });
  assert.deepEqual(ended, { do: 'post', runId: 'run-1', text: 'Done.', byWorker: false, missed: false });
  const after = job(replied(start.phase, null), 'run-1');
  assert.deepEqual(step(after, { thread: thread(null, 'run-1'), messages: [user('run-1'), said('run-1', 'Done.')] }), { do: 'settle' });
  assert.equal(looksRunning({ ...after, phase: settle() }), false);
});

test('[JOBS-003] SERRA-54: a reply posted for one run never leaves another seen run behind', () => {
  // Seen run-1 going; run-1 ended and run-2 started and ended before the next poll: run-2 is posted.
  const seen = seeRun({ id: 'run-1', at: '2026-11-18T10:00:00Z', waits: true, progress: { ts: '9.0', text: '⏳' } });
  const after = replied(seen, null);
  assert.deepEqual(after, { state: 'following' }, 'the old run and its line go with the post');
  assert.equal(looksRunning(job(after, 'run-2')), false);
  // While the run posted is the one still going (a missed reply), it stays.
  assert.deepEqual(replied(seen, 'run-1'), { state: 'following', run: { id: 'run-1', at: '2026-11-18T10:00:00Z', waits: true, progress: { ts: '9.0', text: '⏳' } } });
});

test('[REPLY-002] a missed reply comes first, and the next step goes on from it', () => {
  const messages = [user('run-1'), said('run-1', 'First answer.'), said('run-2', 'Following CI.')];
  const first = step(job(follow(settle())), { thread: thread('run-2', 'run-2'), messages });
  assert.deepEqual(first, { do: 'post', runId: 'run-1', text: 'First answer.', byWorker: false, missed: true });
  const next = step(job(replied(follow(settle()), 'run-2'), 'run-1'), { thread: thread('run-2', 'run-2'), messages });
  assert.equal(next.do, 'follow');
});

test('[REPLY-003] the first sight of a run binds the turn sent to it; later polls know it', () => {
  const messages = [user('run-1')];
  const first = step(job(follow(settle()), null, true), { thread: thread('run-1', 'run-1'), messages });
  assert.deepEqual(first, { do: 'follow', runId: 'run-1', waits: true, firstSight: true, byWorker: false });
  const bound = job(seeRun({ id: 'run-1', at: 'x', waits: false }), null, undefined);
  assert.deepEqual(step(bound, { thread: thread('run-1', 'run-1'), messages }), { do: 'follow', runId: 'run-1', waits: false, firstSight: false, byWorker: false });
  // A run the worker started on its own waits on nobody, and a silent one posts `(quiet)`.
  const own = step(job(follow(settle())), { thread: thread(null, 'run-9'), messages: [said('run-8', 'old')] });
  assert.deepEqual(own, { do: 'post', runId: 'run-9', text: '(quiet)', byWorker: true, missed: false });
});

test('[QUEST-001] a wait shows a card once, closes it for what the chat can\'t show, and tells the owner only once', () => {
  const can = (): boolean => true;
  const cannot = (): boolean => false;
  const request = { requestId: 'q1', questions: [] };
  assert.equal(step(job(follow(settle())), { thread: thread('run-1', 'run-1', 1), messages: [] }).do, 'wait');
  assert.deepEqual(waitStep(follow(settle()), [request], can), { do: 'card', request });
  assert.deepEqual(waitStep(waitFor(settle(), card), [request], cannot), { do: 'in-t3', closeCard: true, unsupported: [request] });
  assert.deepEqual(waitStep(waitFor(settle()), [request], cannot), { do: 'nothing' }, 'told already');
  assert.deepEqual(waitStep(follow(settle()), null, can), { do: 'in-t3', closeCard: false, unsupported: [] });
  assert.deepEqual(waitStep(waitFor(settle(), card), null, can), { do: 'nothing' }, 'unreadable requests leave the card up');
});

test('[JOBS-003] the phase holds only what it means: a card only while waiting, progress only on the run being followed', () => {
  const run = { id: 'run-1', at: 'x' };
  const waiting = waitFor(seeRun(run), card);
  assert.deepEqual(stopWaiting(waiting), { state: 'following', run }, 'the card goes when the wait ends');
  assert.deepEqual(withProgress(seeRun(run), 'run-2', { ts: '1', text: 'x' }), seeRun(run), 'a line for another run is ignored');
  assert.deepEqual(withProgress(settle(), 'run-1', { ts: '1', text: 'x' }), settle(), 'an idle job has no line');
  assert.deepEqual(settle(), { state: 'idle' });
  // Followed again, an idle job's leftover line goes with its run, so the poll still takes it down.
  assert.deepEqual(follow({ state: 'idle', leftover: { ts: '9.9', runId: 'run-7', text: '⏳' } }),
    { state: 'following', run: { id: 'run-7', at: new Date(0).toISOString(), progress: { ts: '9.9', text: '⏳' } } });
});

test('[JOBS-003] any sequence of polls ends idle once T3 is quiet and every run is posted, and none is posted twice', () => {
  // A small model of T3: runs start and end at random, some ask the bot's way, some wait on someone. The shell applies
  // each step as pollJob does: a wait first, otherwise leaving any wait, then the step's transition.
  let seed = 7;
  const random = (): number => { seed = (seed * 48_271) % 2_147_483_647; return seed / 2_147_483_647; };
  for (let trial = 0; trial < 200; trial += 1) {
    let saved: Followed = job(follow(settle()), null, true);
    const messages: T3Message[] = [];
    const postedRuns: string[] = [];
    let active: string | null = null;
    let latest: string | null = null;
    let n = 0;
    const poll = (pending: number): void => {
      const observed = { thread: thread(active, latest, pending), messages: messages.slice(-40) };
      let next = step(saved, observed);
      if (next.do === 'post' && next.missed) {
        postedRuns.push(next.runId);
        saved = { ...saved, lastPostedRunId: next.runId, phase: replied(saved.phase, active) };
        next = step(saved, observed, { missed: false });
      }
      if (next.do === 'wait') {
        saved = { ...saved, phase: waitFor(saved.phase, random() < 0.5 ? card : undefined) };
        return;
      }
      saved = { ...saved, phase: stopWaiting(saved.phase) };
      if (next.do === 'post') { postedRuns.push(next.runId); saved = { ...saved, lastPostedRunId: next.runId, phase: replied(saved.phase, active) }; }
      else if (next.do === 'follow') { if (next.firstSight) saved = { ...saved, phase: seeRun({ id: next.runId, at: String(n), waits: next.waits }) }; }
      else saved = { ...saved, phase: settle() };
    };
    for (let tick = 0; tick < 30; tick += 1) {
      const roll = random();
      if (!active && roll < 0.4) { active = `run-${++n}`; latest = active; if (random() < 0.6) messages.push(user(active)); }
      else if (active && roll < 0.7) { messages.push(said(active, `reply ${active}`)); active = null; }
      const pending = active && random() < 0.15 ? 1 : 0;
      poll(pending);
      // What each phase may hold, after every poll.
      if (saved.phase.state !== 'waiting') assert.ok(!('card' in saved.phase), 'a card only while waiting');
      if (active) assert.notEqual(saved.phase.state, 'idle', 'a job with a run going is never idle');
      if (pending) assert.equal(saved.phase.state, 'waiting');
    }
    // T3 goes quiet: whatever ran ends, and polls continue until nothing changes.
    if (active) { messages.push(said(active, 'end')); active = null; }
    for (let i = 0; i < 4; i += 1) poll(0);
    assert.deepEqual(saved.phase, { state: 'idle' }, `trial ${trial}`);
    assert.equal(looksRunning(saved), false, `trial ${trial}`);
    assert.equal(new Set(postedRuns).size, postedRuns.length, `trial ${trial}: a run is posted once`);
  }
});
