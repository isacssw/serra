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

test('[JOBS-002] a state.json written by alpha.3 reads as it was, and the first write keeps every field without a backup', (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ 'C1:1700000000.000100': alpha3Job }, null, 2));
  const read = readState(file);
  assert.deepEqual(read, { jobs: { 'C1:1700000000.000100': alpha3Job }, invalid: [], repaired: [] });
  const store = createStore(file);
  store.putJob('C1:1700000000.000100', { ...store.getJob('C1:1700000000.000100')!, nextTurnWaits: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['C1:1700000000.000100'], { ...alpha3Job, nextTurnWaits: true });
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('backup')), []);
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
  assert.equal(old.progress, undefined, 'a field of the wrong shape is dropped, not the job');
  assert.equal(store.getJob('C1:2.2'), undefined);
  assert.match(warnings.join('\n'), /1 entry that aren't jobs \(C1:2\.2\)/);

  store.putJob('C1:1.1', { ...old, watching: true });
  const backup = join(dir, 'state.json.backup-2026-11-22T02-00-00.000Z');
  assert.equal(readFileSync(backup, 'utf8'), original, 'the file as it was is kept before anything is rewritten');
  store.putJob('C1:1.1', { ...old, watching: false });
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
  writeFileSync(file, JSON.stringify({ 'C1:1700000000.000100': { ...alpha3Job, futureField: { kept: 1 } } }));
  const store = createStore(file);
  assert.deepEqual(readState(file).repaired, [], 'not counted as a repair');
  store.putJob('C1:1700000000.000100', { ...store.getJob('C1:1700000000.000100')!, watching: false });
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
