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
  actionStates, activateDialog, activationNotice, commitsHeading, preparedLabel, releaseLabel, rollbackDialog, rollbackNotice, sourceLabel,
  type UpdatesStatus,
} from '../app/renderer/screens/updates.logic.ts';
import { type ServiceDriver } from '../src/deploy.ts';
import { createProfile } from '../src/setup.ts';

// ---------------------------------------------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------------------------------------------

const prepared = { release: '/Users/you/bot/releases/2026-11-19T10-00-00-000Z-42', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' };

test('the activate dialog names the release and the running jobs: none, one and several', () => {
  assert.deepEqual(activateDialog(prepared, 0), {
    title: 'Activate a1b2c3d?',
    body: 'No jobs are running. Activating restarts the bot.',
  });
  assert.deepEqual(activateDialog(prepared, 1), {
    title: 'Activate a1b2c3d?',
    body: '1 job is running. Activating restarts the bot; the job continues after restart.',
  });
  assert.deepEqual(activateDialog(prepared, 3), {
    title: 'Activate a1b2c3d?',
    body: '3 jobs are running. Activating restarts the bot; the jobs continue after restart.',
  });
});

test('the rollback dialog counts running jobs the same way', () => {
  assert.match(rollbackDialog(0).body, /^No jobs are running\. Rolling back restarts the bot/);
  assert.match(rollbackDialog(1).body, /^1 job is running\..*; the job continues after restart\.$/);
  assert.match(rollbackDialog(2).body, /^2 jobs are running\..*; the jobs continue after restart\.$/);
});

test('release labels use the commit, mark uncommitted changes, and fall back to the folder name', () => {
  assert.equal(releaseLabel(prepared), 'a1b2c3d');
  assert.equal(releaseLabel({ ...prepared, dirty: true }), 'a1b2c3d + changes');
  assert.equal(releaseLabel({ release: '/Users/you/bot/releases/2026-11-19T10-00-00-000Z-42' }), '2026-11-19T10-00-00-000Z-42');
  assert.equal(releaseLabel(null), 'None');
  assert.equal(preparedLabel({}), '');
  assert.equal(preparedLabel({ preparedAt: 'not a date' }), '');
  assert.match(preparedLabel({ preparedAt: '2026-11-19T12:00:00.000Z' }), /^prepared Nov (19|20), \d\d:\d\d$/);
});

test('the source line names the GitHub repository and branch Updates follows', () => {
  assert.equal(sourceLabel({ ref: 'origin/main', source: '/Users/you/git/serra', upstream: 'git@github.com:acme/serra.git' }), 'From acme/serra main, in /Users/you/git/serra');
  assert.equal(sourceLabel({ ref: 'upstream/release', source: '/code', upstream: 'https://github.com/acme/serra' }), 'From acme/serra release, in /code');
  assert.equal(sourceLabel({ ref: null, source: '/Applications/Serra.app/Contents/Resources/app', upstream: null }), 'From /Applications/Serra.app/Contents/Resources/app');
});

test('the commits heading counts commits on main, says when up to date, and when it cannot tell', () => {
  const commit = { sha: 'abc', subject: 'Keep job state on restart' };
  assert.equal(commitsHeading({ ref: 'origin/main', commitsProblem: null, newCommits: [commit, commit, commit, commit] }), '4 new commits on main');
  assert.equal(commitsHeading({ ref: 'main', commitsProblem: null, newCommits: [commit] }), '1 new commit on main');
  assert.equal(commitsHeading({ ref: 'origin/main', commitsProblem: null, newCommits: [] }), 'Up to date with main');
  assert.equal(commitsHeading({ ref: null, commitsProblem: 'No main branch', newCommits: [] }), 'New commits unknown');
});

const status = (patch: Partial<UpdatesStatus> = {}): UpdatesStatus => ({
  active: null, prepared: null, newCommits: [], ref: 'main', commitsProblem: null, activation: null, source: '/code', upstream: null,
  canRollback: false, activateProblems: [], running: null, log: [], ...patch,
});

test('buttons: activate needs a clean prepared release, rollback needs an activation, and one action runs at a time', () => {
  const idle = actionStates(status({ activateProblems: ['No prepared release. Run prepare first.'] }));
  assert.deepEqual(idle.prepare, { enabled: true });
  assert.deepEqual(idle.activate, { enabled: false, reason: 'No prepared release. Run prepare first.' });
  assert.equal(idle.rollback.enabled, false);
  const ready = actionStates(status({ canRollback: true }));
  assert.ok(ready.activate.enabled && ready.rollback.enabled);
  const busy = actionStates(status({ canRollback: true, running: 'prepare' }));
  for (const state of Object.values(busy)) assert.deepEqual(state, { enabled: false, reason: 'Preparing… Wait for it to finish.' });
});

test('after activation: success, refused, restored, and rollback offered when the restore failed', () => {
  const ok = activationNotice({ ok: true, release: prepared.release }, prepared);
  assert.deepEqual(ok, { tone: 'success', message: 'Activated a1b2c3d. The bot is running the new release.', offerRollback: false });
  const refused = activationNotice({ ok: false, stage: 'checks', error: 'GitHub unavailable', restored: true, rollbackAvailable: false });
  assert.match(refused.message, /^Activation refused; nothing changed\. GitHub unavailable$/);
  assert.equal(refused.offerRollback, false);
  const restored = activationNotice({ ok: false, stage: 'cutover', error: 'bad app token', restored: true, rollbackAvailable: false });
  assert.match(restored.message, /previous one is running again/);
  assert.equal(restored.offerRollback, false);
  const stuck = activationNotice({ ok: false, stage: 'cutover', error: 'bootout hung', restored: false, rollbackAvailable: true });
  assert.equal(stuck.offerRollback, true);
  assert.deepEqual(rollbackNotice({ ok: true, release: null }), { tone: 'success', message: 'Rolled back. No release is active now.', offerRollback: false });
  assert.equal(rollbackNotice({ ok: false, error: 'Already rolled back' }).message, 'Rollback failed. Already rolled back');
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
  assert.equal(after.prepared?.release, plan.release);
  assert.equal(after.running, null);
  assert.deepEqual(after.log, pushes);
  assert.deepEqual(after.activateProblems, ['Prepared dependencies missing. Run prepare again.']);
  assert.match(after.commitsProblem ?? '', /isn't a git checkout.*updates\.source/);
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
  assert.equal((await handlers.status()).prepared, null);
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
  assert.equal(pushes.at(-1), 'Bot connected. The new release is active.');

  const active = await handlers.status();
  assert.equal(active.active?.release, plan.release);
  assert.equal(active.canRollback, true);

  pushes.length = 0;
  assert.deepEqual(await handlers.rollback(), { ok: true, release: null });
  assert.equal(pushes.at(-1), 'Previous installation restored.');
  assert.deepEqual(await handlers.rollback(), { ok: false, error: 'Already rolled back' });
  assert.equal(pushes.at(-1), 'Rollback failed: Already rolled back');
});
