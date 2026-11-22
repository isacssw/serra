import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyWorktreeCleanup, planWorktreeCleanup, type Runner } from '../src/cleanup.ts';
import { ageLabel, formatJobs, listJobs, slackThreadLink, t3ThreadLookup } from '../src/jobs.ts';
import { runCli } from '../src/manage.ts';
import { threadPullRequest } from '../src/t3.ts';
import { t3TaskState } from '../src/tasks.ts';
import { cachedLookup, THREAD_RECHECK_MS } from '../app/main/ipc/jobs.ts';

/** Local time, so "today" doesn't depend on the machine's time zone. */
const NOW = new Date(2026, 10, 18, 15, 0, 0);
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const job = (channel: string, threadTs: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  t3ThreadId: `thread-${threadTs}`,
  channel,
  threadTs,
  requester: 'U0123456789',
  pendingReactionTs: null,
  pendingReactions: [],
  lastPostedRunId: 'run-1',
  watching: true,
  createdAt: minutesAgo(120),
  lastActivityAt: minutesAgo(60),
  ...fields,
});

const profile = (t: TestContext, jobs: Record<string, unknown>[], events: Record<string, unknown>[] = []): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-jobs-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = Object.fromEntries(jobs.map((value) => [`${value.channel}:${value.threadTs}`, value]));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'events.jsonl'), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
  return dir;
};

test('jobs are grouped needs you, running, done, newest first, and state.json is not written', async (t) => {
  const dir = profile(t, [
    job('C1', '1700000000.000001'),
    job('C1', '1700000000.000002', { ownerAskOpen: true, lastActivityAt: minutesAgo(12) }),
    job('C1', '1700000000.000003', { loadingRequested: true, lastActivityAt: minutesAgo(4) }),
    job('C1', '1700000000.000004', { waitingInT3: true, lastActivityAt: minutesAgo(5) }),
    job('C1', '1700000000.000005', { runSeen: { runId: 'run-2', at: minutesAgo(3) } }),
    job('C1', '1700000000.000006', {
      question: { requestId: 'r1', ts: '1700000000.000060', nonce: 'n1', answers: {}, runId: 'run-1',
        questions: [{ id: 'q1', question: 'Which timer should I use for retries?', options: [] }], index: 0 },
    }),
    job('C1', '1700000000.000007'),
  ], [
    { at: minutesAgo(2), event: 'failure', key: 'C1:1700000000.000007', error: 'worktree create failed' },
    // A failure followed by a reply is over.
    { at: minutesAgo(50), event: 'failure', key: 'C1:1700000000.000001', error: 'old' },
    { at: minutesAgo(40), event: 'reply', key: 'C1:1700000000.000001', kind: 'reply' },
    'not json' as unknown as Record<string, unknown>,
  ]);
  writeFileSync(join(dir, 'logs', 'events.jsonl'), `${readFileSync(join(dir, 'logs', 'events.jsonl'), 'utf8')}{broken\n`);
  const before = { text: readFileSync(join(dir, 'state.json'), 'utf8'), mtime: statSync(join(dir, 'state.json')).mtimeMs };

  const { jobs } = await listJobs(dir, { now: NOW });

  assert.deepEqual(jobs.map((row) => [row.key.slice(-1), row.group, row.needsYouReason ?? null]), [
    ['7', 'needs you', 'failed'],
    ['4', 'needs you', 'waiting in T3'],
    ['2', 'needs you', 'owner pinged'],
    ['6', 'needs you', 'question'],
    ['3', 'running', null],
    ['5', 'running', null],
    ['1', 'done', null],
  ]);
  assert.equal(jobs.find((row) => row.key.endsWith('6'))?.ownerQuestion, 'Which timer should I use for retries?');
  assert.equal(jobs[0]?.error, 'worktree create failed');
  // The newest event counts as activity.
  assert.equal(jobs.find((row) => row.key.endsWith('1'))?.lastActivityAt, minutesAgo(40));
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before.text);
  assert.equal(statSync(join(dir, 'state.json')).mtimeMs, before.mtime);
});

test('done shows today only by default, and every done job when asked', async (t) => {
  const yesterday = new Date(2026, 10, 17, 23, 30).toISOString();
  const dir = profile(t, [
    job('C1', '1700000000.000001', { lastActivityAt: new Date(2026, 10, 18, 0, 10).toISOString() }),
    job('C1', '1700000000.000002', { createdAt: yesterday, lastActivityAt: yesterday }),
    // Quiet since yesterday but still waiting on the owner: needs-you rows never age out.
    job('C1', '1700000000.000003', { createdAt: yesterday, lastActivityAt: yesterday, ownerAskOpen: true }),
  ]);

  const today = await listJobs(dir, { now: NOW });
  assert.deepEqual(today.jobs.map((row) => row.key.slice(-1)), ['3', '1']);
  const all = await listJobs(dir, { now: NOW, doneTodayOnly: false });
  assert.deepEqual(all.jobs.map((row) => row.key.slice(-1)), ['3', '1', '2']);
});

test('links: the PR comes only from a recorded review request, Slack only with the workspace URL', async (t) => {
  const dir = profile(t, [
    job('C1', '1700000000.000001'),
    job('C1', '1700000000.000002', {
      reviewRequestedPrs: ['https://github.com/acme/project/pull/7', 'https://github.com/acme/project/pull/9'],
      lastActivityAt: minutesAgo(30),
    }),
  ]);

  const bare = await listJobs(dir, { now: NOW });
  assert.deepEqual(bare.jobs.map((row) => row.links), [{ pr: 'https://github.com/acme/project/pull/9' }, {}]);
  assert.ok(!('pr' in bare.jobs[1]!.links), 'a job with no PR has no PR link, not a guessed one');
  assert.equal(bare.jobs[0]!.title, '', 'no title without T3: state.json does not carry one');

  const linked = await listJobs(dir, { now: NOW, slackUrl: 'https://acme.slack.com/' });
  assert.equal(linked.jobs[1]!.links.slack, 'https://acme.slack.com/archives/C1/p1700000000000001');
  assert.equal(slackThreadLink('https://acme.slack.com', 'C1', 'not-a-ts'), undefined);
});

test('the channel filter keeps one channel and lists every channel for the picker', async (t) => {
  const dir = profile(t, [
    job('C2', '1700000000.000001'),
    job('C1', '1700000000.000002'),
    job('D1', '1700000000.000003', { ownerAskOpen: true }),
  ]);

  const listing = await listJobs(dir, { now: NOW, channel: 'C1' });
  assert.deepEqual(listing.jobs.map((row) => row.key), ['C1:1700000000.000002']);
  assert.deepEqual(listing.channels, ['C1', 'C2', 'D1']);
});

test('T3 adds the title and link; a thread T3 cannot read keeps both absent', async (t) => {
  const dir = profile(t, [
    job('C1', '1700000000.000001'),
    job('C1', '1700000000.000002', { lastActivityAt: minutesAgo(30) }),
  ]);
  const threads = async (id: string) => (id === 'thread-1700000000.000002'
    ? { title: 'Friday: Fix the export timer', link: 'https://t3.example/thread/2' }
    : null);

  const { jobs } = await listJobs(dir, { now: NOW, threads });
  assert.equal(jobs[0]!.title, 'Fix the export timer');
  assert.equal(jobs[0]!.links.t3, 'https://t3.example/thread/2');
  assert.equal(jobs[1]!.title, '');
  assert.ok(!('t3' in jobs[1]!.links));
});

test('t3ThreadLookup reads title and link from t3 thread show, and null when t3 fails', async () => {
  const calls: string[][] = [];
  const run: Runner = async (_cmd, args) => {
    calls.push(args);
    if (args.at(-1) === 'bad') throw new Error('no such thread');
    return JSON.stringify({ thread: { threadId: 'ok', title: 'Friday: a task', link: 't3://thread/ok' }, messages: [] });
  };
  const lookup = t3ThreadLookup('/fake/t3', run);
  assert.deepEqual(await lookup('ok'), { title: 'Friday: a task', link: 't3://thread/ok' });
  assert.equal(await lookup('bad'), null);
  assert.deepEqual(calls[0], ['thread', 'show', '--messages', '1', '--json', 'ok']);
});

test('a profile with no state.json or event log has no jobs', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-jobs-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await listJobs(dir, { now: NOW }), { jobs: [], channels: [] });
  assert.equal(formatJobs({ jobs: [], channels: [] }), 'No jobs.');
});

test('ageLabel and the CLI report', async (t) => {
  assert.equal(ageLabel(minutesAgo(0), NOW), 'now');
  assert.equal(ageLabel(minutesAgo(12), NOW), '12m');
  assert.equal(ageLabel(minutesAgo(125), NOW), '2h');
  assert.equal(ageLabel(minutesAgo(3 * 24 * 60), NOW), '3d');

  const dir = profile(t, [job('C1', '1700000000.000001', { ownerAskOpen: true, lastActivityAt: minutesAgo(12) })]);
  const report = formatJobs(await listJobs(dir, { now: NOW }), { now: NOW });
  assert.equal(report, ['Needs you (1)', '   12m  U0123456789 · C1 · C1:1700000000.000001', '        Blocked, waiting on you in Slack'].join('\n'));
});

/** A valid profile whose t3 binary doesn't exist, a worktrees folder and one job whose worktree cleanup may remove. */
const cleanupFixture = (t: TestContext) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-jobs-cleanup-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const example = JSON.parse(readFileSync(new URL('../examples/profile.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const t3Bin = join(dir, 'missing-t3');
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...example, t3Bin }));
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
  return { dir, path, worktreesRoot, calls, run, t3Bin };
};

test('cleanup dry run lists what would go and removes nothing', async (t) => {
  const { dir, path, worktreesRoot, calls, run, t3Bin } = cleanupFixture(t);
  const report = await planWorktreeCleanup(dir, { now: NOW, worktreesRoot, run });
  assert.equal(report.applied, false);
  assert.equal(report.removable, 1, JSON.stringify(report.verdicts));
  assert.equal(report.removed, 0);
  assert.equal(report.kept, 0);
  assert.equal(report.verdicts[0]?.path, path);
  assert.ok(!calls.some((call) => call.includes('remove')), 'a dry run never runs git worktree remove');
  assert.ok(existsSync(path));
  assert.equal(calls[0]?.[0], t3Bin, 'the t3 binary comes from profile.json, with no Slack token needed');
});

test('cleanup apply removes the removable worktrees and counts them', async (t) => {
  const { dir, path, worktreesRoot, calls, run } = cleanupFixture(t);
  const report = await applyWorktreeCleanup(dir, { now: NOW, worktreesRoot, run });
  assert.equal(report.applied, true);
  assert.equal(report.removed, 1);
  assert.deepEqual(calls.at(-1), ['git', '-C', path, 'worktree', 'remove', path]);
  await assert.rejects(planWorktreeCleanup(dir, { days: -1, run }), /days/);
});

test('pnpm bot jobs prints the list from the profile files', async (t) => {
  const { dir } = cleanupFixture(t);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    'C1:1700000000.000001': job('C1', '1700000000.000001', { ownerAskOpen: true, lastActivityAt: new Date().toISOString() }),
  }));
  const out: string[] = [];
  assert.equal(await runCli(['jobs', '--profile', dir, '--json'], { log: (line) => out.push(line), error: (line) => out.push(line) }), 0);
  const listing = JSON.parse(out.join('\n')) as { jobs: { key: string; group: string }[] };
  assert.deepEqual(listing.jobs.map((row) => [row.key, row.group]), [['C1:1700000000.000001', 'needs you']]);
  assert.equal(await runCli(['jobs', '--profile', dir, '--slack-url', 'nope'], { log: () => {}, error: (line) => out.push(line) }), 1);
  assert.match(out.at(-1)!, /--slack-url/);
});

// ---------------------------------------------------------------------------------------------------------------
// The PR a job's T3 thread opened (a draft PR gets no review request, so state.json never records it)
// ---------------------------------------------------------------------------------------------------------------

test('threadPullRequest: the linked PR, else the newest open one, else the newest; only github.com PRs', () => {
  const pr = (number: number, state = 'open', repo = 'acme/billing') => ({ host: 'github.com', repository: repo, number, url: `https://github.com/${repo}/pull/${number}`, state });
  assert.equal(threadPullRequest({ pullRequests: [pr(1)], linkedPullRequest: null }), 'https://github.com/acme/billing/pull/1');
  assert.equal(threadPullRequest({ pullRequests: [pr(1), pr(2, 'closed')] }), 'https://github.com/acme/billing/pull/1', 'an open PR beats a newer closed one');
  assert.equal(threadPullRequest({ pullRequests: [pr(1, 'merged'), pr(2, 'closed')] }), 'https://github.com/acme/billing/pull/2');
  assert.equal(threadPullRequest({ pullRequests: [pr(1)], linkedPullRequest: pr(7) }), 'https://github.com/acme/billing/pull/7');
  assert.equal(threadPullRequest({ pullRequests: [{ url: 'https://evil.example/pull/1', state: 'open' }] }), undefined);
  assert.equal(threadPullRequest({ pullRequests: 'nope' }), undefined);
  assert.equal(threadPullRequest({}), undefined);
});

test('a job links the PR its T3 thread opened, and a review request still wins', async (t) => {
  const dir = profile(t, [
    job('C1', '1700000000.000001'),
    job('C1', '1700000000.000002', { reviewRequestedPrs: ['https://github.com/acme/project/pull/9'], lastActivityAt: minutesAgo(30) }),
  ]);
  const t3: Runner = async (_cmd, args) => JSON.stringify({
    thread: {
      title: 'Friday: Fix it', link: `https://t3.example/${args.at(-1)}`, linkedPullRequest: null,
      pullRequests: [{ host: 'github.com', repository: 'acme/project', number: 1, url: 'https://github.com/acme/project/pull/1', source: 'created', state: 'open' }],
    },
  });
  const { jobs } = await listJobs(dir, { now: NOW, threads: t3ThreadLookup('/fake/t3', t3) });
  assert.equal(jobs[1]!.links.pr, 'https://github.com/acme/project/pull/1', 'the draft PR T3 recorded');
  assert.equal(jobs[0]!.links.pr, 'https://github.com/acme/project/pull/9', 'the PR the bot asked a review for');
  assert.equal(formatJobs({ jobs, channels: [] }, { now: NOW }).includes('https://github.com/acme/project/pull/1'), true);
});

test('an app task links its PR from T3', async (t) => {
  const dir = profile(t, []);
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ t3ThreadId: 'task-1', requester: 'Sam', title: 'Add a test', branch: 'friday/add-a-test', createdAt: minutesAgo(5) }]));
  const t3: Runner = async () => JSON.stringify({ thread: { link: 'https://t3.example/task-1', pullRequests: [{ url: 'https://github.com/acme/project/pull/4', state: 'open' }] } });
  const { jobs } = await listJobs(dir, { now: NOW, tasks: t3TaskState('/fake/t3', t3) });
  assert.deepEqual(jobs.map((row) => row.links), [{ t3: 'https://t3.example/task-1', pr: 'https://github.com/acme/project/pull/4' }]);
});

test('the app asks T3 again for a thread with no PR yet, and stops asking once it has one', async () => {
  let clock = 0;
  let pr: string | undefined;
  let calls = 0;
  const t3: Runner = async () => {
    calls += 1;
    return JSON.stringify({ thread: { title: 'Friday: Fix it', link: 'https://t3.example/x', pullRequests: pr ? [{ url: pr, state: 'open' }] : [] } });
  };
  const lookup = cachedLookup(new Map(), '/fake/t3', t3, () => clock);
  assert.equal((await lookup('x'))?.pr, undefined);
  assert.equal((await lookup('x'))?.pr, undefined);
  assert.equal(calls, 1, 'remembered for a while');
  pr = 'https://github.com/acme/project/pull/1';
  clock += THREAD_RECHECK_MS + 1;
  assert.equal((await lookup('x'))?.pr, pr, 'the PR shows once the worker opened it');
  clock += 10 * THREAD_RECHECK_MS;
  await lookup('x');
  assert.equal(calls, 2, 'a thread with a PR is not asked again');
});

test('SERRA-54: a Slack job the file lists as running is done when T3 runs nothing and its newest run is posted', async (t) => {
  const yesterday = new Date(2026, 10, 17, 12, 0).toISOString();
  const ghost = { runSeen: { runId: 'run-1', at: minutesAgo(90) }, lastPostedRunId: 'run-2' };
  const dir = profile(t, [
    // A run started and ended between polls: the seen run never matches the posted one.
    job('C1', '1700000000.000001', ghost),
    // The same, but T3 is running it again.
    job('C1', '1700000000.000002', { ...ghost, lastActivityAt: minutesAgo(50) }),
    // T3 finished a run the bot hasn't posted yet: its reply is still owed.
    job('C1', '1700000000.000003', { ...ghost, lastActivityAt: minutesAgo(40) }),
    // T3 can't read the thread: the file decides.
    job('C1', '1700000000.000004', { ...ghost, lastActivityAt: minutesAgo(30) }),
    // Carried over from an older install, quiet since yesterday: done, and so out of today's list.
    job('C1', '1700000000.000005', { pendingReactionTs: '1700000000.000005', loadingRequested: true, createdAt: yesterday, lastActivityAt: yesterday }),
    // A follow-up that came in a moment ago and hasn't reached T3 yet: T3 is idle, but a run is about to start.
    job('C1', '1700000000.000006', { lastPostedRunId: 'run-2', pendingReactions: ['1700000000.000106'], loadingRequested: true, lastActivityAt: minutesAgo(1) }),
  ]);
  const asked: string[] = [];
  const runs = async (threadId: string) => {
    asked.push(threadId);
    const n = threadId.slice(-1);
    if (n === '4') return null;
    return { running: n === '2', waiting: false, latestRunId: n === '3' ? 'run-3' : n === '5' ? 'run-1' : 'run-2' };
  };

  const fileOnly = await listJobs(dir, { now: NOW });
  assert.deepEqual(fileOnly.jobs.map((row) => [row.key.slice(-1), row.group]), [['6', 'running'], ['4', 'running'], ['3', 'running'], ['2', 'running'], ['1', 'running'], ['5', 'running']]);

  const { jobs } = await listJobs(dir, { now: NOW, runs });
  assert.deepEqual(jobs.map((row) => [row.key.slice(-1), row.group]), [['6', 'running'], ['4', 'running'], ['3', 'running'], ['2', 'running'], ['1', 'done']]);
  // Once it had time to reach T3 and still no run started, its 👀 is stale too.
  const later = await listJobs(dir, { now: new Date(NOW.getTime() + 3 * 60_000), runs });
  assert.equal(later.jobs.find((row) => row.key.endsWith('6'))?.group, 'done');
  const all = await listJobs(dir, { now: NOW, runs, doneTodayOnly: false });
  assert.deepEqual(all.jobs.filter((row) => row.group === 'done').map((row) => row.key.slice(-1)), ['1', '5']);
  assert.ok(asked.every((id) => id.startsWith('thread-')), 'only jobs saved as running are looked up');
});

test('t3TaskState reports the thread\'s newest run', async () => {
  const lookup = t3TaskState('t3', async () => JSON.stringify({ thread: { activeRunId: null, latestRunId: 'run-7', pendingRequestCount: 0 } }));
  assert.deepEqual(await lookup('thread-1'), { running: false, waiting: false, latestRunId: 'run-7' });
});
