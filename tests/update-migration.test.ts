// SERRA-63: moving owners from manual installs and alpha.2's update source to in-app updates, without losing data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { botSyncDecision, type BotSyncInput } from '../app/main/bot-sync.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { updatesHandlers } from '../app/main/ipc/updates.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { botLine, clearedLine, followDialog, noteLines } from '../app/renderer/screens/updates.logic.ts';
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

test('an update source is a Serra checkout, missing, inside an app, or something else', (t) => {
  const f = fixture(t);
  assert.equal(classifySource(f.checkout), 'checkout');
  // A worktree has a .git file, not a folder.
  const worktree = join(f.root, 'worktree');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere\n');
  writeFileSync(join(worktree, 'package.json'), '{"name":"serra"}');
  assert.equal(classifySource(worktree), 'checkout');
  assert.equal(classifySource(join(f.root, 'gone')), 'missing');
  assert.equal(classifySource('/Applications/Serra.app/Contents/Resources/app'), 'inside-app');
  assert.equal(classifySource(f.directory), 'not-a-checkout', 'a folder without git');
  const other = join(f.root, 'other');
  mkdirSync(other);
  execFileSync('git', ['init', '-q', other]);
  writeFileSync(join(other, 'package.json'), '{"name":"other"}');
  assert.equal(classifySource(other), 'not-a-checkout', 'another repository');
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

test('a real checkout, or one on a disk that is not connected, is the owner’s choice and stays', (t) => {
  const f = fixture(t);
  f.setSource(f.checkout);
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: true }), null);
  assert.deepEqual(f.profile().updates, { source: f.checkout });
  f.setSource('/Volumes/Work/serra');
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: true }), null);
  assert.deepEqual(f.profile().updates, { source: '/Volumes/Work/serra' });
  f.setSource(join(f.root, 'deleted-clone'));
  assert.match(migrateStaleUpdateSource(f.directory, { packaged: true })?.reason ?? '', /doesn't exist/);
});

test('a profile that does not validate is left exactly as it is', (t) => {
  const f = fixture(t);
  const path = join(f.directory, 'profile.json');
  const broken = JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version: 2, updates: { source: '/nowhere' } });
  writeFileSync(path, broken);
  assert.equal(migrateStaleUpdateSource(f.directory, { packaged: true }), null);
  assert.equal(readFileSync(path, 'utf8'), broken);
  assert.throws(() => clearUpdateSource(f.directory), /version/);
  assert.equal(readFileSync(path, 'utf8'), broken);
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

test('the Updates screen: a stale source is cleared at launch and said once; Follow app updates leaves developer mode', async (t) => {
  const f = fixture(t);
  f.setSource(join(f.root, 'deleted-clone'));
  const handlers = updatesHandlers(contextFor(f.directory, true), { echo: () => {} });
  const status = await handlers.status();
  assert.equal(status.releases?.mode, 'release');
  assert.equal(status.followsApp, true);
  assert.equal(status.sourceCleared?.source, join(f.root, 'deleted-clone'));
  assert.match(clearedLine(status.sourceCleared!), /^Developer mode is off: the update source .* was cleared because the folder doesn't exist any more\. The bot follows the app again\. The old profile\.json is in .*backups/);

  // A checkout the owner set on purpose stays until they choose otherwise.
  f.setSource(f.checkout);
  const developer = updatesHandlers(contextFor(f.directory, true), { echo: () => {} });
  const before = await developer.status();
  assert.equal(before.releases?.mode, 'developer');
  assert.equal(before.sourceCleared, null);
  const done = await developer.followApp();
  assert.equal(done?.source, f.checkout);
  assert.equal(done?.reason, '');
  assert.ok(existsSync(join(done!.backup, 'profile.json')));
  const after = await developer.status();
  assert.equal(after.releases?.mode, 'release');
  assert.equal(clearedLine(after.sourceCleared!), `Developer mode is off. The bot follows the app again. The old profile.json is in ${done!.backup}.`);
  assert.equal(await developer.followApp(), null, 'nothing left to clear');
  f.unchanged();

  // A copy run from source never clears anything.
  f.setSource(join(f.root, 'deleted-clone'));
  const source = await updatesHandlers(contextFor(f.directory, false), { echo: () => {} }).status();
  assert.equal(source.releases?.mode, 'developer');
  assert.equal(source.followsApp, false);
  assert.equal(source.sourceCleared, null);
});

test('the follow dialog names the version the bot moves to', () => {
  assert.match(followDialog('0.1.0-alpha.4').body, /moves to 0\.1\.0-alpha\.4 and then follows each app update/);
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

test('release notes end with how to upgrade, and the app shows them without the rule', () => {
  const notes = releaseNotes('# Changelog\n\n## 0.1.0-alpha.4 (2026-11-23)\n\n- Smoother upgrades.\n\n## 0.1.0-alpha.3 (2026-11-21)\n\n- Older.\n', '0.1.0-alpha.4');
  assert.equal(notes, `- Smoother upgrades.\n\n---\n\n${UPGRADE_NOTE}`);
  assert.match(UPGRADE_NOTE, /github\.com\/isacssw\/serra#updating/);
  assert.deepEqual(noteLines(notes).map((line) => line.text), ['Smoother upgrades.', UPGRADE_NOTE.replace(/\[([^\]]+)\]\([^)]*\)/, '$1')]);
});
