// Tasks started from the app (APP-25): the service against a fake `t3` binary, the brief compared with the daemon's,
// the Jobs listing and cleanup that pick tasks up, the IPC handlers and the New task screen's logic.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { jobsHandlers } from '../app/main/ipc/jobs.ts';
import { tasksHandlers } from '../app/main/ipc/tasks.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { linkButtons, rowIcon } from '../app/renderer/screens/jobs.logic.ts';
import { canStart, MAX_REQUEST, requestProblem, startedText } from '../app/renderer/screens/newTask.logic.ts';
import { slackChat } from './fakes/chat.ts';
import { createBot } from '../src/bot.ts';
import { cleanupWorktrees } from '../src/cleanup.ts';
import { loadConfig } from '../src/config.ts';
import { listJobs } from '../src/jobs.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { createProfile } from '../src/setup.ts';
import { createStore } from '../src/state.ts';
import {
  APP_TASK_CHANNEL, appTaskThread, MAX_TASK_REQUEST, previewTask, readTasks, startTask, t3TaskState, tasksPath,
} from '../src/tasks.ts';
import type { StartThreadInput } from '../src/types.ts';
import { fakeClock } from './fakes/clock.ts';
import { createFakeSlack } from './fakes/slack.ts';

const OWNER = 'U0123456789';
const NOW = new Date('2026-11-18T10:00:00Z');
const REQUEST = 'Update the onboarding page for the new pricing\nand open a PR.';

interface Call { args: string[]; input: string }

/** A profile whose `t3Bin` is a fake that records every call and answers like T3 does. */
const fixture = (t: TestContext, { failStart = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-tasks-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profile');
  const bin = join(root, 't3');
  const calls = join(root, 'calls.jsonl');
  createProfile(profileDir, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' },
    allowedUsers: [], worker: { provider: 'claude', model: 'opus' }, t3Bin: bin,
  });
  writeFileSync(join(profileDir, '.env'), 'SLACK_APP_TOKEN=xapp-fixture\nSLACK_BOT_TOKEN=xoxb-fixture\n');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
// Only start reads the brief from stdin; show answers at once, as T3 does, even when stdin is left open.
const answer = () => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, input }) + '\\n');
  if (args[1] === 'start') {
    if (${failStart}) { console.error('no worktree'); process.exit(1); }
    console.log('Starting…' + JSON.stringify({ threadId: 'task-thread' }));
  } else if (args[1] === 'show') {
    console.log(JSON.stringify({ thread: { threadId: args.at(-1), title: 'Friday: task', link: 'https://t3.test/' + args.at(-1), status: 'running',
      latestRunId: 'run-1', activeRunId: 'run-1', pendingRequestCount: 0, updatedAt: '2026-11-18T10:05:00Z' }, messages: [] }));
  }
};
if (args[1] === 'start') {
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', answer);
} else answer();
`, { mode: 0o700 });
  const recorded = (): Call[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Call) : []);
  return { profileDir, bin, recorded };
};

const noFetch = async (): Promise<void> => {};

test('startTask starts the T3 thread through the real startThread, with the brief on stdin, and records it', async (t) => {
  const { profileDir, recorded } = fixture(t);
  const stateBefore = readFileSync(join(profileDir, 'state.json'), 'utf8');
  const fetched: string[] = [];
  const task = await startTask(profileDir, `  ${REQUEST}  `, { fetchBase: async (config) => { fetched.push(config.project); }, now: () => NOW });

  assert.deepEqual(fetched, ['/Users/you/project'], 'the base is fetched first, as the daemon does');
  const [start, show] = recorded();
  assert.deepEqual(start!.args.slice(0, 4), ['thread', 'start', '--worktree', 'origin/main']);
  assert.equal(start!.args[4], '--branch');
  assert.match(start!.args[5]!, /^friday\/update-the-onboarding-page-for-the-new-/);
  assert.deepEqual(start!.args.slice(6), [
    '--title', 'Friday: Update the onboarding page for the new pricing and open a PR', '--provider', 'claude', '--model', 'opus',
    '--json', '/Users/you/project', '-',
  ]);
  assert.match(start!.input, /Update the onboarding page for the new pricing\nand open a PR\./);
  assert.ok(start!.input.includes('\nAlex (your owner) asked:\n'), 'R13: no Slack link, so the brief says just who asked');
  assert.ok(!start!.input.includes('None. The owner') && !start!.input.includes('()'));
  assert.ok(start!.input.includes(appTaskThread('Alex')));
  assert.deepEqual(show!.args, ['thread', 'show', '--messages', '1', '--json', 'task-thread']);

  assert.deepEqual(task, {
    t3ThreadId: 'task-thread', title: 'Update the onboarding page for the new pricing and open a PR', branch: start!.args[5],
    requester: 'Alex', createdAt: NOW.toISOString(), link: 'https://t3.test/task-thread',
  });
  const { link: _link, ...recordedTask } = task;
  assert.deepEqual(readTasks(profileDir), [recordedTask]);
  assert.equal(readFileSync(join(profileDir, 'state.json'), 'utf8'), stateBefore, "the daemon's state.json is never written");
  assert.ok(!JSON.stringify(task).includes('xoxb') && !readFileSync(tasksPath(profileDir), 'utf8').includes('xoxb'));
});

test('the brief a task sends is the one the daemon sends for the same request, but for the Slack link', async (t) => {
  const { profileDir, recorded } = fixture(t);
  const config = loadConfig({ profileDir, env: {} });

  // The daemon, for the owner asking the same thing in a new DM thread.
  let daemon: StartThreadInput | undefined;
  const quiet = (): void => {};
  const { client } = createFakeSlack({ names: { [OWNER]: 'Alex' } });
  client.chat.getPermalink = async () => ({ ok: true, permalink: 'https://acme.slack.com/archives/D0123456789/p100' });
  const bot = createBot({
    config, ...slackChat(client, config, { botUserId: 'UBOT' }), store: createStore(config.statePath),
    loadIndex: createKnowledge(config.knowledgeDir).loadIndex,
    loadKnowledge: (visibility) => createKnowledge(config.knowledgeDir).briefKnowledge(visibility),
    logger: { info: quiet, warn: quiet, debug: quiet, error: (message) => assert.fail(message) },
    t3: {
      startThread: async (input) => { daemon = input; return 'slack-thread'; },
      sendToThread: async () => {}, showThread: async () => assert.fail('not polled'),
    },
    fetchBase: noFetch, clock: fakeClock(NOW.getTime()),
  });
  await bot.handle({ channel: 'D0123456789', threadTs: '100.000', messageTs: '100.000', user: OWNER, text: REQUEST, direct: true });
  assert.ok(daemon, 'the daemon started a thread');

  await startTask(profileDir, REQUEST, { fetchBase: noFetch, now: () => NOW });
  const [start] = recorded();
  assert.equal(start!.input, daemon.brief
    .replace('Alex (your owner) asked (https://acme.slack.com/archives/D0123456789/p100):', 'Alex (your owner) asked:')
    .replace('(None. The request started a new thread.)', appTaskThread('Alex'))
    // Proposals go to a folder stamped with where they came from: the app's, or this Slack thread's.
    .replace('proposals/from-slack/D0123456789-100-000/', 'proposals/from-app/'));
  assert.deepEqual(
    [start!.args[5], start!.args[7], start!.args[9], start!.args[11], start!.args.at(-2)],
    [daemon.branch, daemon.title, daemon.provider, daemon.model, daemon.project],
    'branch, title, worker and project are the daemon\'s too',
  );
  assert.equal(previewTask(profileDir, REQUEST), start!.input, 'the preview is what gets sent');
});

test('a request that is empty or too long is refused before T3 is called', async (t) => {
  const { profileDir, recorded } = fixture(t);
  await assert.rejects(startTask(profileDir, '   ', { fetchBase: noFetch }), /Write what the bot should do/);
  await assert.rejects(startTask(profileDir, 'x'.repeat(MAX_TASK_REQUEST + 1), { fetchBase: noFetch }), /Keep it under/);
  await assert.rejects(startTask(profileDir, 42, { fetchBase: noFetch }), /Write what/);
  assert.deepEqual(recorded(), []);
  assert.deepEqual(readTasks(profileDir), []);
});

test('a failed start or fetch records nothing', async (t) => {
  const { profileDir } = fixture(t, { failStart: true });
  await assert.rejects(startTask(profileDir, REQUEST, { fetchBase: noFetch }), /exited 1: no worktree/);
  await assert.rejects(startTask(profileDir, REQUEST, { fetchBase: async () => { throw new Error('fetch failed'); } }), /fetch failed/);
  assert.ok(!existsSync(tasksPath(profileDir)));
});

test('Jobs lists a task with its state from T3: running, waiting on the owner, or done', async (t) => {
  const { profileDir, bin } = fixture(t);
  writeFileSync(tasksPath(profileDir), JSON.stringify([
    { t3ThreadId: 'a', title: 'Running one', branch: 'friday/a', requester: 'Alex', createdAt: '2026-11-18T09:00:00Z' },
    { t3ThreadId: 'b', title: 'Asking', branch: 'friday/b', requester: 'Alex', createdAt: '2026-11-18T09:00:00Z' },
    { t3ThreadId: 'c', title: 'Unreadable', branch: 'friday/c', requester: 'Alex', createdAt: '2026-11-18T09:30:00Z' },
    { title: 'broken entry' },
  ]));
  const states = {
    a: { running: true, waiting: false, link: 'https://t3.test/a', updatedAt: '2026-11-18T09:50:00Z' },
    b: { running: true, waiting: true, link: 'https://t3.test/b' },
  } as const;
  const { jobs, channels } = await listJobs(profileDir, { now: NOW, tasks: async (id) => (id in states ? states[id as 'a' | 'b'] : null) });
  assert.deepEqual(jobs.map((job) => [job.key, job.group, job.needsYouReason, job.links.t3, job.lastActivityAt]), [
    ['app:b', 'needs you', 'waiting in T3', 'https://t3.test/b', '2026-11-18T09:00:00Z'],
    ['app:a', 'running', undefined, 'https://t3.test/a', '2026-11-18T09:50:00Z'],
    ['app:c', 'done', undefined, undefined, '2026-11-18T09:30:00Z'],
  ]);
  assert.deepEqual(channels, [APP_TASK_CHANNEL]);
  assert.equal(jobs[1]!.requester, 'Alex');
  assert.equal(jobs[1]!.title, 'Running one');

  // Through the fake binary: an active run is running.
  const live = await t3TaskState(bin)('a');
  assert.deepEqual(live, { running: true, waiting: false, link: 'https://t3.test/a', updatedAt: '2026-11-18T10:05:00Z', latestRunId: 'run-1' });
  assert.equal(await t3TaskState(join(profileDir, 'missing-t3'))('a'), null);
});

test("cleanup weighs a task's worktree like a job's", async (t) => {
  const { profileDir } = fixture(t);
  writeFileSync(join(profileDir, 'state.json'), '{}');
  writeFileSync(tasksPath(profileDir), JSON.stringify([
    { t3ThreadId: 'task-1', title: 'Old', branch: 'friday/old', requester: 'Alex', createdAt: '2026-11-18T09:00:00Z' },
  ]));
  const shown: string[] = [];
  const verdicts = await cleanupWorktrees({
    statePath: join(profileDir, 'state.json'), t3Bin: 't3', now: NOW,
    run: async (_cmd, args) => { shown.push(args.at(-1)!); return JSON.stringify({ thread: { worktreePath: '/w', updatedAt: '2026-11-18T09:00:00Z' } }); },
  });
  assert.deepEqual(shown, ['task-1']);
  assert.equal(verdicts[0]!.threadId, 'task-1');
  assert.equal(verdicts[0]!.removable, false, 'a task from an hour ago is kept');
});

const context = (profileDir: string): HandlerContext => ({
  profileDirOrNull: () => profileDir,
  profileDir: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

test('IPC: start returns the task without any token, refuses a double start, and preview fills the brief', async (t) => {
  const { profileDir } = fixture(t);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handlers = tasksHandlers(context(profileDir), { fetchBase: () => gate, now: () => NOW });

  const first = handlers.start(REQUEST);
  await assert.rejects(Promise.resolve(handlers.start('another')), /already starting/);
  release();
  const task = await first;
  assert.equal(task.t3ThreadId, 'task-thread');
  assert.ok(!JSON.stringify(task).includes('xoxb-fixture') && !JSON.stringify(task).includes('xapp-fixture'));
  await assert.rejects(Promise.resolve().then(() => handlers.start('')), /Write what/);

  const preview = await handlers.preview(REQUEST);
  assert.ok(preview.includes(REQUEST) && preview.includes('Alex (your owner) asked:') && !preview.includes('None. The owner'));
  assert.ok(!preview.includes('xoxb-fixture'));
});

test('the New task screen enables Start for exactly the requests the app then starts, and refuses the rest with the same limit', async (t) => {
  const { profileDir, recorded } = fixture(t);
  const handlers = tasksHandlers(context(profileDir), { fetchBase: noFetch, now: () => NOW });
  const cases: [label: string, request: string, starts: boolean][] = [
    ['empty', '', false],
    ['only spaces', '   \n ', false],
    ['a short request', 'fix it', true],
    ['exactly at the limit', 'x'.repeat(MAX_REQUEST), true],
    ['one over the limit', 'x'.repeat(MAX_REQUEST + 1), false],
  ];
  for (const [label, request, starts] of cases) {
    assert.equal(canStart(request, false), starts, `${label}: the Start button`);
    const before = recorded().length;
    if (starts) {
      const task = await handlers.start(request);
      assert.match(startedText(task), /^Started “.+” on friday\//, label);
      assert.ok(recorded().slice(before).some((call) => call.args[1] === 'start'), `${label}: T3 was asked to start it`);
    } else {
      await assert.rejects(Promise.resolve().then(() => handlers.start(request)), /Write what|Keep it under/, label);
      assert.equal(recorded().length, before, `${label}: T3 was never called`);
    }
  }
  // Over the limit, the screen says why before the owner presses anything, with the number the service enforces.
  assert.match(requestProblem('x'.repeat(MAX_REQUEST + 1)) ?? '', new RegExp(`Keep it under ${MAX_TASK_REQUEST.toLocaleString('en-US')}`));
  assert.equal(requestProblem('fix it'), null);
});

test('with the bot stopped, Jobs shows a task started in the app as running, since T3 runs it, while a Slack job shows as paused', async (t) => {
  const { profileDir } = fixture(t);
  writeFileSync(tasksPath(profileDir), JSON.stringify([
    { t3ThreadId: 'task-thread', title: 'Fix it', branch: 'friday/fix-it', requester: 'Alex', createdAt: '2026-11-18T09:00:00Z' },
  ]));
  writeFileSync(join(profileDir, 'state.json'), JSON.stringify({
    'C0123456789:1700000000.000001': {
      t3ThreadId: 'slack-thread', channel: 'C0123456789', threadTs: '1700000000.000001', requester: OWNER, loadingRequested: true,
      createdAt: '2026-11-18T09:00:00Z', lastActivityAt: '2026-11-18T09:30:00Z',
    },
  }));
  const ctx = context(profileDir);
  const rows = await jobsHandlers(ctx, { now: () => NOW }).list();
  const icon = (channel: string) => rowIcon(rows.find((row) => row.channel === channel)!, ctx.status.current());
  assert.equal(ctx.status.current().state, 'stopped');
  assert.equal(icon(APP_TASK_CHANNEL), 'running');
  assert.equal(icon('C0123456789'), 'paused');
  const task = rows.find((row) => row.channel === APP_TASK_CHANNEL)!;
  assert.equal(task.links.t3, 'https://t3.test/task-thread');
  assert.match(linkButtons(task).find((link) => link.kind === 'slack')!.hint, /Started in the app/);
});

test('an index pushed over its cap outside the app still lets the daemon and a task start a job with every row', async (t) => {
  const { profileDir, recorded } = fixture(t);
  const config = loadConfig({ profileDir, env: {} });
  const rows = Array.from({ length: 70 }, (_, i) => `| topic ${i} | \`owner/page-${i}.md\` |`).join('\n');
  writeFileSync(join(config.knowledgeDir, 'index.md'), `# Index\n\n| When | Open |\n|---|---|\n${rows}\n`);

  let daemon: StartThreadInput | undefined;
  const quiet = (): void => {};
  const { client } = createFakeSlack({ names: { [OWNER]: 'Alex' } });
  client.chat.getPermalink = async () => ({ ok: true, permalink: 'https://acme.slack.com/archives/D0123456789/p100' });
  const bot = createBot({
    config, ...slackChat(client, config, { botUserId: 'UBOT' }), store: createStore(config.statePath),
    loadIndex: createKnowledge(config.knowledgeDir).loadIndex,
    loadKnowledge: (visibility) => createKnowledge(config.knowledgeDir).briefKnowledge(visibility),
    logger: { info: quiet, warn: quiet, debug: quiet, error: (message) => assert.fail(message) },
    t3: {
      startThread: async (input) => { daemon = input; return 'slack-thread'; },
      sendToThread: async () => {}, showThread: async () => assert.fail('not polled'),
    },
    fetchBase: noFetch, clock: fakeClock(NOW.getTime()),
  });
  await bot.handle({ channel: 'D0123456789', threadTs: '100.000', messageTs: '100.000', user: OWNER, text: REQUEST, direct: true });
  assert.ok(daemon, 'the daemon started a thread');
  assert.match(daemon.brief, /topic 0 \|[\s\S]*topic 69 \|/, 'the whole index is in the brief');

  await startTask(profileDir, REQUEST, { fetchBase: noFetch, now: () => NOW });
  assert.match(recorded()[0]!.input, /topic 69 \|/);
});
