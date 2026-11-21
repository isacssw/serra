// Tools (SERRA-39): the provider CLIs' server lists, the Codex comment fix, CLI detection, recommendation signals
// and the screen's logic. Every command is a fake: nothing here runs `claude`, `codex`, `gh` or a shell.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { cliOverview, detectCli, formatCliOverview, recommendationSignals } from '../src/clis.ts';
import type { Profile } from '../src/config.ts';
import type { Exec, ExecResult } from '../src/exec.ts';
import { findExecutable } from '../src/exec.ts';
import { liveMcpOverview, parseClaudeMcpList, parseCodexMcpList } from '../src/mcp-live.ts';
import { formatMcpOverview, mcpOverview, parseCodexServers, tomlScalar, type McpOverview } from '../src/mcp.ts';
import { loginShellPath, mergePaths } from '../src/shell-path.ts';
import { CLI_CATALOG, type CliSpec } from '../src/tool-catalog.ts';
import {
  cliRows, cliStatus, driverGroups, providerLine, recommendationRows, recommendedCliIds, serverBrand, serverLabel, serverOrigin, serverStatus,
} from '../app/renderer/screens/tools.logic.ts';

const TOKEN = 'sntrys_fixture-secret-value';

const result = (overrides: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...overrides });

/** A fake `exec` answering by command and first arguments; anything else is "not installed". */
const fakeRun = (answers: Record<string, Partial<ExecResult>>): Exec & { calls: string[] } => {
  const calls: string[] = [];
  const run = (async (command: string, args: readonly string[]) => {
    const key = [command.split('/').pop(), ...args].join(' ');
    calls.push(key);
    const match = Object.keys(answers).find((prefix) => key.startsWith(prefix));
    return match ? result(answers[match]) : result({ code: null, missing: true });
  }) as Exec & { calls: string[] };
  run.calls = calls;
  return run;
};

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const profileDir = join(root, 'profile');
  const bin = join(root, 'bin');
  for (const dir of [home, project, profileDir, bin]) mkdirSync(dir, { recursive: true });
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  /** An executable in the fake PATH. Never run: the fake `exec` answers instead. */
  const install = (name: string) => { write(join(bin, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, name), 0o755); };
  const profile = (overrides: Partial<Profile> = {}): Profile => ({
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
    worker: { provider: 'claude', model: 'opus' }, ...overrides,
  });
  return { home, project, profileDir, bin, write, install, profile };
};

// ---------------------------------------------------------------------------------------------------------------
// The Codex comment bug
// ---------------------------------------------------------------------------------------------------------------

test('a comment after enabled = false keeps the Codex server off', () => {
  const servers = parseCodexServers([
    '[mcp_servers.off]', 'command = "x"', 'enabled = false # paused for now', '',
    '[mcp_servers.tight]', 'command = "y"', 'enabled = false#no space', '',
    '[mcp_servers.on]', 'command = "z"', 'enabled = true # on',
  ].join('\n'));
  assert.equal(servers.get('off')!.enabled, false);
  assert.equal(servers.get('tight')!.enabled, false);
  assert.equal(servers.get('on')!.enabled, true);
  assert.equal(tomlScalar('"has # inside" # and a comment'), 'has # inside');
  assert.equal(tomlScalar("'literal'"), 'literal');
});

test('the files overview shows a commented-off Codex server as off', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.codex', 'config.toml'), '[mcp_servers.sentry]\nurl = "https://mcp.sentry.example/mcp"\nenabled = false # later\n');
  const overview = mcpOverview(f.profile({ worker: { provider: 'codex', model: 'gpt' } }), { home: f.home, env: {} });
  assert.equal(overview.servers[0]!.load, 'disabled');
});

// ---------------------------------------------------------------------------------------------------------------
// Provider CLI lists
// ---------------------------------------------------------------------------------------------------------------

const CLAUDE_LIST = [
  'Checking MCP server health…',
  '',
  'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
  'claude.ai Miro: https://mcp.miro.com - ! Needs authentication',
  `files: npx -y files-server --token=${TOKEN} - ✘ Failed to connect`,
  `sentry: https://mcp.sentry.example/mcp?token=${TOKEN} (HTTP) - ✔ Connected`,
  'legacy: https://old.example/sse (SSE) - ✔ Connected',
  'plugin:docs:search: node server.js - ✔ Connected',
  'team: https://team.example/mcp (HTTP) - ⏸ Pending approval',
].join('\n');

test('parseClaudeMcpList reads names, transports and health, and skips the header', () => {
  const entries = parseClaudeMcpList(CLAUDE_LIST);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.transport, entry.health]), [
    ['claude.ai Gmail', 'http', 'connected'],
    ['claude.ai Miro', 'http', 'needs-auth'],
    ['files', 'stdio', 'failed'],
    ['sentry', 'http', 'connected'],
    ['legacy', 'sse', 'connected'],
    ['plugin:docs:search', 'stdio', 'connected'],
    ['team', 'http', 'pending'],
  ]);
});

test('parseCodexMcpList reads the JSON list', () => {
  const entries = parseCodexMcpList(JSON.stringify([
    { name: 'node_repl', enabled: true, transport: { type: 'stdio', command: 'node', args: ['repl.js'] }, auth_status: 'unsupported' },
    { name: 'tracker', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.tracker.example/mcp' }, auth_status: 'not_logged_in' },
    { name: 'off', enabled: false, transport: { type: 'stdio', command: 'x' } },
  ]));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.enabled, entry.transport, entry.needsAuth]), [
    ['node_repl', true, 'stdio', false], ['tracker', true, 'http', true], ['off', false, 'stdio', false],
  ]);
  assert.throws(() => parseCodexMcpList('{}'));
});

test('liveMcpOverview lists Claude from `claude mcp list`, connectors included, and never leaks a command or URL', async (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { sentry: { type: 'http', url: `https://mcp.sentry.example/mcp?token=${TOKEN}` } } }));
  f.install('claude');
  const run = fakeRun({ 'claude mcp list': { stdout: CLAUDE_LIST } });
  const overview = await liveMcpOverview(
    f.profile({ messageTriggers: [{ channel: 'C0123456789', botId: 'B0123456789', instructions: 'Investigate this Sentry alert.' }] }),
    { home: f.home, env: {}, run, path: f.bin },
  );
  assert.deepEqual(overview.listing, [{ driver: 'claude', method: 'cli', note: null }]);
  const byName = new Map(overview.servers.map((server) => [server.name, server]));
  assert.deepEqual([byName.get('claude.ai Gmail')!.scope, byName.get('claude.ai Gmail')!.health], ['connector', 'connected']);
  assert.deepEqual([byName.get('sentry')!.scope, byName.get('sentry')!.source, byName.get('sentry')!.host], ['user', '~/.claude.json', 'mcp.sentry.example']);
  assert.equal(byName.get('plugin:docs:search')!.scope, 'plugin');
  assert.deepEqual([byName.get('team')!.load, byName.get('team')!.health], ['unsure', 'pending']);
  assert.deepEqual(overview.warnings, [], 'the connected sentry server satisfies the alert trigger');
  const serialized = JSON.stringify(overview) + formatMcpOverview(overview);
  for (const hidden of [TOKEN, 'npx', 'files-server', 'token=', 'server.js', '/mcp/v1']) assert.ok(!serialized.includes(hidden), `leaked ${hidden}`);
});

test('liveMcpOverview falls back to the config files when a CLI is missing or fails, and says why', async (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.github.example/mcp' } } }));
  f.write(join(f.home, '.codex', 'config.toml'), '[mcp_servers.repl]\ncommand = "node"\n');
  f.install('codex');
  const run = fakeRun({ 'codex mcp list': { code: 2, stderr: `boom ${TOKEN}` } });
  const overview = await liveMcpOverview(f.profile({ worker: undefined }), { home: f.home, env: {}, run, path: f.bin });
  assert.deepEqual(overview.listing.map((listing) => [listing.driver, listing.method]), [['claude', 'files'], ['codex', 'files']]);
  assert.match(overview.listing[0]!.note!, /`claude` isn't installed/);
  assert.match(overview.listing[1]!.note!, /failed \(exit 2\)/);
  assert.deepEqual(overview.servers.map((server) => server.name), ['github', 'repl']);
  assert.ok(!JSON.stringify(overview).includes(TOKEN), 'stderr never reaches the overview');
});

test('liveMcpOverview reads Codex from `codex mcp list --json`, with servers Codex adds itself', async (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.codex', 'config.toml'), '[mcp_servers.repl]\ncommand = "node"\n');
  f.install('codex');
  const run = fakeRun({
    'codex mcp list --json': {
      stdout: JSON.stringify([
        { name: 'repl', enabled: true, transport: { type: 'stdio', command: 'node' } },
        { name: 'bundled', enabled: false, transport: { type: 'stdio', command: 'x' } },
        { name: 'tracker', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.tracker.example/mcp' }, auth_status: 'not_logged_in' },
      ]),
    },
  });
  const overview = await liveMcpOverview(f.profile({ worker: { provider: 'codex', model: 'gpt' } }), { home: f.home, env: {}, run, path: f.bin });
  assert.deepEqual(overview.servers.map((server) => [server.name, server.scope, server.load, server.health]), [
    ['repl', 'user', 'loads', null], ['bundled', 'provider', 'disabled', null], ['tracker', 'provider', 'loads', 'needs-auth'],
  ]);
  assert.ok(run.calls.includes('codex mcp list --json'));
});

// ---------------------------------------------------------------------------------------------------------------
// CLI detection
// ---------------------------------------------------------------------------------------------------------------

const spec = (id: string): CliSpec => CLI_CATALOG.find((entry) => entry.id === id)!;

test('detectCli: not installed, installed and signed in, installed and signed out', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await detectCli(spec('gh'), { path: f.bin, run: fakeRun({}), home: f.home }), { id: 'gh', path: null, version: null, check: null });

  f.install('gh');
  const signedIn = await detectCli(spec('gh'), {
    path: f.bin, home: f.home,
    run: fakeRun({ 'gh --version': { stdout: 'gh version 2.83.0 (2026-11-01)\n' }, 'gh auth status': { stdout: 'github.com\n  ✓ Logged in to github.com account alex (keyring)\n' } }),
  });
  assert.equal(signedIn.version, '2.83.0');
  assert.deepEqual(signedIn.check, { kind: 'signed-in', state: 'yes', account: 'alex' });
  assert.equal(signedIn.path, join(f.bin, 'gh'));

  const signedOut = await detectCli(spec('gh'), { path: f.bin, home: f.home, run: fakeRun({ 'gh --version': { stdout: 'gh version 2.83.0' }, 'gh auth status': { code: 1 } }) });
  assert.deepEqual(signedOut.check, { kind: 'signed-in', state: 'no', account: null });
});

test('detectCli: a check that times out is unknown; empty output with needsOutput is no; odd account text is dropped', async (t) => {
  const f = fixture(t);
  f.install('vercel');
  f.install('flyctl');
  const slow = await detectCli(spec('vercel'), { path: f.bin, home: f.home, run: fakeRun({ 'vercel --version': { stdout: 'Vercel CLI 48.1.0' }, 'vercel whoami': { code: null, timedOut: true } }) });
  assert.equal(slow.check!.state, 'unknown');
  const empty = await detectCli(spec('vercel'), { path: f.bin, home: f.home, run: fakeRun({ 'vercel --version': {}, 'vercel whoami': { stdout: '' } }) });
  assert.equal(empty.check!.state, 'no');
  const fly = await detectCli(spec('fly'), { path: f.bin, home: f.home, run: fakeRun({ 'flyctl version': { stdout: 'flyctl v0.5.14 darwin/arm64' }, 'flyctl auth whoami': { stdout: 'two words here' } }) });
  assert.deepEqual([fly.version, fly.check!.state, fly.check!.account], ['0.5.14', 'yes', null]);
});

test('a tool without a trusted sign-in check reports none', async (t) => {
  const f = fixture(t);
  f.install('acli');
  const acli = await detectCli(spec('acli'), { path: f.bin, home: f.home, run: fakeRun({ 'acli --version': { stdout: 'acli version 1.3.4' } }) });
  assert.deepEqual([acli.version, acli.check], ['1.3.4', null]);
});

test('findExecutable needs an executable file', (t) => {
  const f = fixture(t);
  f.write(join(f.bin, 'plain'), 'not executable');
  mkdirSync(join(f.bin, 'folder'));
  f.install('real');
  assert.equal(findExecutable('plain', f.bin), null);
  assert.equal(findExecutable('folder', f.bin), null);
  assert.equal(findExecutable('real', `/nowhere:${f.bin}`), join(f.bin, 'real'));
});

test('cliOverview checks the whole catalogue and formats it for the command line', async (t) => {
  const f = fixture(t);
  f.install('gh');
  const overview = await cliOverview(f.profile(), f.profileDir, {
    path: f.bin, home: f.home, run: fakeRun({ 'gh --version': { stdout: 'gh version 2.83.0' }, 'gh auth status': { stdout: 'account alex' } }),
  });
  assert.equal(overview.clis.length, CLI_CATALOG.length);
  const text = formatCliOverview(overview);
  assert.match(text, /GitHub CLI {2}2\.83\.0 {2}signed in as alex/);
  assert.match(text, /Vercel CLI {2}not installed {2}\(npm i -g vercel\)/);
});

test('loginShellPath reads PATH between markers; mergePaths keeps order without repeats', async () => {
  const run: Exec = async () => result({ stdout: 'motd noise\n__SERRA_PATH__/a:/b__SERRA_PATH__' });
  assert.equal(await loginShellPath({ run }), '/a:/b');
  assert.equal(await loginShellPath({ run: async () => result({ code: null, timedOut: true }) }), null);
  assert.equal(mergePaths('/a:/b', null, '/b:/c', ''), '/a:/b:/c');
});

// ---------------------------------------------------------------------------------------------------------------
// Recommendation signals
// ---------------------------------------------------------------------------------------------------------------

test('recommendationSignals: Sentry SDK, vercel.json, Jira and Linear links; a bare issue key is not enough', (t) => {
  const f = fixture(t);
  assert.deepEqual(recommendationSignals(f.profile(), f.profileDir), {});
  f.write(join(f.profileDir, 'knowledge', 'work.md'), 'We track work as ABC-123.');
  assert.deepEqual(recommendationSignals(f.profile(), f.profileDir), {});

  f.write(join(f.project, 'requirements.txt'), 'flask\nsentry-sdk==2.0\n');
  f.write(join(f.project, 'vercel.json'), '{}');
  f.write(join(f.profileDir, 'knowledge', 'links.md'), 'Board: https://acme.atlassian.net/jira and https://linear.app/acme');
  assert.deepEqual(recommendationSignals(f.profile(), f.profileDir), {
    sentry: 'The repo uses a Sentry SDK', vercel: 'vercel.json in the repo',
    atlassian: 'Your notes mention Jira or Confluence', linear: 'Your notes link to Linear',
  });
  const alert = f.profile({ messageTriggers: [{ channel: 'C0123456789', instructions: 'Investigate this Sentry alert.' }] });
  assert.equal(recommendationSignals(alert, null).sentry, 'An alert rule mentions Sentry');
});

// ---------------------------------------------------------------------------------------------------------------
// Screen logic
// ---------------------------------------------------------------------------------------------------------------

const emptyMcp = (overrides: Partial<McpOverview> = {}): McpOverview => ({
  worker: { provider: 'claude', drivers: ['claude'], note: null }, servers: [], warnings: [], files: [],
  listing: [{ driver: 'claude', method: 'cli', note: null }], ...overrides,
});

test('server and CLI statuses', () => {
  assert.deepEqual(serverStatus({ load: 'disabled', health: 'connected' }), { tone: 'off', text: 'Off' });
  assert.deepEqual(serverStatus({ load: 'loads', health: 'connected' }), { tone: 'up', text: 'Connected' });
  assert.deepEqual(serverStatus({ load: 'loads', health: 'needs-auth' }), { tone: 'warn', text: 'Needs sign-in' });
  assert.deepEqual(serverStatus({ load: 'loads', health: 'failed' }), { tone: 'down', text: 'Failed' });
  assert.deepEqual(serverStatus({ load: 'unsure', health: null }), { tone: 'warn', text: 'May not load' });
  assert.deepEqual(serverStatus({ load: 'loads', health: null }), { tone: 'up', text: 'On' });
  assert.deepEqual(cliStatus(undefined), { tone: 'off', text: 'Not installed' });
  assert.deepEqual(cliStatus({ id: 'docker', path: '/x', version: '1', check: { kind: 'running', state: 'no', account: null } }), { tone: 'warn', text: 'Not running' });
  assert.equal(serverLabel({ name: 'claude.ai Gmail', scope: 'connector' }), 'Gmail');
  assert.equal(serverBrand({ name: 'claude.ai Google Drive', host: 'drivemcp.googleapis.com' }), 'googledrive');
  assert.equal(serverBrand({ name: 'mystery', host: null }), null);
});

test('the provider line is a few words and says each thing once', () => {
  assert.equal(providerLine({ provider: null, drivers: ['claude', 'codex'], note: 'Servers for both Claude and Codex are listed.' }), 'No worker provider set, so both are listed');
  assert.equal(providerLine({ provider: 'custom', drivers: ['claude', 'codex'], note: 'x' }), '"custom" isn\'t Claude or Codex, so both are listed');
  assert.equal(providerLine({ provider: 'claudeAgent', drivers: ['claude'], note: null }), 'Worker: claudeAgent');
  assert.equal(serverOrigin({ scope: 'provider', source: 'Codex', driver: 'codex' }), 'Added by Codex');
  assert.equal(serverOrigin({ scope: 'user', source: '~/.claude.json', driver: 'claude' }), 'User config · ~/.claude.json');
});

test('driverGroups: problems first, a hint with the provider command, and the fallback note', () => {
  const server = { driver: 'claude' as const, source: '~/.claude.json', transport: 'http' as const, host: null, note: null };
  const [claude] = driverGroups(emptyMcp({
    servers: [
      { ...server, name: 'b', scope: 'user', load: 'loads', health: 'connected' },
      { ...server, name: 'a', scope: 'connector', load: 'loads', health: 'failed' },
    ],
    listing: [{ driver: 'claude', method: 'files', note: 'fallback' }],
  }));
  assert.deepEqual(claude!.servers.map((entry) => entry.name), ['a', 'b']);
  assert.equal(claude!.summary, '2 servers');
  assert.equal(claude!.listingNote, 'fallback');
  assert.match(claude!.hint.command, /^claude mcp add --scope user/);
  assert.equal(driverGroups(emptyMcp())[0]!.summary, 'No servers');
});

test('recommendations: GitHub always, others only with a signal or a server; ready, sign-in and set-up commands', () => {
  const clis = { clis: [{ id: 'gh', path: '/bin/gh', version: '2.83.0', check: { kind: 'signed-in' as const, state: 'yes' as const, account: 'alex' } }], signals: {} };
  let rows = recommendationRows(emptyMcp(), clis);
  assert.deepEqual(rows.map((row) => [row.rec.id, row.state.text, row.setup.length]), [['github', 'Ready', 0]]);

  rows = recommendationRows(emptyMcp({ worker: { provider: null, drivers: ['claude', 'codex'], note: null } }), { ...clis, signals: { vercel: 'vercel.json in the repo' } });
  const vercel = rows.find((row) => row.rec.id === 'vercel')!;
  assert.equal(vercel.state.text, 'Not set up');
  assert.deepEqual(vercel.setup.map((step) => step.command), [
    'npm i -g vercel', 'claude mcp add --scope user --transport http vercel https://mcp.vercel.com', 'codex mcp add vercel --url https://mcp.vercel.com',
  ]);

  const linear = { name: 'linear', driver: 'claude' as const, scope: 'user' as const, source: '~/.claude.json', transport: 'http' as const, host: 'mcp.linear.app', load: 'loads' as const, note: null, health: 'needs-auth' as const };
  rows = recommendationRows(emptyMcp({ servers: [linear] }), clis);
  assert.equal(rows.find((row) => row.rec.id === 'linear')!.state.text, 'Needs sign-in');
  assert.deepEqual([...recommendedCliIds(rows)], ['gh']);
});

test('cliRows: installed first, recommended next, and the one command each needs', () => {
  const overview = {
    clis: [
      { id: 'gh', path: '/bin/gh', version: '2.83.0', check: { kind: 'signed-in' as const, state: 'no' as const, account: null } },
      { id: 'docker', path: '/bin/docker', version: '28.0.1', check: { kind: 'running' as const, state: 'yes' as const, account: null } },
    ],
    signals: {},
  };
  const rows = cliRows(overview, new Set(['gh', 'vercel']));
  assert.deepEqual(rows.slice(0, 3).map((row) => [row.spec.id, row.state.text, row.command]), [
    ['gh', 'Not signed in', 'gh auth login'], ['docker', 'Running', null], ['vercel', 'Not installed', 'npm i -g vercel'],
  ]);
});
