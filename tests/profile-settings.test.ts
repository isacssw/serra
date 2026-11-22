import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AtomicWriteIo, Profile, ProfileSection } from '../src/contracts.ts';
import { runCli } from '../src/manage.ts';
import {
  addAllowedUser, listPeople, PROFILE_SECTIONS, readProfileSettings, removeAllowedUser,
  updateProfileSection,
} from '../src/profile-settings.ts';

const OWNER = 'U0123456789';
const MEMBER = 'U0000000001';

const baseProfile = (allowedUsers: string[] = []): Profile => ({
  version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
  project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers,
});

/** Every optional field set, so a test can walk all of them. */
const fullProfile = (): Required<Profile> => ({
  ...baseProfile([MEMBER]),
  messageTriggers: [{ channel: 'C0123456789', botId: 'B0123456789', instructions: 'Look into new alerts.' }],
  review: { channel: 'C0123456780', repositories: ['acme/project'] },
  repositories: [{ name: 'docs', path: '/Users/you/docs', baseRef: 'origin/main', githubRepo: 'acme/docs' }],
  worker: { provider: 'example', model: 'example-model' },
  serviceLabel: 'dev.serra.friday',
  t3Bin: '/Users/you/.t3/bin/t3',
  branchPattern: '{id}/{slug}-{stamp}',
  updates: { source: '/Users/you/git/serra', ref: 'origin/main' },
});

const tempProfile = (t: TestContext, profile: unknown = baseProfile()): string => {
  const directory = mkdtempSync(join(tmpdir(), 'serra-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  return directory;
};
const read = (directory: string): string => readFileSync(join(directory, 'profile.json'), 'utf8');
const json = (directory: string): Profile => JSON.parse(read(directory));
const strays = (directory: string): string[] => readdirSync(directory).filter((name) => name.endsWith('.tmp'));
/** An io that fails the test if anything is written. */
const noWrites: AtomicWriteIo = {
  writeFileSync: () => assert.fail('must not write'),
  renameSync: () => assert.fail('must not rename'),
};

// --- appliesWhen ---------------------------------------------------------------------------------------------

test('readProfileSettings lists every section with its value and when it applies', (t) => {
  const directory = tempProfile(t);
  const views = readProfileSettings(directory);
  assert.deepEqual(views.map((view) => view.section), PROFILE_SECTIONS);
  const people = views.find((view) => view.section === 'allowedUsers')!;
  assert.deepEqual(people.value, []);
  assert.equal(people.appliesWhen, 'now');
  assert.equal(views.find((view) => view.section === 'worker')!.value, undefined);
});

// --- people --------------------------------------------------------------------------------------------------

test('addAllowedUser adds a member, and adding the same ID again is a no-op', (t) => {
  const directory = tempProfile(t);
  const added = addAllowedUser(directory, MEMBER);
  assert.equal(added.changed, true);
  assert.equal(added.appliesWhen, 'now');
  assert.deepEqual(json(directory).allowedUsers, [MEMBER]);

  const before = read(directory);
  const again = addAllowedUser(directory, ` ${MEMBER} `, { io: noWrites });
  assert.equal(again.changed, false);
  assert.equal(read(directory), before);
  assert.deepEqual(strays(directory), []);
});

test('adding the owner is a no-op: the owner is always allowed', (t) => {
  const directory = tempProfile(t);
  const before = read(directory);
  assert.equal(addAllowedUser(directory, OWNER, { io: noWrites }).changed, false);
  assert.equal(read(directory), before);
});

test('addAllowedUser rejects something that is not a member ID and leaves the file untouched', (t) => {
  const directory = tempProfile(t);
  const before = read(directory);
  assert.throws(() => addAllowedUser(directory, 'alex', { io: noWrites }), /Not a Slack member ID/);
  assert.throws(() => addAllowedUser(directory, 'C0123456789', { io: noWrites }), /Not a Slack member ID/);
  assert.equal(read(directory), before);
});

test('removing the owner is refused and the file is untouched', (t) => {
  const directory = tempProfile(t, baseProfile([OWNER, MEMBER]));
  const before = read(directory);
  assert.throws(() => removeAllowedUser(directory, OWNER, { io: noWrites }), /owner .* cannot be removed/);
  assert.equal(read(directory), before);
});

test('removeAllowedUser removes a member, and removing someone not listed is a no-op', (t) => {
  const directory = tempProfile(t, baseProfile([MEMBER, 'U0000000002']));
  const removed = removeAllowedUser(directory, MEMBER);
  assert.equal(removed.changed, true);
  assert.deepEqual(json(directory).allowedUsers, ['U0000000002']);
  assert.equal(removeAllowedUser(directory, MEMBER, { io: noWrites }).changed, false);
});

test('listPeople puts the owner first, locked, and never lists them twice', (t) => {
  const directory = tempProfile(t, baseProfile([OWNER, MEMBER, MEMBER]));
  assert.deepEqual(listPeople(directory), [
    { slackUserId: OWNER, access: 'owner', name: 'Alex' },
    { slackUserId: MEMBER, access: 'allowed' },
  ]);
});

// --- sections ------------------------------------------------------------------------------------------------

test('updateProfileSection replaces one section, keeps the others and the key order', (t) => {
  const directory = tempProfile(t, fullProfile());
  const result = updateProfileSection(directory, 'worker', { model: 'other-model' });
  assert.equal(result.changed, true);
  assert.equal(result.appliesWhen, 'after restart');
  const saved = json(directory);
  assert.deepEqual(saved.worker, { model: 'other-model' });
  assert.deepEqual({ ...saved, worker: undefined }, { ...fullProfile(), worker: undefined });
  assert.deepEqual(Object.keys(saved), Object.keys(fullProfile()));
});

test('an invalid section value is rejected and the file is untouched', (t) => {
  const directory = tempProfile(t, fullProfile());
  const before = read(directory);
  const invalid: [ProfileSection, unknown, RegExp][] = [
    ['allowedUsers', ['not-an-id'], /Invalid allowed Slack member ID/],
    ['owner', { name: 'Alex', slackUserId: 'nope', githubLogin: 'alex' }, /Invalid owner Slack member ID/],
    ['project', { path: 'relative/path', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, /absolute/],
    ['worker', { model: '--evil' }, /Invalid worker model/],
    ['branchPattern', '{slug}', /must contain/],
    ['messageTriggers', 'not a list', /Invalid messageTriggers/],
    ['updates', { source: 'git/serra' }, /updates\.source must be an absolute path/],
    ['updates', { source: '/Users/you/git/serra', ref: '--upload-pack=evil' }, /Invalid updates\.ref/],
  ];
  for (const [section, value, message] of invalid) {
    assert.throws(() => updateProfileSection(directory, section, value as never, { io: noWrites }), message, section);
  }
  assert.equal(read(directory), before);
  assert.deepEqual(strays(directory), []);
});

test('an unknown or read-only section name is rejected and the file is untouched', (t) => {
  const directory = tempProfile(t);
  const before = read(directory);
  for (const name of ['version', 'secrets', '__proto__']) {
    assert.throws(() => updateProfileSection(directory, name as ProfileSection, 1 as never, { io: noWrites }), /Unknown profile section/);
  }
  assert.equal(read(directory), before);
});

test('optional sections can be removed; required ones cannot', (t) => {
  const directory = tempProfile(t, fullProfile());
  assert.equal(updateProfileSection(directory, 'review', undefined).changed, true);
  assert.equal('review' in json(directory), false);
  assert.equal(updateProfileSection(directory, 'review', undefined, { io: noWrites }).changed, false);
  const before = read(directory);
  assert.throws(() => updateProfileSection(directory, 'owner', undefined, { io: noWrites }), /required/);
  assert.equal(read(directory), before);
});

test('saving the value a section already has is a no-op', (t) => {
  const directory = tempProfile(t, fullProfile());
  assert.equal(updateProfileSection(directory, 'worker', fullProfile().worker, { io: noWrites }).changed, false);
});

test('a broken section can be repaired by setting it, and other invalid edits still fail', (t) => {
  const directory = tempProfile(t, { ...baseProfile(), worker: { model: '' } });
  assert.throws(() => addAllowedUser(directory, MEMBER, { io: noWrites }), /Invalid profile field: model/);
  assert.equal(updateProfileSection(directory, 'worker', { model: 'example-model' }).changed, true);
  assert.deepEqual(json(directory).worker, { model: 'example-model' });
});

test('a write that fails part way leaves the old profile.json intact', (t) => {
  const directory = tempProfile(t);
  const before = read(directory);
  const crash: AtomicWriteIo = { writeFileSync: () => { throw new Error('disk full'); }, renameSync: () => assert.fail('must not rename') };
  assert.throws(() => addAllowedUser(directory, MEMBER, { io: crash }), /disk full/);
  assert.equal(read(directory), before);
  assert.deepEqual(strays(directory), []);
});

// --- CLI -----------------------------------------------------------------------------------------------------

const cli = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = []; const err: string[] = [];
  const code = await runCli(argv, { log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('pnpm bot people adds, lists and removes, and refuses the owner', async (t) => {
  const directory = tempProfile(t);
  const profile = ['--profile', directory];
  assert.match((await cli(['people', 'add', MEMBER, ...profile])).out, /Added U0000000001\. Applies now\./);
  assert.match((await cli(['people', 'add', MEMBER, ...profile])).out, /already allowed/);
  const listed = await cli(['people', ...profile]);
  assert.equal(listed.out, `${OWNER}  owner  Alex\n${MEMBER}  allowed`);
  const refused = await cli(['people', 'remove', OWNER, ...profile]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /cannot be removed/);
  assert.match((await cli(['people', 'remove', MEMBER, ...profile])).out, /Removed U0000000001/);
  assert.deepEqual(json(directory).allowedUsers, []);
  assert.match((await cli(['people', 'invite', MEMBER, ...profile])).err, /Unknown people action/);
});

test('pnpm bot settings lists, shows, sets from JSON or a file, and unsets', async (t) => {
  const directory = tempProfile(t);
  const profile = ['--profile', directory];
  const list = await cli(['settings', ...profile]);
  assert.equal(list.code, 0);
  assert.match(list.out, /allowedUsers\s+set\s+Applies now/);
  assert.match(list.out, /worker\s+not set\s+Applies after a restart/);

  assert.match((await cli(['settings', 'set', 'worker', '{"model":"example-model"}', ...profile])).out, /Saved worker\. Applies after a restart\./);
  assert.match((await cli(['settings', 'show', 'worker', ...profile])).out, /"model": "example-model"/);

  const file = join(directory, 'repos.json');
  writeFileSync(file, JSON.stringify([{ name: 'docs', path: '/Users/you/docs', baseRef: 'origin/main' }]));
  assert.equal((await cli(['settings', 'set', 'repositories', '--file', file, ...profile])).code, 0);
  assert.equal(json(directory).repositories![0]!.name, 'docs');

  assert.match((await cli(['settings', 'unset', 'worker', ...profile])).out, /Removed worker/);
  assert.equal('worker' in json(directory), false);

  const before = read(directory);
  assert.match((await cli(['settings', 'set', 'worker', '{"model":', ...profile])).err, /must be JSON/);
  assert.match((await cli(['settings', 'set', 'version', '2', ...profile])).err, /Unknown profile section/);
  assert.match((await cli(['settings', 'set', 'allowedUsers', '["nope"]', ...profile])).err, /Invalid allowed Slack member ID/);
  assert.match((await cli(['settings', 'unset', 'owner', ...profile])).err, /required/);
  assert.equal(read(directory), before);
});
