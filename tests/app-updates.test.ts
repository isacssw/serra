import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SerraPushes } from '../app/main/bridge.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { updatesHandlers } from '../app/main/ipc/updates.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import {
  actionStates, activateDialog, activationNotice, keepVersions, appCard, botLine, canCheck, commitsHeading, homeOf, noteLines, preparedLabel, progressPercent,
  releaseLabel, rollbackDialog, rollbackNotice, sourceLabel, syncDialog, tildePath,
} from '../app/renderer/screens/updates.logic.ts';
import type { AppUpdateView } from '../app/main/app-updater.ts';
import { botSyncDecision, type BotSyncInput } from '../app/main/bot-sync.ts';
import { updatesService } from '../app/main/ipc/updates.ts';
import { type ServiceDriver } from '../src/deploy.ts';
import { createProfile } from '../src/setup.ts';
import { acknowledgePause, pauseIntake, readPause } from '../src/intake.ts';

// ---------------------------------------------------------------------------------------------------------------
// Developer-mode logic
// ---------------------------------------------------------------------------------------------------------------

const prepared = { release: '/Users/you/bot/releases/2026-11-19T10-00-00-000Z-42', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' };

test('the restart dialog names the build and the running jobs: none, one and several', () => {
  assert.deepEqual(activateDialog(prepared, 0), { title: 'Restart the bot on a1b2c3d?', body: 'No jobs are running. The bot restarts on this build.' });
  assert.match(activateDialog(prepared, 1).body, /^1 job is running\..*the job continues after the restart\.$/);
  assert.match(activateDialog(prepared, 3).body, /^3 jobs are running\..*the jobs continue after the restart\.$/);
});

test('the undo dialog counts running jobs the same way', () => {
  assert.equal(rollbackDialog(0).title, 'Undo the last switch?');
  assert.match(rollbackDialog(0).body, /^No jobs are running\. The bot restarts on the build it ran before/);
  assert.match(rollbackDialog(1).body, /^1 job is running\..*; the job continues after the restart\.$/);
  assert.match(rollbackDialog(2).body, /^2 jobs are running\..*; the jobs continue after the restart\.$/);
});

test('release labels use the commit, then the version, and fall back to the folder name', () => {
  assert.equal(releaseLabel(prepared), 'a1b2c3d');
  assert.equal(releaseLabel({ ...prepared, dirty: true }), 'a1b2c3d + changes');
  assert.equal(releaseLabel({ release: prepared.release, appVersion: '0.1.0-alpha.2' }), '0.1.0-alpha.2', 'a packaged build has a version, not a timestamp');
  assert.equal(releaseLabel({ release: '/Users/you/bot/releases/2026-11-19T10-00-00-000Z-42' }), '2026-11-19T10-00-00-000Z-42');
  assert.equal(releaseLabel(null), 'None');
  assert.equal(preparedLabel({}), '');
  assert.equal(preparedLabel({ preparedAt: 'not a date' }), '');
  assert.match(preparedLabel({ preparedAt: '2026-11-19T12:00:00.000Z' }), /^built Nov (19|20), \d\d:\d\d$/);
});

test('the source line names the repository and branch, with the home folder shortened', () => {
  assert.equal(sourceLabel({ ref: 'origin/main', source: '/Users/you/git/serra', upstream: 'git@github.com:acme/serra.git' }, '/Users/you'), 'acme/serra main, in ~/git/serra');
  assert.equal(sourceLabel({ ref: 'upstream/release', source: '/code', upstream: 'https://github.com/acme/serra' }), 'acme/serra release, in /code');
  assert.equal(sourceLabel({ ref: null, source: '/Users/you/serra', upstream: null }, homeOf('/Users/you/serra')), '~/serra');
  assert.equal(tildePath('/Users/younger/x', '/Users/you'), '/Users/younger/x', 'only the folder itself, not a prefix of a name');
});

test('the commits heading counts commits on main, says when up to date, and when it cannot tell', () => {
  const commit = { sha: 'abc', subject: 'Keep job state on restart' };
  assert.equal(commitsHeading({ ref: 'origin/main', commitsProblem: null, newCommits: [commit, commit, commit, commit] }), '4 new commits on main');
  assert.equal(commitsHeading({ ref: 'main', commitsProblem: null, newCommits: [commit] }), '1 new commit on main');
  assert.equal(commitsHeading({ ref: 'origin/main', commitsProblem: null, newCommits: [] }), 'Up to date with main');
  assert.equal(commitsHeading({ ref: null, commitsProblem: 'No main branch', newCommits: [] }), "Can't list new commits");
});

test('buttons: restart needs a clean build, undo needs an earlier bot, and one action runs at a time', () => {
  const idle = actionStates({ activateProblems: ['No prepared release. Run prepare first.'], canRollback: false, running: null });
  assert.deepEqual(idle.prepare, { enabled: true });
  assert.deepEqual(idle.activate, { enabled: false, reason: 'Nothing built yet.' });
  assert.equal(idle.rollback.enabled, false);
  const ready = actionStates({ activateProblems: [], canRollback: true, running: null });
  assert.ok(ready.activate.enabled && ready.rollback.enabled);
  const busy = actionStates({ activateProblems: [], canRollback: true, running: 'sync' });
  for (const state of Object.values(busy)) assert.deepEqual(state, { enabled: false, reason: 'Updating the bot… Wait for it to finish.' });
});

test('after a restart: success, refused, restored, and undo offered when the restore failed', () => {
  assert.deepEqual(activationNotice({ ok: true, release: prepared.release }, prepared), { tone: 'success', message: 'The bot runs a1b2c3d now.', offerRollback: false });
  const refused = activationNotice({ ok: false, stage: 'checks', error: 'GitHub unavailable', restored: true, rollbackAvailable: false });
  assert.equal(refused.message, "The bot wasn't restarted; nothing changed. GitHub unavailable");
  assert.equal(refused.offerRollback, false);
  const restored = activationNotice({ ok: false, stage: 'cutover', error: 'bad app token', restored: true, rollbackAvailable: false });
  assert.match(restored.message, /previous one is running again/);
  assert.equal(activationNotice({ ok: false, stage: 'cutover', error: 'bootout hung', restored: false, rollbackAvailable: true }).offerRollback, true);
  assert.deepEqual(rollbackNotice({ ok: true, release: prepared.release }, prepared), { tone: 'success', message: 'The bot runs a1b2c3d again.', offerRollback: false });
  assert.equal(rollbackNotice({ ok: false, error: 'Already rolled back' }).message, "Couldn't undo the switch. Already rolled back");
});

// ---------------------------------------------------------------------------------------------------------------
// Release-mode logic: the app card and the bot line
// ---------------------------------------------------------------------------------------------------------------

const release = {
  version: '0.1.0-alpha.3', prerelease: true, notes: '## Added\n- **Updates** from [GitHub](https://github.com)\n- `pnpm` no longer needed', publishedAt: '2026-11-28T10:00:00Z',
  url: 'https://github.com/acme/serra/releases/tag/v0.1.0-alpha.3', dmg: { name: 'Serra-0.1.0-alpha.3-arm64.dmg', url: 'https://example.test/dmg', size: 122_000_000 },
  sums: { url: 'https://example.test/SHA256SUMS' },
};
const view = (phase: object): AppUpdateView => ({ current: '0.1.0-alpha.2', prereleases: { on: true, choice: null, byDefault: true }, updatedFrom: null, ...phase } as AppUpdateView);
const now = new Date('2026-11-28T12:00:00Z');

test('the app card in each state says one thing and offers the one next step', () => {
  assert.deepEqual(appCard(view({ state: 'up-to-date', checkedAt: '2026-11-28T11:55:00Z' }), now), {
    tone: 'up', title: 'Serra 0.1.0-alpha.2', body: "You're on the latest version.", meta: 'Checked 5 min ago', primary: null, secondary: null, link: null,
  });
  const available = appCard(view({ state: 'available', release, checkedAt: now.toISOString() }), now);
  assert.equal(available.title, 'Serra 0.1.0-alpha.3 is available');
  assert.equal(available.meta, 'You have 0.1.0-alpha.2');
  assert.equal(available.body, 'Pre-release · Nov 28');
  assert.deepEqual(available.primary, { action: 'download', label: 'Download' });
  const downloading = appCard(view({ state: 'downloading', release, received: 76_000_000, total: 122_000_000 }), now);
  assert.equal(downloading.body, '76 of 122 MB');
  assert.deepEqual(downloading.secondary, { action: 'cancel', label: 'Cancel' });
  assert.equal(progressPercent(76_000_000, 122_000_000), 62);
  assert.equal(progressPercent(5, null), null);
  assert.deepEqual(appCard(view({ state: 'ready', release, install: { kind: 'replace' } }), now).primary, { action: 'install', label: 'Restart to update' });
  const installer = appCard(view({ state: 'ready', release, install: { kind: 'installer', reason: "Serra is running from its disk image, so it can't replace itself.", folder: 'Applications' } }), now);
  assert.deepEqual(installer.primary, { action: 'openInstaller', label: 'Open installer' });
  assert.equal(installer.body, "Serra is running from its disk image, so it can't replace itself. Open the installer, quit Serra, then drag it into Applications, replacing the old copy.");
  const failedCheck = appCard(view({ state: 'error', stage: 'check', message: "Couldn't reach GitHub." }), now);
  assert.equal(failedCheck.title, "Couldn't check for updates");
  assert.equal(failedCheck.primary, null, 'the header has Check for updates');
  const failedVerify = appCard(view({ state: 'error', stage: 'verify', message: 'x', release }), now);
  assert.equal(failedVerify.title, "Serra 0.1.0-alpha.3 didn't pass its checks");
  assert.equal(failedVerify.meta, 'You have 0.1.0-alpha.2');
  assert.deepEqual(failedVerify.primary, { action: 'download', label: 'Try again' });
  assert.equal(appCard(view({ state: 'idle' }), now).primary, null);
  assert.equal(appCard(view({ state: 'no-build', version: '0.2.0', url: release.url, reason: 'arch', checkedAt: now.toISOString() }), now).body, 'Serra 0.2.0 is out, but it has no build for this Mac yet.');
  for (const state of ['checking', 'downloading', 'verifying', 'installing', 'ready', 'unavailable']) assert.equal(canCheck(view({ state, release, install: { kind: 'replace' }, reason: '' })), false, state);
  assert.equal(canCheck(view({ state: 'up-to-date', checkedAt: '' })), true);
});

test('versions keep together on one line', () => {
  assert.equal(keepVersions('The bot runs version 0.1.0-alpha.3.'), 'The bot runs version 0.1.0\u2011alpha.3.');
  assert.equal(keepVersions('a well-known 1.0.0 release'), 'a well-known 1.0.0 release');
});

test('release notes become plain lines without Markdown syntax', () => {
  assert.deepEqual(noteLines(release.notes), [
    { kind: 'heading', text: 'Added' }, { kind: 'item', text: 'Updates from GitHub' }, { kind: 'item', text: 'pnpm no longer needed' },
  ]);
  assert.deepEqual(noteLines(''), []);
});

test('the bot line: in step, waiting for jobs, updating, failed, not installed, and nothing in developer mode', () => {
  assert.equal(botLine({ state: 'in-step', version: '0.1.0-alpha.3' })?.text, 'The bot runs version 0.1.0-alpha.3.');
  const waiting = botLine({ state: 'waiting', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', jobs: 2, paused: false })!;
  assert.equal(waiting.text, 'The bot still runs version 0.1.0-alpha.2.');
  assert.equal(waiting.detail, 'It moves to 0.1.0-alpha.3 when the 2 running jobs finish.');
  assert.deepEqual(waiting.action, { kind: 'sync', label: 'Update now' });
  assert.equal(botLine({ state: 'waiting', from: null, to: '0.1.0-alpha.3', jobs: 1, paused: false })!.detail, 'It moves to 0.1.0-alpha.3 when the running job finishes.');
  assert.equal(botLine({ state: 'updating', from: null, to: '0.1.0-alpha.3' })!.tone, 'busy');
  const failed = botLine({ state: 'failed', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', message: 'No supported Node', stopped: false, downgrade: false })!;
  assert.equal(failed.text, "The bot couldn't move to 0.1.0-alpha.3, so it's still on version 0.1.0-alpha.2.");
  assert.equal(failed.detail, 'No supported Node');
  assert.equal(botLine({ state: 'failed', from: null, to: '1.0.0', message: 'Slack account: invalid_auth; GitHub account: Expected alex', stopped: false, downgrade: false })!.detail, 'Slack account: invalid_auth (and 1 more)');
  assert.deepEqual(botLine({ state: 'stopped', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', downgrade: false })!.action, { kind: 'sync', label: 'Update now' });
  assert.deepEqual(botLine({ state: 'stopped', from: '0.1.0-alpha.3', to: null, downgrade: false }), { tone: 'neutral', text: "The bot is stopped. It's on version 0.1.0-alpha.3, the same as the app.", detail: 'Start it from the menu bar.', action: null });
  assert.deepEqual(botLine({ state: 'not-installed' })!.action, { kind: 'setup', label: 'Open setup' });
  assert.deepEqual(botLine({ state: 'interrupted' })!.action, { kind: 'rollback', label: 'Undo last switch' });
  assert.equal(botLine({ state: 'manual' }), null);
  assert.match(syncDialog('0.1.0-alpha.3', 2).body, /^2 jobs are running\. The bot restarts on version 0\.1\.0-alpha\.3/);
  assert.equal(syncDialog('0.1.0-alpha.3', 0, { stopped: true }).body, 'The bot starts on version 0.1.0-alpha.3.');
  assert.deepEqual(syncDialog('0.1.0', 0, { older: '0.2.0' }), { title: 'Move the bot back to 0.1.0?', body: "Version 0.1.0 is older than the bot's 0.2.0, so Serra doesn't do this on its own. No jobs are running." });
  assert.match(rollbackDialog(0, 'version').body, /on the version it ran before/);
  const ahead = botLine({ state: 'ahead', from: '0.2.0', to: '0.1.0' })!;
  assert.equal(ahead.text, 'The bot runs version 0.2.0, newer than this app.');
  assert.deepEqual(ahead.action, { kind: 'sync', label: 'Update now' });
});

// ---------------------------------------------------------------------------------------------------------------
// Bot sync decisions
// ---------------------------------------------------------------------------------------------------------------

const input = (patch: Partial<BotSyncInput> = {}): BotSyncInput => ({
  mode: 'release', follows: true, serviceLoaded: true, appVersion: '0.1.0-alpha.3', active: { appVersion: '0.1.0-alpha.2', fromApp: true }, prepared: null, preparedReady: false,
  activation: 'active', jobs: 0, running: null, failed: null, paused: false, mayPause: true, ...patch,
});

test('the bot follows the app only while no job runs, and never in developer mode', () => {
  assert.deepEqual(botSyncDecision(input()), { sync: { state: 'updating', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3' }, action: 'prepare' });
  // A running job defers the restart, and new requests are paused so it is the last one before the restart.
  assert.deepEqual(botSyncDecision(input({ jobs: 1 })), { sync: { state: 'waiting', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', jobs: 1, paused: true }, action: 'pause' });
  assert.deepEqual(botSyncDecision(input({ jobs: 1, paused: true })), { sync: { state: 'waiting', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', jobs: 1, paused: true }, action: 'none' }, 'already paused: just wait');
  assert.deepEqual(botSyncDecision(input({ jobs: 1, mayPause: false })), { sync: { state: 'waiting', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', jobs: 1, paused: false }, action: 'none' }, 'after a pause lapsed: wait for a quiet moment');
  // A build already prepared for this version (a job started while preparing) is only activated.
  assert.equal(botSyncDecision(input({ prepared: { appVersion: '0.1.0-alpha.3', fromApp: true }, preparedReady: true })).action, 'activate');
  assert.equal(botSyncDecision(input({ prepared: { appVersion: '0.1.0-alpha.3', fromApp: true }, preparedReady: false })).action, 'prepare');
  assert.equal(botSyncDecision(input({ prepared: { appVersion: '0.1.0-alpha.3' }, preparedReady: true })).action, 'prepare', 'a checkout build is not the app’s');
  assert.deepEqual(botSyncDecision(input({ active: { appVersion: '0.1.0-alpha.3', fromApp: true } })), { sync: { state: 'in-step', version: '0.1.0-alpha.3' }, action: 'none' });
  assert.equal(botSyncDecision(input({ active: { appVersion: '0.1.0-alpha.3' } })).action, 'prepare', 'same version built from a checkout moves to the app’s build');
  assert.deepEqual(botSyncDecision(input({ mode: 'developer' })), { sync: { state: 'manual' }, action: 'none' });
  assert.deepEqual(botSyncDecision(input({ follows: false })), { sync: { state: 'manual' }, action: 'none' }, 'a copy run from source does not lead the bot');
  // A bot the owner stopped stays stopped.
  assert.deepEqual(botSyncDecision(input({ serviceLoaded: false })), { sync: { state: 'stopped', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', downgrade: false }, action: 'none' });
  assert.equal((botSyncDecision(input({ serviceLoaded: false, appVersion: '0.1.0-alpha.1' })).sync as { downgrade: boolean }).downgrade, true, 'a stopped bot on a newer version warns before moving back');
  // Update now on a stopped bot that failed shows the failure, not "stopped" again.
  assert.equal(botSyncDecision(input({ serviceLoaded: false, failed: { version: '0.1.0-alpha.3', message: 'Slack account: invalid_auth' } })).sync.state, 'failed');
  // Stopped on the app's own version: stopped, not "runs", and nothing to update to.
  assert.deepEqual(botSyncDecision(input({ serviceLoaded: false, active: { appVersion: '0.1.0-alpha.3', fromApp: true } })), { sync: { state: 'stopped', from: '0.1.0-alpha.3', to: null, downgrade: false }, action: 'none' });
  assert.deepEqual(botSyncDecision(input({ active: null })), { sync: { state: 'not-installed' }, action: 'none' });
  assert.deepEqual(botSyncDecision(input({ activation: 'switching' })), { sync: { state: 'interrupted' }, action: 'none' });
  assert.equal(botSyncDecision(input({ activation: 'switching', running: 'sync' })).sync.state, 'updating', 'a switch under way is not an interrupted one');
  // A failure isn't retried on its own; another action running makes it wait.
  assert.equal(botSyncDecision(input({ failed: { version: '0.1.0-alpha.3', message: 'x' } })).action, 'none');
  assert.equal(botSyncDecision(input({ failed: { version: '0.1.0-alpha.2', message: 'x' } })).action, 'prepare', 'a failure for another version does not block');
  assert.equal(botSyncDecision(input({ running: 'rollback' })).action, 'none');
  // An older app (reinstalled by hand) never moves the bot back on its own.
  assert.deepEqual(botSyncDecision(input({ appVersion: '0.1.0-alpha.1' })), { sync: { state: 'ahead', from: '0.1.0-alpha.2', to: '0.1.0-alpha.1' }, action: 'none' });
  // A bot from before versions were recorded counts as older.
  assert.equal(botSyncDecision(input({ active: {} })).action, 'prepare');
});

// ---------------------------------------------------------------------------------------------------------------
// IPC handlers on a temp profile, daemon stopped
// ---------------------------------------------------------------------------------------------------------------

/** A fresh profile like tests/deploy.test.ts's, with no daemon running. */
const profileFixture = async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-app-updates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'profile'); const project = join(root, 'project'); const agents = join(root, 'agents');
  for (const path of [project, agents]) mkdirSync(path);
  execFileSync('git', ['init', '-q', project]); execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'git@github.com:acme/project.git']);
  createProfile(directory, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  writeFileSync(join(directory, '.env'), 'SLACK_APP_TOKEN=xapp-fixture\nSLACK_BOT_TOKEN=xoxb-fixture\n', { mode: 0o600 });
  const events: string[] = [];
  const driver: ServiceDriver = {
    loaded: async () => false,
    stop: async () => { events.push('stop'); },
    start: async () => { events.push('start'); },
    ready: async () => { events.push('ready'); },
  };
  return { root, directory, agents, driver, events };
};

const contextFor = (profileDir: string, pushes: string[]): HandlerContext => ({
  profileDir: () => profileDir,
  profileDirOrNull: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.0.0', node: '22.20.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
  push: <P extends keyof SerraPushes>(channel: P, payload: SerraPushes[P]) => { if (channel === 'releaseLog') pushes.push(String(payload)); },
});

test('prepare uses the Node findNode resolves, never process.execPath, and streams its log', async (t) => {
  const f = await profileFixture(t);
  const pushes: string[] = [];
  const fakeNode = '/Users/you/.volta/bin/node';
  const asked: string[] = [];
  const handlers = updatesHandlers(contextFor(f.directory, pushes), {
    findNode: async (dir) => { asked.push(dir); return fakeNode; },
    prepare: { install: false },
    status: { root: f.root },
    echo: () => {},
  });
  const plan = await handlers.prepare();
  assert.deepEqual(asked, [f.directory]);
  assert.equal(plan.node, fakeNode);
  assert.notEqual(plan.node, process.execPath);
  assert.match(readFileSync(join(plan.release, 'service.plist'), 'utf8'), new RegExp(`<string>${fakeNode}</string>`));
  assert.match(readFileSync(join(f.directory, 'activate.sh'), 'utf8'), new RegExp(`exec '?${fakeNode}'?`));
  assert.equal(pushes[0], 'Looking for Node');
  assert.equal(pushes[1], `Using ${fakeNode}`);
  assert.ok(pushes.some((line) => line.startsWith('Copying code into')));

  // The status works from files with the daemon stopped, and keeps the last action's log for the screen.
  const after = await handlers.status();
  assert.equal(after.releases?.prepared?.release, plan.release);
  assert.equal(after.running, null);
  assert.deepEqual(after.log, pushes);
  assert.deepEqual(after.releases?.activateProblems, ['Prepared dependencies missing. Run prepare again.']);
  assert.match(after.releases?.commitsProblem ?? '', /isn't a git checkout.*updates\.source/);
});

test('a prepare that cannot find Node fails before anything is written, with the reason in the log', async (t) => {
  const f = await profileFixture(t);
  const pushes: string[] = [];
  const handlers = updatesHandlers(contextFor(f.directory, pushes), {
    findNode: async () => { throw new Error('No supported Node (22.18+ or 24+) found. Install Node or pass its path.'); },
    prepare: { install: false }, echo: () => {},
  });
  await assert.rejects(async () => handlers.prepare(), /No supported Node/);
  assert.match(pushes.at(-1) ?? '', /^Prepare failed: No supported Node/);
  assert.equal((await handlers.status()).releases?.prepared, null);
});

test('activate and rollback run with the daemon stopped, one at a time, and report their outcome', async (t) => {
  const f = await profileFixture(t);
  const pushes: string[] = [];
  const handlers = updatesHandlers(contextFor(f.directory, pushes), {
    findNode: async () => '/opt/homebrew/bin/node',
    prepare: { install: false },
    deploy: { driver: f.driver, launchAgentsDir: f.agents, preflight: async () => {} },
    status: { root: f.root },
    echo: () => {},
  });
  const plan = await handlers.prepare();
  mkdirSync(join(plan.release, 'node_modules/@slack/bolt'), { recursive: true });

  // Nothing is followed in state.json, so the dialog says no jobs are running.
  assert.deepEqual(await handlers.runningJobs(), []);

  // Hold the new bot's startup so a second action arrives while activation runs.
  let started!: () => void;
  const startup = new Promise<void>((resolve) => { started = resolve; });
  f.driver.ready = async () => { f.events.push('ready'); await startup; };
  const activating = handlers.activate();
  await assert.rejects(async () => handlers.prepare(), /Activate is still running/);
  const during = await handlers.status();
  assert.equal(during.running, 'activate');
  assert.ok(during.log.includes('Checking the prepared release'));
  started();
  assert.deepEqual(await activating, { ok: true, release: plan.release });
  assert.ok(pushes.includes('Bot connected. The new release is active.'));
  assert.equal(pushes.at(-1), 'New requests start again.', 'the switch paused new requests and lifted the pause after');

  const active = await handlers.status();
  assert.equal(active.releases?.active?.release, plan.release);
  // The first bot installed has nothing before it: rollback is off and refuses, instead of removing the only bot.
  assert.equal(active.releases?.canRollback, false);
  f.events.length = 0;
  assert.deepEqual(await handlers.rollback(), { ok: false, error: 'Nothing to roll back to: this is the first release installed for this profile' });
  assert.deepEqual(f.events, [], 'nothing was stopped');

  const next = await handlers.prepare();
  mkdirSync(join(next.release, 'node_modules/@slack/bolt'), { recursive: true });
  assert.deepEqual(await handlers.activate(), { ok: true, release: next.release });
  assert.equal((await handlers.status()).releases?.canRollback, true);
  pushes.length = 0;
  assert.deepEqual(await handlers.rollback(), { ok: true, release: plan.release });
  assert.ok(pushes.includes('Previous installation restored.'));
  assert.deepEqual(await handlers.rollback(), { ok: false, error: 'Already rolled back' });
  assert.equal(pushes.at(-1), 'Rollback failed: Already rolled back');
});

/** Writes a job the bot is following into state.json, as the daemon does. */
const followJob = (directory: string): void => writeFileSync(join(directory, 'state.json'), JSON.stringify({
  'C0123456789:1.000': {
    t3ThreadId: 't3-1', channel: 'C0123456789', threadTs: '1.000', requester: 'U0123456789', pendingReactionTs: null, lastPostedRunId: null,
    watching: true, createdAt: '2026-11-21T10:00:00.000Z',
  },
}));

test('developer mode needs an update source: without one, status compares nothing with git and the bot follows the app', async (t) => {
  const f = await profileFixture(t);
  const handlers = updatesHandlers({ ...contextFor(f.directory, []), botFollowsApp: true }, { echo: () => {} });
  const release = await handlers.status();
  assert.equal(release.releases?.mode, 'release');
  assert.equal(release.releases?.commitsProblem, null, 'no git error about the packaged app');
  assert.deepEqual(release.bot, { state: 'not-installed' });
  assert.equal(release.appVersion, '0.0.0');

  const path = join(f.directory, 'profile.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), updates: { source: f.root } }, null, 2));
  const developer = await handlers.status();
  assert.equal(developer.releases?.mode, 'developer');
  assert.match(developer.releases?.commitsProblem ?? '', /isn't a git checkout/);
  assert.deepEqual(developer.bot, { state: 'manual' });
});

test('after an app update the bot moves to the new version, but waits while a job runs', async (t) => {
  const f = await profileFixture(t);
  const pushes: string[] = [];
  const scheduled: (() => void)[] = [];
  const context: HandlerContext = {
    ...contextFor(f.directory, pushes),
    runtime: { version: '0.1.0-alpha.3', electron: '45.0.0', node: '22.20.0', platform: 'darwin' },
    every: (_first, _every, task) => { scheduled.push(task); },
    botFollowsApp: true,
    expectStop: () => { pushes.push('expect-stop'); },
  };
  const deps = {
    findNode: async () => '/opt/homebrew/bin/node',
    // The release service installs no dependencies here, so mark them present as each release is prepared.
    prepare: { install: false },
    deploy: { driver: f.driver, launchAgentsDir: f.agents, preflight: async (): Promise<void> => {} },
    echo: () => {},
  };
  const { handlers, tick } = updatesService(context, deps);
  assert.equal(scheduled.length, 1, 'the version check is scheduled');

  // The bot runs a build from the previous app version.
  const old = await handlers.prepare();
  mkdirSync(join(old.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(f.directory, 'prepared.json'), JSON.stringify({ ...old, appVersion: '0.1.0-alpha.2', fromApp: true }));
  assert.equal((await handlers.activate()).ok, true);
  f.events.length = 0;
  // The service runs; a stopped one would stay stopped.
  f.driver.loaded = async () => true;

  followJob(f.directory);
  assert.deepEqual((await handlers.status()).bot, { state: 'waiting', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', jobs: 1, paused: true });
  assert.equal(readPause(f.directory), null, 'reading the status pauses nothing');
  await tick();
  assert.deepEqual(f.events, [], 'a running job is never interrupted: nothing stopped or started');
  // The tick paused new requests, so the running job is the last one before the restart.
  assert.equal(readPause(f.directory)?.reason, 'bot-update');

  // The new app's build was prepared earlier (a job started while preparing): once jobs finish, it is activated.
  const fresh = await handlers.prepare();
  mkdirSync(join(fresh.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(f.directory, 'prepared.json'), JSON.stringify({ ...fresh, appVersion: '0.1.0-alpha.3', fromApp: true }));
  await tick();
  assert.deepEqual(f.events, [], 'still waiting for the job');

  // A job starts during the health checks: the bot isn't stopped, the update waits.
  rmSync(join(f.directory, 'state.json'));
  deps.deploy.preflight = async () => { followJob(f.directory); };
  await tick();
  assert.deepEqual(f.events, [], 'the recheck right before the stop held the restart');
  assert.equal((await handlers.status()).bot.state, 'waiting');

  deps.deploy.preflight = async () => {};
  rmSync(join(f.directory, 'state.json'));
  await tick();
  const after = await handlers.status();
  assert.equal(after.releases?.active?.release, fresh.release);
  assert.equal(readPause(f.directory), null, 'new requests flow again after the switch; the new bot starts the held ones');
  assert.deepEqual(after.bot, { state: 'in-step', version: '0.1.0-alpha.3' });
  const events: string[] = f.events;
  assert.ok(events.includes('stop') && events.includes('start'), 'the bot restarted on the new build');
  assert.ok(pushes.includes('expect-stop'), 'notifications are told the stop is expected');
});

test('the window confirms its first screen, which an update that just installed waits for', () => {
  // The swap script rolls the update back unless the new version confirms it started (app.rendered → started()).
  const app = readFileSync(join(import.meta.dirname, '../app/renderer/App.tsx'), 'utf8');
  assert.match(app, /const Rendered = [\s\S]*app\.rendered\(\)/);
  assert.match(app, /<Rendered \/>/, 'Rendered is mounted in the shell');
});

test('a pause the update no longer needs is lifted, and one that lapsed with jobs still running is not renewed for a while', async (t) => {
  const f = await profileFixture(t);
  let clock = Date.parse('2026-11-21T22:00:00Z');
  const context: HandlerContext = { ...contextFor(f.directory, []), runtime: { version: '0.1.0-alpha.3', electron: '45.0.0', node: '22.20.0', platform: 'darwin' }, botFollowsApp: true };
  const deps = { findNode: async () => '/opt/homebrew/bin/node', prepare: { install: false }, deploy: { driver: f.driver, launchAgentsDir: f.agents, preflight: async () => {} }, echo: () => {}, now: () => clock };
  const { handlers, tick } = updatesService(context, deps);
  // The bot is already on the app's version (the app update was called off and the old app came back).
  const plan = await handlers.prepare();
  mkdirSync(join(plan.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(f.directory, 'prepared.json'), JSON.stringify({ ...plan, appVersion: '0.1.0-alpha.3', fromApp: true }));
  assert.equal((await handlers.activate()).ok, true);
  f.driver.loaded = async () => true;
  pauseIntake(f.directory, 'app-update', { now: clock });
  await tick();
  assert.equal(readPause(f.directory, clock), null, 'nothing waits on it: lifted');

  // Behind, with a job that outlasts the pause: once it lapses, no new pause for an hour; requests flow meanwhile.
  writeFileSync(join(f.directory, 'active.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(f.directory, 'active.json'), 'utf8')), appVersion: '0.1.0-alpha.2' }));
  followJob(f.directory);
  await tick();
  assert.ok(readPause(f.directory, clock), 'paused for the job to finish');
  clock += 31 * 60_000;
  assert.equal(readPause(f.directory, clock), null, 'the pause lapses on its own');
  await tick();
  assert.equal(readPause(f.directory, clock), null, 'not renewed right away');
  assert.deepEqual((await handlers.status()).bot, { state: 'waiting', from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', jobs: 1, paused: false });
  clock += 61 * 60_000;
  await tick();
  assert.ok(readPause(f.directory, clock), 'after the cool-down it pauses again');
});

test('Restart to update pauses new requests first, so the bot can move to the new version as soon as its jobs finish', async (t) => {
  const f = await profileFixture(t);
  writeFileSync(join(f.directory, 'active.json'), JSON.stringify({ release: join(f.directory, 'releases/x'), appVersion: '0.1.0-alpha.2' }));
  const installing = { state: 'installing' } as unknown as AppUpdateView;
  // The pause is on disk before Serra is told to quit.
  let pausedAtInstall: unknown = 'not called';
  const appUpdater = { install: () => { pausedAtInstall = readPause(f.directory)?.reason ?? null; return installing; } } as unknown as NonNullable<HandlerContext['appUpdater']>;
  const quiet = updatesHandlers({ ...contextFor(f.directory, []), appUpdater, botFollowsApp: false }, { echo: () => {} });
  await quiet.install();
  assert.equal(readPause(f.directory), null, 'a copy run from source leads no bot: nothing paused');
  const handlers = updatesHandlers({ ...contextFor(f.directory, []), appUpdater, botFollowsApp: true }, { echo: () => {} });
  assert.equal((await handlers.install()).state, 'installing');
  assert.equal(pausedAtInstall, 'app-update');
  assert.equal(readPause(f.directory)?.reason, 'app-update');

  // Nothing to install after all: the pause this call started is lifted.
  rmSync(join(f.directory, 'intake-paused.json'));
  const idle = { install: () => ({ state: 'ready' }) } as unknown as NonNullable<HandlerContext['appUpdater']>;
  await updatesHandlers({ ...contextFor(f.directory, []), appUpdater: idle, botFollowsApp: true }, { echo: () => {} }).install();
  assert.equal(readPause(f.directory), null);
});

test('a request the paused daemon is still starting holds the restart, like a running job', async (t) => {
  const f = await profileFixture(t);
  const context: HandlerContext = { ...contextFor(f.directory, []), runtime: { version: '0.1.0-alpha.3', electron: '45.0.0', node: '22.20.0', platform: 'darwin' }, botFollowsApp: true };
  const deps = { findNode: async () => '/opt/homebrew/bin/node', prepare: { install: false }, deploy: { driver: f.driver, launchAgentsDir: f.agents, preflight: async (): Promise<void> => {} }, echo: () => {} };
  const { handlers, tick } = updatesService(context, deps);
  const old = await handlers.prepare();
  mkdirSync(join(old.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(f.directory, 'prepared.json'), JSON.stringify({ ...old, appVersion: '0.1.0-alpha.2', fromApp: true }));
  assert.equal((await handlers.activate()).ok, true);
  f.driver.loaded = async () => true;
  const fresh = await handlers.prepare();
  mkdirSync(join(fresh.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(f.directory, 'prepared.json'), JSON.stringify({ ...fresh, appVersion: '0.1.0-alpha.3', fromApp: true }));
  f.events.length = 0;
  // During the health checks the daemon reports a request it let in before the pause and is still starting.
  deps.deploy.preflight = async () => { pauseIntake(f.directory, 'bot-update'); acknowledgePause(f.directory, 1); };
  await tick();
  assert.deepEqual(f.events, [], 'not restarted while a request is still starting');
  deps.deploy.preflight = async () => { acknowledgePause(f.directory, 0); };
  await tick();
  assert.equal((await handlers.status()).releases?.active?.release, fresh.release);
  assert.equal(readPause(f.directory), null);
});

test('a pause left by the app before a restart that lapsed with jobs running is not renewed by the new app at once', async (t) => {
  const f = await profileFixture(t);
  const clock = Date.parse('2026-11-21T23:00:00Z');
  const context: HandlerContext = { ...contextFor(f.directory, []), runtime: { version: '0.1.0-alpha.3', electron: '45.0.0', node: '22.20.0', platform: 'darwin' }, botFollowsApp: true };
  const deps = { findNode: async () => '/opt/homebrew/bin/node', prepare: { install: false }, deploy: { driver: f.driver, launchAgentsDir: f.agents, preflight: async () => {} }, echo: () => {}, now: () => clock };
  const { handlers, tick } = updatesService(context, deps);
  const old = await handlers.prepare();
  mkdirSync(join(old.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(f.directory, 'prepared.json'), JSON.stringify({ ...old, appVersion: '0.1.0-alpha.2', fromApp: true }));
  assert.equal((await handlers.activate()).ok, true);
  f.driver.loaded = async () => true;
  followJob(f.directory);
  // The previous app's pause ran out ten minutes ago.
  pauseIntake(f.directory, 'app-update', { now: clock - 40 * 60_000 });
  await tick();
  assert.equal(readPause(f.directory, clock), null, 'requests keep flowing for now');
});
