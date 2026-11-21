import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { acknowledgePause, admit, dropHeld, HELD_REQUESTS, heldThread, holdRequest, INTAKE_ACK, INTAKE_PAUSED, PAUSE_MS, pauseIntake, readAck, readHeld, readPause, readPauseFile, resumeIntake } from '../src/intake.ts';
import type { IncomingMessage } from '../src/types.ts';

const profile = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-intake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const message = (text: string): IncomingMessage => ({ channel: 'C0123456789', threadTs: '1.000', messageTs: '1.000', user: 'U0123456789', text, direct: true });

test('a pause holds until it is lifted or its deadline passes, and renewing keeps when it started', (t) => {
  const dir = profile(t);
  const start = Date.parse('2026-11-21T22:00:00Z');
  assert.equal(readPause(dir, start), null);
  const pause = pauseIntake(dir, 'bot-update', { now: start });
  assert.equal(pause.until, new Date(start + PAUSE_MS).toISOString());
  assert.equal(readPause(dir, start + 1000)?.reason, 'bot-update');
  assert.equal(readPause(dir, start + PAUSE_MS + 1), null, 'a pause nobody lifts lapses, so the bot never stays deaf');
  const renewed = pauseIntake(dir, 'bot-update', { now: start + 60_000 });
  assert.equal(renewed.since, pause.since);
  resumeIntake(dir);
  assert.equal(existsSync(join(dir, INTAKE_PAUSED)), false);
  resumeIntake(dir);
});

test('while paused, only a request that would start new work is held; a running job still gets its messages', () => {
  assert.equal(admit(true, false), 'hold');
  assert.equal(admit(true, true), 'handle');
  assert.equal(admit(false, false), 'handle');
  assert.equal(admit(false, true), 'handle');
});

test('held requests stay on disk until each is started, in order, once; a broken line is skipped', (t) => {
  const dir = profile(t);
  assert.deepEqual(readHeld(dir), []);
  const first = message('first');
  const second = { ...message('second'), messageTs: '2.000' };
  holdRequest(dir, first);
  holdRequest(dir, first);
  appendFileSync(join(dir, HELD_REQUESTS), 'not json\n');
  holdRequest(dir, second);
  assert.deepEqual(readHeld(dir).map((msg) => msg.text), ['first', 'second'], 'a message Slack delivered twice is held once');
  assert.ok(heldThread(dir, first.channel, first.threadTs), 'its thread counts as the bot\'s, so replies wait behind it');
  assert.equal(heldThread(dir, first.channel, '9.000'), false);
  dropHeld(dir, first);
  assert.deepEqual(readHeld(dir).map((msg) => msg.text), ['second'], 'the others stay until their turn');
  dropHeld(dir, second);
  assert.equal(existsSync(join(dir, HELD_REQUESTS)), false);
});

test('the daemon acknowledges a pause with the requests it is still starting; a stale or missing one says nothing', (t) => {
  const dir = profile(t);
  const now = Date.parse('2026-11-21T22:00:00Z');
  assert.equal(readAck(dir, now), null, 'a daemon from before pauses writes none');
  acknowledgePause(dir, 2, { pid: 42, now });
  assert.deepEqual(readAck(dir, now + 1000), { pid: 42, at: new Date(now).toISOString(), starting: 2 });
  assert.equal(readAck(dir, now + 120_000), null, 'stale');
  pauseIntake(dir, 'app-update', { now });
  resumeIntake(dir);
  assert.equal(existsSync(join(dir, INTAKE_ACK)), false, 'lifting the pause drops the acknowledgment');
  pauseIntake(dir, 'bot-update', { now, ms: 1000 });
  assert.equal(readPause(dir, now + 2000), null);
  assert.equal(readPauseFile(dir)?.reason, 'bot-update', 'the lapsed pause is still on file, for the cool-down after a restart');
});
