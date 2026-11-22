// Tools (SERRA-39): the provider CLIs' server lists, the Codex comment fix, CLI detection, recommendation signals
// and the screen's logic. Every command is a fake: nothing here runs `claude`, `codex`, `gh` or a shell.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { cliOverview, detectCli, formatCliOverview, recommendationSignals } from '../src/clis.ts';
import type { Profile } from '../src/config.ts';
import type { Exec, ExecResult } from '../src/exec.ts';
import { exec, findExecutable, toolEnv } from '../src/exec.ts';
import { liveMcpOverview, parseClaudeMcpList, parseCodexMcpList } from '../src/mcp-live.ts';
import { formatMcpOverview, mcpOverview, parseCodexServers, tomlScalar, type McpOverview } from '../src/mcp.ts';
import { loginShellEnv, loginShellPath, mergePaths } from '../src/shell-path.ts';
import { CLI_CATALOG, type CliSpec } from '../src/tool-catalog.ts';
import {
  cliRows, cliStatus, driverGroups, providerLine, recommendationRows, recommendedCliIds, serverBrand, serverLabel, serverStatus,
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
  return { root, home, project, profileDir, bin, write, install, profile };
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
  const entries = parseClaudeMcpList(CLAUDE_LIST)!;
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

test('parseClaudeMcpList reads Claude\'s real statuses, with appended detail, and keeps unknown ones as unknown', () => {
  const entries = parseClaudeMcpList([
    'team: https://team.example/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)',
    'old: npx old-server - ⊘ Disabled for this project (re-enable via /mcp)',
    'blocked: https://b.example/mcp (HTTP) - Rejected (see disabledMcpjsonServers in settings)',
    `slow: npx -y slow - fast - ✗ Failed to connect — timed out after 30s ${TOKEN}`,
    'half: https://h.example/mcp (HTTP) - ! Connected · tools fetch failed',
    'fine: https://f.example/mcp (HTTP) - ✓ Connected',
    'later: https://l.example/mcp (HTTP) - ✓ Something new',
    'policy: https://p.example/mcp (HTTP) - Blocked by enterprise managed policy',
    'empty: npx thing - - Not configured',
  ].join('\n'))!;
  assert.deepEqual(entries.map((entry) => [entry.name, entry.health, entry.disabled, entry.unknown]), [
    ['team', 'pending', false, false], ['old', null, true, false], ['blocked', null, true, false], ['slow', 'failed', false, false],
    ['half', 'failed', false, false], ['fine', 'connected', false, false], ['later', null, false, true],
    ['policy', null, true, false], ['empty', 'failed', false, false],
  ]);
  assert.equal(entries[3]!.target, 'npx -y slow - fast', 'the status starts at the first " - " that begins a status');
});

test('parseClaudeMcpList trusts only server rows and names; unknown output is null, "no servers" is empty', () => {
  assert.deepEqual(parseClaudeMcpList('weird: thing - stuff\nWarning: x - y'), null);
  assert.deepEqual(parseClaudeMcpList('ok: https://a.example/mcp - ✔ Connected\nfoo: bar - baz')!.map((entry) => entry.name), ['ok']);
  assert.deepEqual(parseClaudeMcpList('<script>: https://a.example - ✔ Connected'), null);
  assert.deepEqual(parseClaudeMcpList('No MCP servers configured. Use `claude mcp add` to add a server.'), []);
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
  assert.throws(() => parseCodexMcpList('[{"name":"x"}]'), /Not a server row/);
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

test('with a working CLI, a server only in the files is not shown, and the winning definition is the local one', async (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), JSON.stringify({
    mcpServers: { hidden: { command: 'x' }, both: { type: 'http', url: 'https://user.example/mcp' } },
    projects: { [f.project]: { mcpServers: { both: { type: 'http', url: 'https://local.example/mcp' } } } },
  }));
  f.install('claude');
  const run = fakeRun({ 'claude mcp list': { stdout: 'both: https://local.example/mcp (HTTP) - ✔ Connected' } });
  const overview = await liveMcpOverview(f.profile(), { home: f.home, env: {}, run, path: f.bin });
  assert.deepEqual(overview.servers.map((server) => [server.name, server.scope, server.load]), [['both', 'local', 'unsure']]);
});

test('output Claude prints with exit 0 that Serra can\'t read falls back to the files', async (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.github.example/mcp' } } }));
  f.install('claude');
  const overview = await liveMcpOverview(f.profile(), { home: f.home, env: {}, run: fakeRun({ 'claude mcp list': { stdout: 'Something new happened' } }), path: f.bin });
  assert.equal(overview.listing[0]!.method, 'files');
  assert.match(overview.listing[0]!.note!, /couldn't read/);
  assert.deepEqual(overview.servers.map((server) => server.name), ['github']);
});

test('exec settles at the deadline even when a grandchild holds the pipes open', async () => {
  const started = Date.now();
  const outcome = await exec('/bin/sh', ['-c', 'sleep 5 & sleep 5'], { timeoutMs: 150 });
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
  const missing = await exec('/definitely/not/here', []);
  assert.equal(missing.missing, true);
  const ok = await exec('/bin/sh', ['-c', 'printf hi; exit 3']);
  assert.deepEqual([ok.code, ok.stdout, ok.timedOut], [3, 'hi', false]);
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

  const signedOut = await detectCli(spec('gh'), { path: f.bin, home: f.home, run: fakeRun({ 'gh auth status --help': { stdout: '--active' }, 'gh --version': { stdout: 'gh version 2.83.0' }, 'gh auth status': { code: 1 } }) });
  assert.deepEqual(signedOut.check, { kind: 'signed-in', state: 'no', account: null });
});

test('detectCli: a check that times out is unknown; empty output with needsOutput is no; odd account text is dropped', async (t) => {
  const f = fixture(t);
  f.install('gcloud');
  f.install('flyctl');
  const slow = await detectCli(spec('gcloud'), { path: f.bin, home: f.home, run: fakeRun({ 'gcloud --version': { stdout: 'Google Cloud SDK 594.0.0' }, 'gcloud auth': { code: null, timedOut: true } }) });
  assert.equal(slow.check!.state, 'unknown');
  const empty = await detectCli(spec('gcloud'), { path: f.bin, home: f.home, run: fakeRun({ 'gcloud --version': {}, 'gcloud auth': { stdout: '' } }) });
  assert.equal(empty.check!.state, 'no');
  f.install('az');
  const az = await detectCli(spec('az'), { path: f.bin, home: f.home, run: fakeRun({ 'az --version': { stdout: 'azure-cli 2.93.0' }, 'az account': { stdout: 'two words here' } }) });
  assert.deepEqual([az.version, az.check!.state, az.check!.account], ['2.93.0', 'yes', null]);
  const fly = await detectCli(spec('fly'), { path: f.bin, home: f.home, run: fakeRun({ 'flyctl version': { stdout: 'flyctl v0.5.14 darwin/arm64' } }) });
  assert.deepEqual([fly.version, fly.check], ['0.5.14', null], 'fly auth whoami can refresh tokens, so it is not checked');
});

test('a tool without a trusted sign-in check reports none', async (t) => {
  const f = fixture(t);
  f.install('sentry-cli');
  const sentry = await detectCli(spec('sentry-cli'), { path: f.bin, home: f.home, run: fakeRun({ 'sentry-cli --version': { stdout: 'sentry-cli 2.58.1' } }) });
  assert.deepEqual([sentry.version, sentry.check], ['2.58.1', null]);
  assert.equal(spec('aws').check, undefined, 'aws sts can run credential helpers, so it is not checked');
  assert.equal(spec('vercel').check, undefined, 'vercel whoami can refresh saved credentials, so it is not checked');
});

test('checking GitHub sign-in never makes gh refresh its token, and still shows the account on a gh too old to know --no-refresh', async (t) => {
  const f = fixture(t);
  const refreshed = join(f.root, 'refreshed');
  /** A real `gh` on the PATH. `auth status` without --no-refresh refreshes the token (leaves a mark); `--help` is how it says what it knows. */
  const gh = (version: 'newer' | 'older' | 'broken-help') => {
    f.write(join(f.bin, 'gh'), `#!/bin/sh
case "$*" in
  "--version") echo "gh version 2.99.0" ;;
  "auth status --help")
    ${version === 'broken-help' ? 'exit 2' : version === 'newer' ? 'echo "  --no-refresh   Don\'t refresh tokens"' : 'echo "  --active"'} ;;
  "auth status"*)
    case "$*" in
      *--no-refresh*) ${version === 'older' ? 'echo "unknown flag: --no-refresh" >&2; exit 1' : ':'} ;;
      *) /usr/bin/touch ${JSON.stringify(refreshed)} ;;
    esac
    echo "github.com"; echo "  ✓ Logged in to github.com account alex (keyring)" ;;
  *) exit 1 ;;
esac
`);
    chmodSync(join(f.bin, 'gh'), 0o755);
    rmSync(refreshed, { force: true });
  };

  gh('newer');
  assert.deepEqual((await detectCli(spec('gh'), { path: f.bin, home: f.home })).check, { kind: 'signed-in', state: 'yes', account: 'alex' });
  assert.equal(existsSync(refreshed), false, 'a gh that can skip the refresh is told to');

  gh('older');
  assert.deepEqual((await detectCli(spec('gh'), { path: f.bin, home: f.home })).check, { kind: 'signed-in', state: 'yes', account: 'alex' },
    'an older gh is not handed a flag it would fail on');

  gh('broken-help');
  assert.deepEqual((await detectCli(spec('gh'), { path: f.bin, home: f.home })).check, { kind: 'signed-in', state: 'unknown', account: null });
  assert.equal(existsSync(refreshed), false, 'when it is unclear whether gh can skip the refresh, it is not asked at all');
});

test('findExecutable needs an executable file', (t) => {
  const f = fixture(t);
  f.write(join(f.bin, 'plain'), 'not executable');
  mkdirSync(join(f.bin, 'folder'));
  f.install('real');
  assert.equal(findExecutable('plain', f.bin), null);
  assert.equal(findExecutable('folder', f.bin), null);
  assert.equal(findExecutable('real', `/nowhere:${f.bin}`), join(f.bin, 'real'));
  assert.equal(findExecutable('real', 'relative/bin:.'), null, 'relative PATH entries are never searched');
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

test('toolEnv passes only the allowlist, the PATH and the quiet switches', () => {
  const env = toolEnv('/bin', { HOME: '/h', SLACK_BOT_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, CODEX_HOME: '/c', HTTPS_PROXY: 'http://proxy' });
  assert.equal(env.HOME, '/h');
  assert.equal(env.CODEX_HOME, '/c');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.VERCEL_TELEMETRY_DISABLED, '1');
  assert.ok(!JSON.stringify(env).includes(TOKEN));
  assert.equal(env.AZURE_LOGGING_ENABLE_LOG_FILE, 'false');
  assert.equal(env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, 'true');
});

test('loginShellPath reads PATH between markers; mergePaths keeps order without repeats', async () => {
  const run: Exec = async () => result({ stdout: 'motd noise\n__SERRA_ENV__PATH=/a:/b\0HOME=/h\0__SERRA_ENV_END__' });
  assert.equal(await loginShellPath({ run }), '/a:/b');
  assert.equal(await loginShellPath({ run: async () => result({ code: null, timedOut: true }) }), null);
  assert.equal(mergePaths('/a:/b', null, '/b:/c', ''), '/a:/b:/c');
  assert.equal(mergePaths('.:bin:/a'), '/a');
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
  // A FIFO in the repo is skipped, never read (a blocking read would freeze the main process).
  rmSync(join(f.project, 'requirements.txt'));
  execFileSync('mkfifo', [join(f.project, 'requirements.txt')]);
  assert.equal(recommendationSignals(f.profile(), f.profileDir).sentry, undefined);
  const alert = f.profile({ messageTriggers: [{ channel: 'C0123456789', instructions: 'Investigate this Sentry alert.' }] });
  assert.equal(recommendationSignals(alert, null).sentry, 'An alert rule mentions Sentry');
});

// ---------------------------------------------------------------------------------------------------------------
// Screen logic
// ---------------------------------------------------------------------------------------------------------------

const emptyMcp = (overrides: Partial<McpOverview> = {}): McpOverview => ({
  worker: { provider: 'claude', drivers: ['claude'], providers: [], note: null }, servers: [], warnings: [], files: [],
  listing: [{ driver: 'claude', method: 'cli', note: null }], ...overrides,
});

test('server and CLI statuses', () => {
  assert.deepEqual(serverStatus({ load: 'disabled', health: 'connected' }), { tone: 'off', text: 'Off' });
  assert.deepEqual(serverStatus({ load: 'loads', health: 'connected' }), { tone: 'up', text: 'Connected' });
  assert.deepEqual(serverStatus({ load: 'loads', health: 'needs-auth' }), { tone: 'warn', text: 'Needs sign-in' });
  assert.deepEqual(serverStatus({ load: 'loads', health: 'failed' }), { tone: 'down', text: 'Failed' });
  assert.deepEqual(serverStatus({ load: 'unsure', health: null }), { tone: 'warn', text: 'May not load' });
  assert.deepEqual(serverStatus({ load: 'unsure', health: 'connected' }), { tone: 'warn', text: 'May not load' }, 'connected from the checkout, not surely in a job');
  assert.deepEqual(serverStatus({ load: 'loads', health: null }), { tone: 'neutral', text: 'Enabled' });
  assert.deepEqual(cliStatus(undefined), { tone: 'off', text: 'Not installed' });
  assert.deepEqual(cliStatus({ id: 'docker', path: '/x', version: '1', check: { kind: 'running', state: 'no', account: null } }), { tone: 'warn', text: 'Not running' });
  assert.equal(serverLabel({ name: 'claude.ai Gmail', scope: 'connector' }), 'Gmail');
  assert.equal(serverBrand({ name: 'claude.ai Google Drive', host: 'drivemcp.googleapis.com' }), 'googledrive');
  assert.equal(serverBrand({ name: 'mystery', host: null }), null);
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
  assert.match(claude!.hint!.command, /^claude mcp add --scope user/);
  assert.equal(driverGroups(emptyMcp())[0]!.summary, 'No servers');
});

test('driverGroups follow T3\'s providers: its names, and "not supported yet" for one Serra can\'t read instead of a guess', () => {
  const groups = driverGroups(emptyMcp({
    worker: {
      provider: null, drivers: ['claude', 'codex'], note: null,
      providers: [
        { instanceId: 'claudeAgent', label: 'Claude', driver: 'claude' },
        { instanceId: 'claude-work', label: 'Claude (work)', driver: 'claude' },
        { instanceId: 'codex', label: 'Codex', driver: 'codex' },
        { instanceId: 'cursor', label: 'Cursor', driver: null },
        { instanceId: 'antigravity', label: 'Antigravity', driver: null },
      ],
    },
  }));
  assert.deepEqual(groups.map((group) => [group.title, group.summary]), [
    ['Claude · Claude (work)', 'No servers'], ['Codex', 'No servers'], ['Cursor', 'Not supported yet'], ['Antigravity', 'Not supported yet'],
  ]);
  const cursor = groups[2]!;
  assert.equal(cursor.hint, null, 'no made-up command for a provider Serra can\'t read');
  assert.match(cursor.unsupported!, /Serra can't read Cursor's MCP servers yet/);
  assert.equal(providerLine({ provider: null, drivers: [], note: null, providers: [{ instanceId: 'cursor', label: 'Cursor', driver: null }] }), 'No worker provider set: every provider on in T3 (Cursor)');
  assert.equal(providerLine({ provider: 'cursor', drivers: [], note: null, providers: [{ instanceId: 'cursor', label: 'Cursor', driver: null }] }), 'Worker: Cursor');
});

test('recommendations: GitHub always, others only with a signal or a server; ready, sign-in and set-up commands', () => {
  const clis = { clis: [{ id: 'gh', path: '/bin/gh', version: '2.83.0', check: { kind: 'signed-in' as const, state: 'yes' as const, account: 'alex' } }], signals: {} };
  let rows = recommendationRows(emptyMcp(), clis);
  assert.deepEqual(rows.map((row) => [row.rec.id, row.state.text, row.setup.length]), [['github', 'Ready', 0]]);

  rows = recommendationRows(emptyMcp({ worker: { provider: null, drivers: ['claude', 'codex'], providers: [], note: null } }), { ...clis, signals: { vercel: 'vercel.json in the repo' } });
  const vercel = rows.find((row) => row.rec.id === 'vercel')!;
  assert.equal(vercel.state.text, 'Not set up');
  assert.deepEqual(vercel.setup.map((step) => step.command), [
    'npm i -g vercel', 'claude mcp add --scope user --transport http vercel https://mcp.vercel.com', 'codex mcp add vercel --url https://mcp.vercel.com',
  ]);

  const linear = { name: 'linear', driver: 'claude' as const, scope: 'user' as const, source: '~/.claude.json', transport: 'http' as const, host: 'mcp.linear.app', load: 'loads' as const, note: null, health: 'needs-auth' as const };
  rows = recommendationRows(emptyMcp({ servers: [{ ...linear, name: 'claude.ai Linear' }] }), clis);
  const signIn = rows.find((row) => row.rec.id === 'linear')!;
  assert.equal(signIn.state.text, 'Needs sign-in');
  assert.deepEqual(signIn.setup.map((step) => step.command), ["claude mcp login 'claude.ai Linear'"], 'sign in, never re-add an existing server');
  assert.deepEqual([...recommendedCliIds(rows)], ['gh']);

  // A Codex server nobody health-checked is only Configured; a GitHub MCP server never makes GitHub ready without gh.
  rows = recommendationRows(emptyMcp({ servers: [{ ...linear, driver: 'codex', health: null }, { ...linear, name: 'github', host: 'api.githubcopilot.com', health: 'connected' }] }), { clis: [], signals: {} });
  assert.equal(rows.find((row) => row.rec.id === 'linear')!.state.text, 'Configured');
  rows = recommendationRows(emptyMcp({ servers: [{ ...linear, scope: 'local', load: 'unsure', health: 'connected' }] }), { clis: [], signals: {} });
  assert.deepEqual(rows.find((row) => row.rec.id === 'linear')!.state, { tone: 'warn', text: 'May not load' }, 'a local-scope server is not Ready, and says why');

  // A failed server says Failed; a turned-off one says Turned off and never gets an `add` that would replace it.
  rows = recommendationRows(emptyMcp({ servers: [{ ...linear, health: 'failed' }] }), { clis: [], signals: {} });
  assert.deepEqual(rows.find((row) => row.rec.id === 'linear')!.state, { tone: 'down', text: 'Failed' });
  const off = { ...linear, name: 'vercel', host: 'mcp.vercel.com', driver: 'codex' as const, load: 'disabled' as const, health: null };
  rows = recommendationRows(emptyMcp({ worker: { provider: 'codex', drivers: ['codex'], providers: [], note: null }, servers: [off] }), { clis: [], signals: { vercel: 'vercel.json in the repo' } });
  const turnedOff = rows.find((row) => row.rec.id === 'vercel')!;
  assert.equal(turnedOff.state.text, 'Turned off');
  assert.ok(!turnedOff.setup.some((step) => step.command.includes('mcp add')), turnedOff.setup.map((step) => step.command).join('\n'));

  // Without an MCP list (it failed), no MCP commands are offered at all.
  rows = recommendationRows(null, { clis: [], signals: { vercel: 'vercel.json in the repo' } });
  assert.deepEqual(rows.find((row) => row.rec.id === 'vercel')!.setup.map((step) => step.command), ['npm i -g vercel']);
  const github = rows.find((row) => row.rec.id === 'github')!;
  assert.equal(github.state.text, 'Not set up');

  // An installed CLI nobody could check isn't Ready: Sentry with sentry-cli and no server shows Installed, with sign-in.
  rows = recommendationRows(emptyMcp(), { clis: [{ id: 'sentry-cli', path: '/bin/sentry-cli', version: '2.58.1', check: null }], signals: { sentry: 'The repo uses a Sentry SDK' } });
  const sentry = rows.find((row) => row.rec.id === 'sentry')!;
  assert.deepEqual(sentry.state, { tone: 'neutral', text: 'Installed' });
  assert.equal(sentry.setup[0]!.command, 'sentry-cli login');
  assert.deepEqual(github.setup.map((step) => step.command), ['brew install gh']);
});

test('while the MCP list loads, an MCP-backed recommendation says Checking, with no commands; GitHub waits for nothing', () => {
  const clis = { clis: [], signals: { sentry: 'The repo uses a Sentry SDK' } };
  const rows = recommendationRows(null, clis, undefined, undefined, true);
  const sentry = rows.find((row) => row.rec.id === 'sentry')!;
  assert.deepEqual([sentry.state.text, sentry.setup], ['Checking…', []]);
  assert.equal(rows.find((row) => row.rec.id === 'github')!.state.text, 'Not set up');
});

test('loginShellEnv reads the environment after the marker, NUL-separated', async () => {
  const env = await loginShellEnv({ run: async () => result({ stdout: `motd\n__SERRA_ENV__PATH=/a:/b\0GITHUB_TOKEN=x=y\0__SERRA_ENV_END__bye` }) });
  assert.deepEqual(env, { PATH: '/a:/b', GITHUB_TOKEN: 'x=y' });
  assert.equal(await loginShellEnv({ run: async () => result({ stdout: 'no marker' }) }), null);
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
