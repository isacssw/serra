// Settings › Meetings in the main process (SERRA-69): what the screen reads when it opens, and the one place a model
// call may start, the owner's Test button. Fakes only: no T3 run, no model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { meetingsHandlers } from '../app/main/ipc/meetings.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { writeProfileFile, type Profile } from '../src/config.ts';
import type { MeetingRunOptions } from '../src/meeting-runs.ts';
import { saveSourceTest, sourceStatuses, SOURCE_TEST_TTL_MS } from '../src/meeting-source-tests.ts';
import { testedLine, testLabel } from '../app/renderer/screens/settings/meetings.logic.ts';
import { customAgents, parseCommandLine, slugifyAgentId, validateCustomAgentForm } from '../app/renderer/screens/settings/agent-backend.logic.ts';
import { t3Providers } from '../src/t3-providers.ts';

const setup = (t: TestContext, options: { binDir?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-app-meetings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const profile: Profile = {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: join(root, 'project'), remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
    worker: { provider: 'cursor', model: 'composer-2' }, t3Bin: join(root, 'missing-t3'),
  };
  writeProfileFile(profileDir, profile);
  const opened: string[] = [];
  const context: HandlerContext = {
    profileDir: () => profileDir, profileDirOrNull: () => profileDir, prefs: memoryPrefs(), status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
    openExternal: async () => {}, openPath: async (path) => { opened.push(path); },
  };
  const made: MeetingRunOptions[] = [];
  const tested: string[] = [];
  const handlers = meetingsHandlers(context, {
    readProviders: () => t3Providers({ providerInstances: { cursor: { driver: 'cursor', enabled: true } } }),
    ...(options.binDir ? { searchPath: async () => options.binDir! } : {}),
    runs: (runOptions) => {
      made.push(runOptions);
      return {
        fetchTranscript: async () => { throw new Error('not in this test'); },
        extract: async () => { throw new Error('not in this test'); },
        ask: async () => { throw new Error('not in this test'); },
        checkSource: async (provider) => { tested.push(provider); return { provider, state: 'ready', detail: 'ok' }; },
      };
    },
  });
  return { handlers, made, tested, opened, root, profileDir, profile };
};

test('opening Settings › Meetings reads files only: no T3 run, every source untested', async (t) => {
  const f = setup(t);
  const view = await f.handlers.sources();
  assert.equal(f.made.length, 0, 'no T3 run was even set up');
  assert.deepEqual(view.sources.map((entry) => [entry.provider, entry.state]), [['granola', 'untested'], ['google-meet', 'untested']]);
  assert.equal(view.runner.ready, false, 'the profile points at a t3 command that isn\'t there');
  assert.match(view.runner.detail, /can't find T3 Code/);
});

test('Test runs one check on the profile\'s T3 provider and model, and only for a known source', async (t) => {
  const f = setup(t);
  const result = await f.handlers.testSource('granola');
  assert.deepEqual({ ...result, testedAt: undefined }, { provider: 'granola', state: 'ready', detail: 'ok', testedAt: undefined });
  assert.ok(result.testedAt);
  assert.deepEqual(f.tested, ['granola']);
  assert.equal(f.made[0]!.provider, 'cursor');
  assert.equal(f.made[0]!.model, 'composer-2');
  assert.equal(f.made[0]!.t3Bin, join(f.root, 'missing-t3'));
  await assert.rejects(async () => f.handlers.testSource('zoom' as never), /Pick Granola or Google Meet/);
  assert.deepEqual(f.tested, ['granola']);
});

test('a tested source keeps its answer when the screen opens again, with no new T3 run', async (t) => {
  const f = setup(t);
  await f.handlers.testSource('granola');
  const view = await f.handlers.sources();
  assert.equal(f.made.length, 1, 'only the Test press started a run');
  assert.deepEqual(view.sources.map((entry) => [entry.provider, entry.state]), [['granola', 'ready'], ['google-meet', 'untested']]);
  const granola = view.sources[0]!;
  assert.equal(testedLine(granola, new Date(Date.parse(granola.testedAt!) + 2 * 3_600_000)), 'Tested 2 h ago');
  assert.equal(testLabel(granola), 'Test again');
  assert.equal(testLabel(view.sources[1]), 'Test');
  assert.equal(testedLine(view.sources[1], new Date()), null);
});

test('a kept answer goes back to untested when the worker\'s provider or model changes', async (t) => {
  const f = setup(t);
  await f.handlers.testSource('granola');
  writeProfileFile(f.profileDir, { ...f.profile, worker: { provider: 'cursor', model: 'composer-3' } });
  assert.equal((await f.handlers.sources()).sources[0]!.state, 'untested');
  writeProfileFile(f.profileDir, { ...f.profile, worker: { provider: 'claude', model: 'composer-2' } });
  assert.equal((await f.handlers.sources()).sources[0]!.state, 'untested');
  writeProfileFile(f.profileDir, f.profile);
  assert.equal((await f.handlers.sources()).sources[0]!.state, 'ready', 'the same provider and model again');
});

test('a kept answer stands for a week, and a broken file reads as untested', (t) => {
  const f = setup(t);
  const runner = { instance: 'codex', model: null };
  const at = new Date('2026-11-01T10:00:00Z');
  saveSourceTest(f.profileDir, { provider: 'google-meet', state: 'needs-sign-in', detail: 'Sign in to Drive.' }, runner, at);
  const saved = JSON.parse(readFileSync(join(f.profileDir, 'meeting-sources.json'), 'utf8'));
  assert.deepEqual(saved['google-meet'].runner, runner);
  const meet = (now: Date) => sourceStatuses(f.profileDir, runner, now)[1]!;
  assert.deepEqual(meet(new Date(at.getTime() + SOURCE_TEST_TTL_MS - 1)), { provider: 'google-meet', state: 'needs-sign-in', detail: 'Sign in to Drive.', testedAt: at.toISOString() });
  assert.equal(meet(new Date(at.getTime() + SOURCE_TEST_TTL_MS)).state, 'untested');
  writeFileSync(join(f.profileDir, 'meeting-sources.json'), '{ not json');
  assert.equal(meet(at).state, 'untested');
});

test('Agent backend IPC: add, select, remove custom ACP agents and open config file', async (t) => {
  const binDir = mkdtempSync(join(tmpdir(), 'serra-acp-bin-'));
  t.after(() => rmSync(binDir, { recursive: true, force: true }));
  writeFileSync(join(binDir, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  const f = setup(t, { binDir });

  // Opening config creates a valid starter file in the profile and opens it.
  await f.handlers.openAgentBackendConfig();
  assert.deepEqual(f.opened, [join(f.profileDir, 'agent-backend.json')]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.profileDir, 'agent-backend.json'), 'utf8')), {
    backend: 't3', agent: null, models: {}, agents: [],
  });

  // Add Antigravity (installed) and Grok (not on PATH), then select Antigravity.
  const withAgy = await f.handlers.addAcpAgent({ name: 'Antigravity', command: 'agy', args: ['acp'] });
  assert.equal(withAgy.configPath, join(f.profileDir, 'agent-backend.json'));
  assert.equal(withAgy.configError, null);
  assert.deepEqual(
    withAgy.agents.find((entry) => entry.id === 'antigravity'),
    { id: 'antigravity', name: 'Antigravity', command: 'agy acp', installed: true, custom: true },
  );
  const withGrok = await f.handlers.addAcpAgent({ name: 'Grok', command: 'grok', args: ['--acp'] });
  assert.equal(withGrok.agents.find((entry) => entry.id === 'grok')?.installed, false);

  const selected = await f.handlers.setAgentBackend({ backend: 'acp', agent: 'antigravity' });
  assert.equal(selected.backend, 'acp');
  assert.equal(selected.agent, 'antigravity');
  await assert.rejects(async () => f.handlers.setAgentBackend({ backend: 'acp', agent: 'grok' }), /isn’t installed/);

  // Removing the active custom agent returns to T3.
  const removed = await f.handlers.removeAcpAgent('antigravity');
  assert.equal(removed.backend, 't3');
  assert.equal(removed.agent, null);
  assert.equal(removed.agents.some((entry) => entry.id === 'antigravity'), false);

  // Hand-editing agent-backend.json on disk is reflected immediately, and broken JSON reports configError.
  writeFileSync(join(f.profileDir, 'agent-backend.json'), JSON.stringify({
    agents: [{ id: 'pi', name: 'pi', command: 'pi', args: ['--acp'] }],
  }));
  const reloaded = await f.handlers.agentBackend();
  assert.equal(reloaded.agents.some((entry) => entry.id === 'pi' && entry.custom), true);
  assert.equal(reloaded.configError, null);

  writeFileSync(join(f.profileDir, 'agent-backend.json'), '{ nope');
  const broken = await f.handlers.agentBackend();
  assert.match(broken.configError ?? '', /not valid JSON/);
});

test('Agent backend renderer logic: command parsing, slugifying and form validation', () => {
  assert.deepEqual(parseCommandLine('agy acp'), { command: 'agy', args: ['acp'] });
  assert.deepEqual(parseCommandLine('"/Applications/My Agent/bin" --acp --flag "hello world"'), {
    command: '/Applications/My Agent/bin',
    args: ['--acp', '--flag', 'hello world'],
  });
  assert.deepEqual(parseCommandLine("pi '--acp'"), { command: 'pi', args: ['--acp'] });
  assert.ok('error' in parseCommandLine(''));
  assert.ok('error' in parseCommandLine('agy "unclosed'));
  assert.ok('error' in parseCommandLine('--flag'));
  assert.ok('error' in parseCommandLine('bin/agy acp'));
  assert.equal(slugifyAgentId('Antigravity CLI'), 'antigravity-cli');

  const existing = [
    { id: 'claude', name: 'Claude Code', custom: false },
    { id: 'muse', name: 'Muse', custom: true },
  ];
  assert.deepEqual(validateCustomAgentForm({ name: 'Antigravity', commandLine: 'agy acp' }, existing), {
    value: { id: 'antigravity', name: 'Antigravity', command: 'agy', args: ['acp'] },
    errors: {},
  });
  assert.match(validateCustomAgentForm({ name: 'Claude', commandLine: 'claude' }, existing).errors.name ?? '', /built-in/);
  assert.match(validateCustomAgentForm({ name: 'Muse', commandLine: 'muse acp' }, existing).errors.name ?? '', /already added/);
  assert.deepEqual(
    customAgents([
      { id: 'claude', name: 'Claude Code', command: 'claude', installed: true, custom: false },
      { id: 'antigravity', name: 'Antigravity', command: 'agy acp', installed: true, custom: true },
    ]).map((entry) => entry.id),
    ['antigravity'],
  );
});
