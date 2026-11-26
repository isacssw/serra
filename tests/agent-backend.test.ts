// The AgentBackend contract (src/agent/backend.ts): what every backend gives the features that run on it. Each backend
// runs the same checks against a fake of what it drives: T3 against a scripted `t3` CLI and tool endpoint, ACP against
// a scripted ACP agent on stdio (tests/fakes/acp-agent.ts) that speaks the real protocol through the official SDK.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createAcpBackend } from '../src/agent/acp.ts';
import {
  addCustomAcpAgent, agentBackendConfigError, agentChoices, ensureAgentBackendFile, KNOWN_ACP_AGENTS, launchFor,
  readAgentBackend, removeCustomAcpAgent, writeAgentBackend, type AcpAgent,
} from '../src/agent/acp-agents.ts';
import { createBackendPool } from '../src/agent/pool.ts';
import { followAgentBackend } from '../app/main/agent-backend-watch.ts';
import { createMeetingRuns } from '../src/meeting-runs.ts';
import { pollUntilSettled, worktreeRun, type AgentBackend, type RunDetail, type WaitOptions } from '../src/agent/backend.ts';
import { createT3Backend } from '../src/agent/t3.ts';
import type { T3Session } from '../src/t3-session.ts';
import { createFakeT3 } from './fakes/t3.ts';

const agentChoicesAgent = (id: string): AcpAgent => KNOWN_ACP_AGENTS.find((agent) => agent.id === id)!;

/** A backend under test, and the agent's side of it: end the running turn with `text`. */
interface ContractSubject {
  backend: AgentBackend;
  /** The agent ends its running turn with `text`. Resolves once the backend can see it. */
  reply: (threadId: string, text: string) => Promise<void>;
  workspace: StartWorkspace;
  cleanup?: () => Promise<void>;
}
type StartWorkspace = Parameters<AgentBackend['start']>[0]['workspace'];

const fast: Omit<WaitOptions, 'after'> = { timeoutMs: 5_000, pollMs: 1, sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), now: Date.now };

/** The checks every backend passes. */
const backendContract = (name: string, make: () => Promise<ContractSubject>): void => {
  test(`${name}: declares every capability as a yes or no`, async () => {
    const { backend, cleanup } = await make();
    try {
      assert.deepEqual(Object.keys(backend.capabilities).sort(), ['persistentRuns', 'readOnly', 'steer', 'toolResults', 'transcriptLink', 'worktrees']);
      assert.ok(Object.values(backend.capabilities).every((value) => typeof value === 'boolean'));
      assert.ok(backend.label.length > 0);
    } finally { await backend.close(); await cleanup?.(); }
  });

  test(`${name}: a run starts, is followed until it settles, and gives its final answer; a follow-up is the next run`, async () => {
    const { backend, reply, workspace, cleanup } = await make();
    try {
      const threadId = await backend.start({ workspace, title: 'Contract: first', brief: 'Say hello.' });
      const going = await backend.read(threadId);
      assert.equal(going.thread.threadId, threadId);
      assert.notEqual(going.thread.activeRunId, null, 'a started run is going until the agent ends it');
      await reply(threadId, 'hello');
      const first = await backend.wait(threadId, { ...fast, after: null });
      assert.equal(first.kind, 'settled');
      assert.ok(first.kind === 'settled' && first.answer === 'hello', 'the run\'s final answer');
      const firstRun = first.kind === 'settled' ? first.runId : '';

      await backend.send(threadId, 'Say it again.');
      await reply(threadId, 'hello again');
      const second = await backend.wait(threadId, { ...fast, after: firstRun });
      assert.ok(second.kind === 'settled' && second.runId !== firstRun && second.answer === 'hello again', 'the follow-up is a run of its own');
      const detail: RunDetail = await backend.read(threadId, 10);
      assert.equal(detail.thread.activeRunId, null);
      assert.ok(detail.messages.some((message) => message.role === 'assistant' && message.text === 'hello'));
      assert.equal(typeof detail.thread.link, 'string', backend.capabilities.transcriptLink ? 'a link to open' : 'empty: no link');
      if (backend.capabilities.transcriptLink) assert.ok(detail.thread.link.length > 0);
      assert.ok(Array.isArray(await backend.list({ project: '/Users/you/project', title: 'Contract: first', since: new Date(0).toISOString() })));
      await backend.settle(threadId);
    } finally { await backend.close(); await backend.close(); await cleanup?.(); }
  });
};

/** A tool-endpoint session that answers settle and interrupt, and counts what's opened and closed. */
const fakeSession = (calls: string[]) => async (): Promise<T3Session> => {
  calls.push('open');
  return {
    call: async (tool) => { calls.push(tool); return { ok: true }; },
    close: async () => { calls.push('close'); },
  };
};

backendContract('T3', async () => {
  const fake = createFakeT3();
  const calls: string[] = [];
  return {
    backend: createT3Backend({ bin: '/Users/you/.t3/bin/t3', cli: fake.t3, session: fakeSession(calls) }),
    reply: async (threadId, text) => { fake.reply(text, threadId); },
    workspace: { kind: 'worktree', project: '/Users/you/project', baseRef: 'origin/main', branch: 'serra/contract' },
  };
});

test('T3: a worktree run is `t3 thread start` with the job\'s branch, title and worker, unchanged', async () => {
  const fake = createFakeT3();
  const backend = createT3Backend({ bin: '/Users/you/.t3/bin/t3', cli: fake.t3, session: fakeSession([]) });
  const input = { project: '/Users/you/project', baseRef: 'origin/main', branch: 'serra/x', title: 'Serra: x', brief: 'Do x.', provider: 'codex', model: 'gpt-6.1-sol' };
  await backend.start(worktreeRun(input));
  assert.deepEqual(fake.started, [input]);
  await backend.start(worktreeRun({ ...input, provider: undefined, model: undefined }));
  assert.equal('provider' in fake.started[1]!, false, 'no worker: T3 picks');
});

test('T3: the tool-endpoint session opens only when a call needs it, and close revokes it once', async () => {
  const fake = createFakeT3();
  const calls: string[] = [];
  const backend = createT3Backend({ bin: '/Users/you/.t3/bin/t3', cli: fake.t3, session: fakeSession(calls) });
  const threadId = await backend.start(worktreeRun({ project: '/Users/you/project', baseRef: 'origin/main', branch: 'b', title: 't', brief: 'x' }));
  await backend.send(threadId, 'queued');
  assert.deepEqual(calls, [], 'a job never opens a session');
  await backend.send(threadId, 'steered', { mode: 'steer' });
  await backend.interrupt(threadId, 'stop');
  await backend.close();
  await backend.close();
  assert.deepEqual(calls, ['open', 't3_thread_send', 't3_thread_interrupt', 'close']);
  assert.deepEqual(fake.sends.map((send) => send.message), ['queued'], 'a queued message goes through the CLI');
});

test('a wait ends on a request the run waits on, or when time runs out, as well as on a settled run', async () => {
  const detail = (over: Partial<RunDetail['thread']>): RunDetail => ({ thread: { threadId: 't', link: '', status: 'running', latestRunId: 'r1', activeRunId: 'r1', ...over }, messages: [{ role: 'assistant', runId: 'r1', text: 'done' }] });
  const pending = await pollUntilSettled(async () => detail({ pendingRequestCount: 1 }), 't', { ...fast, after: null });
  assert.equal(pending.kind, 'pending');
  let clock = 0;
  const timeout = await pollUntilSettled(async () => detail({}), 't', { ...fast, after: null, timeoutMs: 10, now: () => (clock += 5), sleep: async () => {} });
  assert.equal(timeout.kind, 'timeout');
  const settled = await pollUntilSettled(async () => detail({ activeRunId: null }), 't', { ...fast, after: null });
  assert.deepEqual(settled.kind === 'settled' ? [settled.runId, settled.answer] : [], ['r1', 'done']);
  const before = await pollUntilSettled(async () => detail({ activeRunId: null }), 't', { ...fast, after: 'r1', timeoutMs: 10, now: () => (clock += 5), sleep: async () => {} });
  assert.equal(before.kind, 'timeout', 'the run it was told to skip doesn\'t count');
});

// ACP ---------------------------------------------------------------------------------------------------------------

const FAKE_AGENT = new URL('./fakes/acp-agent.ts', import.meta.url).pathname;

/** The fake ACP agent in a folder of its own, with the processes it started, to check none is left running. */
const fakeAcp = (t?: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-acp-'));
  const children: ChildProcess[] = [];
  const agent: AcpAgent = { id: 'fake', name: 'Fake Agent', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_DIR: dir } };
  const logs: string[] = [];
  const backend = (over: Partial<Parameters<typeof createAcpBackend>[0]> = {}) => createAcpBackend({
    agent, log: (line) => logs.push(line), worktreeRoot: join(dir, 'worktrees'),
    spawnAgent: (chosen, env) => {
      const child = execAgent(chosen, env);
      children.push(child);
      return child;
    },
    ...over,
  });
  let turn = 0;
  /** The agent ends its next turn with `text`. */
  const reply = (text: string, at = turn + 1): void => { turn = at; writeFileSync(join(dir, `turn-${at}`), text); };
  const cleanup = async (): Promise<void> => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  };
  t?.after(cleanup);
  return { dir, agent, backend, reply, children, logs, cleanup, read: (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null) };
};

/** The real spawn, in a process group of its own like the backend's own; the fake's env on top. */
const execAgent: NonNullable<Parameters<typeof createAcpBackend>[0]['spawnAgent']> = (chosen, env) =>
  spawn(chosen.command, chosen.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...chosen.env }, detached: true });

/** Waits for `done`, up to 10 s: the fake agent is a process of its own, slow to answer when the suite runs in parallel. */
const until = async (done: () => boolean): Promise<void> => {
  for (const end = Date.now() + 10_000; !done() && Date.now() < end;) await new Promise((resolve) => { setTimeout(resolve, 5); });
};

/** The first question card a thread waits on, once there is one (up to 10 s). */
const waitingOn = async (backend: AgentBackend, threadId: string) => {
  let found: Awaited<ReturnType<NonNullable<AgentBackend['questions']>['list']>>[number] | undefined;
  for (const end = Date.now() + 10_000; !found && Date.now() < end;) {
    [found] = await backend.questions!.list(threadId);
    if (!found) await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  return found;
};

const alive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

backendContract('ACP', async () => {
  const fake = fakeAcp();
  return {
    backend: fake.backend(),
    reply: async (_threadId, text) => { fake.reply(text); },
    workspace: { kind: 'folder', path: fake.dir, name: 'Contract' },
    cleanup: fake.cleanup,
  };
});

test('ACP: a read-only run refuses every permission request and counts it as waiting; others allow reads once and refuse writes and commands', async (t) => {
  const fake = fakeAcp(t);
  const backend = fake.backend();
  try {
    const guarded = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'g', brief: 'ASK:read', readOnly: true });
    await until(() => fake.read('permission-1') !== null);
    assert.equal(fake.read('permission-1'), 'no', 'even a read is refused in a read-only run');
    assert.equal(fake.read(`mode-${guarded}`), 'read-only', 'an agent with a read-only mode is put in it');
    assert.equal((await backend.read(guarded)).thread.pendingRequestCount, 1, 'a meeting run sees it and stops the run, as on T3');
    const outcome = await backend.wait(guarded, { ...fast, after: null });
    assert.equal(outcome.kind, 'pending');
    await backend.interrupt(guarded, 'stop');
    assert.equal((await backend.wait(guarded, { ...fast, after: null, timeoutMs: 2_000 })).kind, 'pending', 'still counted after the stop');
    for (const [kind, answer] of [['read', 'yes'], ['search', 'yes'], ['edit', 'no'], ['execute', 'no'], ['delete', 'no'], ['move', 'no'], ['switch_mode', 'no']] as const) {
      const threadId = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: kind, brief: `ASK:${kind}` });
      const turn = Number(threadId.split('-')[1]);
      await until(() => fake.read(`permission-${turn}`) !== null);
      assert.equal(fake.read(`permission-${turn}`), answer, `${kind} is ${answer === 'yes' ? 'allowed' : 'refused'}`);
      fake.reply('ok', turn);
      await backend.wait(threadId, { ...fast, after: null });
    }
  } finally { await backend.close(); }
});

test('ACP: a tool\'s own result is read back from the run, a stop ends the turn, and close leaves no agent running', async (t) => {
  const fake = fakeAcp(t);
  const backend = fake.backend();
  const threadId = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 't', brief: 'TOOL:abc-123' });
  fake.reply('<meeting-read>done</meeting-read>');
  const done = await backend.wait(threadId, { ...fast, after: null });
  assert.ok(done.kind === 'settled');
  const call = await backend.toolCall!(threadId, done.runId, 'abc-123');
  assert.deepEqual(call, { input: { meeting_id: 'abc-123' }, output: { content: [{ type: 'text', text: 'Ana: Hi\nBo: Hello' }] }, failed: false });
  assert.equal(await backend.toolCall!(threadId, done.runId, 'other-id'), null);

  await backend.send(threadId, 'a long turn');
  assert.notEqual((await backend.read(threadId)).thread.activeRunId, null);
  await backend.interrupt(threadId, 'stop');
  const stopped = await backend.wait(threadId, { ...fast, after: done.runId });
  assert.ok(stopped.kind === 'settled' && stopped.answer === null, 'a stopped turn ends without an answer');

  assert.equal(fake.children.length, 1, 'one agent process for every run of a backend');
  await backend.close();
  assert.equal(alive(fake.children[0]!), false, 'close stops the agent');
  await assert.rejects(backend.read(threadId), /ended when Serra restarted/, 'its runs are gone with it');
});

test('ACP: an agent that starts in a mode that never asks (Claude Code\'s auto) is moved to one that asks; read-only refuses to start without one', async (t) => {
  const fake = fakeAcp(t);
  const claudeLike = { currentModeId: 'auto', availableModes: [{ id: 'default', name: 'Manual' }, { id: 'acceptEdits', name: 'Accept edits' }, { id: 'plan', name: 'Plan' }, { id: 'auto', name: 'Auto' }, { id: 'bypassPermissions', name: 'Bypass' }] };
  const backend = fake.backend({ agent: { ...fake.agent, env: { ...fake.agent.env, FAKE_ACP_MODES: JSON.stringify(claudeLike) } } });
  try {
    const guarded = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'g', brief: 'x', readOnly: true });
    assert.equal(fake.read(`mode-${guarded}`), 'default', 'a read-only run asks before every tool, and Serra refuses');
    const open = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'o', brief: 'x' });
    assert.equal(fake.read(`mode-${open}`), 'default', 'any run asks, so Serra\'s permission answers hold');
  } finally { await backend.close(); }
  const permissive = fake.backend({ agent: { ...fake.agent, env: { ...fake.agent.env, FAKE_ACP_MODES: JSON.stringify({ currentModeId: 'yolo', availableModes: [{ id: 'yolo', name: 'YOLO' }] }) } } });
  try {
    await assert.rejects(permissive.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'g', brief: 'x', readOnly: true }), /runs in "yolo" mode and has none that asks.*can't make this run read-only/);
  } finally { await permissive.close(); }
});

test('ACP on Codex\'s modes: read-only and ask runs go in its read-only mode, job runs in its full access', async (t) => {
  // Codex's ACP adapter (@agentclientprotocol/codex-acp 2.6.0) offers these modes and starts in `agent` (auto review).
  const codexModes = { currentModeId: 'agent', availableModes: [{ id: 'read-only', name: 'Read-only' }, { id: 'workspace-write', name: 'Workspace access' }, { id: 'agent', name: 'Auto review' }, { id: 'agent-full-access', name: 'Full access' }] };
  const fake = fakeAcp(t);
  const backend = fake.backend({ agent: { ...fake.agent, env: { ...fake.agent.env, FAKE_ACP_MODES: JSON.stringify(codexModes) } } });
  const repo = join(fake.dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=You', '-c', 'user.email=you@example.com', 'commit', '-q', '--allow-empty', '-m', 'start']);
  try {
    const readOnly = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'r', brief: 'x', readOnly: true });
    const ask = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'a', brief: 'x' });
    const job = await backend.start({ workspace: { kind: 'worktree', project: repo, baseRef: 'main', branch: 'serra/codex' }, title: 'j', brief: 'x' });
    assert.deepEqual([fake.read(`mode-${readOnly}`), fake.read(`mode-${ask}`), fake.read(`mode-${job}`)], ['read-only', 'read-only', 'agent-full-access']);
  } finally { await backend.close(); }
});

test('ACP: a missing agent command is a plain sentence, and a worktree run gets a worktree Serra made', async (t) => {
  const fake = fakeAcp(t);
  const missing = createAcpBackend({ agent: { id: 'gone', name: 'Gone Agent', command: join(fake.dir, 'no-such-agent'), args: [] } });
  await assert.rejects(missing.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 't', brief: 'x' }), /can't find .*no-such-agent.*Install Gone Agent/);
  await missing.close();

  const repo = join(fake.dir, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'You', GIT_AUTHOR_EMAIL: 'you@example.com', GIT_COMMITTER_NAME: 'You', GIT_COMMITTER_EMAIL: 'you@example.com' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  const backend = fake.backend();
  try {
    const threadId = await backend.start({ workspace: { kind: 'worktree', project: repo, baseRef: 'main', branch: 'serra/try-it' }, title: 'w', brief: 'x' });
    const cwd = fake.read(`session-${threadId.split('-')[1]}`)!;
    assert.equal(cwd, join(fake.dir, 'worktrees', 'repo', 'serra-try-it'));
    assert.match(git('worktree', 'list').toString(), /serra-try-it/);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim(), 'main', 'the project itself is untouched');
    fake.reply('done');
  } finally { await backend.close(); }
});

test('ACP: meeting runs work on an ACP agent: read-only extraction, and a link read from the tool\'s own result', async (t) => {
  const fake = fakeAcp(t);
  const workspace = join(fake.dir, 'meetings');
  const runs = createMeetingRuns({ t3Bin: '/Users/you/.t3/bin/t3', provider: 'cursor', model: 'composer-2', workspace, pollMs: 2, backend: () => fake.backend() });
  fake.reply('DIGEST');
  assert.equal(await runs.extract('TRANSCRIPT'), 'DIGEST');
  assert.equal(fake.read('mode-session-1'), 'read-only');
  assert.equal(fake.children.length, 1);
  assert.equal(alive(fake.children[0]!), false, 'the agent stops when the run ends');
  fake.reply('<meeting-title>Sync</meeting-title><meeting-read>done</meeting-read>');
  const fetched = await runs.fetchTranscript({ provider: 'granola', id: 'abc-123', url: 'https://notes.granola.ai/d/abc-123' });
  assert.equal(fetched.text, 'Ana: Hi\nBo: Hello', 'the tool\'s result, not the model\'s copy');
  assert.equal(fetched.title, 'Sync');
  assert.ok(fake.children.every((child) => !alive(child)));
  assert.deepEqual(readdirSync(workspace), []);
  // A run that asks for anything is stopped, and says where it ran.
  writeFileSync(join(fake.dir, 'turn-3'), 'never read');
  const asking = createMeetingRuns({ t3Bin: '/Users/you/.t3/bin/t3', workspace, pollMs: 2, backend: () => fake.backend() });
  await assert.rejects(asking.ask('t', 'ASK:execute'), /The Fake Agent run stopped to ask for approval or a question.*Serra stopped it in Fake Agent\./);
});

test('ACP: a failed turn says why in a fixed sentence (usage limit, sign-in), never the agent\'s text, and a wait wakes as soon as a turn ends', async (t) => {
  const fake = fakeAcp(t);
  const workspace = join(fake.dir, 'meetings');
  const runs = createMeetingRuns({ t3Bin: '/Users/you/.t3/bin/t3', workspace, pollMs: 60_000, backend: () => fake.backend() });
  await assert.rejects(runs.ask('t', 'FAIL:rate_limit'), (error: Error) => /The Fake Agent run failed: Fake Agent hit its usage or rate limit\. Try again later\./.test(error.message) && !error.message.includes('SECRET'));
  await assert.rejects(runs.ask('t', 'FAIL:authentication_failed'), /needs you to sign in/);
  assert.ok(!fake.logs.some((line) => line.includes('SECRET')), 'nor in the log');
  // pollMs is a minute: the answer still comes back as soon as the turn ends.
  const started = Date.now();
  fake.reply('quick', 3);
  assert.equal(await runs.ask('t', 'hello'), 'quick');
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
});

test('ACP: a job run gets the agent\'s full access, as on T3; what it still asks, and its questions, wait as question cards', async (t) => {
  const fake = fakeAcp(t);
  const claudeLike = { currentModeId: 'auto', availableModes: [{ id: 'default', name: 'Manual' }, { id: 'acceptEdits', name: 'Accept edits' }, { id: 'auto', name: 'Auto' }, { id: 'bypassPermissions', name: 'Bypass' }] };
  const backend = fake.backend({ agent: { ...fake.agent, env: { ...fake.agent.env, FAKE_ACP_MODES: JSON.stringify(claudeLike) } } });
  const repo = join(fake.dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=You', '-c', 'user.email=you@example.com', 'commit', '-q', '--allow-empty', '-m', 'start']);
  try {
    const threadId = await backend.start({ workspace: { kind: 'worktree', project: repo, baseRef: 'main', branch: 'serra/job' }, title: 'job', brief: 'ASK:execute ELICIT' });
    assert.equal(fake.read(`mode-${threadId}`), 'bypassPermissions', 'full access, like a T3 job');
    const request = await waitingOn(backend, threadId);
    assert.ok(request, 'the permission request waits for a person');
    assert.equal(request.questions[0]!.question, 'Fake Agent wants to: a execute tool');
    assert.deepEqual(request.questions[0]!.options.map((option) => option.label), ['Allow', 'Deny']);
    assert.equal((await backend.read(threadId)).thread.pendingRequestCount, 1, 'the job waits on it, as on T3');
    await backend.questions!.answer(threadId, request.requestId, { permission: 'yes' });
    await until(() => fake.read('permission-1') !== null);
    assert.equal(fake.read('permission-1'), 'yes');
    // The agent's question, as Claude Code asks it: a form with an "Other" box.
    const form = await waitingOn(backend, threadId);
    assert.deepEqual(form!.questions, [{ id: 'question_0', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red', description: 'warm', value: 'Red' }, { label: 'Blue', description: '', value: 'Blue' }], allowCustomAnswer: true }]);
    await backend.questions!.answer(threadId, form!.requestId, { question_0: 'Green, please' });
    await until(() => fake.read('elicit-1') !== null);
    assert.deepEqual(JSON.parse(fake.read('elicit-1')!), { action: 'accept', content: { question_0_custom: 'Green, please' } }, 'a typed answer goes in the Other box');
    fake.reply('done');
    const done = await backend.wait(threadId, { ...fast, after: null });
    assert.ok(done.kind === 'settled' && done.answer === 'done');
  } finally { await backend.close(); }
});

test('ACP: a run with a record carries on after a restart: the session is reopened and the cut-off turn answered', async (t) => {
  const fake = fakeAcp(t);
  const runsDir = join(fake.dir, 'runs');
  const first = fake.backend({ runsDir });
  const threadId = await first.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'Serra: hello', brief: 'Say hello.' });
  fake.reply('hello');
  const settled = await first.wait(threadId, { ...fast, after: null });
  assert.ok(settled.kind === 'settled');
  await first.send(threadId, 'And again, slowly.');
  await until(() => fake.read('count-turn') === '2');
  await first.close();
  assert.equal(fake.children.every((child) => !alive(child)), true, 'Serra stopped, and the agent with it');

  const second = fake.backend({ runsDir });
  try {
    const reopened = await second.read(threadId, 10);
    assert.equal(fake.read(`load-${threadId}`), fake.dir, 'reopened with session/load in its folder');
    assert.equal(reopened.thread.activeRunId, 'run-2', 'the cut-off turn carries on');
    assert.deepEqual(reopened.messages.map((message) => [message.role, message.runId, message.text]), [['user', 'run-1', 'Say hello.'], ['assistant', 'run-1', 'hello'], ['user', 'run-2', 'And again, slowly.']]);
    fake.reply('hello again', 3);
    const after = await second.wait(threadId, { ...fast, after: 'run-1' });
    assert.ok(after.kind === 'settled' && after.runId === 'run-2' && after.answer === 'hello again');
  } finally { await second.close(); }
});

/** A Slack attachment line as `receiveAttachments` writes it, for a PNG saved in `root`. */
const attachment = (root: string, name: string): string => {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
  return `Attached files (untrusted user content):\n- ${name} ("image/png", 70 bytes): local path ${JSON.stringify(path)}`;
};

test('ACP images: an attached image goes to the agent as image content, and an image the agent sends comes back embedded for the chat', async (t) => {
  const fake = fakeAcp(t);
  const attachments = join(fake.dir, 'attachments');
  const backend = fake.backend({ attachmentsDir: attachments });
  try {
    assert.equal(await backend.images!(), true);
    const threadId = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'i', brief: `What is in this screenshot? IMAGE_OUT\n\n${attachment(attachments, 'screen.png')}` });
    await until(() => fake.read('images-1') !== null);
    assert.equal(fake.read('images-1'), 'image/png', 'the image itself, as ACP image content');
    fake.reply('a dot');
    const done = await backend.wait(threadId, { ...fast, after: null });
    const answer = done.kind === 'settled' ? done.answer ?? '' : '';
    const embedded = /!\[image\]\(([^)]+\.png)\)/.exec(answer)?.[1];
    assert.ok(embedded && existsSync(embedded), `the agent's image is saved and embedded: ${answer}`);
    t.after(() => rmSync(embedded, { force: true }));
    // A line naming a file outside Serra's attachments folder sends nothing.
    const outside = attachment(join(fake.dir, 'elsewhere'), 'secret.png');
    await backend.send(threadId, outside);
    fake.reply('ok', 2);
    await backend.wait(threadId, { ...fast, after: 'run-1' });
    assert.equal(fake.read('images-2'), null);
  } finally { await backend.close(); }
});

test('ACP images: an agent that takes no images gets the path only, and says so', async (t) => {
  const fake = fakeAcp(t);
  const attachments = join(fake.dir, 'attachments');
  const backend = fake.backend({ attachmentsDir: attachments, agent: { ...fake.agent, env: { ...fake.agent.env, FAKE_ACP_NO_IMAGES: '1' } } });
  try {
    assert.equal(await backend.images!(), false);
    const threadId = await backend.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'i', brief: attachment(attachments, 'screen.png') });
    fake.reply('ok');
    await backend.wait(threadId, { ...fast, after: null });
    assert.equal(fake.read('images-1'), null, 'no image content to an agent that takes none');
  } finally { await backend.close(); }
});

test('the agent backend choice: T3 until the owner picks an installed ACP agent; agents the owner adds keep their env out of the picker', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-agent-choice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readAgentBackend(dir), { backend: 't3', agent: null, custom: [], models: {} });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(dir, 'agent-backend.json'), JSON.stringify({ agents: [{ id: 'mine', name: 'My agent', command: 'my-acp', args: ['--stdio'], env: { MY_TOKEN: 'xoxb-1111-2222-fixturevalue' } }] }));
  const choices = agentChoices(readAgentBackend(dir), bin);
  assert.deepEqual(choices.map((choice) => [choice.id, choice.installed]), [['claude', true], ['codex', false], ['opencode', false], ['gemini', false], ['mine', false]]);
  assert.doesNotMatch(JSON.stringify(choices), /fixturevalue/, 'the picker never carries an agent\'s env');
  assert.equal(agentChoices(readAgentBackend(dir), join(dir, 'empty'))[0]!.installed, false, 'no `claude` CLI, no Claude Code');
  // Claude Code is the adapter Serra ships, run by this Node on the owner's own `claude`: nothing to install but Claude Code.
  const claude = launchFor(agentChoicesAgent('claude'), bin);
  assert.ok(!('missing' in claude));
  assert.equal(claude.command, process.execPath);
  assert.match(claude.args[0]!, /node_modules\/@agentclientprotocol\/claude-agent-acp\/dist\/index\.js$/);
  assert.deepEqual(claude.env, { ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: join(bin, 'claude') });
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  const codex = launchFor(agentChoicesAgent('codex'), bin);
  assert.ok(!('missing' in codex) && codex.env.CODEX_PATH === join(bin, 'codex') && /codex-acp\/dist\/index\.js$/.test(codex.args[0]!));
  assert.match(JSON.stringify(launchFor(agentChoicesAgent('opencode'), bin)), /can't find `opencode`/, 'OpenCode and Gemini are the agents themselves, found on PATH');
  assert.throws(() => writeAgentBackend(dir, { backend: 'acp' }), /Pick an ACP agent/);
  assert.deepEqual(writeAgentBackend(dir, { backend: 'acp', agent: 'claude' }).backend, 'acp');
  assert.equal(readAgentBackend(dir).custom.length, 1, 'the owner\'s own agents are kept');
  assert.equal(writeAgentBackend(dir, { backend: 't3' }).backend, 't3');
});

test('custom ACP agents: add, remove, starter file, validation, and configError without clobbering invalid JSON', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-custom-agents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'agy'), '#!/bin/sh\n', { mode: 0o755 });

  assert.equal(agentBackendConfigError(dir), null, 'missing file is not an error');
  const file = ensureAgentBackendFile(dir);
  assert.equal(file, join(dir, 'agent-backend.json'));
  assert.equal(existsSync(file), true);
  assert.equal(agentBackendConfigError(dir), null);

  // Add Antigravity and pi; existing env on another hand-edited agent stays untouched.
  writeFileSync(file, JSON.stringify({
    backend: 't3', agent: null, models: {},
    agents: [{ id: 'muse', name: 'Muse', command: 'muse', args: ['--acp'], env: { MUSE_TOKEN: 'xoxb-1111-2222-fixturevalue' } }],
  }));
  addCustomAcpAgent(dir, { name: 'Antigravity', command: 'agy', args: ['acp'] });
  addCustomAcpAgent(dir, { name: 'pi', command: 'pi', args: ['--acp'] });
  const choices = agentChoices(readAgentBackend(dir), bin);
  assert.deepEqual(
    choices.filter((entry) => entry.custom).map((entry) => [entry.id, entry.name, entry.command, entry.installed]),
    [['muse', 'Muse', 'muse --acp', false], ['antigravity', 'Antigravity', 'agy acp', true], ['pi', 'pi', 'pi --acp', false]],
  );
  assert.equal(readAgentBackend(dir).custom.find((entry) => entry.id === 'muse')?.env?.MUSE_TOKEN, 'xoxb-1111-2222-fixturevalue');

  // Rejects built-in collisions, duplicates, bad commands.
  assert.throws(() => addCustomAcpAgent(dir, { name: 'Claude', command: 'claude', args: [] }), /built-in/);
  assert.throws(() => addCustomAcpAgent(dir, { name: 'Antigravity', command: 'agy', args: ['acp'] }), /already added/);
  assert.throws(() => addCustomAcpAgent(dir, { name: 'Bad', command: '--flag', args: [] }), /hyphen/);
  assert.throws(() => addCustomAcpAgent(dir, { name: 'Bad', command: 'relative/bin', args: [] }), /absolute path/);

  // Selecting then removing a custom agent falls back cleanly to T3 and drops its model entry.
  writeAgentBackend(dir, { backend: 'acp', agent: 'antigravity', model: 'gemini-4' });
  assert.equal(readAgentBackend(dir).backend, 'acp');
  assert.equal(readAgentBackend(dir).models.antigravity, 'gemini-4');
  const afterRemove = removeCustomAcpAgent(dir, 'antigravity');
  assert.equal(afterRemove.backend, 't3');
  assert.equal(afterRemove.agent, null);
  assert.equal(afterRemove.models.antigravity, undefined);
  assert.equal(afterRemove.custom.some((entry) => entry.id === 'antigravity'), false);

  // Invalid JSON surfaces configError and blocks writes so hand edits aren't overwritten.
  writeFileSync(file, '{ broken json');
  assert.match(agentBackendConfigError(dir) ?? '', /not valid JSON/);
  assert.throws(() => addCustomAcpAgent(dir, { name: 'Grok', command: 'grok', args: ['acp'] }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ broken json', 'broken file untouched');

  // Malformed entry inside agents array surfaces a plain configError too.
  writeFileSync(file, JSON.stringify({ agents: [{ id: 'ok', command: 'agy' }, { name: 'Missing id' }] }));
  assert.match(agentBackendConfigError(dir) ?? '', /missing a valid id or command/);
});

test('running backend pool picks up a newly added custom ACP agent from agent-backend.json without restart', async (t) => {
  const fake = fakeAcp(t);
  const profileDir = join(fake.dir, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const t3Fake = createFakeT3();
  const t3 = createT3Backend({ bin: '/Users/you/.t3/bin/t3', cli: t3Fake.t3, session: fakeSession([]) });
  const pool = createBackendPool({
    profileDir, t3,
    makeAcp: (options) => fake.backend({ ...options, env: async () => process.env, agent: { ...options.agent, env: { ...fake.agent.env, ...options.agent.env } } }),
  });
  t.after(() => pool.close());

  assert.equal(pool.current().key, 't3', 'starts on T3 before any custom agent is added');
  addCustomAcpAgent(profileDir, { name: 'Custom Harness', command: process.execPath, args: [FAKE_AGENT] });
  writeAgentBackend(profileDir, { backend: 'acp', agent: 'custom-harness' });

  const active = pool.current();
  assert.equal(active.key, 'acp:custom-harness');
  assert.equal(active.label, 'Custom Harness');
  const threadId = await active.start({ workspace: { kind: 'folder', path: fake.dir, name: 'x' }, title: 'live', brief: 'Hello custom harness.' });
  fake.reply('hello from custom harness');
  const done = await active.wait(threadId, { ...fast, after: null });
  assert.ok(done.kind === 'settled' && done.answer === 'hello from custom harness');
});

test('followAgentBackend notifies when agent-backend.json changes on disk', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-watch-backend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let changes = 0;
  const follower = followAgentBackend(() => { changes += 1; }, { debounceMs: 25 });
  t.after(() => follower.close());
  follower.follow(dir);
  // On macOS, fs.watch can return before its FSEvents stream has attached; write until the stream sees it.
  const file = join(dir, 'agent-backend.json');
  const payload = JSON.stringify({ agents: [{ id: 'antigravity', name: 'Antigravity', command: 'agy', args: ['acp'] }] });
  for (const end = Date.now() + 5_000; changes === 0 && Date.now() < end;) {
    writeFileSync(file, payload);
    await new Promise((resolve) => { setTimeout(resolve, 40); });
  }
  assert.ok(changes >= 1, 'watcher fired when agent-backend.json was written');
});
