import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBridge, type InvokeResult } from '../app/main/bridge.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { createHandlers, registerHandlers, type IpcRegistrar } from '../app/main/ipc/index.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import {
  addPersonFieldMessage, addPersonProblem, appliesLabel, botForm, branchPatternForm, channelIdProblem, emptyTriggerRow,
  formChanged, memberIdProblem, ownerForm, parseRepositories, parseTriggers, peopleRows, pendingRestart, projectForm,
  repositoryRows, reviewForm, sectionList, serviceLabelForm, t3BinForm, triggerRows, updatesForm, workerForm, type SectionForm,
} from '../app/renderer/screens/settings/settings.logic.ts';
import { loadConfig } from '../src/config.ts';
import { validateProfile, type BotStatus, type Profile, type ProfileSection } from '../src/contracts.ts';
import { createProfileReloader } from '../src/profile-reload.ts';
import { PROFILE_SECTIONS } from '../src/profile-settings.ts';

const OWNER = 'U0123456789';
const MEMBER = 'U0000000001';
const NEWCOMER = 'U0000000002';

const baseProfile = (allowedUsers: string[] = [MEMBER]): Profile => ({
  version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
  project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers,
});

const fullProfile = (): Required<Profile> => ({
  ...baseProfile(),
  messageTriggers: [
    { channel: 'C0123456789', botId: 'B0123456789', instructions: 'Look into new alerts.' },
    { channel: 'C0123456789', userId: 'U0000000003', instructions: 'Answer questions.' },
    { channel: 'G0123456789', instructions: 'Summarise.' },
  ],
  review: { channel: 'C0123456780', repositories: ['acme/project', 'acme/docs'] },
  repositories: [{ name: 'docs', path: '/Users/you/docs', baseRef: 'origin/main', githubRepo: 'acme/docs' }, { name: 'infra', path: '/Users/you/infra', baseRef: 'origin/main' }],
  worker: { provider: 'example', model: 'example-model' },
  serviceLabel: 'dev.serra.friday',
  t3Bin: '/Users/you/.t3/bin/t3',
  branchPattern: '{id}/{slug}-{stamp}',
  updates: { source: '/Users/you/git/serra', ref: 'origin/main' },
});

const forms: SectionForm[] = [botForm, ownerForm, reviewForm, serviceLabelForm, projectForm, workerForm, branchPatternForm, t3BinForm, updatesForm] as SectionForm[];

// --- field validation messages --------------------------------------------------------------------------------

test('member and channel IDs say what a valid one looks like', () => {
  assert.equal(memberIdProblem(' U0123456789 '), null);
  assert.equal(memberIdProblem('W0123456789'), null);
  assert.equal(memberIdProblem(''), 'Enter a Slack member ID.');
  assert.match(memberIdProblem('u0123456789') ?? '', /start with U or W, like U0123456789/);
  assert.match(memberIdProblem('@alex') ?? '', /Not a Slack member ID/);
  assert.equal(channelIdProblem('C0123456789'), null);
  assert.match(channelIdProblem('#alerts') ?? '', /not #name/);
});

test('text field forms report problems by field', () => {
  assert.deepEqual(botForm.parse({ name: '', id: 'Friday Bot' }).errors, {
    name: 'Display name is required.',
    id: 'Start with a lowercase letter and use up to 48 lowercase letters, digits or hyphens.',
  });
  assert.deepEqual(ownerForm.parse({ name: 'Alex', slackUserId: 'alex', githubLogin: 'alex smith' }).errors, {
    slackUserId: 'Not a Slack member ID. Member IDs start with U or W, like U0123456789.',
    githubLogin: 'Use letters, digits, underscores and hyphens only.',
  });
  assert.deepEqual(projectForm.parse({ path: 'project', githubRepo: 'project', remote: '--upload-pack=x', baseRef: 'origin/main' }).errors, {
    path: 'Local path must be an absolute path, like /Users/you/project.',
    githubRepo: 'Use owner/name, like acme/project.',
    remote: "Remote can't start with a hyphen.",
  });
  assert.deepEqual(branchPatternForm.parse({ branchPattern: '{id}/{slug}' }).errors, { branchPattern: 'Include {slug} and {stamp}, so two jobs never share a branch.' });
  assert.deepEqual(t3BinForm.parse({ t3Bin: 't3' }).errors, { t3Bin: 'T3 command path must be an absolute path, like /Users/you/.t3/bin/t3.' });
  assert.deepEqual(botForm.parse({ name: 'Two\nlines', id: 'friday' }).errors, { name: 'Display name must be one line.' });
});

test('optional sections: empty fields remove the section, half-filled ones explain what is missing', () => {
  assert.deepEqual(reviewForm.parse({ channel: '', repositories: '' }), { value: undefined, errors: {} });
  assert.deepEqual(reviewForm.parse({ channel: 'C0123456789', repositories: '' }).errors, {
    repositories: 'Add at least one repository, or clear the channel to turn review posting off.',
  });
  assert.deepEqual(reviewForm.parse({ channel: 'C0123456789', repositories: 'acme/project, acme/docs\nacme/infra' }).value, {
    channel: 'C0123456789', repositories: ['acme/project', 'acme/docs', 'acme/infra'],
  });
  assert.deepEqual(workerForm.parse({ provider: '', model: '' }), { value: undefined, errors: {} });
  assert.deepEqual(workerForm.parse({ provider: '', model: 'example-model' }).value, { model: 'example-model' });
  assert.deepEqual(workerForm.parse({ provider: 'example', model: '' }).errors, { model: 'Model is required.' });
  assert.deepEqual(serviceLabelForm.parse({ serviceLabel: ' ' }), { value: undefined, errors: {} });
});

test('every form round-trips a full profile unchanged, and what it parses passes validateProfile', () => {
  const profile = fullProfile();
  for (const form of forms) {
    const { value, errors } = form.parse(form.toForm(profile));
    assert.deepEqual(errors, {}, form.section);
    assert.deepEqual(value, profile[form.section], form.section);
    assert.equal(formChanged(form, profile, form.toForm(profile)), false, form.section);
  }
  assert.deepEqual(parseRepositories(repositoryRows(profile)).value, profile.repositories);
  assert.deepEqual(parseTriggers(triggerRows(profile)).value, profile.messageTriggers);
});

test('a value the field checks accept is accepted by validateProfile too', () => {
  const profile: Record<string, unknown> = { ...baseProfile() };
  profile.review = reviewForm.parse({ channel: 'G0123456789', repositories: 'acme/project' }).value;
  profile.worker = workerForm.parse({ provider: '', model: 'example-model' }).value;
  profile.messageTriggers = parseTriggers([{ channel: 'C0123456789', source: 'any', sourceId: 'ignored', instructions: 'Look.' }]).value;
  profile.repositories = parseRepositories([{ name: 'docs', path: '/Users/you/docs', baseRef: 'origin/main', githubRepo: '' }]).value;
  assert.doesNotThrow(() => validateProfile(profile));
});

test('repository rows: problems are keyed by row and field, and no rows removes the section', () => {
  assert.deepEqual(parseRepositories([]), { value: undefined, errors: {} });
  const { errors } = parseRepositories([
    { name: 'docs', path: '/Users/you/docs', baseRef: 'origin/main', githubRepo: '' },
    { name: '', path: 'docs', baseRef: '-x', githubRepo: 'docs' },
  ]);
  assert.deepEqual(errors, {
    '1.name': 'Name is required.',
    '1.path': 'Path must be an absolute path, like /Users/you/project.',
    '1.baseRef': "Base ref can't start with a hyphen.",
    '1.githubRepo': 'Use owner/name, like acme/project.',
  });
});

test('trigger rows: source IDs, instructions and duplicates', () => {
  const { errors } = parseTriggers([
    { channel: 'C0123456789', source: 'bot', sourceId: 'U0123456789', instructions: 'Look.' },
    { channel: 'C0123456789', source: 'user', sourceId: 'B0123456789', instructions: ' ' },
    { channel: 'C0123456789', source: 'any', sourceId: '', instructions: 'Look.' },
    { channel: 'C0123456789', source: 'any', sourceId: '', instructions: 'Look again.' },
    { ...emptyTriggerRow(), sourceId: 'B0123456789', instructions: 'x'.repeat(10_001) },
  ]);
  assert.deepEqual(errors, {
    '0.sourceId': 'Not a Slack bot ID. Bot IDs start with B, like B0123456789.',
    '1.sourceId': 'Not a Slack member ID. Member IDs start with U or W, like U0123456789.',
    '1.instructions': 'Tell the worker what to do with these messages.',
    '3.channel': 'Another trigger already answers these messages in this channel.',
    '4.channel': 'Enter a Slack channel ID.',
    '4.instructions': 'Keep instructions under 10000 characters.',
  });
});

// --- people ---------------------------------------------------------------------------------------------------

test('people: the owner first with the stored name, others by member ID with no invented name', () => {
  assert.deepEqual(peopleRows(baseProfile([MEMBER, OWNER, MEMBER, NEWCOMER])), [
    { slackUserId: OWNER, access: 'owner', name: 'Alex' },
    { slackUserId: MEMBER, access: 'allowed', name: null },
    { slackUserId: NEWCOMER, access: 'allowed', name: null },
  ]);
});

test('add person: format, owner and duplicate messages; quiet while an ID is still being typed', () => {
  const profile = baseProfile();
  assert.equal(addPersonProblem(NEWCOMER, profile), null);
  assert.equal(addPersonProblem(MEMBER, profile), 'Already allowed.');
  assert.equal(addPersonProblem(OWNER, profile), 'That is the owner, who always has access.');
  assert.equal(addPersonFieldMessage('', profile), null);
  assert.equal(addPersonFieldMessage('U000', profile), null);
  assert.match(addPersonFieldMessage('alex', profile) ?? '', /Not a Slack member ID/);
  assert.equal(addPersonFieldMessage(` ${MEMBER} `, profile), 'Already allowed.');
});

// --- when changes apply ---------------------------------------------------------------------------------------

test('applies labels and the restart banner follow the daemon start time', () => {
  assert.equal(appliesLabel('now'), 'Applies now');
  assert.equal(appliesLabel('next job'), 'Applies on the next job');
  assert.equal(appliesLabel('after restart'), 'Applies after a restart');
  const up = (startedAt: string): BotStatus => ({ state: 'up', pid: 1, startedAt, slackConnected: true, counts: { needsYou: 0, running: 0 } });
  const saves = [
    { section: 'bot' as const, savedAt: '2026-11-19T09:00:00.000Z' },
    { section: 'worker' as const, savedAt: '2026-11-19T10:00:00.000Z' },
    { section: 'worker' as const, savedAt: '2026-11-19T10:05:00.000Z' },
  ];
  assert.deepEqual(pendingRestart(saves, up('2026-11-19T08:00:00.000Z')), ['bot', 'worker']);
  assert.deepEqual(pendingRestart(saves, up('2026-11-19T09:30:00.000Z')), ['worker']);
  assert.deepEqual(pendingRestart(saves, up('2026-11-19T11:00:00.000Z')), []);
  assert.deepEqual(pendingRestart(saves, { state: 'stopped' }), []);
  assert.deepEqual(pendingRestart(saves, null), ['bot', 'worker']);
  assert.equal(sectionList(['bot', 'worker', 'review']), 'Bot, Worker and Review channel');
});

// --- the bridge, on a real profile folder ---------------------------------------------------------------------

const tempProfile = (t: TestContext, profile: unknown = baseProfile()): string => {
  const directory = mkdtempSync(join(tmpdir(), 'serra-app-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  return directory;
};

/** The window's `window.serra` over a fake ipcMain, with structured clone like Electron's IPC. */
const bridgeFor = (profileDir: string) => {
  const context: HandlerContext = {
    profileDir: () => profileDir, profileDirOrNull: () => profileDir, prefs: memoryPrefs(), status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
    openExternal: async () => {}, openPath: async () => {},
  };
  const handlers = new Map<string, Parameters<IpcRegistrar['handle']>[1]>();
  registerHandlers({ handle: (channel, listener) => { handlers.set(channel, listener); } }, createHandlers(context), () => true, () => {});
  return createBridge(
    async (channel, args): Promise<InvokeResult> =>
      structuredClone(await handlers.get(channel)!({ senderFrame: { url: 'file:///app' } }, ...structuredClone(args))),
    () => () => {},
  );
};

const fileText = (directory: string): string => readFileSync(join(directory, 'profile.json'), 'utf8');

test('settings.read and settings.sections give the profile and when every section applies', async (t) => {
  const bridge = bridgeFor(tempProfile(t));
  assert.equal((await bridge.settings.read()).owner.slackUserId, OWNER);
  const sections = await bridge.settings.sections();
  assert.deepEqual(Object.keys(sections).sort(), [...PROFILE_SECTIONS].sort());
  assert.equal(sections.allowedUsers.appliesWhen, 'now');
  assert.equal(sections.messageTriggers.appliesWhen, 'now');
  assert.equal(sections.worker.appliesWhen, 'after restart');
});

test('adding a person applies now, and the running daemon accepts them without a restart', async (t) => {
  const directory = tempProfile(t);
  const config = loadConfig({ profileDir: directory, env: {} });
  const reload = createProfileReloader(config);
  assert.equal(config.allowed.has(NEWCOMER), false);

  const bridge = bridgeFor(directory);
  const result = await bridge.settings.addPerson(` ${NEWCOMER} `);
  assert.equal(result.applies, 'now');
  assert.equal(result.changed, true);
  assert.deepEqual(result.profile.allowedUsers, [MEMBER, NEWCOMER]);

  // What the daemon's profile watcher does on the change event.
  assert.deepEqual(reload(), { status: 'applied', applied: ['allowedUsers'], restartNeeded: [] });
  assert.equal(config.allowed.has(NEWCOMER), true);

  assert.equal((await bridge.settings.addPerson(NEWCOMER)).changed, false);
  const removed = await bridge.settings.removePerson(NEWCOMER);
  assert.deepEqual(removed.profile.allowedUsers, [MEMBER]);
  reload();
  assert.equal(config.allowed.has(NEWCOMER), false);
});

test('the owner cannot be removed, and a bad member ID is refused, with the file untouched', async (t) => {
  const directory = tempProfile(t);
  const before = fileText(directory);
  const bridge = bridgeFor(directory);
  await assert.rejects(bridge.settings.removePerson(OWNER), /owner always has access/);
  await assert.rejects(bridge.settings.addPerson('alex'), /Not a Slack member ID/);
  await assert.rejects(bridge.settings.addPerson(42 as unknown as string), /must be text/);
  assert.equal(fileText(directory), before);
});

test('an invalid section value never reaches disk', async (t) => {
  const directory = tempProfile(t);
  const before = fileText(directory);
  const bridge = bridgeFor(directory);
  const invalid: [ProfileSection, unknown][] = [
    ['bot', { id: 'Not Valid', name: 'Friday' }],
    ['project', { ...baseProfile().project, path: 'relative' }],
    ['review', { channel: 'C0123456789', repositories: [] }],
    ['branchPattern', '{slug}-{stamp}/'],
    ['messageTriggers', [{ channel: 'C0123456789', botId: 'B0123456789', userId: OWNER, instructions: 'x' }]],
    ['owner', null],
  ];
  for (const [section, value] of invalid) await assert.rejects(bridge.settings.saveSection(section, value), Error, section);
  await assert.rejects(bridge.settings.saveSection('version' as ProfileSection, 2), /Unknown profile section: version/);
  assert.equal(fileText(directory), before);
});

test('saving a section reports when it applies; null removes an optional section', async (t) => {
  const directory = tempProfile(t, fullProfile());
  const bridge = bridgeFor(directory);
  const worker = await bridge.settings.saveSection('worker', { model: 'other-model' });
  assert.deepEqual({ applies: worker.applies, changed: worker.changed }, { applies: 'after restart', changed: true });
  assert.deepEqual(JSON.parse(fileText(directory)).worker, { model: 'other-model' });

  const same = await bridge.settings.saveSection('worker', { model: 'other-model' });
  assert.equal(same.changed, false);

  const removed = await bridge.settings.saveSection('review', null);
  assert.equal('review' in JSON.parse(fileText(directory)), false);
  assert.equal(removed.profile.review, undefined);

  const triggers = await bridge.settings.saveSection('messageTriggers', []);
  assert.equal(triggers.applies, 'now');
});
