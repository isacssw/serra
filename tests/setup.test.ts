import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { secretsHandlers } from '../app/main/ipc/secrets.ts';
import { setupHandlers } from '../app/main/ipc/setup.ts';
import { defaultPrefs, memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import {
  draftErrors, draftRequest, emptyDraft, outcomeText, stepState, suggestId, visibleStep,
} from '../app/renderer/screens/Welcome/welcome.logic.ts';
import { loadConfig, readProfileFile } from '../src/config.ts';
import type { ServiceDriver } from '../src/deploy.ts';
import { diagnose, type SlackAccountCheck } from '../src/doctor.ts';
import { prepareNextRelease } from '../src/releases.ts';
import type { SlackVerify } from '../src/secrets.ts';
import {
  confirmOwner, createProfile, createSetupProfile, detectProject, installService, profileFromDraft, setupProgress,
  slackManifest, suggestBotId, type MemberLookup, type ProfileDraft, type SetupProgress,
} from '../src/setup.ts';

const BOT = 'xoxb-1111-2222-fixturevalue';
const APP = 'xapp-1-A111-2222-fixturevalue';
const OWNER = 'U0123456789';

/** A node script run as a binary. Plain JS: it runs outside the repo, without type stripping. */
const script = (path: string, body: string): string => {
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return path;
};

/**
 * A temp root with a Git repository on GitHub (`acme/project`, `origin/main`), and fake `security`, `gh` and `t3`
 * on PATH. `security` keeps items in a JSON file like the Secrets tests' fake; `gh` is signed in as `alex`.
 */
const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Alex');
  git('config', 'user.email', 'alex@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('remote', 'add', 'origin', 'git@github.com:acme/project.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const keychain = join(root, 'keychain.json');
  writeFileSync(keychain, '{}');
  script(join(bin, 'security'), `
const fs = require('node:fs');
const items = JSON.parse(fs.readFileSync(${JSON.stringify(keychain)}, 'utf8'));
const opt = (args, flag) => args[args.indexOf(flag) + 1];
let args = process.argv.slice(2);
if (args[0] === '-i') {
  const line = fs.readFileSync(0, 'utf8').trim();
  args = (line.match(/"[^"]*"|\\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
  items[opt(args, '-s') + '/' + opt(args, '-a')] = opt(args, '-w');
  fs.writeFileSync(${JSON.stringify(keychain)}, JSON.stringify(items));
  process.exit(0);
}
const key = opt(args, '-s') + '/' + opt(args, '-a');
if (!(key in items)) { process.stderr.write('security: The specified item could not be found in the keychain.\\n'); process.exit(44); }
process.stdout.write(args.includes('-w') ? items[key] + '\\n' : 'class: "genp"\\n');
`);
  script(join(bin, 'gh'), `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0); }
if (args[0] === 'api' && args[1] === 'user') { console.log('alex'); process.exit(0); }
process.exit(1);
`);
  const t3 = script(join(bin, 't3'), `
const args = process.argv.slice(2);
if (args[0] === 'thread' && args[1] === 'list') { console.log('[]'); }
process.exit(0);
`);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  t.after(() => { process.env.PATH = path; });
  return { root, project, bin, t3, keychain: () => JSON.parse(readFileSync(keychain, 'utf8')) as Record<string, string> };
};

const context = (prefsDir: string | null = null): HandlerContext & { pushed: string[] } => {
  const prefs = memoryPrefs({ ...defaultPrefs, profileDir: prefsDir });
  const pushed: string[] = [];
  return {
    pushed,
    profileDir: () => { const dir = prefs.get().profileDir; if (!dir) throw new Error('No bot profile selected.'); return dir; },
    profileDirOrNull: () => prefs.get().profileDir,
    prefs,
    status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.22.3', platform: 'darwin' },
    openExternal: async () => {},
    openPath: async () => {},
    push: (channel, payload) => { if (channel === 'releaseLog') pushed.push(String(payload)); },
  };
};

const verify: SlackVerify = async (name) => (name === 'SLACK_BOT_TOKEN' ? { url: 'https://acme.slack.com/', team: 'Acme' } : {});
const lookup: MemberLookup = async (_token, id) => ({ name: id === OWNER ? 'Alex' : 'Sam', isBot: false, deleted: false });
const slack: SlackAccountCheck = async (token, owner) => {
  assert.equal(token, BOT);
  assert.equal(owner, OWNER);
  return '@friday in Acme; owner found.';
};

/** A launchd that records calls and is never touched for real. */
const fakeLaunchd = () => {
  const calls: string[] = [];
  const driver: ServiceDriver = {
    loaded: async () => false,
    stop: async () => { calls.push('stop'); },
    start: async () => { calls.push('start'); },
    ready: async () => { calls.push('ready'); },
  };
  return { calls, driver };
};

/** Prepares from this checkout without `pnpm install`, then fakes the dependency activation checks for. */
const prepareWithoutInstall: typeof prepareNextRelease = async (dir, options) => {
  const prepared = await prepareNextRelease(dir, { ...options, install: false });
  mkdirSync(join(prepared.release, 'node_modules/@slack/bolt'), { recursive: true });
  return prepared;
};

const draft = (f: { project: string; t3: string }, directory: string): ProfileDraft => ({
  botName: 'Friday', ownerName: 'Alex', ownerSlackUserId: OWNER, githubLogin: 'alex', projectPath: f.project, t3Bin: f.t3, directory,
});

// ---------------------------------------------------------------------------------------------------------------
// The acceptance run: an empty profile folder to a valid profile and a passing diagnose()
// ---------------------------------------------------------------------------------------------------------------

test('the wizard takes an empty profile folder to a valid profile, an installed service and a passing diagnose()', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'profiles', 'friday');
  mkdirSync(dir, { recursive: true });
  assert.deepEqual(readdirSync(dir), []);

  const ctx = context();
  const { calls, driver } = fakeLaunchd();
  const agents = join(f.root, 'LaunchAgents');
  const logged: string[] = [];
  const setup = setupHandlers(ctx, {
    root: join(f.root, 'profiles'),
    findNode: async () => process.execPath,
    lookup,
    githubLogin: async () => 'alex',
    echo: (line) => logged.push(line),
    install: { deploy: { driver, launchAgentsDir: agents }, diagnose: { slack }, prepareRelease: prepareWithoutInstall },
  });
  const secrets = secretsHandlers(ctx, { verify });
  const responses: unknown[] = [];
  const call = async <T>(promise: T | Promise<T>): Promise<T> => { const value = await promise; responses.push(value); return value; };

  // Nothing selected yet: the wizard starts at the profile.
  const start = await call(setup.progress());
  assert.equal(start.next, 'profile');
  assert.equal(start.profileDir, null);
  assert.deepEqual(await call(setup.defaults()), { githubLogin: 'alex', profileRoot: join(f.root, 'profiles') });
  const detected = await call(setup.detectProject(f.project, 'origin'));
  assert.deepEqual(detected, { baseRef: 'origin/main', githubRepo: 'acme/project', problem: null });

  // 1. Profile: created in the empty folder and selected as the app's profile.
  const created = await call(setup.create(draft(f, dir)));
  assert.equal(created.profileDir, dir);
  assert.equal(created.next, 'slackApp');
  assert.equal(ctx.prefs.get().profileDir, dir);
  const profile = readProfileFile(dir);
  assert.deepEqual(profile.project, { path: f.project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' });
  assert.equal(profile.bot.id, 'friday');
  assert.equal(statSync(dir).mode & 0o777, 0o700);

  // 2. Slack app: the manifest names the bot and the link carries it.
  const manifest = await call(setup.manifest());
  assert.equal(JSON.parse(manifest.json).display_information.name, 'Friday');
  const url = new URL(manifest.createUrl);
  assert.equal(url.origin, 'https://api.slack.com');
  assert.equal(JSON.parse(url.searchParams.get('manifest_json')!).features.bot_user.display_name, 'friday');

  // 3. Tokens: stored in (fake) Keychain items through the Secrets handlers, then checked with (fake) Slack.
  for (const [name, value] of [['SLACK_BOT_TOKEN', BOT], ['SLACK_APP_TOKEN', APP]] as const) {
    await call(secrets.setSource(name, { kind: 'keychain', service: '', account: '' }, value));
    const checked = await call(secrets.check(name));
    assert.equal(checked.error, null);
    assert.ok(checked.verifiedAt);
  }
  assert.deepEqual(f.keychain(), { 'dev.serra.friday/SLACK_BOT_TOKEN': BOT, 'dev.serra.friday/SLACK_APP_TOKEN': APP });
  assert.equal((await call(setup.progress())).next, 'owner');

  // 4. Owner: confirmed in Slack.
  const owner = await call(setup.confirmOwner(OWNER));
  assert.deepEqual(owner, { slackUserId: OWNER, slackName: 'Alex', changed: false });
  assert.equal((await call(setup.progress())).next, 'service');

  // 5. Service: prepared, checked with diagnose(), then started under the fake launchd.
  const outcome = await call(setup.installService());
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(calls, ['stop', 'start', 'ready']);
  assert.ok(existsSync(join(agents, 'dev.serra.friday.plist')));
  assert.ok(ctx.pushed.some((line) => line === 'PASS Slack account: @friday in Acme; owner found.'));

  const done = await call(setup.progress()) as SetupProgress;
  assert.equal(done.next, null);
  assert.ok(done.steps.every((step) => step.done), JSON.stringify(done.steps));

  // The result: a valid profile whose diagnose() passes every check, Slack mocked.
  const results = await diagnose(loadConfig({ profileDir: dir, env: {} }), { slack });
  assert.deepEqual(results.filter((result) => !result.ok), []);
  assert.ok(results.some((result) => result.name === 'Slack account'));

  // No token value ever went back to the window or into a log line or a profile file other than the Keychain.
  const seen = JSON.stringify(responses) + ctx.pushed.join('\n') + logged.join('\n');
  for (const value of [BOT, APP]) assert.ok(!seen.includes(value));
  for (const file of ['profile.json', 'secrets.json', 'setup.json', '.env']) assert.ok(!readFileSync(join(dir, file), 'utf8').includes(BOT));
});

// ---------------------------------------------------------------------------------------------------------------
// Steps on their own
// ---------------------------------------------------------------------------------------------------------------

test('progress with no profile, and for a profile made with pnpm run setup', (t) => {
  const f = fixture(t);
  const none = setupProgress(null);
  assert.equal(none.next, 'profile');
  assert.equal(none.bot, null);
  assert.ok(none.steps.slice(1).every((step) => !step.done));
  assert.equal(setupProgress(join(f.root, 'missing')).next, 'profile');

  const dir = join(f.root, 'cli');
  createProfile(dir, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
    project: { path: f.project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  const progress = setupProgress(dir);
  assert.equal(progress.next, 'slackApp');
  assert.deepEqual(progress.bot, { id: 'friday', name: 'Friday' });
  assert.deepEqual(progress.owner, { name: 'Alex', slackUserId: OWNER, slackName: null });
  assert.match(progress.steps.find((step) => step.id === 'tokens')!.detail, /bot token and app token not checked yet/);
});

test('create refuses an existing profile and an invalid form, leaving files as they were', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  await createSetupProfile(draft(f, dir));
  const before = readFileSync(join(dir, 'profile.json'), 'utf8');
  await assert.rejects(createSetupProfile({ ...draft(f, dir), botName: 'Other' }), /already exists/);
  assert.equal(readFileSync(join(dir, 'profile.json'), 'utf8'), before);

  const other = join(f.root, 'other');
  await assert.rejects(createSetupProfile({ ...draft(f, other), ownerSlackUserId: 'alex' }), /Invalid owner Slack member ID/);
  await assert.rejects(createSetupProfile({ ...draft(f, other), projectPath: 'relative/path' }), /absolute/);
  assert.equal(existsSync(other), false);

  // Defaults: the bot ID from the name and the folder under the profile root.
  const made = await profileFromDraft({ ...draft(f, ''), botName: '42 Night Owl!' }, { root: '/Users/you/.local/share/serra' });
  assert.equal(made.profile.bot.id, 'night-owl');
  assert.equal(made.directory, '/Users/you/.local/share/serra/night-owl');
});

test('create through IPC remembers the profile, and says so when --profile pins another one', async (t) => {
  const f = fixture(t);
  const pinned = context();
  pinned.profileDirOrNull = () => '/Users/you/pinned';
  const handlers = setupHandlers(pinned, { root: f.root });
  await assert.rejects(async () => handlers.create(draft(f, join(f.root, 'new'))), /started with --profile \/Users\/you\/pinned/);
  assert.ok(existsSync(join(f.root, 'new', 'profile.json')));
  await assert.rejects(async () => handlers.create({ ...draft(f, join(f.root, 'x')), botName: 42 } as unknown as ProfileDraft), /botName must be text/);
});

test('the owner check uses Slack, refuses bots and scrubs the token from errors', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  await createSetupProfile(draft(f, dir));
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);

  await assert.rejects(confirmOwner(dir, 'not-an-id', { lookup }), /Not a Slack member ID/);
  await assert.rejects(confirmOwner(dir, OWNER, { lookup: async (token) => { throw new Error(`bad ${token}`); } }), (error: Error) => {
    assert.ok(!error.message.includes(BOT));
    assert.match(error.message, /\[hidden\]/);
    return true;
  });
  await assert.rejects(confirmOwner(dir, OWNER, { lookup: async () => { throw Object.assign(new Error('An API error occurred'), { data: { error: 'user_not_found' } }); } }),
    /user_not_found\. Copy the member ID/);
  await assert.rejects(confirmOwner(dir, 'U0000000002', { lookup: async () => ({ name: 'Bot', isBot: true, deleted: false }) }), /is a bot/);
  assert.equal(setupProgress(dir).steps.find((step) => step.id === 'owner')!.done, false);

  // A corrected member ID becomes the owner and marks the step done.
  const changed = await confirmOwner(dir, 'U0000000009', { lookup });
  assert.deepEqual(changed, { slackUserId: 'U0000000009', slackName: 'Sam', changed: true });
  assert.equal(readProfileFile(dir).owner.slackUserId, 'U0000000009');
  assert.equal(setupProgress(dir).owner?.slackName, 'Sam');
  assert.equal(statSync(join(dir, 'setup.json')).mode & 0o777, 0o600);
});

test('a failing check refuses the install before launchd is touched', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  await createSetupProfile(draft(f, dir));
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  const { calls, driver } = fakeLaunchd();
  const agents = join(f.root, 'agents');
  const lines: string[] = [];
  const outcome = await installService(dir, {
    node: process.execPath, log: (line) => lines.push(line), prepareRelease: prepareWithoutInstall,
    deploy: { driver, launchAgentsDir: agents },
    diagnose: { slack: async () => { throw new Error('invalid_auth'); } },
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.stage === 'checks' && /Slack account: invalid_auth/.test(outcome.error));
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(agents, 'dev.serra.friday.plist')), false);
  assert.ok(lines.includes('FAIL Slack account: invalid_auth'));
  assert.equal(setupProgress(dir).steps.find((step) => step.id === 'service')!.done, false);
});

test('installing is macOS only, and one install runs at a time', async (t) => {
  const f = fixture(t);
  const ctx = context(join(f.root, 'friday'));
  await createSetupProfile(draft(f, join(f.root, 'friday')));
  const linux = setupHandlers({ ...ctx, runtime: { ...ctx.runtime, platform: 'linux' } });
  await assert.rejects(async () => linux.installService(), /macOS only/);
  let release!: () => void;
  const handlers = setupHandlers(ctx, { findNode: () => new Promise((_, fail) => { release = () => fail(new Error('No supported Node')); }), echo: () => {} });
  const first = handlers.installService();
  await assert.rejects(async () => handlers.installService(), /already being installed/);
  release();
  await assert.rejects(async () => { await first; }, /No supported Node/);
  assert.match(ctx.pushed.at(-1) ?? '', /Install failed: No supported Node/);
});

test('detectProject reads the base branch and GitHub name, and explains what is wrong', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await detectProject(f.project), { baseRef: 'origin/main', githubRepo: 'acme/project', problem: null });
  assert.match((await detectProject(f.root)).problem ?? '', /isn't a Git repository/);
  assert.match((await detectProject(join(f.root, 'nope'))).problem ?? '', /doesn't exist/);
  assert.match((await detectProject('relative')).problem ?? '', /absolute/);
  assert.match((await detectProject(f.project, 'upstream')).problem ?? '', /no remote named upstream/);
});

test('the manifest comes from the profile, so an edited one is what Slack gets', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  await createSetupProfile(draft(f, dir));
  const edited = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  edited.display_information.description = 'Edited';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(edited));
  const manifest = slackManifest(dir);
  assert.equal(JSON.parse(manifest.json).display_information.description, 'Edited');
  assert.equal(JSON.parse(new URL(manifest.createUrl).searchParams.get('manifest_json')!).display_information.description, 'Edited');
});

// ---------------------------------------------------------------------------------------------------------------
// The wizard's logic
// ---------------------------------------------------------------------------------------------------------------

const progressWith = (done: string[], profileDir: string | null = '/Users/you/.local/share/serra/friday'): SetupProgress => {
  const ids = ['profile', 'slackApp', 'tokens', 'owner', 'service'] as const;
  const steps = ids.map((id) => ({ id, done: done.includes(id), detail: '' }));
  return { profileDir, bot: null, owner: null, steps, next: steps.find((step) => !step.done)?.id ?? null };
};

test('welcome logic: step states and which step shows', () => {
  const fresh = progressWith([], null);
  assert.equal(stepState(fresh, 'profile'), 'current');
  assert.equal(stepState(fresh, 'tokens'), 'locked');
  assert.equal(visibleStep(fresh, 'tokens'), 'profile');

  const made = progressWith(['profile']);
  assert.equal(stepState(made, 'profile'), 'done');
  assert.equal(stepState(made, 'slackApp'), 'current');
  assert.equal(stepState(made, 'tokens'), 'open');
  assert.equal(visibleStep(made, null), 'slackApp');
  assert.equal(visibleStep(made, 'tokens'), 'tokens');
  assert.equal(visibleStep(made, 'profile'), 'profile');

  assert.equal(visibleStep(progressWith(['profile', 'slackApp', 'tokens', 'owner', 'service']), null), 'finished');
});

test('welcome logic: form checks, the request and the ID suggestion match the service', () => {
  const empty = draftErrors(emptyDraft());
  for (const field of ['botName', 'ownerName', 'ownerSlackUserId', 'githubLogin', 'projectPath'] as const) assert.ok(empty[field], field);
  const good = { ...emptyDraft(), botName: 'Friday', ownerName: 'Alex', ownerSlackUserId: OWNER, githubLogin: 'alex', projectPath: '/Users/you/project' };
  assert.deepEqual(draftErrors(good), {});
  assert.ok(draftErrors({ ...good, githubRepo: 'not a repo' }).githubRepo);
  assert.ok(draftErrors({ ...good, botId: 'Bad ID' }).botId);
  assert.deepEqual(draftRequest({ ...good, botName: ' Friday ' }), {
    botName: 'Friday', ownerName: 'Alex', ownerSlackUserId: OWNER, githubLogin: 'alex', projectPath: '/Users/you/project', remote: 'origin',
  });
  for (const name of ['Friday', '42 Night Owl!', '', '---', 'Ünïcode Bot', 'a'.repeat(80)]) assert.equal(suggestId(name), suggestBotId(name), name);
});

test('welcome logic: install outcomes read as what to do next', () => {
  assert.equal(outcomeText({ ok: true, release: '/r' }).tone, 'up');
  assert.match(outcomeText({ ok: false, stage: 'checks', error: 'Slack account: invalid_auth', restored: true, rollbackAvailable: false }).text, /Nothing was installed/);
  assert.match(outcomeText({ ok: false, stage: 'cutover', error: 'bad app token', restored: false, rollbackAvailable: true }).text, /roll back/);
});

