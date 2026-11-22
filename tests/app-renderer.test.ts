import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeCounts, badgeText, badgeTone } from '../app/renderer/badges.logic.ts';
import { defaultPath, initialPath, routeForPath } from '../app/renderer/routes.ts';
import { statusHeader, statusView } from '../app/renderer/status.logic.ts';
import type { BotStatus, JobSummary, Proposal } from '../src/contracts.ts';

const up = (counts: { needsYou: number; running: number }, slackConnected = true): BotStatus =>
  ({ state: 'up', pid: 4242, startedAt: '2026-11-19T08:00:00.000Z', slackConnected, counts });

const job = (key: string, group: JobSummary['group']): JobSummary => ({
  key, group, requester: 'U0123456789', channel: 'C0123456789', title: 'Fix the export', createdAt: '2026-11-19T08:00:00.000Z',
  lastActivityAt: '2026-11-19T08:00:00.000Z', links: {},
});
const proposal = (path: string): Proposal => ({ path, date: '2026-11-16', target: null });

test('status header: says Serra and the real state', () => {
  assert.equal(statusHeader(statusView({ state: 'stopped' })), 'Serra · stopped');
  assert.equal(statusHeader(statusView(up({ needsYou: 0, running: 0 }))), 'Serra · up');
  assert.equal(statusHeader(statusView(null)), 'Serra · checking');
});

test('status tone: down when stopped or Slack is disconnected, needs-you when a job waits on the owner', () => {
  assert.equal(statusView({ state: 'stopped' }).tone, 'down');
  const disconnected = statusView(up({ needsYou: 2, running: 1 }, false));
  assert.equal(disconnected.tone, 'down');
  assert.equal(disconnected.label, 'Slack disconnected');
  assert.equal(statusView(up({ needsYou: 0, running: 3 })).tone, 'up');
  assert.equal(statusView(up({ needsYou: 2, running: 0 })).tone, 'needs-you');
  assert.equal(statusView(null).tone, 'unknown');
});

test('status detail: counts with the right plural', () => {
  assert.equal(statusView(up({ needsYou: 1, running: 1 })).detail, 'Slack connected. 1 job needs you. 1 job running.');
  assert.equal(statusView(up({ needsYou: 2, running: 0 })).detail, 'Slack connected. 2 jobs need you. 0 jobs running.');
  assert.equal(statusView({ state: 'stopped' }).detail, 'The bot is not running.');
});

test('badge counts: live counts while the daemon is up', () => {
  const counts = badgeCounts({ status: up({ needsYou: 2, running: 1 }), jobs: [job('a', 'needs you')], proposals: null });
  assert.deepEqual(counts, { needsYou: 2, running: 1 });
});

test('badge counts: with the daemon stopped, needs-you comes from the files and nothing is running', () => {
  const jobs = [job('a', 'needs you'), job('b', 'needs you'), job('c', 'running'), job('d', 'done')];
  assert.deepEqual(badgeCounts({ status: { state: 'stopped' }, jobs, proposals: null }), { needsYou: 2 });
});

test('badge counts: unknown sources give no count rather than zero', () => {
  assert.deepEqual(badgeCounts({ status: null, jobs: null, proposals: null }), {});
  assert.deepEqual(badgeCounts({ status: { state: 'stopped' }, jobs: null, proposals: [] }), { proposals: 0 });
  const proposals = Array.from({ length: 18 }, (_, i) => proposal(`2026-11-16-page-${i}.md`));
  assert.equal(badgeCounts({ status: null, jobs: null, proposals }).proposals, 18);
});

test('badge text: hidden for zero or unknown, capped at 99+', () => {
  assert.equal(badgeText(undefined), null);
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(-1), null);
  assert.equal(badgeText(Number.NaN), null);
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeTone('needsYou'), 'warn');
  assert.equal(badgeTone('proposals'), 'accent');
});

test('routes: the window reopens on the saved screen only when it still exists', () => {
  assert.ok(routeForPath(defaultPath));
  assert.equal(initialPath(null), defaultPath);
  assert.equal(initialPath(undefined), defaultPath);
  assert.equal(initialPath('/settings/people'), '/settings/people');
  assert.equal(initialPath('/smoke'), defaultPath);
  assert.equal(initialPath('/settings/removed'), defaultPath);
});
