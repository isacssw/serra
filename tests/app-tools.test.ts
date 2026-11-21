import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { toolsHandlers } from '../app/main/ipc/tools.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { transportLabel } from '../app/renderer/screens/tools.logic.ts';
import { writeProfileFile, type Profile } from '../src/config.ts';
import type { Exec } from '../src/exec.ts';
import { runCli } from '../src/manage.ts';

const TOKEN = 'sntrys_fixture-secret-value';

const setup = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-app-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const profileDir = join(root, 'profile');
  const bin = join(root, 'bin');
  for (const dir of [home, project, profileDir, bin]) mkdirSync(dir, { recursive: true });
  const profile: Profile = {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
    worker: { provider: 'claude', model: 'opus' },
    messageTriggers: [{ channel: 'C0123456789', botId: 'B0123456789', instructions: 'Investigate this Sentry alert.' }],
  };
  writeProfileFile(profileDir, profile);
  const context: HandlerContext = {
    profileDir: () => profileDir, profileDirOrNull: () => profileDir, prefs: memoryPrefs(), status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
    openExternal: async () => {}, openPath: async () => {},
  };
  const install = (name: string) => { writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, name), 0o755); };
  return { home, project, profileDir, bin, context, install };
};

/** Answers `claude mcp list` and `gh`; never runs anything. */
const fakeRun: Exec = async (command, args) => {
  const key = [command.split('/').pop(), ...args].join(' ');
  const out = (stdout: string) => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });
  if (key === 'claude mcp list') return out(`github: https://api.github.example/mcp?token=${TOKEN} (HTTP) - ✔ Connected\nclaude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected`);
  if (key === 'gh --version') return out('gh version 2.83.0');
  if (key.startsWith('gh auth status')) return out('Logged in to github.com account alex');
  return { code: null, stdout: '', stderr: '', missing: true, timedOut: false };
};

test('tools.overview lists the provider CLI servers and the warning, structured-clone safe and without secrets', async (t) => {
  const f = setup(t);
  f.install('claude');
  const overview = structuredClone(await toolsHandlers(f.context, { home: f.home, env: {}, run: fakeRun, path: f.bin }).overview());
  assert.deepEqual(overview.servers.map((server) => [server.name, server.scope, server.health]), [['github', 'provider', 'connected'], ['claude.ai Gmail', 'connector', 'connected']]);
  assert.deepEqual(overview.warnings.map((warning) => [warning.tool, warning.driver, warning.channels]), [['Sentry', 'claude', ['C0123456789']]]);
  assert.ok(!JSON.stringify(overview).includes(TOKEN));
});

test('tools.clis reports installed tools with version and account, and missing ones', async (t) => {
  const f = setup(t);
  f.install('gh');
  const overview = structuredClone(await toolsHandlers(f.context, { home: f.home, run: fakeRun, path: f.bin }).clis());
  const gh = overview.clis.find((entry) => entry.id === 'gh')!;
  assert.deepEqual([gh.version, gh.check?.state, gh.check?.account], ['2.83.0', 'yes', 'alex']);
  assert.equal(overview.clis.find((entry) => entry.id === 'vercel')!.path, null);
});

test('tools handlers without a selected profile throw the context message', (t) => {
  const f = setup(t);
  const handlers = toolsHandlers({ ...f.context, profileDir: () => { throw new Error('No bot profile selected.'); } });
  assert.throws(() => handlers.overview(), /No bot profile selected/);
  assert.throws(() => handlers.clis(), /No bot profile selected/);
});

test('pnpm bot tools prints the servers, the warning and the command-line tools', async (t) => {
  const f = setup(t);
  const out: string[] = [];
  const previous = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, SERRA_TOOLS_PATH: process.env.SERRA_TOOLS_PATH };
  process.env.HOME = f.home;
  process.env.CLAUDE_CONFIG_DIR = f.home;
  process.env.CODEX_HOME = join(f.home, '.codex');
  // An empty PATH: no real `claude` or `gh` is found or run, so the files are used and every CLI is missing.
  process.env.SERRA_TOOLS_PATH = f.bin;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const code = await runCli(['tools', '--profile', f.profileDir], { log: (text) => out.push(text), error: (text) => out.push(text) });
  assert.equal(code, 0, out.join('\n'));
  const text = out.join('\n');
  assert.match(text, /Worker provider: claude/);
  assert.match(text, /Claude: `claude` isn't installed/);
  assert.match(text, /! The alert trigger for channel C0123456789 mentions Sentry, but Claude has no Sentry MCP server/);
  assert.match(text, /GitHub CLI {2}not installed {2}\(brew install gh\)/);

  out.length = 0;
  assert.equal(await runCli(['tools', '--profile', f.profileDir, '--json'], { log: (line) => out.push(line), error: (line) => out.push(line) }), 0);
  const json = JSON.parse(out.join('\n')) as Record<string, unknown>;
  for (const key of ['worker', 'servers', 'warnings', 'files', 'listing', 'clis']) assert.ok(key in json, `--json keeps ${key} at the top level`);
});

test('transport labels', () => {
  assert.equal(transportLabel({ transport: 'stdio', host: null }), 'Local command');
  assert.equal(transportLabel({ transport: 'http', host: 'mcp.example.com' }), 'HTTP · mcp.example.com');
  assert.equal(transportLabel({ transport: 'sse', host: null }), 'SSE');
  assert.equal(transportLabel({ transport: null, host: null }), 'Unknown transport');
});
