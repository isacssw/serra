import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { admit, HELD_REQUESTS, heldCount, holdRequest, INTAKE_PAUSED, PAUSE_MS, pauseIntake, readPause, resumeIntake, takeHeld } from '../src/intake.ts';
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

test('held requests come back once, in order, and a broken line is skipped', (t) => {
  const dir = profile(t);
  assert.deepEqual(takeHeld(dir), []);
  holdRequest(dir, message('first'));
  appendFileSync(join(dir, HELD_REQUESTS), 'not json\n');
  holdRequest(dir, message('second'));
  assert.equal(heldCount(dir), 3);
  assert.deepEqual(takeHeld(dir).map((msg) => msg.text), ['first', 'second']);
  assert.deepEqual(takeHeld(dir), [], 'each is started once');
  assert.equal(heldCount(dir), 0);
});
