// The Jobs screen (APP-12): its logic module and its IPC handlers over APP-7's services.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { jobsHandlers } from '../src/handlers/jobs.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../src/status-source.ts';
import {
  ageLabel, channelOptions, channelTag, cleanupView, filterJobs, groupJobs, linkButtons, rowDetail, rowIcon, rowNote, rowParts, rowPill,
  verdictLabel,
  type JobRow,
} from '../app/renderer/screens/jobs.logic.ts';
import type { Runner } from '../src/cleanup.ts';
import type { BotStatus, CleanupVerdict } from '../src/contracts.ts';
import { engineContext, type AppContext } from './fakes/app-context.ts';

const NOW = new Date(2026, 10, 18, 15, 0, 0);
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const UP: BotStatus = { state: 'up', pid: 4242, startedAt: minutesAgo(600), slackConnected: true, counts: { needsYou: 1, running: 1 } };

const row = (key: string, group: JobRow['group'], fields: Partial<JobRow> = {}): JobRow => ({
  key, group, requester: 'U0123456789', channel: 'C0123456789', title: 'Fix the export', createdAt: minutesAgo(120),
  lastActivityAt: minutesAgo(10), links: {}, ...fields,
});

// ---------------------------------------------------------------------------------------------------------------
// jobs.logic.ts
// ---------------------------------------------------------------------------------------------------------------

test('grouping: always Needs you, Running, Done today in that order, newest first, empty groups kept', () => {
  const sections = groupJobs([
    row('done-old', 'done', { lastActivityAt: minutesAgo(240) }),
    row('ask', 'needs you'),
    row('done-new', 'done', { lastActivityAt: minutesAgo(24) }),
  ]);
  assert.deepEqual(sections.map((s) => [s.title, s.rows.map((r) => r.key)]), [
    ['Needs you', ['ask']],
    ['Running', []],
    ['Done today', ['done-new', 'done-old']],
  ]);
});

test('channel filter: one channel or all, options from the rows and keep the picked one', () => {
  const rows = [row('a', 'done', { channel: 'C2' }), row('b', 'running', { channel: 'C1' }), row('c', 'done', { channel: 'C2' })];
  assert.deepEqual(filterJobs(rows, 'C2').map((r) => r.key), ['a', 'c']);
  assert.deepEqual(filterJobs(rows, null).map((r) => r.key), ['a', 'b', 'c']);
  assert.deepEqual(channelOptions(rows), ['C1', 'C2']);
  // The picked channel's jobs may all finish and age out; the filter must still show what is picked.
  assert.deepEqual(channelOptions(rows, 'C9'), ['C1', 'C2', 'C9']);
  assert.deepEqual(groupJobs(filterJobs(rows, 'C9')).flatMap((s) => s.rows), []);
});

test('age labels as the mockup shows them', () => {
  assert.equal(ageLabel(minutesAgo(0), NOW), 'now');
  assert.equal(ageLabel(minutesAgo(12), NOW), '12m');
  assert.equal(ageLabel(minutesAgo(59), NOW), '59m');
  assert.equal(ageLabel(minutesAgo(60), NOW), '1h');
  assert.equal(ageLabel(minutesAgo(4 * 60 + 30), NOW), '4h');
  assert.equal(ageLabel(minutesAgo(2 * 24 * 60), NOW), '2d');
  assert.equal(ageLabel('not a date', NOW), '');
});

test('spinner only for jobs the daemon reports as running', () => {
  const running = row('r', 'running');
  assert.equal(rowIcon(running, UP), 'running');
  assert.equal(rowIcon(running, { state: 'stopped' }), 'paused');
  assert.equal(rowIcon(running, null), 'paused', 'no spinner before the daemon has reported');
  assert.equal(rowIcon(row('d', 'done'), UP), 'done');
  assert.equal(rowIcon(row('q', 'needs you', { needsYouReason: 'question' }), UP), 'needs-you');
  assert.equal(rowIcon(row('f', 'needs you', { needsYouReason: 'failed', error: 'boom' }), { state: 'stopped' }), 'failed');
});

test('the line under a Needs-you row: the question, else the error, else the reason', () => {
  assert.equal(rowDetail(row('q', 'needs you', { needsYouReason: 'question', ownerQuestion: 'Which timer for retries?\nMore' })), 'Which timer for retries?');
  assert.equal(rowDetail(row('f', 'needs you', { needsYouReason: 'failed', error: '\nworker crashed' })), 'worker crashed');
  assert.equal(rowDetail(row('t', 'needs you', { needsYouReason: 'waiting in T3' })), 'Waiting on you in T3');
  assert.equal(rowDetail(row('d', 'done', { ownerQuestion: 'old' })), undefined);
});

test('row parts: a job T3 has no title for says Untitled, with its key in the tooltip', () => {
  assert.deepEqual(rowParts(row('C1:1.2', 'done', { title: '' })), {
    requester: 'U0123456789', channel: 'C0123456789', title: 'Untitled', tooltip: 'T3 had no title for this job (C1:1.2)',
  });
  assert.equal(rowParts(row('C1:1.2', 'done')).title, 'Fix the export');
});

test('link buttons: Slack, T3, PR in order, disabled when absent or not https', () => {
  const buttons = linkButtons(row('a', 'done', {
    links: { slack: 'https://acme.slack.com/archives/C0123456789/p1700000000000001', t3: 'javascript:alert(1)' },
  }));
  assert.deepEqual(buttons.map((b) => [b.kind, b.url ?? null]), [
    ['slack', 'https://acme.slack.com/archives/C0123456789/p1700000000000001'],
    ['t3', null],
    ['pr', null],
  ]);
  assert.equal(buttons[2]?.hint, 'No pull request yet');
  assert.equal(linkButtons(row('b', 'done', { links: { pr: 'https://github.com/acme/project/pull/7' } }))[2]?.url, 'https://github.com/acme/project/pull/7');
});

const verdict = (fields: Partial<CleanupVerdict>): CleanupVerdict =>
  ({ threadId: 'thread-1', path: '/Users/you/.t3/worktrees/project/task', branch: 'task', removable: false, reason: 'a run is in progress', ...fields });

test('cleanup dialog: dry run splits remove and keep; apply reports removed and failed', () => {
  const dry = cleanupView([verdict({ removable: true, reason: 'quiet 5 days' }), verdict({ threadId: 'thread-2' })], false);
  assert.equal(dry.remove.length, 1);
  assert.equal(dry.keep.length, 1);
  assert.equal(dry.summary, '1 worktree can go. 1 kept.');
  assert.equal(cleanupView([verdict({})], false).summary, 'Nothing to clean up. 1 kept.');
  assert.equal(cleanupView([], false).summary, 'Nothing to clean up. 0 kept.');

  const applied = cleanupView([
    verdict({ removable: true, removed: true }),
    verdict({ threadId: 'thread-2', removable: true, removed: false, error: 'locked' }),
  ], true);
  assert.equal(applied.summary, 'Removed 1 worktree. 1 failed.');
  assert.equal(applied.failed[0]?.error, 'locked');
  assert.equal(verdictLabel(verdict({})), 'project/task');
  assert.equal(verdictLabel(verdict({ path: null, branch: null })), 'thread-1');
});

// ---------------------------------------------------------------------------------------------------------------
// app/main/ipc/jobs.ts
// ---------------------------------------------------------------------------------------------------------------

const context = (profileDir: string): AppContext => ({
  profileDirOrNull: () => profileDir,
  profileDir: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

/** A valid profile with one job waiting on the owner, its t3 binary pointing nowhere. */
const profile = (t: TestContext, extra: { secrets?: unknown } = {}) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-jobs-screen-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const example = JSON.parse(readFileSync(new URL('../examples/profile.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const t3Bin = join(dir, 'missing-t3');
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...example, t3Bin }));
  const state = {
    'C0123456789:1700000000.000001': {
      t3ThreadId: 'thread-a', channel: 'C0123456789', threadTs: '1700000000.000001', requester: 'U0123456789',
      pendingReactionTs: null, lastPostedRunId: null, watching: true, ownerAskOpen: true,
      createdAt: minutesAgo(30), lastActivityAt: minutesAgo(12),
    },
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  if (extra.secrets) writeFileSync(join(dir, 'secrets.json'), JSON.stringify(extra.secrets));
  return { dir, t3Bin };
};

test('jobs.list reads the files with the daemon stopped, with Slack links from the saved workspace', async (t) => {
  const { dir, t3Bin } = profile(t, {
    secrets: { version: 1, sources: {}, checks: {}, slack: { url: 'https://acme.slack.com', checkedAt: minutesAgo(5) } },
  });
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, t3Bin, 'the t3 binary comes from profile.json');
    return JSON.stringify({ thread: { title: 'Serra: Fix the export', link: 'https://t3.example/threads/thread-a' } });
  };
  const handlers = jobsHandlers(engineContext(context(dir)), { run, now: () => NOW });
  const before = readFileSync(join(dir, 'state.json'), 'utf8');
  const rows = await handlers.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.group, 'needs you');
  assert.equal(rows[0]?.needsYouReason, 'owner pinged');
  assert.equal(rows[0]?.title, 'Fix the export');
  assert.deepEqual(rows[0]?.links, {
    slack: 'https://acme.slack.com/archives/C0123456789/p1700000000000001',
    t3: 'https://t3.example/threads/thread-a',
  });
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before, 'state.json is never written');
  // The list reloads on every daemon event; a thread's title and link are asked from T3 once.
  await handlers.list();
  assert.equal(calls.length, 1);
});

test('jobs.list without a saved workspace or a working t3 still lists the job, with no links', async (t) => {
  const { dir } = profile(t);
  const handlers = jobsHandlers(engineContext(context(dir)), { run: async () => { throw new Error('t3 not found'); }, now: () => NOW });
  const rows = await handlers.list();
  assert.deepEqual(rows.map((r) => [r.group, r.title, r.links]), [['needs you', '', {}]]);
});

test('jobs.cleanupWorktrees: dry run removes nothing, apply removes, bad input is refused', async (t) => {
  const { dir, t3Bin } = profile(t);
  const worktreesRoot = join(dir, 'worktrees');
  const path = join(worktreesRoot, 'project', 'task');
  mkdirSync(path, { recursive: true });
  const old = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'C1:1': { t3ThreadId: 'old', channel: 'C1', threadTs: '1', createdAt: old, lastActivityAt: old } }));
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === t3Bin) return JSON.stringify({ thread: { worktreePath: path, branch: 'task', activeRunId: null, openPullRequestCount: 0, updatedAt: old } });
    if (cmd === 'gh') return '[]';
    if (cmd === 'git' && args[2] === 'symbolic-ref') return 'task\n';
    return '';
  };
  const handlers = jobsHandlers(engineContext(context(dir)), { run, now: () => NOW, worktreesRoot });

  const dry = await handlers.cleanupWorktrees({ apply: false });
  assert.deepEqual(dry.map((v) => [v.path, v.removable, v.removed]), [[path, true, undefined]]);
  assert.ok(!calls.some((call) => call.includes('remove')), 'a dry run never removes');
  assert.ok(existsSync(path));

  const applied = await handlers.cleanupWorktrees({ apply: true, days: 3 });
  assert.equal(applied[0]?.removed, true);
  assert.deepEqual(calls.at(-1), ['git', '-C', path, 'worktree', 'remove', path]);

  await assert.rejects(Promise.resolve().then(() => handlers.cleanupWorktrees({ apply: false, days: -1 })), /days/);
  await assert.rejects(Promise.resolve().then(() => handlers.cleanupWorktrees({} as { apply: boolean })), /apply/);
});

test('row pill and note: a Needs-you row says why in 1-3 words, and its question or failure in the meta line', () => {
  assert.deepEqual(rowPill(row('q', 'needs you', { needsYouReason: 'question', ownerQuestion: 'Which timer?' })), { label: 'Asked in chat', tone: 'warn' });
  assert.deepEqual(rowPill(row('t', 'needs you', { needsYouReason: 'waiting in T3' })), { label: 'Waiting in T3', tone: 'warn' });
  assert.deepEqual(rowPill(row('p', 'needs you', { needsYouReason: 'owner pinged' })), { label: 'Blocked in Slack', tone: 'warn' });
  assert.deepEqual(rowPill(row('f', 'needs you', { needsYouReason: 'failed', error: 'boom' })), { label: 'Failed', tone: 'down' });
  assert.deepEqual(rowPill(row('r', 'running'), 'running'), { label: 'Working', tone: 'neutral' });
  assert.deepEqual(rowPill(row('r', 'running'), 'paused'), { label: 'Paused', tone: 'neutral' });
  assert.equal(rowPill(row('d', 'done')), undefined);
  assert.equal(rowNote(row('q', 'needs you', { needsYouReason: 'question', ownerQuestion: '\nWhich timer?\nMore' })), 'Which timer?');
  assert.equal(rowNote(row('t', 'needs you', { needsYouReason: 'waiting in T3' })), undefined, 'the pill already says why');
  assert.equal(rowNote(row('d', 'done', { error: 'old' })), undefined);
});

test('channel tag: #name once Slack named it, the raw ID before, the app for app tasks', () => {
  assert.equal(channelTag(row('a', 'done', { channelName: 'eng' })), '#eng');
  assert.equal(channelTag(row('b', 'done', { channelName: '#eng' })), '#eng');
  assert.equal(channelTag(row('c', 'done')), 'C0123456789');
  assert.equal(channelTag(row('d', 'done', { channel: 'app' })), 'Serra app');
});
