import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { badgeCounts, badgeText, badgeTone } from '../app/renderer/badges.logic.ts';
import { defaultPath, initialPath, routeForPath, routes, sections } from '../app/renderer/routes.ts';
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

test('routes: every sidebar item has a unique route, in a known section', () => {
  const paths = routes.map((route) => route.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(new Set(routes.map((route) => route.id)).size, routes.length);
  const sectionIds = new Set(sections.map((section) => section.id));
  for (const route of routes) {
    assert.ok(sectionIds.has(route.section), `${route.id} is in an unknown section`);
    assert.match(route.path, /^\/[a-z-]+(\/[a-z-]+)?$/);
    assert.match(route.ticket, /^APP-\d+$/);
  }
  // The MVP screens from the spike, in the mockup's order.
  assert.deepEqual(routes.map((route) => route.label), [
    'Needs you', 'Running', 'Done today', 'New task', 'Proposals', 'Pages', 'Brief & policy', 'Bot & Slack', 'People', 'Repositories',
    'Alerts', 'Worker', 'Secrets', 'Tools (MCP)', 'Updates', 'Diagnostics', 'Appearance',
  ]);
});

test('routes: the window reopens on the saved screen only when it still exists', () => {
  assert.ok(routeForPath(defaultPath));
  assert.equal(initialPath(null), defaultPath);
  assert.equal(initialPath(undefined), defaultPath);
  assert.equal(initialPath('/settings/people'), '/settings/people');
  assert.equal(initialPath('/smoke'), defaultPath);
  assert.equal(initialPath('/settings/removed'), defaultPath);
});

test('renderer: the page is titled Serra and imports no Node modules', () => {
  const root = fileURLToPath(new URL('../app/renderer/', import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => /\.(tsx?|html|css)$/.test(file));
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = readFileSync(root + file, 'utf8');
    // The renderer may only import Node modules' types (via contracts), never `node:` modules at runtime.
    if (file !== 'vite.config.ts') assert.doesNotMatch(text, /from 'node:/, `${file} imports a Node module`);
  }
  assert.match(readFileSync(root + 'index.html', 'utf8'), /<title>Serra<\/title>/);
});

test('renderer: a monospace field sets font-mono on the field, not on its label and note', () => {
  // QA: `className="font-mono"` on <Input> styles the wrapper, so the wizard's labels and hints came out monospace.
  const root = fileURLToPath(new URL('../app/renderer/', import.meta.url));
  const screens = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.tsx'));
  for (const file of screens) {
    for (const [tag] of readFileSync(root + file, 'utf8').matchAll(/<Input\b[^>]*>/gs)) {
      assert.doesNotMatch(tag, /(?<!input)className="[^"]*\bfont-mono\b/, `${file}: use inputClassName="font-mono"`);
    }
  }
  assert.match(readFileSync(root + 'ui/Input.tsx', 'utf8'), /inputClassName,\n\s*\)\}/, 'Input puts inputClassName on the <input>');
});
