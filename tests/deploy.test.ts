import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codeRoot } from '../src/config.ts';
import { createProfile } from '../src/setup.ts';
import { activate, canRollBack, defaultNode, PACKAGED_SOURCE, pruneReleases, RELEASE_INFO, stageReleaseSource, startupError, pnpmCommand, prepareRelease, releaseSourceRoot, rollback, servicePlist, type ServiceDriver } from '../src/deploy.ts';
import { activateRelease, activationPreflight, findNode, nvmNodes, prepareNextRelease, releaseStatus, rollbackRelease, supportedNode } from '../src/releases.ts';

/**
 * A fresh profile with a prepared release and no service yet. The fake launchd knows a service by its plist, and
 * reports each start as the prepared release (`start-new`) or the earlier one put back by a rollback (`start-old`).
 */
const fixture = async (t: { after: (fn: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-deploy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'profile'); const project = join(root, 'project'); const agents = join(root, 'agents');
  for (const path of [project, agents]) mkdirSync(path);
  execFileSync('git', ['init', '-q', project]); execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'git@github.com:acme/project.git']);
  createProfile(directory, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U12345', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  writeFileSync(join(directory, '.env'), 'SLACK_APP_TOKEN=xapp-fixture\nSLACK_BOT_TOKEN=xoxb-fixture\n', { mode: 0o600 });
  const plan = await prepareRelease(directory, { install: false });
  mkdirSync(join(plan.release, 'node_modules/@slack/bolt'), { recursive: true });
  const label = plan.label;
  const events: string[] = []; let readyError = false;
  const prepared = (): string => readFileSync(join(JSON.parse(readFileSync(join(directory, 'prepared.json'), 'utf8')).release, 'service.plist'), 'utf8');
  const driver: ServiceDriver = {
    loaded: async (name) => existsSync(join(agents, `${name}.plist`)),
    stop: async () => { events.push('stop'); },
    start: async (path) => { events.push(readFileSync(path, 'utf8') === prepared() ? 'start-new' : 'start-old'); },
    ready: async () => { events.push('ready'); if (readyError) throw new Error('bad app token'); },
  };
  const opts = { driver, launchAgentsDir: agents, preflight: async () => { events.push('preflight'); } };
  return { root, directory, agents, label, plan, events, driver, opts, failReady: () => { readyError = true; } };
};

/** Activates the fixture's release, then prepares a newer one, so a previous installation is running. */
const upgrade = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await activate(f.directory, f.opts);
  const previous = f.plan.release;
  await new Promise((done) => setTimeout(done, 2));
  const next = await prepareRelease(f.directory, { install: false });
  mkdirSync(join(next.release, 'node_modules/@slack/bolt'), { recursive: true });
  f.events.length = 0;
  return { previous, next };
};

test('preparation changes no service: nothing is installed or started', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.events, []);
  assert.equal(existsSync(join(f.agents, `${f.label}.plist`)), false);
  assert.equal(existsSync(join(f.directory, 'active.json')), false);
  assert.equal(f.label, 'dev.serra.friday');
});

test('a fresh install never takes over an existing service with the same label', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.agents, `${f.label}.plist`), 'someone else');
  await assert.rejects(activate(f.directory, f.opts), /already exists/);
  assert.deepEqual(f.events, ['preflight']);
  assert.equal(readFileSync(join(f.agents, `${f.label}.plist`), 'utf8'), 'someone else');
});

test('failed preflight or a modified release never stops the live service', async (t) => {
  const f = await fixture(t);
  await assert.rejects(activate(f.directory, { ...f.opts, preflight: async () => { throw new Error('GitHub unavailable'); } }), /GitHub unavailable/);
  assert.deepEqual(f.events, []);
  writeFileSync(join(f.plan.release, 'src/index.ts'), 'changed after preparation');
  await assert.rejects(activate(f.directory, f.opts), /release changed/);
  assert.deepEqual(f.events, []);
});

test('startup failure automatically restores the previous release and restarts it', async (t) => {
  const f = await fixture(t);
  const { previous } = await upgrade(f); f.failReady();
  await assert.rejects(activate(f.directory, f.opts), /previous installation restored/);
  assert.deepEqual(f.events, ['preflight', 'stop', 'start-new', 'ready', 'stop', 'start-old']);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'active.json'), 'utf8')).release, previous);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'activation.json'), 'utf8')).phase, 'rolled-back');
});

test('a failed first start removes the new service again', async (t) => {
  const f = await fixture(t); f.failReady();
  await assert.rejects(activate(f.directory, f.opts), /previous installation restored/);
  assert.deepEqual(f.events, ['preflight', 'stop', 'start-new', 'ready', 'stop']);
  assert.equal(existsSync(join(f.agents, `${f.label}.plist`)), false);
  assert.equal(existsSync(join(f.directory, 'active.json')), false);
});

test('an edited service plist cannot reach cutover', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.plan.release, 'service.plist'), 'different executable');
  await assert.rejects(activate(f.directory, f.opts), /release changed/);
  assert.deepEqual(f.events, []);
});

test('failure to stop the old bot never starts the new release', async (t) => {
  const f = await fixture(t);
  const { previous } = await upgrade(f);
  let calls = 0;
  f.driver.stop = async () => { f.events.push('stop'); if (calls++ === 0) throw new Error('stop failed'); };
  await assert.rejects(activate(f.directory, f.opts), /previous installation restored/);
  assert.equal(f.events.includes('start-new'), false);
  assert.equal(f.events.at(-1), 'start-old');
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'active.json'), 'utf8')).release, previous);
});

test('future upgrades keep the external state and roll back only code', async (t) => {
  const f = await fixture(t); await activate(f.directory, f.opts);
  const previous = JSON.parse(readFileSync(join(f.directory, 'active.json'), 'utf8')).release;
  await new Promise((done) => setTimeout(done, 2));
  const next = await prepareRelease(f.directory, { install: false });
  mkdirSync(join(next.release, 'node_modules/@slack/bolt'), { recursive: true });
  writeFileSync(join(f.directory, 'state.json'), '{"keep":{"lastPostedRunId":"run-new"}}');
  await activate(f.directory, f.opts);
  await rollback(f.directory, f.opts);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'active.json'), 'utf8')).release, previous);
  assert.match(readFileSync(join(f.directory, 'state.json'), 'utf8'), /run-new/);
});

test('plist generation escapes paths and names without shell interpolation', () => {
  const plist = servicePlist({ directory: '/tmp/Bob & Co', release: '/tmp/release <one>', label: 'dev.serra.friday', node: '/tmp/node' });
  assert.match(plist, /Bob &amp; Co/); assert.match(plist, /release &lt;one&gt;/); assert.match(plist, /--profile/);
});

// ---------------------------------------------------------------------------------------------------------------
// Release status service (releases.ts)
// ---------------------------------------------------------------------------------------------------------------

const gitIn = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
}).trim();

/** A git checkout holding the files a release copies, so commits can be counted. */
const codeCheckout = (root: string): string => {
  const code = join(root, 'code'); mkdirSync(code);
  for (const name of ['src', 'templates', 'docs', 'examples', 'README.md', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']) cpSync(join(codeRoot, name), join(code, name), { recursive: true });
  gitIn(code, 'init', '-q', '-b', 'main'); gitIn(code, 'add', '.'); gitIn(code, 'commit', '-q', '-m', 'First release');
  return code;
};

test('status with a prepared release and nothing active yet', async (t) => {
  const f = await fixture(t);
  const status = await releaseStatus(f.directory);
  assert.equal(status.active, null);
  assert.equal(status.prepared?.release, f.plan.release);
  assert.deepEqual(status.activateProblems, []);
  assert.equal(status.activation, null); assert.equal(status.canRollback, false);
  // Release mode (no `updates` in the profile) compares nothing with git.
  assert.equal(status.mode, 'release');
  assert.deepEqual(status.newCommits, []); assert.equal(status.commitsProblem, null);
  assert.match((await releaseStatus(f.directory, { commits: true })).commitsProblem ?? '', /No active release/);
});

test('status without a prepared release lists the commits on main the active release lacks', async (t) => {
  const f = await fixture(t);
  const code = codeCheckout(f.root);
  const plan = await prepareRelease(f.directory, { root: code, install: false });
  assert.equal(plan.commit, gitIn(code, 'rev-parse', 'HEAD')); assert.equal(plan.dirty, false); assert.ok(plan.preparedAt);
  mkdirSync(join(plan.release, 'node_modules/@slack/bolt'), { recursive: true });
  await activate(f.directory, f.opts);
  writeFileSync(join(code, 'README.md'), 'second'); gitIn(code, 'commit', '-qam', 'Second change');
  writeFileSync(join(code, 'README.md'), 'third'); gitIn(code, 'commit', '-qam', 'Third change');

  const status = await releaseStatus(f.directory, { root: code });
  assert.equal(status.active?.release, plan.release);
  assert.equal(status.prepared, null, 'prepared.json of the active release is not a pending release');
  assert.deepEqual(status.activateProblems, ['No prepared release. Run prepare first.']);
  assert.equal(status.activation, 'active');
  assert.equal(status.canRollback, false, 'the first activation has nothing earlier to roll back to');
  assert.equal(status.ref, 'main'); assert.equal(status.commitsProblem, null);
  assert.deepEqual(status.newCommits.map((c) => c.subject), ['Third change', 'Second change']);
  assert.equal(status.newCommits[0]!.sha, gitIn(code, 'rev-parse', 'HEAD'));

  writeFileSync(join(code, 'README.md'), 'uncommitted');
  const dirty = await prepareRelease(f.directory, { root: code, install: false });
  assert.equal(dirty.dirty, true);
  const pending = await releaseStatus(f.directory, { root: code });
  assert.equal(pending.prepared?.release, dirty.release);
  assert.deepEqual(pending.activateProblems, ['Prepared dependencies missing. Run prepare again.']);
});

test('status explains when commits cannot be counted', async (t) => {
  const f = await fixture(t);
  const code = codeCheckout(f.root);
  await activate(f.directory, f.opts);
  const active = JSON.parse(readFileSync(join(f.directory, 'active.json'), 'utf8'));
  writeFileSync(join(f.directory, 'active.json'), JSON.stringify({ ...active, commit: undefined }));
  assert.match((await releaseStatus(f.directory, { root: code })).commitsProblem ?? '', /doesn't record its commit\. Build from main and restart the bot on it/);
  assert.match((await releaseStatus(f.directory, { root: f.root })).commitsProblem ?? '', /isn't a git checkout.*updates\.source/);
  gitIn(f.root, 'init', '-q');
  assert.match((await releaseStatus(f.directory, { root: f.root })).commitsProblem ?? '', /No main branch/);
});

/** Points the fixture profile's `updates` at `source`, as Settings › Worker › Developer: update from a checkout does. */
const followUpdates = (directory: string, updates: { source: string; ref?: string }): void => {
  const path = join(directory, 'profile.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), updates }, null, 2));
};

test('a packaged install follows the profile\'s update source: prepare copies it, status fetches and counts its origin/main', async (t) => {
  const f = await fixture(t);
  const upstream = codeCheckout(f.root);
  const clone = join(f.root, 'clone');
  execFileSync('git', ['clone', '-q', upstream, clone]);
  followUpdates(f.directory, { source: clone });

  const log: string[] = [];
  const plan = await prepareRelease(f.directory, { install: false, log: (line) => log.push(line) });
  assert.equal(plan.commit, gitIn(upstream, 'rev-parse', 'HEAD'));
  assert.ok(log.includes(`Taking the code from ${clone}`));
  mkdirSync(join(plan.release, 'node_modules/@slack/bolt'), { recursive: true });
  await activate(f.directory, f.opts);

  writeFileSync(join(upstream, 'README.md'), 'second'); gitIn(upstream, 'commit', '-qam', 'Second change');
  const offline = await releaseStatus(f.directory);
  assert.equal(offline.source, clone); assert.equal(offline.upstream, upstream); assert.equal(offline.ref, 'origin/main');
  assert.deepEqual(offline.newCommits, [], 'without a fetch the clone has not seen the new commit');
  const fetched = await releaseStatus(f.directory, { fetch: true });
  assert.equal(fetched.commitsProblem, null);
  assert.deepEqual(fetched.newCommits.map((c) => c.subject), ['Second change']);

  // Prepare copies the checkout as it is, and says when that isn't the branch Updates follows.
  log.length = 0;
  await prepareRelease(f.directory, { install: false, log: (line) => log.push(line) });
  assert.ok(log.some((line) => line.startsWith(`Note: ${clone} is at`)), log.join('\n'));
});

test('status says when the active release came from another repository\'s history', async (t) => {
  const f = await fixture(t);
  const code = codeCheckout(f.root);
  await activate(f.directory, f.opts);
  const active = JSON.parse(readFileSync(join(f.directory, 'active.json'), 'utf8'));
  writeFileSync(join(f.directory, 'active.json'), JSON.stringify({ ...active, commit: 'bfecea37a03cb5085312525b31eacb4a6a930cf2' }));
  followUpdates(f.directory, { source: code, ref: 'main' });
  const status = await releaseStatus(f.directory);
  assert.equal(status.ref, 'main'); assert.equal(status.upstream, null);
  assert.match(status.commitsProblem ?? '', /bfecea3 isn't in .*Build from main and restart the bot on it/);
});

test('activation preflight lists running jobs, newest activity first, without writing state', async (t) => {
  const f = await fixture(t);
  const job = (requester: string, watching: boolean, lastActivityAt?: string) => ({
    t3ThreadId: `thread-${requester}`, channel: 'C0123456789', threadTs: '1.0', requester, pendingReactionTs: null,
    lastPostedRunId: null, watching, createdAt: '2026-11-19T08:00:00.000Z', ...(lastActivityAt ? { lastActivityAt } : {}),
  });
  const state = JSON.stringify({
    'C0123456789:1.0': job('U0000000001', true, '2026-11-19T09:00:00.000Z'),
    'C0123456789:2.0': job('U0000000002', false, '2026-11-19T10:00:00.000Z'),
    'C0123456789:3.0': job('U0000000003', true, '2026-11-19T11:00:00.000Z'),
    'C0123456789:4.0': job('U0000000004', true),
  });
  writeFileSync(join(f.directory, 'state.json'), state);
  const preflight = activationPreflight(f.directory);
  assert.deepEqual(preflight.problems, []);
  assert.equal(preflight.prepared?.release, f.plan.release);
  assert.deepEqual(preflight.runningJobs.map((j) => j.requester), ['U0000000003', 'U0000000001', 'U0000000004']);
  assert.equal(preflight.runningJobs[2]!.lastActivityAt, '2026-11-19T08:00:00.000Z');
  assert.equal(readFileSync(join(f.directory, 'state.json'), 'utf8'), state);

  rmSync(join(f.plan.release, 'node_modules'), { recursive: true });
  assert.deepEqual(activationPreflight(f.directory).problems, ['Prepared dependencies missing. Run prepare again.']);
  rmSync(join(f.directory, 'prepared.json'));
  assert.deepEqual(activationPreflight(f.directory).problems, ['No prepared release. Run prepare first.']);
});

test('expect checks the plan under the lock and refuses before anything changes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(activate(f.directory, { ...f.opts, expect: (plan) => { if (!plan.fromApp) throw new Error('not the app build'); } }), /not the app build/);
  assert.deepEqual(f.events, [], 'not even the health checks ran');
  assert.equal(existsSync(join(f.directory, 'activation.json')), false);
});

test('activate streams its steps; a refused activation changes nothing', async (t) => {
  const f = await fixture(t);
  const lines: string[] = [];
  const refused = await activateRelease(f.directory, { ...f.opts, log: (line) => lines.push(line), preflight: async () => { throw new Error('GitHub unavailable'); } });
  assert.deepEqual(refused, { ok: false, stage: 'checks', error: 'GitHub unavailable', restored: true, rollbackAvailable: false });
  assert.deepEqual(f.events, []);
  lines.length = 0;
  const outcome = await activateRelease(f.directory, { ...f.opts, log: (line) => lines.push(line) });
  assert.deepEqual(outcome, { ok: true, release: f.plan.release });
  assert.deepEqual(lines.map((line) => line.split(' ')[0]), ['Checking', 'Running', 'Stopping', 'Starting', 'Waiting', 'Bot']);
  // The first activation has nothing before it: rollback refuses instead of stopping the only bot.
  assert.equal(canRollBack(f.directory), false);
  assert.deepEqual(await rollbackRelease(f.directory, f.opts), { ok: false, error: 'Nothing to roll back to: this is the first release installed for this profile' });
  assert.equal(existsSync(join(f.directory, 'active.json')), true);

  const next = await prepareNextRelease(f.directory, { install: false });
  mkdirSync(join(next.release, 'node_modules/@slack/bolt'), { recursive: true });
  assert.deepEqual(await activateRelease(f.directory, f.opts), { ok: true, release: next.release });
  assert.equal(canRollBack(f.directory), true);
  lines.length = 0;
  assert.deepEqual(await rollbackRelease(f.directory, { ...f.opts, log: (line) => lines.push(line) }), { ok: true, release: f.plan.release });
  assert.equal(lines.at(-1), 'Previous installation restored.');
  assert.deepEqual(await rollbackRelease(f.directory, f.opts), { ok: false, error: 'Already rolled back' });
});

test('a failed start restores the previous bot, and offers rollback when the restore fails too', async (t) => {
  const f = await fixture(t); f.failReady();
  const lines: string[] = [];
  const restored = await activateRelease(f.directory, { ...f.opts, log: (line) => lines.push(line) });
  assert.equal(restored.ok, false);
  assert.ok(!restored.ok && restored.stage === 'cutover' && restored.restored && !restored.rollbackAvailable);
  assert.ok(lines.includes('Restoring the previous installation'));
  assert.equal((await releaseStatus(f.directory)).canRollback, false);

  // The automatic restore can't stop the new bot either: the owner is offered rollback.
  const next = await prepareNextRelease(f.directory, { install: false });
  mkdirSync(join(next.release, 'node_modules/@slack/bolt'), { recursive: true });
  let stops = 0;
  f.driver.stop = async () => { f.events.push('stop'); if (stops++ === 1) throw new Error('bootout hung'); };
  const stuck = await activateRelease(f.directory, f.opts);
  assert.ok(!stuck.ok && stuck.stage === 'cutover' && !stuck.restored && stuck.rollbackAvailable);
  assert.match(stuck.ok ? '' : stuck.error, /Run rollback/);
  const status = await releaseStatus(f.directory);
  assert.equal(status.activation, 'switching'); assert.equal(status.canRollback, true);
  assert.match(activationPreflight(f.directory).problems[0] ?? '', /needs rollback first/);
  assert.deepEqual(await rollbackRelease(f.directory, f.opts), { ok: true, release: null });
  assert.equal(f.events.at(-1), 'stop', 'there was no earlier service to start again');
  assert.equal(existsSync(join(f.agents, `${f.label}.plist`)), false);
});

test('rollback with nothing activated says so', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await rollbackRelease(f.directory, f.opts), { ok: false, error: 'Nothing to roll back: no release was activated for this profile' });
});

test('the release records and uses the given Node binary, and refuses to default to Electron', async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(f.directory, { install: false, node: '/opt/node/bin/node' });
  assert.equal(plan.node, '/opt/node/bin/node');
  assert.match(readFileSync(join(plan.release, 'service.plist'), 'utf8'), /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(readFileSync(join(f.directory, 'activate.sh'), 'utf8'), /exec '\/opt\/node\/bin\/node' /);
  assert.equal(defaultNode(), process.execPath);
  Object.defineProperty(process.versions, 'electron', { value: '45.4.1', configurable: true });
  try {
    assert.throws(() => defaultNode(), /pass the Node binary path/);
    assert.throws(() => servicePlist({ directory: '/tmp/p', release: '/tmp/r', label: 'dev.serra.test' }), /Electron/);
    await assert.rejects(prepareRelease(f.directory, { install: false }), /Electron/);
    // The app's wrapper finds a real Node instead: here the one the prepared release already uses.
    const fake = join(f.root, 'bin'); mkdirSync(fake);
    writeFileSync(join(fake, 'node'), '#!/bin/sh\necho "24.1.0 "\n'); chmodSync(join(fake, 'node'), 0o755);
    writeFileSync(join(f.directory, 'prepared.json'), JSON.stringify({ ...plan, node: join(fake, 'node') }));
    const next = await prepareNextRelease(f.directory, { install: false });
    assert.equal(next.node, join(fake, 'node'));
  } finally { delete (process.versions as Record<string, string | undefined>).electron; }
});

test('findNode skips Electron, old Node and files not named node', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-node-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = (dir: string, name: string, output: string): string => {
    mkdirSync(join(root, dir), { recursive: true });
    const path = join(root, dir, name); writeFileSync(path, `#!/bin/sh\necho "${output}"\n`); chmodSync(path, 0o755); return path;
  };
  const electron = fake('electron', 'node', '24.22.3 45.4.1');
  const old = fake('old', 'node', '20.11.0 ');
  const wrongName = fake('named', 'Electron', '24.22.3 ');
  const good = fake('good', 'node', '24.1.0 ');
  assert.equal(await findNode(root, { candidates: [electron, old, wrongName, join(root, 'missing/node'), good] }), good);
  await assert.rejects(findNode(root, { candidates: [electron, old] }), /No supported Node.*Electron.*Node 20\.11\.0/);
  assert.equal(supportedNode('22.18.0'), true); assert.equal(supportedNode('22.17.1'), false);
  assert.equal(supportedNode('23.1.0'), false); assert.equal(supportedNode('24.0.0'), true);
});

// QA: on a Mac with Node from nvm or nodejs.org, `corepack` sits next to `node` but there is no `pnpm` command, and
// the wizard's Install and Updates › Prepare stopped at "spawn pnpm ENOENT".
const fakeBin = (dir: string, name: string, script = 'exit 0'): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
};

test('pnpmCommand uses pnpm from PATH, then Corepack next to Node, and says what to do when neither is there', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-pnpm-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const withPnpm = join(root, 'a'); const withCorepack = join(root, 'b'); const empty = join(root, 'c');
  fakeBin(withPnpm, 'pnpm'); fakeBin(withCorepack, 'corepack'); mkdirSync(empty);
  writeFileSync(join(empty, 'pnpm'), 'not executable', { mode: 0o644 });
  assert.deepEqual(pnpmCommand(`${withCorepack}:${withPnpm}`), { cmd: 'pnpm', args: [] });
  assert.deepEqual(pnpmCommand(`${empty}:${withCorepack}`), { cmd: 'corepack', args: ['pnpm'] });
  assert.throws(() => pnpmCommand(`${empty}::`), /neither pnpm nor corepack is on PATH.*corepack enable/);
});

test('prepare installs the release through corepack pnpm when only Corepack is on PATH', async (t) => {
  const f = await fixture(t);
  const bin = mkdtempSync(join(tmpdir(), 'bots-corepack-')); t.after(() => rmSync(bin, { recursive: true, force: true }));
  const calls = join(bin, 'calls.txt');
  fakeBin(bin, 'corepack', `echo "$COREPACK_ENABLE_DOWNLOAD_PROMPT $*" >> ${JSON.stringify(calls)}`);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  t.after(() => { process.env.PATH = path; });
  const lines: string[] = [];
  const plan = await prepareRelease(f.directory, { log: (line) => lines.push(line) });
  assert.equal(readFileSync(calls, 'utf8').trim(), `0 pnpm --dir ${plan.release} install --prod --frozen-lockfile --ignore-scripts`);
  assert.ok(lines.includes('Installing production dependencies'));
});

test('startupError reports the error the daemon logged during this start, ignoring older runs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-startup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'bot.log');
  const since = Date.now();
  const old = new Date(since - 60_000).toISOString(); const now = new Date(since + 10).toISOString();
  writeFileSync(log, `${old} [ERROR] bolt-app An old failure\n`);
  assert.equal(startupError(log, since), undefined);
  writeFileSync(log, `${old} [ERROR] bolt-app An old failure\n${now} [INFO] bolt-app starting\n${now} [ERROR] bolt-app Can't read the repository /x (git timed out)\n`);
  assert.equal(startupError(log, since), "Can't read the repository /x (git timed out)");
  assert.equal(startupError(join(dir, 'missing.log'), since), undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// Prepare from the packaged app (Contents/Resources/app has no src/; Contents/Resources/release-source has)
// ---------------------------------------------------------------------------------------------------------------

test('prepare in a packaged app copies the release from release-source, with its own package.json', async (t) => {
  const f = await fixture(t);
  const app = join(f.root, 'Serra.app/Contents/Resources/app');
  mkdirSync(join(app, 'app/out/main'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"serra","main":"app/out/main/index.mjs"}');
  cpSync(join(codeRoot, 'templates'), join(app, 'templates'), { recursive: true });
  assert.throws(() => releaseSourceRoot(app), /missing src, .*Rebuild the app with pnpm app:package/);

  const shipped = join(app, '..', PACKAGED_SOURCE);
  for (const name of ['src', 'templates', 'examples', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']) cpSync(join(codeRoot, name), join(shipped, name), { recursive: true });
  assert.equal(releaseSourceRoot(app), join(f.root, 'Serra.app/Contents/Resources', PACKAGED_SOURCE));
  assert.equal(releaseSourceRoot(codeRoot), codeRoot, 'a checkout releases itself');

  const plan = await prepareRelease(f.directory, { root: app, install: false });
  assert.ok(existsSync(join(plan.release, 'src/index.ts')));
  assert.equal(readFileSync(join(plan.release, 'package.json'), 'utf8'), readFileSync(join(codeRoot, 'package.json'), 'utf8'), 'the pristine package.json, matching the lockfile');
  assert.ok(!existsSync(join(plan.release, 'docs')), 'optional folders the package leaves out are skipped');
  assert.equal(plan.commit, undefined, 'no git in the package');
  const version = JSON.parse(readFileSync(join(codeRoot, 'package.json'), 'utf8')).version;
  assert.equal(plan.appVersion, version, 'the version comes from the shipped package.json');

  // `pnpm app:build` records the version and commit the copy was built from, so the release can name them.
  const commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  writeFileSync(join(shipped, RELEASE_INFO), JSON.stringify({ version: '9.9.9-alpha.1', commit }));
  const labelled = await prepareRelease(f.directory, { root: app, install: false });
  assert.equal(labelled.appVersion, '9.9.9-alpha.1');
  assert.equal(labelled.commit, commit);
});

test('activation removes old releases but keeps the active one, the one before it and a prepared one', async (t) => {
  const f = await fixture(t);
  const releases: string[] = [f.plan.release];
  for (let i = 0; i < 3; i++) {
    await activate(f.directory, f.opts);
    await new Promise((done) => setTimeout(done, 2));
    const next = await prepareRelease(f.directory, { install: false });
    mkdirSync(join(next.release, 'node_modules/@slack/bolt'), { recursive: true });
    releases.push(next.release);
  }
  // Activating the 3rd removed the 1st: active 3rd, previous 2nd, prepared 4th.
  assert.deepEqual(releases.map((path) => existsSync(path)), [false, true, true, true]);
  const stray = join(f.directory, 'releases', 'notes'); mkdirSync(stray);
  // A build another process is still making (its marker names a live PID) stays, even when older than the active one.
  const inProgress = join(f.directory, 'releases', '2000-01-01T00-00-00-000Z-1'); mkdirSync(inProgress);
  writeFileSync(`${inProgress}.building`, String(process.pid));
  const abandoned = join(f.directory, 'releases', '2000-01-01T00-00-00-000Z-2'); mkdirSync(abandoned);
  writeFileSync(`${abandoned}.building`, '999999');
  assert.deepEqual(pruneReleases(f.directory), [abandoned], 'a marker whose process is gone does not protect it');
  assert.equal(existsSync(`${abandoned}.building`), false, 'and the stale marker is swept');
  assert.ok(existsSync(inProgress));
  rmSync(`${inProgress}.building`);
  assert.deepEqual(pruneReleases(f.directory), [inProgress]);
  assert.deepEqual(pruneReleases(f.directory), [], 'nothing else is old, and folders not named like a release stay');
  await activate(f.directory, f.opts);
  assert.deepEqual(releases.map((path) => existsSync(path)), [false, false, true, true]);
  assert.ok(existsSync(stray));
});

test('stageReleaseSource skips files a checkout lacks, like release.json', (t) => {
  const to = mkdtempSync(join(tmpdir(), 'bots-stage-')); t.after(() => rmSync(to, { recursive: true, force: true }));
  stageReleaseSource(codeRoot, to);
  assert.ok(existsSync(join(to, 'src/index.ts')));
  assert.equal(existsSync(join(to, RELEASE_INFO)), existsSync(join(codeRoot, RELEASE_INFO)));
});

test('prepare names what is missing when neither the root nor release-source has the code', async (t) => {
  const f = await fixture(t);
  const app = join(f.root, 'bare/app'); mkdirSync(app, { recursive: true });
  await assert.rejects(prepareRelease(f.directory, { root: app, install: false }), /isn't in .*bare\/app or .*bare\/release-source \(missing src, templates, examples, package\.json, pnpm-lock\.yaml, tsconfig\.json\)/);
});

test('prepare finds corepack next to the release\'s Node when PATH has neither (the app opened from Finder)', async (t) => {
  const f = await fixture(t);
  const nodeDir = mkdtempSync(join(tmpdir(), 'bots-nvm-')); t.after(() => rmSync(nodeDir, { recursive: true, force: true }));
  const calls = join(nodeDir, 'calls.txt');
  fakeBin(nodeDir, 'node');
  fakeBin(nodeDir, 'corepack', `echo "$(command -v node) $(pwd -P) $*" >> ${JSON.stringify(calls)}`);
  const path = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  t.after(() => { process.env.PATH = path; });
  const plan = await prepareRelease(f.directory, { node: join(nodeDir, 'node') });
  assert.equal(readFileSync(calls, 'utf8').trim(), `${join(nodeDir, 'node')} ${realpathSync(plan.release)} pnpm --dir ${plan.release} install --prod --frozen-lockfile --ignore-scripts`,
    'corepack runs with that Node on its PATH, from the release, so it reads the pinned pnpm version there');
});

test('nvmNodes lists nvm\'s Node installs newest first, for an app opened from Finder', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-nvm-root-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const version of ['v22.18.0', 'v24.2.0', 'v24.10.1', 'not-a-version']) mkdirSync(join(root, version, 'bin'), { recursive: true });
  assert.deepEqual(nvmNodes(root), ['v24.10.1', 'v24.2.0', 'v22.18.0'].map((version) => join(root, version, 'bin/node')));
  assert.deepEqual(nvmNodes(join(root, 'missing')), []);
});
