import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Profile } from '../src/config.ts';
import { formatMcpOverview, mcpOverview, parseCodexServers, requiredTools, workerDrivers } from '../src/mcp.ts';

const TOKEN = 'sntrys_fixture-secret-value';
const HEADER = `Bearer ${TOKEN}`;
const SENTRY_ALERT = { channel: 'C0123456789', botId: 'B0123456789', instructions: 'Investigate this Sentry alert and reply with impact.' };

/** A fake home folder and project checkout. `write` puts a file under either. */
const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const write = (path: string, content: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const profile = (overrides: Partial<Profile> = {}): Profile => ({
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
    worker: { provider: 'claude', model: 'opus' }, messageTriggers: [SENTRY_ALERT], ...overrides,
  });
  const overview = (profileValue = profile()) => mcpOverview(profileValue, { home, env: {} });
  return { home, project, write, profile, overview };
};

const sentryHttp = { type: 'http', url: 'https://mcp.sentry.example/mcp?org=acme', headers: { Authorization: HEADER } };

test('a Sentry alert trigger with a Sentry server for Claude has no warning, and no config value reaches the result', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), {
    mcpServers: {
      sentry: sentryHttp,
      files: { command: 'npx', args: ['-y', 'files-server', `--token=${TOKEN}`], env: { API_KEY: TOKEN } },
    },
  });
  const overview = f.overview();
  assert.deepEqual(overview.worker.drivers, ['claude']);
  assert.deepEqual(overview.warnings, []);
  const sentry = overview.servers.find((server) => server.name === 'sentry')!;
  assert.deepEqual(sentry, {
    name: 'sentry', driver: 'claude', scope: 'user', source: '~/.claude.json', transport: 'http', host: 'mcp.sentry.example', load: 'loads', note: null, health: null,
  });
  assert.equal(overview.servers.find((server) => server.name === 'files')!.transport, 'stdio');
  const serialized = JSON.stringify(overview) + formatMcpOverview(overview);
  for (const hidden of [TOKEN, 'Authorization', 'npx', 'files-server', 'API_KEY', 'org=acme', '/mcp']) {
    assert.ok(!serialized.includes(hidden), `the overview must not contain ${hidden}`);
  }
});

test('a Sentry alert trigger without a Sentry server warns with the trigger channel', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), { mcpServers: { github: { type: 'http', url: 'https://api.github.example/mcp' } } });
  const { warnings } = f.overview();
  assert.equal(warnings.length, 1);
  assert.deepEqual({ ...warnings[0], text: undefined }, { tool: 'Sentry', driver: 'claude', channels: ['C0123456789'], text: undefined });
  assert.match(warnings[0]!.text, /alert trigger for channel C0123456789 mentions Sentry, but Claude has no Sentry MCP server/);
});

test('no config files at all: the trigger still warns, and each file is listed as missing', (t) => {
  const f = fixture(t);
  const overview = f.overview();
  assert.deepEqual(overview.servers, []);
  assert.equal(overview.warnings.length, 1);
  assert.ok(overview.files.length > 0 && overview.files.every((file) => file.state === 'missing'));
});

test('a server recognised by its command, not its name, satisfies the trigger', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), { mcpServers: { errors: { command: 'npx', args: ['@sentry/mcp-server'], env: { SENTRY_TOKEN: TOKEN } } } });
  assert.deepEqual(f.overview().warnings, []);
});

test('triggers that name no known tool need nothing; several channels naming one tool give one warning', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.overview(f.profile({ messageTriggers: [{ channel: 'C0123456789', instructions: 'Summarize each message.' }] })).warnings, []);
  assert.deepEqual(f.overview(f.profile({ messageTriggers: undefined })).warnings, []);
  const two = f.overview(f.profile({
    messageTriggers: [SENTRY_ALERT, { channel: 'C9876543210', instructions: 'Check the sentry issue.' }, { channel: 'C9876543210', userId: 'U0123456789', instructions: 'Sentry again' }],
  })).warnings;
  assert.equal(two.length, 1);
  assert.deepEqual(two[0]!.channels, ['C0123456789', 'C9876543210']);
  assert.match(two[0]!.text, /alert triggers for channels C0123456789 and C9876543210 mention Sentry/);
});

test('requiredTools matches product names as words', () => {
  const needed = requiredTools([
    { channel: 'C1', instructions: 'Check Datadog and PagerDuty.' },
    { channel: 'C2', instructions: 'Use the sentryless path.' },
  ]);
  assert.deepEqual([...needed.keys()].sort(), ['datadog', 'pagerduty']);
});

test('a project .mcp.json server may not load until the project servers are approved for every folder', (t) => {
  const f = fixture(t);
  f.write(join(f.project, '.mcp.json'), { mcpServers: { sentry: sentryHttp } });
  let overview = f.overview();
  assert.equal(overview.servers[0]!.load, 'unsure');
  assert.equal(overview.servers[0]!.source, join(f.project, '.mcp.json'));
  assert.match(overview.warnings[0]!.text, /the only Sentry MCP server for Claude \(sentry\) may not load in a T3 job/);

  f.write(join(f.project, '.claude', 'settings.json'), { enableAllProjectMcpServers: true });
  overview = f.overview();
  assert.equal(overview.servers[0]!.load, 'loads');
  assert.deepEqual(overview.warnings, []);
});

test('a project server turned off for the folder is off; one approved only for the folder may not load', (t) => {
  const f = fixture(t);
  f.write(join(f.project, '.mcp.json'), { mcpServers: { sentry: sentryHttp, other: { command: 'x' } } });
  f.write(join(f.home, '.claude.json'), { projects: { [f.project]: { disabledMcpjsonServers: ['sentry'], enabledMcpjsonServers: ['other'] } } });
  const overview = f.overview();
  assert.equal(overview.servers.find((server) => server.name === 'sentry')!.load, 'disabled');
  assert.equal(overview.servers.find((server) => server.name === 'other')!.load, 'unsure');
  assert.match(overview.warnings[0]!.text, /the Sentry MCP server for Claude \(sentry\) is turned off/);
});

test('a local-scope server belongs to the checkout folder and may not reach a job worktree', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), { projects: { [f.project]: { mcpServers: { sentry: sentryHttp } } } });
  const overview = f.overview();
  assert.deepEqual([overview.servers[0]!.scope, overview.servers[0]!.load], ['local', 'unsure']);
  assert.equal(overview.warnings.length, 1);
});

test('CLAUDE_CONFIG_DIR and CODEX_HOME move the config files', (t) => {
  const f = fixture(t);
  const claudeDir = join(f.home, 'claude-config');
  const codexDir = join(f.home, 'codex-config');
  f.write(join(claudeDir, '.claude.json'), { mcpServers: { sentry: sentryHttp } });
  f.write(join(codexDir, 'config.toml'), '[mcp_servers.sentry]\nurl = "https://mcp.sentry.example/mcp"\n');
  const overview = mcpOverview(f.profile({ worker: undefined }), { home: f.home, env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } });
  assert.deepEqual(overview.servers.map((server) => `${server.driver}:${server.source}`), ['claude:~/claude-config/.claude.json', 'codex:~/codex-config/config.toml']);
  assert.deepEqual(overview.warnings, []);
});

test('a Codex worker reads only Codex config, and a turned-off Codex server warns', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), { mcpServers: { sentry: sentryHttp } });
  f.write(join(f.home, '.codex', 'config.toml'), [
    '[mcp_servers.sentry]', 'command = "npx"', `args = ["-y", "@sentry/mcp-server", "--access-token=${TOKEN}"]`, 'enabled = false', '',
    '[mcp_servers.sentry.env]', `SENTRY_TOKEN = "${TOKEN}"`,
  ].join('\n'));
  const overview = f.overview(f.profile({ worker: { provider: 'codex', model: 'gpt' } }));
  assert.deepEqual(overview.worker.drivers, ['codex']);
  assert.deepEqual(overview.servers.map((server) => [server.driver, server.name, server.load]), [['codex', 'sentry', 'disabled']]);
  assert.equal(overview.warnings.length, 1);
  assert.match(overview.warnings[0]!.text, /Sentry MCP server for Codex \(sentry\) is turned off/);
  assert.ok(!JSON.stringify(overview).includes(TOKEN));
});

test('without a worker provider both kinds are listed and each is checked', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), { mcpServers: { sentry: sentryHttp } });
  const overview = f.overview(f.profile({ worker: undefined }));
  assert.deepEqual(overview.worker.drivers, ['claude', 'codex']);
  assert.match(overview.worker.note!, /both Claude and Codex/);
  assert.deepEqual(overview.warnings.map((warning) => warning.driver), ['codex']);
});

test('workerDrivers maps provider instance names to their kind', () => {
  assert.deepEqual(workerDrivers('claudeAgent').drivers, ['claude']);
  assert.deepEqual(workerDrivers('codex-work').drivers, ['codex']);
  const unknown = workerDrivers('custom');
  assert.deepEqual(unknown.drivers, ['claude', 'codex']);
  assert.match(unknown.note!, /"custom"/);
});

test('an unreadable config is reported as a file problem without its content or the parser message', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), `{"mcpServers": {"sentry": {"headers": {"Authorization": "${HEADER}"}}`);
  const overview = f.overview();
  assert.equal(overview.files.find((file) => file.path === '~/.claude.json')!.state, 'unreadable');
  assert.deepEqual(overview.servers, []);
  const output = JSON.stringify(overview) + formatMcpOverview(overview);
  assert.ok(!output.includes(TOKEN));
  assert.match(formatMcpOverview(overview), /Couldn't read ~\/\.claude\.json\./);
});

test('parseCodexServers reads tables, quoted names, inline tables and multi-line args, and nothing else', () => {
  const servers = parseCodexServers([
    'model = "gpt"',
    '[mcp_servers."error tracker"]',
    'command = "npx"',
    'args = [',
    '  "-y",',
    '  "@sentry/mcp-server",',
    ']',
    'enabled = true # still on',
    '',
    '[mcp_servers."error tracker".env]',
    `TOKEN = "${TOKEN}"`,
    'command = "not-the-command"',
    '',
    '[mcp_servers]',
    `docs = { url = "https://docs.example/mcp", enabled = false, env = { KEY = "${TOKEN}" } }`,
    '',
    '[profiles.work]',
    'command = "elsewhere"',
    '',
    '[[skills]]',
    'name = "x"',
    'mcp_servers.inline.command = "uvx"',
  ].join('\n'));
  assert.deepEqual([...servers.keys()], ['error tracker', 'docs']);
  const tracker = servers.get('error tracker')!;
  assert.equal(tracker.command, 'npx');
  assert.equal(tracker.enabled, true);
  assert.match(tracker.args, /@sentry\/mcp-server/);
  assert.deepEqual({ ...servers.get('docs') }, { command: '', url: 'https://docs.example/mcp', args: '', enabled: false });
});
