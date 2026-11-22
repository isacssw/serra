// SERRA-63: moving owners from manual installs and alpha.2's update source to in-app updates, without losing data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { botSyncDecision, type BotSyncInput } from '../app/main/bot-sync.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { updatesHandlers, updatesService } from '../app/main/ipc/updates.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { botLine, clearedLine, followDialog, noteLines, UPGRADE_NOTE_START } from '../app/renderer/screens/updates.logic.ts';
import { releaseNotes, UPGRADE_NOTE } from '../scripts/release.ts';
import { createProfile } from '../src/setup.ts';
import { classifySource, clearUpdateSource, migrateStaleUpdateSource } from '../src/update-migration.ts';

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-update-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'profile');
  const project = join(root, 'project');
  mkdirSync(project);
  execFileSync('git', ['init', '-q', project]);
  createProfile(directory, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  // The owner's data, which no migration may touch.
  mkdirSync(join(directory, 'knowledge/owner'), { recursive: true });
  const data: Record<string, string> = {
    'knowledge/owner/about.md': '---\naudience: owner\n---\nLikes small PRs.\n',
    'state.json': '{"version":1,"threads":{}}\n',
    'secrets.json': '{"version":1,"SLACK_BOT_TOKEN":{"keychain":{"service":"dev.serra.friday","account":"bot"}}}\n',
    '.env': 'SLACK_APP_TOKEN=xapp-fixture\n',
  };
  for (const [name, text] of Object.entries(data)) writeFileSync(join(directory, name), text);
  const checkout = join(root, 'serra');
  mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  writeFileSync(join(checkout, 'package.json'), '{"name":"serra"}');
  const setSource = (source: string): void => {
    const path = join(directory, 'profile.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), updates: { source } }, null, 2));
  };
  const unchanged = (): void => { for (const [name, text] of Object.entries(data)) assert.equal(readFileSync(join(directory, name), 'utf8'), text, `${name} is kept`); };
  const profile = (): { updates?: unknown } => JSON.parse(readFileSync(join(directory, 'profile.json'), 'utf8'));
  return { root, directory, checkout, setSource, unchanged, profile };
};

test('an update source is Serra’s code, clearly unusable, or unknown, and only clear evidence counts', (t) => {
  const f = fixture(t);
  assert.equal(classifySource(f.checkout), 'checkout');
  const dir = (name: string, files: Record<string, string> = {}): string => {
    const path = join(f.root, name);
    mkdirSync(path, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
    return path;
  };
  // A worktree has a .git file; a plain copy of Serra (no git) still builds in developer mode.
  assert.equal(classifySource(dir('worktree', { '.git': 'gitdir: /somewhere\n', 'package.json': '{"name":"serra"}' })), 'checkout');
  assert.equal(classifySource(dir('download', { 'package.json': '{"name":"serra"}' })), 'checkout');
  assert.equal(classifySource(dir('web.app/serra', { '.git': '', 'package.json': '{"name":"serra"}' })), 'checkout', 'a folder named .app is not a bundle');

  assert.equal(classifySource(join(f.root, 'gone')), 'missing');
  assert.equal(classifySource('/Applications/Serra.app/Contents/Resources/app'), 'inside-app');
  assert.equal(classifySource(dir('acme', { 'package.json': '{"name":"acme"}' })), 'not-a-checkout', 'another package, no git');
  // An empty folder may be a mount point waiting for its disk, and so may the nearest folder above a missing one.
  assert.equal(classifySource(dir('empty')), 'unknown');
  dir('mnt');
  assert.equal(classifySource(join(f.root, 'mnt/serra')), 'unknown');

  // Anything it can't be sure of stays.
  assert.equal(classifySource('/Volumes/Work/serra'), 'unknown', 'a disk that may not be connected is not read');
  assert.equal(classifySource(dir('fork', { '.git': '', 'package.json': '{"name":"serra-fork"}' })), 'unknown', 'a renamed fork');
  assert.equal(classifySource(dir('rebasing', { '.git': '', 'package.json': '<<<<<<< HEAD\n' })), 'unknown', 'a package.json mid-conflict');
  symlinkSync(join(f.root, 'unplugged/serra'), join(f.root, 'link'));
  assert.equal(classifySource(join(f.root, 'link')), 'unknown', 'a link to something absent');
  // A folder above it that is a link to something absent (an unplugged disk), or a repository above it (a monorepo).
  symlinkSync(join(f.root, 'unplugged/work'), join(f.root, 'work'));
  assert.equal(classifySource(join(f.root, 'work/serra')), 'unknown');
  symlinkSync(join(f.root, 'acme'), join(f.root, 'linked-acme'));
  assert.equal(classifySource(join(f.root, 'linked-acme/gone')), 'missing', 'a link that resolves is just a folder');
  dir('mono/.git');
  assert.equal(classifySource(dir('mono/packages/tool', { 'package.json': '{"name":"tool"}' })), 'unknown');
  const locked = dir('locked/serra', { '.git': '', 'package.json': '{"name":"serra"}' });
  chmodSync(join(f.root, 'locked'), 0o000);
  try { if (process.getuid?.() !== 0) assert.equal(classifySource(locked), 'unknown', 'unreadable (permissions, macOS privacy)'); }
  finally { chmodSync(join(f.root, 'locked'), 0o755); }
});

test('a packaged app clears an update source that can never work, after a backup, and keeps everything else', (t) => {
  const f = fixture(t);
  f.setSource('/Applications/Serra.app/Contents/Resources/app');
  const before = readFileSync(join(f.directory, 'profile.json'), 'utf8');
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: false }), null, 'a copy run from source never migrates');
  assert.ok(f.profile().updates);

  const done = migrateStaleUpdateSource(f.directory, { packaged: true, now: new Date('2026-11-22T10:00:00.000Z') });
  assert.ok(done);
  assert.equal(done.source, '/Applications/Serra.app/Contents/Resources/app');
  assert.match(done.reason, /inside the Serra app/);
  assert.equal(done.backup, join(f.directory, 'backups', '2026-11-22T10-00-00-000Z-update-source'));
  assert.equal(readFileSync(join(done.backup, 'profile.json'), 'utf8'), before, 'the backup is the profile as it was');
  assert.equal(f.profile().updates, undefined);
  f.unchanged();
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: true }), null, 'nothing left to clear');
});

test('a source changed after it was looked at is not cleared', (t) => {
  const f = fixture(t);
  f.setSource(f.checkout);
  assert.equal(clearUpdateSource(f.directory, 'stale', new Date(), '/somewhere/else'), null);
  assert.deepEqual(f.profile().updates, { source: f.checkout });
  assert.ok(!existsSync(join(f.directory, 'backups')), 'no backup either');
});

test('a real checkout, or one on a disk that is not connected, is the owner’s choice and stays', (t) => {
  const f = fixture(t);
  f.setSource(f.checkout);
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: true }), null);
  assert.deepEqual(f.profile().updates, { source: f.checkout });
  f.setSource('/Volumes/Work/serra');
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: true }), null);
  assert.deepEqual(f.profile().updates, { source: '/Volumes/Work/serra' });
  f.setSource(join(f.root, 'deleted-clone'));
  assert.match(migrateStaleUpdateSource(f.directory, { packaged: true })?.reason ?? '', /the folder is gone/);
});

test('a profile that does not validate is left exactly as it is, and the failure is logged', (t) => {
  const f = fixture(t);
  const logged: string[] = [];
  const path = join(f.directory, 'profile.json');
  const broken = JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version: 2, updates: { source: '/nowhere' } });
  writeFileSync(path, broken);
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: true, log: (line) => logged.push(line) }), null);
  assert.equal(readFileSync(path, 'utf8'), broken);
  assert.match(logged.join('\n'), /^Couldn't clear the update source \/nowhere: .*version/);
  assert.throws(() => clearUpdateSource(f.directory), /version/);
  assert.equal(readFileSync(path, 'utf8'), broken);
  assert.ok(!existsSync(join(f.directory, 'backups')) || readdirSync(join(f.directory, 'backups')).length === 0, 'no backup without a change');
});

const contextFor = (profileDir: string, packaged: boolean): HandlerContext => ({
  profileDir: () => profileDir,
  profileDirOrNull: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.1.0-alpha.4', electron: '45.0.0', node: '22.20.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
  botFollowsApp: packaged,
});

test('the Updates screen: a stale source is cleared once per launch and said in one line; Follow app updates leaves developer mode', async (t) => {
  const f = fixture(t);
  f.setSource(join(f.root, 'deleted-clone'));
  let clock = Date.parse('2026-11-22T10:00:00.000Z');
  const handlers = updatesHandlers(contextFor(f.directory, true), { echo: () => {}, now: () => clock });
  // A missing folder may only be being moved: the first look keeps it, a look a minute later clears it.
  assert.equal((await handlers.status()).releases?.mode, 'developer');
  clock += 30_000;
  assert.equal((await handlers.status()).releases?.mode, 'developer', 'not yet a minute');
  clock += 31_000;
  const status = await handlers.status();
  assert.equal(status.releases?.mode, 'release');
  assert.equal(status.followsApp, true);
  assert.equal(status.sourceCleared?.source, join(f.root, 'deleted-clone'));
  assert.equal(clearedLine(status.sourceCleared!, f.root), 'Cleared the old update source ~/deleted-clone (the folder is gone), so the bot follows app updates again. profile.json was backed up first.');

  // The notice outlives a restart, for a week.
  const restarted = updatesHandlers(contextFor(f.directory, true), { echo: () => {}, now: () => clock + 6 * 24 * 60 * 60_000 });
  assert.equal((await restarted.status()).sourceCleared?.source, join(f.root, 'deleted-clone'));
  const later = updatesHandlers(contextFor(f.directory, true), { echo: () => {}, now: () => clock + 8 * 24 * 60 * 60_000 });
  assert.equal((await later.status()).sourceCleared, null);

  // A checkout the owner set on purpose stays until they choose otherwise.
  f.setSource(f.checkout);
  const developer = updatesHandlers(contextFor(f.directory, true), { echo: () => {}, now: () => clock + 60 * 60_000 });
  const before = await developer.status();
  assert.equal(before.releases?.mode, 'developer');
  assert.equal(before.sourceCleared, null, 'no notice in developer mode');
  assert.ok(existsSync(status.sourceCleared!.backup), 'the backup is kept');
  assert.ok(!existsSync(join(status.sourceCleared!.backup, 'cleared.json')), 'its notice is dropped once a source is set again');
  const done = await developer.followApp();
  assert.equal(done?.source, f.checkout);
  assert.equal(done?.reason, '');
  assert.ok(existsSync(join(done!.backup, 'profile.json')));
  const after = await developer.status();
  assert.equal(after.releases?.mode, 'release');
  assert.equal(after.sourceCleared, null, 'the owner asked: no notice, and the older automatic one no longer applies');
  assert.equal(await developer.followApp(), null, 'nothing left to clear');
  f.unchanged();

  // A copy run from source never clears anything.
  f.setSource(join(f.root, 'deleted-clone'));
  const source = await updatesHandlers(contextFor(f.directory, false), { echo: () => {} }).status();
  assert.equal(source.releases?.mode, 'developer');
  assert.equal(source.followsApp, false);
  assert.equal(source.sourceCleared, null);
});

test('the follow dialog says what is removed, that the folder stays, and when the bot moves', () => {
  const body = followDialog('0.1.0-alpha.4').body;
  assert.match(body, /removes the checkout path and branch from Settings › Worker and backs up profile\.json; the folder isn't touched/);
  assert.match(body, /The bot then moves to 0\.1\.0-alpha\.4 once no job is running, unless it's stopped or already newer\.$/);
});

const input = (patch: Partial<BotSyncInput> = {}): BotSyncInput => ({
  mode: 'release', follows: true, serviceLoaded: true, appVersion: '0.1.0-alpha.4', active: { appVersion: '0.1.0-alpha.3', fromApp: true }, prepared: null, preparedReady: false,
  activation: 'active', jobs: 1, running: null, failed: null, paused: false, mayPause: true, ...patch,
});

test('a bot from before alpha.3 ignores the pause, so the screen does not promise that requests wait', () => {
  const old = botSyncDecision(input({ active: {}, honorsPause: false }));
  assert.deepEqual(old, { sync: { state: 'waiting', from: null, to: '0.1.0-alpha.4', jobs: 1, paused: false }, action: 'pause' });
  assert.doesNotMatch(botLine(old.sync)!.detail, /New requests wait/);
  assert.deepEqual(botSyncDecision(input({ active: {}, honorsPause: false, paused: true })).sync, { state: 'waiting', from: null, to: '0.1.0-alpha.4', jobs: 1, paused: false });
  const current = botSyncDecision(input({ honorsPause: true }));
  assert.match(botLine(current.sync)!.detail, /New requests wait until then/);
});

test('release notes end with how to upgrade by hand, which the app leaves out', () => {
  const notes = releaseNotes('# Changelog\n\n## 0.1.0-alpha.4 (2026-11-23)\n\n- Smoother upgrades.\n\n## 0.1.0-alpha.3 (2026-11-21)\n\n- Older.\n', '0.1.0-alpha.4');
  assert.equal(notes, `- Smoother upgrades.\n\n${UPGRADE_NOTE}`);
  assert.match(UPGRADE_NOTE, /github\.com\/isacssw\/serra#updating/);
  assert.deepEqual(noteLines(notes).map((line) => line.text), ['Smoother upgrades.'], 'the app updates itself: the manual-install line is left out');
  assert.ok(UPGRADE_NOTE.startsWith(UPGRADE_NOTE_START), 'the app recognises the footer');
  assert.deepEqual(noteLines('- One.\n\n---\n\n- Two.\n').map((line) => line.text), ['One.', 'Two.'], 'any other rule keeps what follows');
});

test('with a bot from before alpha.3 running a job, Updates and its log make no promise about new requests', async (t) => {
  const f = fixture(t);
  // alpha.2's active.json: no appVersion, no fromApp.
  const record = { version: 1, releaseHash: 'sha256-fixture', releaseFiles: ['src/index.ts'], label: 'dev.serra.friday', node: '/opt/homebrew/bin/node' };
  writeFileSync(join(f.directory, 'active.json'), JSON.stringify({ ...record, release: join(f.directory, 'releases/old') }));
  writeFileSync(join(f.directory, 'state.json'), JSON.stringify({
    'C0123456789:1.000': {
      t3ThreadId: 't3-1', channel: 'C0123456789', threadTs: '1.000', requester: 'U0123456789', pendingReactionTs: null, lastPostedRunId: null,
      watching: true, createdAt: '2026-11-21T10:00:00.000Z',
    },
  }));
  const log: string[] = [];
  const driver = { loaded: async () => true, stop: async () => {}, start: async () => {}, ready: async () => {} };
  const { handlers, tick } = updatesService({ ...contextFor(f.directory, true), every: () => {} }, { echo: (line) => log.push(line), deploy: { driver } });
  const before = await handlers.status();
  assert.deepEqual(before.bot, { state: 'waiting', from: null, to: '0.1.0-alpha.4', jobs: 1, paused: false });
  assert.doesNotMatch(botLine(before.bot)!.detail, /New requests wait/);
  await tick();
  assert.deepEqual(log, ['The bot restarts once the running jobs finish.']);
  assert.deepEqual((await handlers.status()).bot, { state: 'waiting', from: null, to: '0.1.0-alpha.4', jobs: 1, paused: false }, 'still no promise once paused');

  // A build that has the intake pause holds new requests, whatever version it reports (main said alpha.2 for a while).
  const release = join(f.directory, 'releases/new');
  mkdirSync(join(release, 'src'), { recursive: true });
  writeFileSync(join(release, 'src/intake.ts'), '');
  writeFileSync(join(f.directory, 'active.json'), JSON.stringify({ ...record, release, appVersion: '0.1.0-alpha.2', fromApp: true }));
  const holding = await updatesService({ ...contextFor(f.directory, true), every: () => {} }, { echo: () => {}, deploy: { driver } }).handlers.status();
  assert.equal(holding.bot.state === 'waiting' && holding.bot.paused, true);
  assert.match(botLine(holding.bot)!.detail, /New requests wait until then/);
});

test('a folder that is not Serra’s code is cleared only if it still is a minute later (it may be mid-copy)', async (t) => {
  const f = fixture(t);
  const copying = join(f.root, 'copying');
  mkdirSync(copying);
  writeFileSync(join(copying, 'README.md'), '# Serra\n');
  f.setSource(copying);
  let clock = Date.parse('2026-11-22T10:00:00.000Z');
  const handlers = updatesHandlers(contextFor(f.directory, true), { echo: () => {}, now: () => clock });
  assert.equal((await handlers.status()).releases?.mode, 'developer');
  writeFileSync(join(copying, 'package.json'), '{"name":"serra"}');
  clock += 61_000;
  assert.equal((await handlers.status()).releases?.mode, 'developer', 'the copy finished: it is Serra’s code now, and stays');
  assert.deepEqual(f.profile().updates, { source: copying });
});
