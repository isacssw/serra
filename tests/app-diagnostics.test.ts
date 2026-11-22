import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { diagnosticsHandlers, MAX_LOG_LINES } from '../app/main/ipc/diagnostics.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { reportText, statusKey, summarize } from '../app/renderer/screens/diagnostics.logic.ts';
import { loadConfig, type Config, type Profile } from '../src/config.ts';
import type { Diagnostic } from '../src/contracts.ts';
import { diagnose, type DiagnoseOptions } from '../src/doctor.ts';
import { createProfile } from '../src/setup.ts';

const BOT = 'xoxb-1111-2222-fixturevalue';
const APP = 'xapp-1-A111-2222-fixturevalue';

const profile = (): Profile => ({
  version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
  project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
});

const tempProfile = (t: TestContext): string => {
  const root = mkdtempSync(join(tmpdir(), 'serra-app-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'profile');
  createProfile(dir, profile());
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  return dir;
};

const context = (dir: string | null): HandlerContext => ({
  profileDir: () => { if (!dir) throw new Error('No bot profile selected.'); return dir; },
  profileDirOrNull: () => dir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.22.3', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

const fakeNode = (t: TestContext, version: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-fake-node-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'node');
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  return path;
};

// ---------------------------------------------------------------------------------------------------------------
// diagnose(): the Node check
// ---------------------------------------------------------------------------------------------------------------

const nodeCheck = (results: Diagnostic[]): Diagnostic => results.find((result) => result.name === 'Node')!;

test('without a Node binary, the Node check reports the Node running the code (the CLI case)', async (t) => {
  const config = loadConfig({ profileDir: tempProfile(t), env: {} });
  assert.deepEqual(nodeCheck(await diagnose(config, { offline: true })), { name: 'Node', ok: true, detail: process.versions.node });
});

test('with a Node binary, the Node check runs it and reports its version, not the one running the code', async (t) => {
  const config = loadConfig({ profileDir: tempProfile(t), env: {} });
  const good = fakeNode(t, '24.1.0');
  const check = nodeCheck(await diagnose(config, { offline: true, nodeBinary: async () => good }));
  assert.equal(check.ok, true);
  assert.equal(check.detail, `24.1.0 (${good}, the Node the bot runs on)`);

  const old = fakeNode(t, '20.11.0');
  const failed = nodeCheck(await diagnose(config, { offline: true, nodeBinary: async () => old }));
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /is Node 20\.11\.0\. Use Node 22\.18\+/);

  const missing = nodeCheck(await diagnose(config, { offline: true, nodeBinary: async () => { throw new Error('No supported Node found'); } }));
  assert.deepEqual(missing, { name: 'Node', ok: false, detail: 'No supported Node found' });
});

// ---------------------------------------------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------------------------------------------

test('run passes the release Node finder for the profile and returns only scrubbed contract fields', async (t) => {
  const dir = tempProfile(t);
  const seen: { profileDir?: string; options?: DiagnoseOptions } = {};
  const handlers = diagnosticsHandlers(context(dir), {
    findNode: async (profileDir) => { seen.profileDir = profileDir; return '/opt/homebrew/bin/node'; },
    diagnose: async (config: Config, options: DiagnoseOptions) => {
      seen.options = options;
      assert.equal(config.botToken, BOT);
      return [
        { name: 'Node', ok: true, detail: await options.nodeBinary!() },
        { name: 'Slack account', ok: false, detail: `rejected ${BOT} and ${APP} and xoxp-9999-other`, extra: BOT } as Diagnostic,
      ];
    },
  });
  const results = await handlers.run();
  assert.equal(seen.profileDir, dir);
  assert.equal(seen.options?.offline, undefined, 'the screen runs the network checks too');
  assert.deepEqual(results, [
    { name: 'Node', ok: true, detail: '/opt/homebrew/bin/node' },
    { name: 'Slack account', ok: false, detail: 'rejected [hidden] and [hidden] and [hidden]' },
  ]);
  assert.ok(!JSON.stringify(results).includes('fixturevalue'));
});

test('a profile that cannot load is the only check, failing with the reason', async (t) => {
  const dir = tempProfile(t);
  writeFileSync(join(dir, 'profile.json'), '{ not json');
  const handlers = diagnosticsHandlers(context(dir), { diagnose: async () => assert.fail('must not run') });
  const results = await handlers.run();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, 'Profile');
  assert.equal(results[0]!.ok, false);
  assert.ok(results[0]!.detail.length > 0);
});

test('a missing token fails the Tokens check, and the other token value stays hidden', async (t) => {
  const dir = tempProfile(t);
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\n`);
  const results = await diagnosticsHandlers(context(dir), {
    findNode: async () => { throw new Error('no node in this test'); },
    diagnose: (config, options) => diagnose(config, { ...options, offline: true }),
  }).run();
  const tokens = results.find((result) => result.name === 'Tokens')!;
  assert.equal(tokens.ok, false);
  assert.match(tokens.detail, /Missing SLACK_APP_TOKEN/);
  assert.ok(!JSON.stringify(results).includes('fixturevalue'));
});

test('a diagnose() crash rejects with a scrubbed message', async (t) => {
  const handlers = diagnosticsHandlers(context(tempProfile(t)), { diagnose: async () => { throw new Error(`boom ${BOT}`); } });
  await assert.rejects(async () => handlers.run(), { message: 'boom [hidden]' });
});

test('with no profile selected, run and logTail reject with the context message', async () => {
  const handlers = diagnosticsHandlers(context(null));
  await assert.rejects(async () => handlers.run(), /No bot profile selected/);
  await assert.rejects(async () => handlers.logTail(10), /No bot profile selected/);
});

test('logTail reads logs/bot.log, hides token-shaped text and cuts very long lines', async (t) => {
  const dir = tempProfile(t);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs/bot.log'), `first\nconnecting with ${APP}\n${'x'.repeat(5000)}\nlast\n`);
  const lines = await diagnosticsHandlers(context(dir)).logTail(3);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'connecting with [hidden]');
  assert.equal(lines[1]!.length, 4001);
  assert.ok(lines[1]!.endsWith('…'));
  assert.equal(lines[2], 'last');
});

test('logTail of a profile without a log is empty, and a bad line count is refused', async (t) => {
  const handlers = diagnosticsHandlers(context(tempProfile(t)));
  assert.deepEqual(await handlers.logTail(50), []);
  for (const bad of [0, -1, 1.5, MAX_LOG_LINES + 1, Number.NaN, '10' as unknown as number]) {
    await assert.rejects(async () => handlers.logTail(bad), { message: `Ask for 1 to ${MAX_LOG_LINES} log lines.` });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Screen logic
// ---------------------------------------------------------------------------------------------------------------

const results: Diagnostic[] = [
  { name: 'Node', ok: true, detail: '24.1.0 (/opt/homebrew/bin/node, the Node the bot runs on)' },
  { name: 'Tokens', ok: false, detail: 'Set real xoxb and xapp tokens' },
  { name: 'GitHub CLI', ok: false, detail: 'gh not found' },
];

test('the summary names each failing check', () => {
  assert.deepEqual(summarize(results), { tone: 'down', text: '2 of 3 checks fail: Tokens, GitHub CLI', failing: results.slice(1) });
  assert.equal(summarize(results.slice(0, 2)).text, '1 of 2 checks fails: Tokens');
  assert.deepEqual(summarize(results.slice(0, 1)), { tone: 'up', text: 'The check passes', failing: [] });
  assert.equal(summarize([...results.slice(0, 1), results[0]!]).text, 'All 2 checks pass');
});

test('checks rerun when the daemon starts, stops, restarts or its Slack link changes, not on job counts', () => {
  const up = (pid: number, slackConnected: boolean, running = 0) =>
    statusKey({ state: 'up', pid, startedAt: '2026-11-19T10:00:00Z', slackConnected, counts: { needsYou: 0, running } });
  assert.equal(statusKey(null), 'unknown');
  assert.equal(statusKey({ state: 'stopped' }), 'stopped');
  assert.equal(up(10, true), up(10, true, 5));
  assert.notEqual(up(10, true), up(11, true));
  assert.notEqual(up(10, true), up(10, false));
});

test('the copied report lists every check and the log tail', () => {
  const text = reportText({
    results, checkedAt: new Date('2026-11-19T10:00:00Z'),
    info: { version: '0.1.0', electron: '45.4.1', node: '24.22.3', platform: 'darwin' }, log: ['a', 'b'],
  });
  assert.equal(text, [
    'Serra diagnostics (2026-11-19T10:00:00.000Z)',
    'App: Serra 0.1.0, Electron 45.4.1 (bundled Node 24.22.3), darwin',
    '',
    '2 of 3 checks fail: Tokens, GitHub CLI',
    'PASS Node: 24.1.0 (/opt/homebrew/bin/node, the Node the bot runs on)',
    'FAIL Tokens: Set real xoxb and xapp tokens',
    'FAIL GitHub CLI: gh not found',
    '',
    'Last 2 log lines:',
    'a',
    'b',
  ].join('\n'));
});
