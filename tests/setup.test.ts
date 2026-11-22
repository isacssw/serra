import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { secretsHandlers } from '../app/main/ipc/secrets.ts';
import { setupHandlers } from '../app/main/ipc/setup.ts';
import type { MenuItemConstructorOptions } from 'electron';
import { createBridge, type InvokeResult } from '../app/main/bridge.ts';
import { createHandlers, registerHandlers } from '../app/main/ipc/index.ts';
import { menuTemplate } from '../app/main/menu.ts';
import { defaultPrefs, memoryPrefs, mergePrefs, readPrefs } from '../app/main/prefs.ts';
import { routes } from '../app/renderer/routes.ts';
import { isSetupIncomplete, SETUP_INCOMPLETE, SETUP_INCOMPLETE_MESSAGE, SetupIncomplete } from '../src/setup-incomplete.ts';
import { isTokenVerdict } from '../src/token-errors.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import {
  announcement, DONE_PATH, draftErrors, lockedReason, draftRequest, draftToSave, emptyDraft, foundLine, nextPath, outcomeText, pickable, previousPath,
  plainError, restoreDraft, resumePath, ringDash, shortPath, tokenRefused, tokenText, setupRowLabel, slackLine, startView, stepOpen, suggestId, summaryRows, tokensToPrecheck, toToken,
} from '../app/renderer/setup/setup.logic.ts';
import type { SecretStatus } from '../src/contracts.ts';
import { loadConfig, readProfileFile } from '../src/config.ts';
import type { ServiceDriver } from '../src/deploy.ts';
import { diagnose, type SlackAccountCheck } from '../src/doctor.ts';
import { prepareNextRelease } from '../src/releases.ts';
import { checkSecret, type SlackVerify } from '../src/secrets.ts';
import {
  certainPresence, confirmOwner, createProfile, createSetupProfile, detectProject, installService, profileFromDraft, setupProgress,
  slackManifest, suggestBotId, summarizeProfile, type MemberLookup, type ProfileDraft, type ProfileSummary, type SetupProgress,
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
    gitName: async () => 'Alex',
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
  assert.deepEqual(await call(setup.defaults()), { githubLogin: 'alex', ownerName: 'Alex', profileRoot: join(f.root, 'profiles') });
  const detected = await call(setup.detectProject(f.project, 'origin'));
  assert.deepEqual(detected, { baseRef: 'origin/main', githubRepo: 'acme/project', problem: null });

  // 1. Profile: created in the empty folder and selected as the app's profile.
  const created = await call(setup.create(draft(f, dir)));
  assert.equal(created.profileDir, dir);
  assert.equal(created.next, 'slack');
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

  // Installed isn't done: the last step waits until the bot answers on its status socket.
  const stopped = await call(setup.progress()) as SetupProgress;
  assert.equal(stopped.next, 'service');
  assert.equal(stopped.installed, true);
  assert.equal(stopped.steps.find((step) => step.id === 'service')!.detail, 'Installed, hasn’t answered yet');
  const up = { state: 'up', pid: 1, startedAt: '2026-11-22T00:00:00Z', slackConnected: true, counts: { needsYou: 0, running: 0 } } as const;
  ctx.status = { current: () => up, subscribe: () => () => {} };
  const done = await call(setup.progress()) as SetupProgress;
  assert.equal(done.next, null);
  // The first answer is kept: stopped later, the bot no longer reopens setup.
  ctx.status = stoppedStatusSource();
  assert.equal((await call(setup.progress())).next, null);
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
  const agents = join(f.root, 'agents');
  const progress = setupProgress(dir, { launchAgentsDir: agents });
  assert.equal(progress.next, 'slack');
  assert.deepEqual(progress.bot, { id: 'friday', name: 'Friday' });
  assert.deepEqual(progress.owner, { name: 'Alex', slackUserId: OWNER, slackName: null });
  assert.match(progress.steps.find((step) => step.id === 'slack')!.detail, /Bot token and app token not checked yet/);
  // A service installed by the CLI has a plist but no active.json: it counts as installed.
  assert.equal(progress.steps.find((step) => step.id === 'service')!.done, false);
  mkdirSync(agents);
  writeFileSync(join(agents, 'dev.serra.friday.plist'), '<plist/>');
  assert.equal(setupProgress(dir, { launchAgentsDir: agents }).steps.find((step) => step.id === 'service')!.done, true);
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
  assert.equal(setupProgress(dir, { launchAgentsDir: agents }).steps.find((step) => step.id === 'service')!.done, false);
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
  const ids = ['profile', 'slack', 'owner', 'service'] as const;
  const steps = ids.map((id) => ({ id, done: done.includes(id), detail: '' }));
  return { profileDir, bot: { id: 'friday', name: 'Friday' }, owner: null, steps, next: steps.find((step) => !step.done)?.id ?? null, installed: done.includes('service') };
};

const summaryWith = (done: string[], extra: Partial<ProfileSummary> = {}): ProfileSummary => ({
  ...progressWith(done), profileDir: '/Users/you/.local/share/serra/friday', problem: null, repo: 'acme/project', workspace: null,
  tokens: [], service: 'none', ...extra,
});

test('setup logic: where to resume, and which step comes next', () => {
  const fresh = progressWith([], null);
  assert.equal(resumePath(null), '/setup');
  assert.equal(resumePath(fresh), '/setup/you');
  assert.equal(stepOpen(fresh, 'profile'), true);
  assert.equal(stepOpen(fresh, 'slack'), false);

  const made = progressWith(['profile']);
  assert.equal(resumePath(made), '/setup/slack');
  // Steps open in order: the owner check needs Slack's token, the install's checks need both.
  assert.equal(stepOpen(made, 'slack'), true);
  assert.equal(stepOpen(made, 'owner'), false);
  assert.equal(stepOpen(made, 'service'), false);
  assert.equal(lockedReason(made, 'service'), 'available after Confirm you');
  assert.equal(lockedReason(made, 'owner'), 'available after Slack');
  // A step done out of order (an install from the CLI) stays open.
  assert.equal(stepOpen(progressWith(['profile', 'service']), 'service'), true);
  assert.equal(stepOpen(progressWith(['profile', 'slack', 'owner']), 'service'), true);
  assert.equal(nextPath(made, '/setup/you'), '/setup/slack');
  // A later step already done is skipped; the end comes once nothing is left.
  assert.equal(nextPath(progressWith(['profile', 'slack', 'owner']), '/setup/slack'), '/setup/service');
  assert.equal(nextPath(progressWith(['profile', 'slack', 'service']), '/setup/you'), '/setup/owner');
  assert.equal(nextPath(progressWith(['profile', 'slack', 'owner', 'service']), '/setup/service'), DONE_PATH);
  assert.equal(previousPath('/setup/you'), '/setup');
  assert.equal(previousPath('/setup/owner'), '/setup/slack');
  assert.equal(announcement('/setup/slack'), 'Step 2 of 4: Connect Slack');
  assert.equal(announcement('/setup'), 'Serra setup');
});

test('setup logic: the first screen welcomes, summarises what was found, or asks which bot', () => {
  const base = { pinned: false, profileRoot: '/Users/you/.local/share/serra', home: '/Users/you' };
  assert.equal(startView({ ...base, selected: null, others: [] }), 'fresh');
  assert.equal(startView({ ...base, selected: summaryWith([]), others: [] }), 'fresh');
  assert.equal(startView({ ...base, selected: summaryWith(['profile']), others: [] }), 'summary');
  const two = { ...base, selected: null, others: [summaryWith(['profile']), summaryWith(['profile', 'slack'], { profileDir: '/p/jarvis' })] };
  assert.equal(startView(two), 'picker');
  assert.equal(pickable(two).length, 2);

  const legacy = summaryWith(['profile', 'service'], {
    tokens: [
      { name: 'SLACK_BOT_TOKEN', state: 'found', where: '.env', error: null },
      { name: 'SLACK_APP_TOKEN', state: 'found', where: '.env', error: null },
    ],
    service: 'installed',
  });
  // An installed service whose first answer is on record (or, for another profile, that is installed) is done.
  assert.equal(foundLine(legacy), '2 of 4 steps already done.');
  assert.equal(summaryRows(summaryWith(['profile'], { service: 'installed' }))[3]!.value, 'Installed, hasn’t answered yet');
  assert.equal(summaryRows(summaryWith(['profile'], { service: 'disconnected' }))[3]!.value, 'Running, not connected to Slack');
  assert.equal(foundLine(summaryWith(['profile', 'slack', 'owner', 'service'], { service: 'disconnected' })), 'Set up, but not connected to Slack.');
  assert.equal(isTokenVerdict("1Password (op) failed: \"Serra\" isn't an item in the \"Private\" vault"), true);
  assert.equal(shortPath('/Users/you/.local/share/serra/friday', '/Users/you'), '~/.local/share/serra/friday');
  assert.equal(shortPath('/Volumes/x/friday', '/Users/you'), '/Volumes/x/friday');
  assert.deepEqual(summaryRows(legacy).map((row) => [row.label, row.value, row.done]), [
    ['Profile', 'Friday · acme/project', true],
    ['Slack', '2 tokens found in .env', false],
    ['You', 'Not set', false],
    ['Service', 'Installed', true],
  ]);
  assert.equal(slackLine([{ name: 'SLACK_BOT_TOKEN', state: 'verified', where: 'Keychain', error: null }, { name: 'SLACK_APP_TOKEN', state: 'verified', where: 'Keychain', error: null }], 'acme.slack.com'), 'Connected to acme.slack.com');
  assert.equal(slackLine([{ name: 'SLACK_BOT_TOKEN', state: 'found', where: 'Keychain', error: null }, { name: 'SLACK_APP_TOKEN', state: 'missing', where: '.env', error: null }], null), 'No app token yet');
  assert.equal(foundLine(summaryWith(['profile', 'slack', 'owner', 'service'], { service: 'running' })), 'Everything is set up.');
});

test('setup logic: found tokens are checked on their own, except 1Password ones, which would prompt', () => {
  const status = (name: SecretStatus['name'], source: SecretStatus['source'], extra: Partial<SecretStatus> = {}): SecretStatus =>
    ({ name, source, set: true, verifiedAt: null, error: null, ...extra });
  const statuses = [
    status('SLACK_BOT_TOKEN', { kind: 'env' }),
    status('SLACK_APP_TOKEN', { kind: '1password', reference: 'op://v/i/f' }),
  ];
  assert.deepEqual(tokensToPrecheck(statuses), ['SLACK_BOT_TOKEN']);
  assert.deepEqual(tokensToPrecheck([status('SLACK_BOT_TOKEN', { kind: 'keychain', service: 's', account: 'a' })]), ['SLACK_BOT_TOKEN']);
  assert.deepEqual(tokensToPrecheck([status('SLACK_BOT_TOKEN', { kind: 'env' }, { verifiedAt: '2026-11-22T00:00:00Z' })]), []);
  assert.equal(toToken(status('SLACK_BOT_TOKEN', { kind: 'env' }, { set: false })).state, 'missing');
  assert.equal(toToken(status('SLACK_BOT_TOKEN', { kind: 'env' }, { error: 'invalid_auth' })).state, 'rejected');
  // Only Slack refusing the token asks for a new one; a check that couldn't run asks for a retry and says why.
  assert.equal(tokenRefused('Slack rejected SLACK_BOT_TOKEN: invalid_auth'), true);
  assert.equal(tokenRefused('getaddrinfo ENOTFOUND slack.com'), false);
  assert.equal(tokenText(toToken(status('SLACK_BOT_TOKEN', { kind: 'env' }, { error: 'token_revoked' })), null), 'Slack didn’t accept this token. Paste a new one.');
  assert.equal(tokenText(toToken(status('SLACK_BOT_TOKEN', { kind: '1password', reference: 'op://v/i/f' }, { error: '1Password is locked' })), null), 'Couldn’t check it: 1Password is locked');
  // Wrong kind of token, or a missing scope: a retry never helps, so these ask for a new token in plain words.
  const wrongKind = toToken(status('SLACK_APP_TOKEN', { kind: 'keychain', service: 's', account: 'a' }, { error: "SLACK_APP_TOKEN from Keychain item s/a isn't a real xapp- token" }));
  assert.equal(tokenRefused(wrongKind.error), true);
  assert.equal(tokenText(wrongKind, null), 'This isn’t an xapp- token. Paste the app token.');
  const scope = toToken(status('SLACK_APP_TOKEN', { kind: 'env' }, { error: 'Slack rejected SLACK_APP_TOKEN: missing_scope' }));
  assert.equal(tokenText(scope, null), 'It’s missing the connections:write scope. Generate a new app token with it.');
  // Offline: the check never reached Slack, said plainly, with no variable name or path.
  const offline = toToken(status('SLACK_BOT_TOKEN', { kind: 'env' }, { error: "Couldn't reach Slack: A request error occurred: getaddrinfo ENOTFOUND slack.com" }));
  assert.equal(tokenRefused(offline.error), false);
  assert.equal(tokenText(offline, null), 'Couldn’t check it: Slack is unreachable (getaddrinfo ENOTFOUND slack.com)');
  assert.equal(tokenText(toToken(status('SLACK_APP_TOKEN', { kind: 'env' }, { error: 'Slack rejected SLACK_APP_TOKEN: ratelimited' })), null), 'Couldn’t check it: Slack is busy. Try again in a minute');
  assert.equal(plainError("SLACK_APP_TOKEN from /Users/you/.local/share/serra/friday/.env is empty"), '.env is empty');
  // Something unknown counts as the token's problem: the owner can always paste a new one.
  assert.equal(tokenRefused('Slack rejected SLACK_BOT_TOKEN: something_new'), true);
});

test('setup logic: the sidebar row and the saved draft', () => {
  assert.deepEqual(setupRowLabel(progressWith(['profile'])), { text: 'Finish setup', detail: '3 left', aria: 'Finish setup: 1 of 4 steps done' });
  assert.equal(setupRowLabel(progressWith([], null)).text, 'Set up Serra');
  const ring = ringDash(1, 4, 6);
  assert.equal(ring.dash.split(' ')[0], (ring.length / 4).toFixed(2));
  assert.equal(ringDash(0, 4, 6).dash.split(' ')[0], '0.00');

  assert.equal(draftToSave(emptyDraft()), null);
  const saved = draftToSave({ ...emptyDraft(), botName: 'Friday', remote: 'upstream' });
  assert.deepEqual(saved, { botName: 'Friday', remote: 'upstream' });
  assert.deepEqual(restoreDraft({ ...saved, unknown: 'x' } as Record<string, string>), { ...emptyDraft(), botName: 'Friday', remote: 'upstream' });
  assert.deepEqual(restoreDraft(null), emptyDraft());
});

test('setup logic: form checks, the request and the ID suggestion match the service', () => {
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

test('setup logic: install outcomes read as what to do next', () => {
  assert.equal(outcomeText({ ok: true, release: '/r' }).tone, 'up');
  assert.match(outcomeText({ ok: false, stage: 'checks', error: 'Slack account: invalid_auth', restored: true, rollbackAvailable: false }).text, /Nothing was installed/);
  assert.match(outcomeText({ ok: false, stage: 'cutover', error: 'bad app token', restored: false, rollbackAvailable: true }).text, /roll back/);
});


// ---------------------------------------------------------------------------------------------------------------
// Detection (SERRA-51): an existing setup resumes instead of starting over
// ---------------------------------------------------------------------------------------------------------------

const cliProfile = (f: { project: string }, dir: string, id = 'friday'): void => createProfile(dir, {
  version: 1, bot: { id, name: id[0]!.toUpperCase() + id.slice(1) }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
  project: { path: f.project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
});

test('a CLI profile with tokens in .env is summarised as found, not missing, and nothing is read from 1Password', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  cliProfile(f, dir);
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  const agents = join(f.root, 'agents');
  mkdirSync(agents);
  writeFileSync(join(agents, 'dev.serra.friday.plist'), '<plist/>');

  const summary = await summarizeProfile(dir, { launchAgentsDir: agents });
  assert.equal(summary.next, 'slack');
  assert.equal(summary.repo, 'acme/project');
  assert.deepEqual(summary.tokens.map((token) => [token.name, token.state, token.where]), [
    ['SLACK_BOT_TOKEN', 'found', '.env'], ['SLACK_APP_TOKEN', 'found', '.env'],
  ]);
  assert.equal(summary.service, 'installed');
  assert.equal((await summarizeProfile(dir, { launchAgentsDir: agents, running: true })).service, 'running');
  assert.ok(!JSON.stringify(summary).includes(BOT), 'no token value in the summary');

  // A 1Password reference counts as found without running `op` (which would ask to unlock).
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, sources: { SLACK_APP_TOKEN: { kind: '1password', reference: 'op://Vault/Serra/app' } }, checks: {} }));
  const withOp = await summarizeProfile(dir, { launchAgentsDir: agents, secrets: { tools: { op: join(f.root, 'no-op') } } });
  assert.deepEqual(withOp.tokens.find((token) => token.name === 'SLACK_APP_TOKEN'), { name: 'SLACK_APP_TOKEN', state: 'found', where: '1Password', error: null });

  // An unreadable profile is reported, not thrown.
  const broken = join(f.root, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, 'profile.json'), '{');
  const bad = await summarizeProfile(broken, { launchAgentsDir: agents });
  assert.equal(bad.next, 'profile');
  assert.match(bad.problem ?? '', /profile\.json can't be read/);
});

test('detect lists every profile found, and useProfile switches to one, unless --profile pins another', async (t) => {
  const f = fixture(t);
  const root = join(f.root, 'profiles');
  cliProfile(f, join(root, 'friday'));
  cliProfile(f, join(root, 'jarvis'), 'jarvis');
  const ctx = context();
  const deps = { root, launchAgentsDir: join(f.root, 'agents') };
  const setup = setupHandlers(ctx, deps);

  const none = await setup.detect();
  assert.equal(none.selected, null);
  assert.deepEqual(none.others.map((profile) => profile.bot?.id), ['friday', 'jarvis']);
  assert.equal(none.pinned, false);

  const picked = await setup.useProfile(join(root, 'jarvis'));
  assert.equal(ctx.prefs.get().profileDir, join(root, 'jarvis'));
  assert.equal(picked.selected?.bot?.id, 'jarvis');
  assert.deepEqual(picked.others.map((profile) => profile.bot?.id), ['friday']);

  await assert.rejects(async () => setup.useProfile(f.root), /has no profile\.json/);
  await assert.rejects(async () => setup.useProfile('relative'), /Choose a profile folder/);
  assert.equal(ctx.prefs.get().profileDir, join(root, 'jarvis'));

  const pinnedCtx = { ...context(join(root, 'friday')), profilePinned: true };
  const pinned = setupHandlers(pinnedCtx, deps);
  assert.equal((await pinned.detect()).pinned, true);
  await assert.rejects(async () => pinned.useProfile(join(root, 'jarvis')), /command line/);

  // The folder dialog is main's; without one (tests, smoke) nothing is chosen.
  assert.equal(await setup.chooseFolder('repository'), null);
  const asked: string[] = [];
  const withDialog = setupHandlers({ ...ctx, chooseFolder: async ({ title }) => { asked.push(title); return '/Users/you/project'; } }, deps);
  assert.equal(await withDialog.chooseFolder('repository'), '/Users/you/project');
  assert.deepEqual(asked, ['Choose the repository']);
  await assert.rejects(async () => withDialog.chooseFolder('elsewhere' as 'profile'), /Unknown folder purpose/);
});

test('creating the profile clears the saved draft; prefs keep only known draft fields', async (t) => {
  const f = fixture(t);
  const ctx = context();
  ctx.prefs.set(mergePrefs(ctx.prefs.get(), { setupDraft: { botName: 'Friday', projectPath: f.project } }));
  assert.deepEqual(ctx.prefs.get().setupDraft, { botName: 'Friday', projectPath: f.project });
  assert.throws(() => mergePrefs(ctx.prefs.get(), { setupDraft: { token: 'xoxb-1' } }), /not a setup field/);
  assert.throws(() => mergePrefs(ctx.prefs.get(), { setupDraft: { botName: 'x'.repeat(501) } }), /not a setup field/);
  assert.throws(() => mergePrefs(ctx.prefs.get(), { setupDraft: 'Friday' }), /object or null/);
  assert.deepEqual(readPrefs({ setupDraft: { botName: 42 } }).setupDraft, null);

  await setupHandlers(ctx, { root: f.root }).create(draft(f, join(f.root, 'friday')));
  assert.equal(ctx.prefs.get().setupDraft, null);
});

test('a call with no profile fails as SetupIncomplete across IPC, so the window shows setup, not the message', async () => {
  const registered = new Map<string, (event: { senderFrame: { url: string } | null }, ...args: unknown[]) => Promise<InvokeResult>>();
  const ctx = context();
  ctx.profileDir = () => { throw new SetupIncomplete(); };
  registerHandlers({ handle: (channel, listener) => { registered.set(channel, listener); } }, createHandlers(ctx), () => true);
  const bridge = createBridge(async (channel, args) => registered.get(channel)!({ senderFrame: { url: 'app://' } }, ...args), () => () => {});
  const result = await registered.get('serra:settings.read')!({ senderFrame: { url: 'app://' } });
  assert.deepEqual(result, { ok: false, error: SETUP_INCOMPLETE_MESSAGE, code: SETUP_INCOMPLETE });
  await assert.rejects(bridge.settings.read(), (error: Error) => isSetupIncomplete(error) && error.name === 'SetupIncomplete');
  // Other failures keep their own message and carry no code.
  const other = await registered.get('serra:setup.useProfile')!({ senderFrame: { url: 'app://' } }, 'relative');
  assert.deepEqual(other, { ok: false, error: 'Choose a profile folder.' });
  assert.equal(isSetupIncomplete(new Error('Choose a profile folder.')), false);
});

test('Set Up Serra… is in the app menu on macOS, and in File elsewhere', () => {
  let opened = 0;
  const mac = menuTemplate(() => { opened += 1; }, 'darwin');
  const item = (mac[0]!.submenu as MenuItemConstructorOptions[]).find((entry) => entry.label === 'Set Up Serra…');
  assert.ok(item);
  (item.click as () => void)();
  assert.equal(opened, 1);
  assert.deepEqual(mac.slice(1).map((menu) => menu.role), ['editMenu', 'viewMenu', 'windowMenu']);
  const other = menuTemplate(() => {}, 'linux');
  assert.equal(other[0]!.label, 'File');
  assert.ok((other[0]!.submenu as MenuItemConstructorOptions[]).some((entry) => entry.label === 'Set Up Serra…'));
});

test('every screen that reads the profile is gated; Updates and Appearance work without one', () => {
  const open = routes.filter((route) => !('needs' in route)).map((route) => route.id);
  assert.deepEqual(open, ['updates', 'settings-appearance']);
  for (const route of routes) if ('needs' in route) assert.equal(route.needs, 'profile', route.id);
});

test('a passing check counts only while the token is still there, and a stopped bot leaves setup open', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  cliProfile(f, dir);
  const agents = join(f.root, 'agents');
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  const at = '2026-11-22T00:00:00.000Z';
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, sources: {}, checks: { SLACK_BOT_TOKEN: { verifiedAt: at, error: null }, SLACK_APP_TOKEN: { verifiedAt: at, error: null } } }));
  assert.equal(setupProgress(dir, { launchAgentsDir: agents }).steps.find((step) => step.id === 'slack')!.done, true);

  // The values were removed from .env after the checks passed: Slack isn't connected any more.
  writeFileSync(join(dir, '.env'), '');
  const progress = setupProgress(dir, { launchAgentsDir: agents });
  assert.equal(progress.next, 'slack');
  const summary = await summarizeProfile(dir, { launchAgentsDir: agents });
  assert.deepEqual(summary.tokens.map((token) => token.state), ['missing', 'missing']);

  // Installed but not answering: the last step stays open in the app; the CLI (no running given) counts it done.
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ version: 1, owner: { slackUserId: OWNER, slackName: 'Alex', checkedAt: at } }));
  writeFileSync(join(dir, 'active.json'), '{}');
  assert.equal(setupProgress(dir, { launchAgentsDir: agents }).next, null);
  assert.equal(setupProgress(dir, { launchAgentsDir: agents, running: false }).next, 'service');
  assert.equal(setupProgress(dir, { launchAgentsDir: agents, running: true }).next, null);

  // Right after launch the app may not have heard from the daemon yet: with a socket there, progress waits for it.
  writeFileSync(join(dir, 'status.sock'), '');
  const ctx = context(dir);
  let listener: ((status: { state: string }) => void) | null = null;
  const up = { state: 'up', pid: 1, startedAt: at, slackConnected: true, counts: { needsYou: 0, running: 0 } } as const;
  let current: { state: 'stopped' } | typeof up = { state: 'stopped' };
  ctx.status = { current: () => current, subscribe: (l) => { listener = l.status as never; return () => { listener = null; }; } };
  const handlers = setupHandlers(ctx, { launchAgentsDir: agents, answerWaitMs: 2_000 });
  const pending = handlers.progress();
  setTimeout(() => { current = up; listener?.(up); }, 20);
  assert.equal((await pending).next, null);
  current = up;
  // Once it has answered, that is recorded: a bot stopped later is a status to fix, not setup to redo.
  assert.match(readFileSync(join(dir, 'setup.json'), 'utf8'), /serviceAnsweredAt/);
  current = { state: 'stopped' };
  assert.equal((await setupHandlers(ctx, { launchAgentsDir: agents, answerWaitMs: 10 }).progress()).next, null);
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ version: 1, owner: { slackUserId: OWNER, slackName: 'Alex', checkedAt: at } }));
  // Answering but not connected to Slack isn't running yet.
  current = { ...up, slackConnected: false } as never;
  assert.equal((await setupHandlers(ctx, { launchAgentsDir: agents, answerWaitMs: 10 }).progress()).next, 'service');
  // With no answer in time, the bot counts as stopped.
  current = { state: 'stopped' };
  assert.equal((await setupHandlers(ctx, { launchAgentsDir: agents, answerWaitMs: 10 }).progress()).next, 'service');
});

test('a deleted Keychain item isn\'t connected, even with a passing check on record', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  cliProfile(f, dir);
  const at = '2026-11-22T00:00:00.000Z';
  const keychain = (name: string) => ({ kind: 'keychain', service: 'dev.serra.friday', account: name });
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({
    version: 1, sources: { SLACK_BOT_TOKEN: keychain('SLACK_BOT_TOKEN'), SLACK_APP_TOKEN: keychain('SLACK_APP_TOKEN') },
    checks: { SLACK_BOT_TOKEN: { verifiedAt: at, error: null }, SLACK_APP_TOKEN: { verifiedAt: at, error: null } },
  }));
  writeFileSync(join(f.root, 'keychain.json'), JSON.stringify({ 'dev.serra.friday/SLACK_BOT_TOKEN': BOT, 'dev.serra.friday/SLACK_APP_TOKEN': APP }));
  const handlers = setupHandlers(context(dir), { launchAgentsDir: join(f.root, 'agents'), answerWaitMs: 0, presenceCacheMs: 0 });
  assert.equal((await handlers.progress()).steps.find((step) => step.id === 'slack')!.done, true);
  // The app token's item was deleted from the Keychain.
  writeFileSync(join(f.root, 'keychain.json'), JSON.stringify({ 'dev.serra.friday/SLACK_BOT_TOKEN': BOT }));
  const progress = await handlers.progress();
  assert.equal(progress.next, 'slack');
  const summary = await summarizeProfile(dir, { launchAgentsDir: join(f.root, 'agents') });
  assert.equal(summary.steps.find((step) => step.id === 'slack')!.done, false);
  assert.equal(summary.tokens.find((token) => token.name === 'SLACK_APP_TOKEN')!.state, 'missing');
});

test('an uncertain Keychain answer isn\'t a deleted token, and a bot that reached Slack before counts as answered', async (t) => {
  const f = fixture(t);
  const statuses: SecretStatus[] = [
    { name: 'SLACK_BOT_TOKEN', source: { kind: 'keychain', service: 's', account: 'a' }, set: false, verifiedAt: null, error: 'security timed out', lookupFailed: true },
    { name: 'SLACK_APP_TOKEN', source: { kind: 'keychain', service: 's', account: 'b' }, set: false, verifiedAt: null, error: null },
  ];
  assert.deepEqual(certainPresence(statuses), { SLACK_APP_TOKEN: false });

  const dir = join(f.root, 'friday');
  cliProfile(f, dir);
  writeFileSync(join(dir, 'active.json'), '{}');
  const agents = join(f.root, 'agents');
  assert.equal(setupProgress(dir, { launchAgentsDir: agents, running: false }).steps.find((step) => step.id === 'service')!.done, false);
  // Set up before the first answer was recorded: the daemon's ready.json says it reached Slack.
  writeFileSync(join(dir, 'ready.json'), '{}');
  assert.equal(setupProgress(dir, { launchAgentsDir: agents, running: false }).steps.find((step) => step.id === 'service')!.done, true);
});

test('a check that never reached Slack says so, instead of "Slack rejected"', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  cliProfile(f, dir);
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  const offline = await checkSecret(dir, 'SLACK_BOT_TOKEN', { verify: async () => { throw new Error('A request error occurred: getaddrinfo ENOTFOUND slack.com'); } });
  assert.equal(offline.error, "Couldn't reach Slack: A request error occurred: getaddrinfo ENOTFOUND slack.com");
  const refused = await checkSecret(dir, 'SLACK_BOT_TOKEN', { verify: async () => { throw Object.assign(new Error('An API error occurred'), { data: { error: 'invalid_auth' } }); } });
  assert.equal(refused.error, 'Slack rejected SLACK_BOT_TOKEN: invalid_auth');
});

test('a check that only failed to run keeps an earlier pass; a verdict against the token undoes it', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  cliProfile(f, dir);
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  const agents = join(f.root, 'agents');
  const at = '2026-11-22T00:00:00.000Z';
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ version: 1, owner: { slackUserId: OWNER, slackName: 'Alex', checkedAt: at }, serviceAnsweredAt: at }));
  writeFileSync(join(dir, 'active.json'), '{}');
  for (const name of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const) await checkSecret(dir, name, { verify: async () => ({}) });
  assert.equal(setupProgress(dir, { launchAgentsDir: agents, running: false }).next, null);

  // Offline, Slack down, rate-limited, a locked Keychain: the pass stands, so setup doesn't reopen.
  for (const failure of [
    () => { throw new Error('A request error occurred: getaddrinfo ENOTFOUND slack.com'); },
    () => { throw Object.assign(new Error('An API error occurred'), { data: { error: 'service_unavailable' } }); },
    () => { throw Object.assign(new Error('An API error occurred'), { data: { error: 'ratelimited' } }); },
  ]) {
    const status = await checkSecret(dir, 'SLACK_BOT_TOKEN', { verify: async () => failure() });
    assert.ok(status.error);
    assert.equal(setupProgress(dir, { launchAgentsDir: agents, running: false }).next, null, status.error!);
    assert.equal(toToken(status).state, 'verified');
  }
  assert.equal(isTokenVerdict('Keychain (security) failed: security: SecKeychainSearchCopyNext: User interaction is not allowed.'), false);
  assert.equal(plainError('Keychain (security) failed: security: SecKeychainSearchCopyNext: User interaction is not allowed.'), 'your Keychain is locked. Unlock it, then Check again');
  assert.equal(plainError("Couldn't reach Slack: A rate limit was exceeded (url: auth.test, retry-after: 30)"), 'Slack is busy. Try again in a minute');

  // Slack refusing the token is a verdict: Slack isn't connected any more.
  await checkSecret(dir, 'SLACK_BOT_TOKEN', { verify: async () => { throw Object.assign(new Error('An API error occurred'), { data: { error: 'invalid_auth' } }); } });
  assert.equal(setupProgress(dir, { launchAgentsDir: agents, running: false }).next, 'slack');
});

test('a Keychain item gone for sure is missing even after an offline recheck; ready.json is recorded before a restart clears it', async (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'friday');
  cliProfile(f, dir);
  const agents = join(f.root, 'agents');
  const at = '2026-11-22T00:00:00.000Z';
  const keychain = (name: string) => ({ kind: 'keychain', service: 'dev.serra.friday', account: name });
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({
    version: 1, sources: { SLACK_BOT_TOKEN: keychain('SLACK_BOT_TOKEN'), SLACK_APP_TOKEN: keychain('SLACK_APP_TOKEN') },
    // A pass, then a recheck that couldn't reach Slack: the pass stands while the item is there.
    checks: { SLACK_BOT_TOKEN: { verifiedAt: at, error: "Couldn't reach Slack: getaddrinfo ENOTFOUND slack.com" }, SLACK_APP_TOKEN: { verifiedAt: at, error: null } },
  }));
  writeFileSync(join(f.root, 'keychain.json'), JSON.stringify({ 'dev.serra.friday/SLACK_BOT_TOKEN': BOT, 'dev.serra.friday/SLACK_APP_TOKEN': APP }));
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ version: 1, owner: { slackUserId: OWNER, slackName: 'Alex', checkedAt: at } }));
  writeFileSync(join(dir, 'active.json'), '{}');
  writeFileSync(join(dir, 'ready.json'), '{}');
  const handlers = setupHandlers(context(dir), { launchAgentsDir: agents, answerWaitMs: 0, presenceCacheMs: 0 });
  assert.equal((await handlers.progress()).next, null);

  // ready.json alone made the service step done; it is recorded, so a restart that clears it doesn't reopen setup.
  assert.match(readFileSync(join(dir, 'setup.json'), 'utf8'), /serviceAnsweredAt/);
  rmSync(join(dir, 'ready.json'));
  assert.equal((await handlers.progress()).next, null);

  // The bot token's item is deleted: gone for sure, so Slack reopens and the row asks for a new token.
  writeFileSync(join(f.root, 'keychain.json'), JSON.stringify({ 'dev.serra.friday/SLACK_APP_TOKEN': APP }));
  assert.equal((await handlers.progress()).next, 'slack');
  const summary = await summarizeProfile(dir, { launchAgentsDir: agents });
  assert.equal(summary.tokens.find((token) => token.name === 'SLACK_BOT_TOKEN')!.state, 'missing');
});
