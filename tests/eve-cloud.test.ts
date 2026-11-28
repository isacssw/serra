// A profile whose agent is an eve agent on Vercel (SB-17): it runs through the agent layer like any ACP agent, with a
// person answering its approvals; nothing starts, and Check sends nothing, before the owner accepted the notice for
// the URL's host; the bypass secret lives only in the (fake) Keychain and reaches only eve's environment, never its
// arguments, a profile file or a log; eve's own failures read as fixed sentences. The fake ACP agent
// (tests/fakes/acp-agent.ts) plays the deployed agent: no Vercel, no network.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createAcpBackend } from '../src/agent/acp.ts';
import { agentChoices, launchFor, readAgentBackend, removeCustomAcpAgent, writeAgentBackend } from '../src/agent/acp-agents.ts';
import { chosenAcpAgent } from '../src/agent/select.ts';
import { checkEve, saveEve } from '../src/agent/eve-connect.ts';
import {
  BYPASS_ENV, consented, EVE_AGENT_ID, EVE_NOTICE_VERSION, eveCloudAgent, eveProblemOf, normalizeEveUrl, normalizeTeam, parseBypassInput,
  remoteAgentEnv, REMOTE_CWD, type EveCloud,
} from '../src/agent/eve-cloud.ts';
import { createBackendPool } from '../src/agent/pool.ts';
import { createT3Backend } from '../src/agent/t3.ts';
import { meetingsHandlers } from '../src/handlers/meetings.ts';
import { profilesHandlers } from '../src/handlers/profiles.ts';
import { defaultPrefs, memoryPrefs } from '../app/main/prefs.ts';
import { profileRows, rowLabel } from '../app/renderer/profiles.logic.ts';
import { agentOptions } from '../app/renderer/screens/settings/agent-backend.logic.ts';
import { EVE_DETAILS, eveContinueLabel, eveHost, eveNotice } from '../app/renderer/setup/eve.logic.ts';
import { stoppedStatusSource } from '../src/status-source.ts';
import { createProfile } from '../src/setup.ts';
import type { SecretStore } from '../src/secrets.ts';
import { engineContext, type AppContext } from './fakes/app-context.ts';
import { createFakeT3 } from './fakes/t3.ts';

// No login shell: the agent's environment is Serra's safe subset of this one.
process.env.SERRA_TOOLS_PATH ??= process.env.PATH ?? '';

const FAKE_AGENT = new URL('./fakes/acp-agent.ts', import.meta.url).pathname;
const OWNER = 'U0123456789';
/** A made-up bypass secret: the shape Vercel's has, nothing real. */
const BYPASS = 'fixturebypassvalue0000000000000a';
const URL_ = 'https://researcher.vercel.app';
const HOST = 'researcher.vercel.app';

/** A Keychain in memory, which records what was asked of it. */
const fakeKeychain = () => {
  const items = new Map<string, string>();
  const store: SecretStore = {
    get: async (service, account) => items.get(`${service}/${account}`) ?? null,
    set: async (service, account, value) => { items.set(`${service}/${account}`, value); },
    remove: async (service, account) => { items.delete(`${service}/${account}`); },
  };
  const readSecret = async (source: { kind: string; service?: string; account?: string }) => {
    const value = source.kind === 'keychain' ? items.get(`${source.service}/${source.account}`) : undefined;
    if (value === undefined) throw new Error('not found');
    return value;
  };
  return { items, store, readSecret };
};

/** A temp folder with a profile in it, and the fake agent eve is played by. */
const fixture = (t: TestContext) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'serra-eve-')));
  const root = join(base, 'serra');
  const fake = join(base, 'fake');
  const trash = join(base, 'Trash');
  for (const dir of [root, fake, trash]) mkdirSync(dir, { recursive: true });
  const children: ChildProcess[] = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  });
  const profile = (id: string): string => {
    const dir = join(root, id);
    createProfile(dir, {
      version: 1, bot: { id, name: id[0]!.toUpperCase() + id.slice(1) }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
      project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
    });
    return dir;
  };
  /** Starts the fake in place of `npx eve acp`, with eve's own arguments, in the environment Serra built. */
  const spawnAgent = (extra: Record<string, string> = {}) => (agent: { args: string[]; env?: Record<string, string> }, env: NodeJS.ProcessEnv): ChildProcess => {
    const child = spawn(process.execPath, [FAKE_AGENT, ...agent.args], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: { ...env, ...agent.env, FAKE_ACP_DIR: fake, FAKE_ACP_MODES: 'none', ...extra },
    });
    children.push(child);
    return child;
  };
  const makeAcp = (extra: Record<string, string> = {}): typeof createAcpBackend => (options) => createAcpBackend({ ...options, spawnAgent: spawnAgent(extra) });
  const read = (name: string): string | null => (existsSync(join(fake, name)) ? readFileSync(join(fake, name), 'utf8') : null);
  const reply = (text: string, turn: number): void => { writeFileSync(join(fake, `turn-${turn}.tmp`), text); renameSync(join(fake, `turn-${turn}.tmp`), join(fake, `turn-${turn}`)); };
  const context = (active: string | null): AppContext => {
    const prefs = memoryPrefs({ ...defaultPrefs, profileDir: active });
    return {
      profileDir: () => { const dir = prefs.get().profileDir; if (!dir) throw new Error('No bot profile selected.'); return dir; },
      profileDirOrNull: () => prefs.get().profileDir,
      prefs, status: stoppedStatusSource(),
      runtime: { version: '0.0.0', electron: '45.4.1', node: '24.22.3', platform: 'darwin' },
      openExternal: async () => {}, openPath: async () => {}, push: () => {},
      trashItem: async (path) => { renameSync(path, join(trash, basename(path))); },
    };
  };
  return { base, root, fake, trash, profile, makeAcp, read, reply, context, children };
};

const until = async (done: () => boolean): Promise<void> => {
  for (const end = Date.now() + 10_000; !done() && Date.now() < end;) await new Promise((resolve) => { setTimeout(resolve, 5); });
};

const cloud = (over: Partial<EveCloud> = {}): EveCloud => ({
  url: URL_, host: HOST, team: 'acme', bypass: null, secretSavedAt: null, check: null,
  notice: { host: HOST, version: EVE_NOTICE_VERSION, acceptedAt: '2026-11-28T12:00:00.000Z' }, ...over,
});

test('eve on Vercel: the address is https and the agent’s root only; the team is a short name; a bypass secret is letters and digits or an op:// reference', () => {
  assert.deepEqual(normalizeEveUrl(' researcher.vercel.app '), { url: URL_, host: HOST });
  assert.deepEqual(normalizeEveUrl('https://researcher.vercel.app/'), { url: URL_, host: HOST });
  assert.deepEqual(normalizeEveUrl('http://127.0.0.1:2417'), { url: 'http://127.0.0.1:2417', host: '127.0.0.1:2417' }, 'plain http only on this Mac');
  for (const [input, message] of [
    ['', /Enter/], ['http://researcher.vercel.app', /https/], ['https://me:pw@researcher.vercel.app', /sign-in/],
    ['https://researcher.vercel.app/?x=1', /address only/], ['https://researcher.vercel.app/api', /address only/], ['ftp://x', /https/],
  ] as const) assert.throws(() => normalizeEveUrl(input), message, input);
  assert.equal(normalizeTeam(' acme '), 'acme');
  assert.equal(normalizeTeam(''), null);
  assert.throws(() => normalizeTeam('--scope x'), /short name/);
  assert.deepEqual(parseBypassInput(BYPASS), { value: BYPASS });
  assert.deepEqual(parseBypassInput('op://Private/eve/bypass'), { reference: 'op://Private/eve/bypass' });
  assert.equal(parseBypassInput('  '), null);
  assert.throws(() => parseBypassInput('has "quotes" and spaces'), /letters and digits/);
});

test('eve on Vercel: the agent is eve’s pinned ACP bridge with the URL and team as arguments, and refuses to start before the notice is accepted for that host', () => {
  const agent = eveCloudAgent(cloud());
  assert.equal(agent.id, EVE_AGENT_ID);
  assert.equal(agent.command, 'npx');
  assert.deepEqual(agent.args, ['--yes', 'eve@1.5.0', 'acp', '--url', URL_, '--scope', 'acme']);
  assert.equal(agent.env?.EVE_TELEMETRY_DISABLED, '1');
  assert.ok(!JSON.stringify(agent).includes(BYPASS));

  for (const notice of [null, { host: 'other.vercel.app', version: EVE_NOTICE_VERSION, acceptedAt: 'x' }, { host: HOST, version: 0, acceptedAt: 'x' }]) {
    const refused = eveCloudAgent(cloud({ notice }));
    assert.equal(consented(cloud({ notice })), false);
    const launch = launchFor(refused, process.env.PATH ?? '');
    assert.ok('missing' in launch && /Accept what leaves this Mac for researcher\.vercel\.app/.test(launch.missing), JSON.stringify(notice));
  }
});

test('eve on Vercel: its environment drops a bypass secret or eve setting the shell exported for another project, and adds this profile’s secret, read at start', async () => {
  const keychain = fakeKeychain();
  keychain.items.set('dev.serra.ada/eve-bypass', BYPASS);
  const agent = eveCloudAgent(cloud({ bypass: { kind: 'keychain', service: 'dev.serra.ada', account: 'eve-bypass' } }));
  const env = await remoteAgentEnv(agent, async () => ({ PATH: '/usr/bin', HOME: '/Users/you', [BYPASS_ENV]: 'another-projects-secret', EVE_VERCEL_SCOPE: 'elsewhere' }), keychain.readSecret);
  assert.equal(env[BYPASS_ENV], BYPASS);
  assert.equal(env.EVE_VERCEL_SCOPE, undefined);
  assert.equal(env.HOME, '/Users/you');
  // Rotated: the next start reads the new value.
  keychain.items.set('dev.serra.ada/eve-bypass', `${BYPASS}b`);
  assert.equal((await remoteAgentEnv(agent, async () => ({}), keychain.readSecret))[BYPASS_ENV], `${BYPASS}b`);
  // No consent: refused before the secret is read or anything starts.
  let read = false;
  await assert.rejects(remoteAgentEnv(eveCloudAgent(cloud({ notice: null })), async () => ({}), async () => { read = true; return BYPASS; }), /Accept what leaves/);
  assert.equal(read, false);
  // A secret that can't be read says so plainly, without the item's name or value.
  await assert.rejects(remoteAgentEnv(eveCloudAgent(cloud({ bypass: { kind: 'keychain', service: 's', account: 'gone' } })), async () => ({}), keychain.readSecret), /can’t read the bypass secret for researcher\.vercel\.app/);
});

test('eve on Vercel: a job runs through the agent pool with no worktree and a neutral folder, the secret only in eve’s environment, and a person answering every approval', async (t) => {
  const f = fixture(t);
  const dir = f.profile('ada');
  const keychain = fakeKeychain();
  await saveEve(dir, { url: URL_, team: 'acme', secret: BYPASS, accept: HOST }, { store: keychain.store, now: () => new Date('2026-11-28T12:00:00Z') });
  const saved = readFileSync(join(dir, 'agent-backend.json'), 'utf8');
  assert.ok(!saved.includes(BYPASS), 'no secret in the profile’s files');
  assert.deepEqual(JSON.parse(saved).eve.bypass, { kind: 'keychain', service: 'dev.serra.ada', account: 'eve-bypass' });
  assert.equal(keychain.items.get('dev.serra.ada/eve-bypass'), BYPASS);
  assert.equal(readAgentBackend(dir).agent, EVE_AGENT_ID, 'eve is the agent new work runs on');
  assert.equal(chosenAcpAgent(dir), null, 'meeting runs stay on this Mac (T3): transcripts aren’t sent');

  const t3 = createFakeT3();
  const repo = join(f.base, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=You', '-c', 'user.email=you@example.com', 'commit', '-q', '--allow-empty', '-m', 'start']);
  const logs: string[] = [];
  const pool = createBackendPool({
    profileDir: dir, log: (line) => logs.push(line), readSecret: keychain.readSecret, makeAcp: f.makeAcp({ FAKE_ACP_VERSION: '1.5.0' }),
    t3: createT3Backend({ bin: '/Users/you/.t3/bin/t3', cli: t3.t3 }),
  });
  t.after(() => pool.close());
  const backend = pool.current();
  assert.equal(backend.key, `acp:${EVE_AGENT_ID}`);
  const threadId = await backend.start({ workspace: { kind: 'worktree', project: repo, baseRef: 'main', branch: 'serra/eve' }, title: 'job', brief: 'ASK:restart' });

  const start = JSON.parse(f.read('start-1')!) as { args: string[]; bypass: string | null; eve: string[] };
  assert.deepEqual(start.args, ['--yes', 'eve@1.5.0', 'acp', '--url', URL_, '--scope', 'acme'], 'the URL and team as arguments');
  assert.ok(!start.args.join(' ').includes(BYPASS), 'never the secret in its arguments');
  assert.equal(start.bypass, BYPASS, 'the secret in its environment');
  assert.deepEqual(start.eve, ['EVE_TELEMETRY_DISABLED']);
  assert.equal(f.read('session-1'), REMOTE_CWD, 'a neutral folder name, never a path on this Mac');
  assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n').length, 1, 'no worktree is made');

  // The approval waits as a card; nothing is allowed until a person answers.
  let request: Awaited<ReturnType<NonNullable<typeof backend.questions>['list']>>[number] | undefined;
  for (const end = Date.now() + 10_000; !request && Date.now() < end;) {
    [request] = await backend.questions!.list(threadId);
    if (!request) await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.ok(request, 'the approval waits as a card');
  assert.equal(f.read('permission-1'), null);
  await backend.questions!.answer(threadId, request.requestId, { permission: 'yes' });
  await until(() => f.read('permission-1') !== null);
  assert.equal(f.read('permission-1'), 'yes');
  f.reply('restarted', 1);
  const done = await backend.wait(threadId, { after: null, timeoutMs: 10_000, pollMs: 5, sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), now: Date.now });
  assert.ok(done.kind === 'settled' && done.answer === 'restarted');

  // eve's own failure (its login ran out mid-job) reads as a fixed sentence, never its text.
  await backend.send(threadId, 'FAIL_EVE:401');
  await until(() => logs.some((line) => line.includes('failed')));
  const failed = await backend.read(threadId);
  assert.equal(failed.thread.error, 'Sign in to Vercel: run vercel login, then Check.');
  assert.ok(!logs.join('\n').includes('SECRET-TRANSCRIPT') && !logs.join('\n').includes(BYPASS), 'eve’s text and the secret stay out of the log');
});

test('eve on Vercel: Check sends nothing until the notice for the URL’s host is accepted, then starts eve and opens a session without a prompt; its failures are one fixed sentence each', async (t) => {
  const f = fixture(t);
  const now = () => new Date('2026-11-28T12:00:00Z');
  await assert.rejects(checkEve(null, { url: URL_, accept: 'other.vercel.app' }, { makeAcp: f.makeAcp(), now }), /Accept what leaves this Mac for researcher\.vercel\.app/);
  assert.equal(f.read('start-1'), null, 'nothing started');

  const ok = await checkEve(null, { url: URL_, secret: BYPASS, accept: HOST }, { makeAcp: f.makeAcp({ FAKE_ACP_VERSION: '1.5.0' }), now });
  assert.deepEqual({ result: ok.result, version: ok.version, sentence: ok.sentence }, { result: 'ok', version: '1.5.0', sentence: 'Connected · eve 1.5.0' });
  assert.equal(JSON.parse(f.read('start-1')!).bypass, BYPASS, 'a typed secret is used for this start only');
  assert.equal(f.read('count-turn'), null, 'no prompt: no model call');

  const cases: [string, string][] = [
    ['Error: You are not logged in to Vercel. Run vercel login', 'Sign in to Vercel: run vercel login, then Check.'],
    ['Vercel Deployment Protection blocked the request to https://researcher.vercel.app.', 'This deployment is protected. Add a bypass secret or allow this Mac in Vercel.'],
    ['TypeError: fetch failed (getaddrinfo ENOTFOUND researcher.vercel.app)', 'Can’t reach researcher.vercel.app.'],
    [`something odd ${BYPASS}`, 'eve at researcher.vercel.app stopped with an error.'],
  ];
  for (const [stderr, sentence] of cases) {
    const check = await checkEve(null, { url: URL_, accept: HOST }, { makeAcp: f.makeAcp({ FAKE_ACP_STDERR: stderr }), now });
    assert.equal(check.sentence, sentence, stderr);
    assert.ok(!JSON.stringify(check).includes(BYPASS));
  }
  assert.equal(eveProblemOf('', { code: -32002, data: { httpStatus: 403 } }), 'protected');
});

test('eve on Vercel: Settings connects only after a passing Check, disconnects with its Keychain item, and refuses while it has a run going; other agents are unchanged', async (t) => {
  const f = fixture(t);
  const dir = f.profile('ada');
  const keychain = fakeKeychain();
  const handlers = meetingsHandlers(engineContext(f.context(dir)), { searchPath: async () => process.env.PATH ?? '', eve: { store: keychain.store, readSecret: keychain.readSecret, makeAcp: f.makeAcp({ FAKE_ACP_STDERR: 'not logged in' }), now: () => new Date('2026-11-28T12:00:00Z') } });
  await assert.rejects(async () => handlers.connectEve({ url: URL_, secret: BYPASS, accept: HOST }), /Sign in to Vercel/);
  assert.equal(readAgentBackend(dir).eve, undefined, 'a failed Check changes nothing');
  assert.equal(keychain.items.size, 0, 'and keeps no secret');

  const connected = meetingsHandlers(engineContext(f.context(dir)), { searchPath: async () => process.env.PATH ?? '', eve: { store: keychain.store, readSecret: keychain.readSecret, makeAcp: f.makeAcp({ FAKE_ACP_VERSION: '1.5.0' }), now: () => new Date('2026-11-28T12:00:00Z') } });
  const view = await connected.connectEve({ url: URL_, team: 'acme', secret: BYPASS, accept: HOST });
  assert.deepEqual(view.eve, { url: URL_, host: HOST, team: 'acme', secret: 'keychain', check: { at: '2026-11-28T12:00:00.000Z', result: 'ok', version: '1.5.0', sentence: 'Connected · eve 1.5.0' } });
  assert.equal(view.backend, 'acp');
  assert.equal(view.agent, EVE_AGENT_ID);
  assert.ok(!JSON.stringify(view).includes(BYPASS), 'the window never gets the secret');
  assert.equal(agentChoices(readAgentBackend(dir), process.env.PATH ?? '').find((choice) => choice.id === EVE_AGENT_ID)?.host, HOST);
  assert.throws(() => removeCustomAcpAgent(dir, EVE_AGENT_ID), /Disconnect eve/);

  // A run going: refused, so its turn keeps the agent it needs.
  mkdirSync(join(dir, 'agent-runs'));
  writeFileSync(join(dir, 'agent-runs', 's.json'), JSON.stringify({ version: 1, agent: EVE_AGENT_ID, sessionId: 's', cwd: REMOTE_CWD, active: 'run-1', entries: [] }));
  await assert.rejects(async () => connected.disconnectEve(), /run going/);
  rmSync(join(dir, 'agent-runs'), { recursive: true });

  const after = await connected.disconnectEve();
  assert.equal(after.eve, null);
  assert.equal(after.backend, 't3', 'new work goes back to T3');
  assert.equal(keychain.items.size, 0, 'its Keychain item is deleted');
  // Another agent the owner picked is untouched by eve's coming and going.
  await connected.connectEve({ url: URL_, accept: HOST });
  writeAgentBackend(dir, { backend: 'acp', agent: 'opencode' });
  await connected.disconnectEve();
  assert.equal(readAgentBackend(dir).backend, 'acp');
  assert.equal(readAgentBackend(dir).agent, 'opencode', 'disconnecting eve keeps an agent that wasn’t eve');
});

test('eve on Vercel: Add… › Profile makes a cloud profile (marked with its host) only with the notice accepted for that host, and Remove deletes its Keychain item; profiles on this Mac are unchanged', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  const ctx = f.context(saitama);
  const keychain = fakeKeychain();
  const profiles = profilesHandlers(engineContext(ctx), { root: f.root, launchAgentsDir: join(f.base, 'LaunchAgents'), probeMs: 100, searchPath: async () => '', now: () => new Date('2026-11-28T12:00:00Z'), eve: { store: keychain.store } });
  const draft = {
    botName: 'Researcher', ownerName: 'Alex', ownerSlackUserId: OWNER, githubLogin: 'alex', projectPath: '/Users/you/project', remote: 'origin',
    baseRef: 'origin/main', githubRepo: 'acme/project',
  };
  await assert.rejects(async () => profiles.create({ draft, color: null, agent: EVE_AGENT_ID, eve: { url: URL_, accept: 'other.vercel.app' } }), /Accept what leaves/);
  await assert.rejects(async () => profiles.create({ draft, color: null, agent: EVE_AGENT_ID }), /URL/);
  assert.deepEqual(readdirSync(f.root).filter((name) => !name.endsWith('.json')), ['saitama'], 'nothing is made without the notice');

  await profiles.create({ draft, color: null, agent: EVE_AGENT_ID, eve: { url: URL_, team: 'acme', secret: BYPASS, accept: HOST } });
  const researcher = join(f.root, 'researcher');
  const eve = readAgentBackend(researcher).eve!;
  assert.equal(eve.notice?.host, HOST);
  assert.equal(keychain.items.get('dev.serra.researcher/eve-bypass'), BYPASS);
  for (const name of readdirSync(researcher)) if (!name.startsWith('.') && name.endsWith('.json')) assert.ok(!readFileSync(join(researcher, name), 'utf8').includes(BYPASS), name);

  const listed = await profiles.list();
  assert.deepEqual(listed.profiles.map((entry) => [entry.name, entry.agent, entry.cloud]), [['Saitama', 'T3', null], ['Researcher', 'eve', HOST]]);
  assert.deepEqual(profileRows(listed, null).map((row) => [row.name, row.cloud]), [['Saitama', null], ['Researcher', HOST]]);

  const { backup } = await profiles.remove('local/researcher');
  assert.equal(keychain.items.size, 0, 'its Keychain item goes with it');
  assert.ok(!readFileSync(join(backup, 'agent-backend.json'), 'utf8').includes(BYPASS), 'the backup holds where it was, never the value');
  assert.deepEqual((await profiles.list()).profiles.map((entry) => [entry.name, entry.cloud]), [['Saitama', null]]);
});

test('eve on Vercel in the window: the notice names the host the URL gives, the button carries it, the card says where, and the row is marked with an icon and its spoken host only', () => {
  assert.equal(eveHost('researcher.vercel.app'), HOST);
  assert.equal(eveHost('https://researcher.vercel.app/'), HOST);
  for (const bad of ['', 'researcher', 'http://researcher.vercel.app', 'https://researcher.vercel.app/api', 'https://a@researcher.vercel.app']) assert.equal(eveHost(bad), null, bad);
  assert.equal(eveNotice(HOST), 'Requests and this profile’s knowledge index go to researcher.vercel.app.');
  assert.ok(eveNotice(HOST).split(' ').length <= 16, 'one short sentence');
  assert.ok(!/cloud/i.test(eveNotice(HOST)), 'never the word cloud');
  assert.equal(eveContinueLabel(HOST, 'Continue with'), 'Continue with researcher.vercel.app');
  assert.equal(eveContinueLabel(null, 'Connect'), 'Connect');
  assert.ok(EVE_DETAILS.length <= 5);

  const options = agentOptions([
    { id: 'claude', name: 'Claude Code', command: 'claude', installed: true, custom: false },
    { id: EVE_AGENT_ID, name: 'eve', command: 'npx', installed: true, custom: false, host: HOST },
  ]);
  assert.deepEqual(options.find((option) => option.value === `acp:${EVE_AGENT_ID}`), { value: `acp:${EVE_AGENT_ID}`, name: 'eve', detail: HOST, mark: 'eve', disabled: false, custom: false });

  const rows = profileRows({ pinned: false, palette: ['#111111', '#222222'], profiles: [
    { ref: 'local/saitama', dir: '/Users/you/.local/share/serra/saitama', name: 'Saitama', color: '#111111', active: true, setupDone: true, status: null, agent: 'T3' },
    { ref: 'local/researcher', dir: '/Users/you/.local/share/serra/researcher', name: 'Researcher', color: '#222222', active: false, setupDone: true, status: { state: 'stopped' }, agent: 'eve', cloud: HOST },
  ] }, null);
  assert.deepEqual(rows.map(rowLabel), ['Saitama, checking, command 1', 'Researcher, stopped, agent at researcher.vercel.app, command 2']);
  assert.equal(rows[1]!.presence.phrase, 'stopped', 'the status phrase is the same as any profile’s');
});
