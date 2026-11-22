import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { holdRequest, INTAKE_PAUSED, readHeld, readPause, HELD_REQUESTS } from '../src/intake.ts';
import { createStore, readState } from '../src/state.ts';

const folder = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A job as 0.1.0-alpha.3 saves it. */
const alpha3Job = {
  t3ThreadId: 'thr_1', channel: 'C1', threadTs: '1700000000.000100', requester: 'USAM', pendingReactionTs: null,
  pendingReactions: ['1700000000.000100'], loadingRequested: true, ownerFollows: false, lastPostedRunId: null, watching: true,
  createdAt: '2026-11-20T10:00:00.000Z', lastActivityAt: '2026-11-20T10:00:00.000Z', visibility: 'team',
  knowledgeRead: { 'workflows/release.md': 'team' }, knowledgeDir: '/tmp/k', branch: 'friday/rename-pricing-1',
  runSeen: { runId: 'run-1', at: '2026-11-20T10:00:15.000Z' },
};

test('[JOBS-002] a state.json written by alpha.3 reads into a phase, is backed up before the first rewrite, and keeps every flag alpha.3 reads', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  const original = JSON.stringify({ 'C1:1700000000.000100': alpha3Job }, null, 2);
  writeFileSync(file, original);
  const read = readState(file);
  const { watching: _watching, runSeen: _runSeen, ...rest } = alpha3Job;
  assert.deepEqual(read, { jobs: { 'C1:1700000000.000100': { ...rest, phase: { state: 'following', run: { id: 'run-1', at: '2026-11-20T10:00:15.000Z' } } } }, invalid: [], repaired: ['C1:1700000000.000100'] });
  const store = createStore(file, { now: () => new Date('2026-11-22T02:00:00Z') });
  store.putJob('C1:1700000000.000100', { ...store.getJob('C1:1700000000.000100')!, nextTurnWaits: true });
  const saved = JSON.parse(readFileSync(file, 'utf8'))['C1:1700000000.000100'];
  // An older build reading the new file sees what it wrote, plus the phase it keeps as a field it doesn't know.
  assert.deepEqual(saved, { ...alpha3Job, nextTurnWaits: true, waitingInT3: false, phase: { state: 'following', run: { id: 'run-1', at: '2026-11-20T10:00:15.000Z' } } });
  assert.equal(readFileSync(join(dir, 'state.json.backup-2026-11-22T02-00-00.000Z'), 'utf8'), original, 'the alpha.3 file is kept before the first rewrite');
  // Read again, nothing needs repairing.
  assert.deepEqual(readState(file).repaired, []);
});

test('[JOBS-002] the old flags migrate to one phase: a card is a wait with it, a T3 wait without one, a stale seen run is followed until settled', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  const card = { requestId: 'r1', questions: [], ts: '2.5', nonce: 'n', index: 0, answers: {}, runId: 'run-1' };
  const base = { t3ThreadId: 'thr', channel: 'C1', requester: 'USAM', pendingReactionTs: null, lastPostedRunId: 'run-1', createdAt: '2026-11-20T10:00:00.000Z' };
  writeFileSync(file, JSON.stringify({
    'C1:1.1': { ...base, threadTs: '1.1', watching: true, waitingInT3: true, question: card },
    'C1:2.2': { ...base, threadTs: '2.2', watching: false, waitingInT3: true },
    // SERRA-54 as an older build left it: nothing follows the job, but a seen run was never posted and its line is up.
    'C1:3.3': { ...base, threadTs: '3.3', watching: false, runSeen: { runId: 'run-2', at: 'x' }, progress: { ts: '9.9', runId: 'run-2', text: '⏳' } },
    'C1:4.4': { ...base, threadTs: '4.4', watching: false, runSeen: { runId: 'run-1', at: 'x' } },
  }));
  const { jobs } = readState(file, { now: Date.parse('2026-11-22T00:00:00Z') });
  assert.deepEqual(jobs['C1:1.1']!.phase, { state: 'waiting', card });
  assert.deepEqual(jobs['C1:2.2']!.phase, { state: 'waiting' });
  assert.deepEqual(jobs['C1:3.3']!.phase, { state: 'following', run: { id: 'run-2', at: 'x', progress: { ts: '9.9', text: '⏳' } } });
  assert.deepEqual(jobs['C1:4.4']!.phase, { state: 'idle' }, 'a seen run that was posted tells nothing');
});

test('[JOBS-002] a job older builds stopped looking at stays idle: a run owed weeks ago is not posted from nowhere', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  const quiet = { t3ThreadId: 'thr', channel: 'C1', threadTs: '5.5', requester: 'USAM', pendingReactionTs: null, lastPostedRunId: 'run-6',
    createdAt: '2026-10-01T10:00:00.000Z', lastActivityAt: '2026-10-20T10:00:00.000Z', watching: false, runSeen: { runId: 'run-7', at: 'x' } };
  const line = { ts: '9.9', runId: 'run-7', text: '⏳ Still on it' };
  writeFileSync(file, JSON.stringify({ 'C1:5.5': quiet, 'C1:6.6': { ...quiet, threadTs: '6.6', waitingInT3: true }, 'C1:7.7': { ...quiet, threadTs: '7.7', progress: line } }));
  const { jobs } = readState(file, { now: Date.parse('2026-11-22T00:00:00Z') });
  assert.deepEqual(jobs['C1:5.5']!.phase, { state: 'idle' });
  assert.deepEqual(jobs['C1:6.6']!.phase, { state: 'idle' });
  assert.deepEqual(jobs['C1:7.7']!.phase, { state: 'idle', leftover: line }, 'its line is still taken down at start');
  // An open card still works, however old: it keeps its wait.
  const card = { requestId: 'r1', questions: [], ts: '2.5', nonce: 'n', index: 0, answers: {}, runId: 'run-7' };
  writeFileSync(file, JSON.stringify({ 'C1:8.8': { ...quiet, threadTs: '8.8', waitingInT3: true, question: card } }));
  assert.deepEqual(readState(file, { now: Date.parse('2026-11-22T00:00:00Z') }).jobs['C1:8.8']!.phase, { state: 'waiting', run: { id: 'run-7', at: 'x' }, card });
  // A job still being followed is followed, however long ago it last spoke.
  writeFileSync(file, JSON.stringify({ 'C1:5.5': { ...quiet, watching: true } }));
  assert.equal(readState(file, { now: Date.parse('2026-11-22T00:00:00Z') }).jobs['C1:5.5']!.phase.state, 'following');
});

test('[JOBS-002] a file with a phase and none of the old flags is read as it is', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  const phase = { state: 'waiting', run: { id: 'run-1', at: 'x' } };
  writeFileSync(file, JSON.stringify({ 'C1:1.1': { t3ThreadId: 'thr', channel: 'C1', threadTs: '1.1', requester: 'USAM', pendingReactionTs: null,
    lastPostedRunId: null, createdAt: '2026-11-20T10:00:00.000Z', phase } }));
  const read = readState(file);
  assert.deepEqual(read.jobs['C1:1.1']!.phase, phase);
  assert.deepEqual(read.repaired, []);
});

test('[JOBS-002] after a rollback, the flags an older build changed win over the phase it kept', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  const store = createStore(file);
  store.putJob('C1:1.1', { t3ThreadId: 'thr', channel: 'C1', threadTs: '1.1', requester: 'USAM', pendingReactionTs: null, lastPostedRunId: null,
    createdAt: '2026-11-20T10:00:00.000Z', phase: { state: 'following', run: { id: 'run-1', at: 'x' } } });
  // An older build posted run-1 and stopped following: it rewrote its flags and kept `phase` as it was.
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const job = saved['C1:1.1'];
  writeFileSync(file, JSON.stringify({ 'C1:1.1': { ...job, watching: false, runSeen: undefined, lastPostedRunId: 'run-1' } }));
  const read = readState(file);
  assert.deepEqual(read.jobs['C1:1.1']!.phase, { state: 'idle' });
  assert.deepEqual(read.repaired, ['C1:1.1']);
});

test('[JOBS-002] an older or damaged job is migrated on read, and the original file is backed up before the first rewrite', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  const original = JSON.stringify({
    // From before `requester` and `pendingReactions`, with a progress line of the wrong shape.
    'C1:1.1': { t3ThreadId: 'thr_old', channel: 'C1', threadTs: '1.1', pendingReactionTs: '1.1', lastPostedRunId: 'run-1', watching: false, createdAt: '2026-01-01T00:00:00.000Z', progress: 'still on it' },
    // Not a job at all.
    'C1:2.2': { note: 'hand-edited' },
  });
  writeFileSync(file, original);
  const warnings: string[] = [];
  const store = createStore(file, { warn: (message) => warnings.push(message), now: () => new Date('2026-11-22T02:00:00Z') });
  const old = store.getJob('C1:1.1')!;
  assert.equal(old.requester, '', 'a field an older build never wrote gets its neutral default');
  assert.equal(old.pendingReactionTs, '1.1', 'what it did write is kept');
  assert.deepEqual(old.phase, { state: 'idle' }, 'a progress line of the wrong shape is dropped, not the job');
  assert.equal(store.getJob('C1:2.2'), undefined);
  assert.match(warnings.join('\n'), /1 entry that aren't jobs \(C1:2\.2\)/);

  store.putJob('C1:1.1', { ...old, phase: { state: 'following' } });
  const backup = join(dir, 'state.json.backup-2026-11-22T02-00-00.000Z');
  assert.equal(readFileSync(backup, 'utf8'), original, 'the file as it was is kept before anything is rewritten');
  store.putJob('C1:1.1', { ...old, phase: { state: 'idle' } });
  assert.equal(readdirSync(dir).filter((name) => name.includes('backup')).length, 1, 'backed up once');
});

test('[JOBS-002] a state.json that is not a JSON object stops the reader rather than being overwritten', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, '{ "C1:1.1": ');
  assert.throws(() => createStore(file), /not valid JSON/);
  writeFileSync(file, '[]');
  assert.throws(() => readState(file), /not an object/);
  assert.equal(readFileSync(file, 'utf8'), '[]');
});

test('[INTAKE-008] held requests and the pause are read through guards: a broken or wrong-shaped line is skipped, never started', (t) => {
  const dir = folder(t);
  const good = { channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: 'USAM', text: 'rename it', direct: true };
  holdRequest(dir, good);
  appendFileSync(join(dir, HELD_REQUESTS), '{broken\n{"channel":"C1","threadTs":"2.2"}\n{"channel":"C1","threadTs":"3.3","messageTs":"3.3","user":"USAM","text":"x","direct":"yes"}\n');
  assert.deepEqual(readHeld(dir), [good]);

  writeFileSync(join(dir, INTAKE_PAUSED), JSON.stringify({ reason: 'app-update', since: 'yesterday', until: 'tomorrow' }));
  assert.equal(readPause(dir), null, 'a pause with no real deadline is no pause: the bot never stays deaf');
  writeFileSync(join(dir, INTAKE_PAUSED), JSON.stringify({ reason: 'app-update', since: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() }));
  assert.ok(readPause(dir));
  assert.ok(existsSync(join(dir, HELD_REQUESTS)));
});

test('[JOBS-002] a field this build doesn\'t know (from a newer build) survives a read and a write, so a rollback loses nothing', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  const current = { ...alpha3Job, waitingInT3: false, phase: { state: 'following', run: { id: 'run-1', at: '2026-11-20T10:00:15.000Z' } } };
  writeFileSync(file, JSON.stringify({ 'C1:1700000000.000100': { ...current, futureField: { kept: 1 } } }));
  const store = createStore(file);
  assert.deepEqual(readState(file).repaired, [], 'not counted as a repair');
  store.putJob('C1:1700000000.000100', { ...store.getJob('C1:1700000000.000100')!, phase: { state: 'idle' } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['C1:1700000000.000100'].futureField, { kept: 1 });
});

test('[JOBS-002] a "__proto__" key in a saved job cannot change the job object', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, `{"C1:1700000000.000100": ${JSON.stringify(alpha3Job).slice(0, -1)}, "__proto__": {"watching": true, "polluted": true}}}`);
  const job = readState(file).jobs['C1:1700000000.000100']!;
  assert.equal(Object.getPrototypeOf(job), Object.prototype);
  assert.equal((job as unknown as { polluted?: boolean }).polluted, undefined);
});
