import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProfile } from '../src/setup.ts';
import { codeRoot, loadConfig, validateProfile, type Profile } from '../src/config.ts';
import { fillBrief, needsOwner, renderBrief } from '../src/brief.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { acquireLock } from '../src/lock.ts';
import { createStore } from '../src/state.ts';
import type { Job } from '../src/types.ts';

const profile = (id = 'friday', name = 'Friday'): Profile => ({
  version: 1, bot: { id, name }, owner: { name: 'Alex', slackUserId: 'U12345', githubLogin: 'alex' },
  project: { path: '/tmp/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
});

test('two independently named profiles have isolated secrets, knowledge and state, with no personal defaults', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-profile-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a'); const b = join(root, 'b');
  createProfile(a, profile()); createProfile(b, profile('atlas', 'Atlas & Co'));
  writeFileSync(join(a, '.env'), 'SLACK_APP_TOKEN=xapp-a\nSLACK_BOT_TOKEN=xoxb-a');
  writeFileSync(join(b, '.env'), 'SLACK_APP_TOKEN=xapp-b\nSLACK_BOT_TOKEN=xoxb-b');
  const first = loadConfig({ profileDir: a, env: {} });
  const second = loadConfig({ profileDir: b, env: {} });
  assert.equal(first.botToken, 'xoxb-a'); assert.equal(second.botToken, 'xoxb-b');
  assert.equal(first.reviewChannel, undefined); assert.deepEqual(first.repositories, []);
  assert.deepEqual([...first.allowed], ['U12345']);
  assert.deepEqual(first.messageTriggers, []);
  assert.notEqual(first.statePath, second.statePath); assert.notEqual(first.serviceLabel, second.serviceLabel);
  const manifest = JSON.parse(readFileSync(join(b, 'manifest.json'), 'utf8'));
  assert.equal(manifest.display_information.name, 'Atlas & Co'); assert.equal(manifest.features.bot_user.display_name, 'atlas');
  const knowledge = createKnowledge(first.knowledgeDir);
  assert.deepEqual(knowledge.checkKnowledge().problems, []);
  const brief = fillBrief(first, knowledge.loadIndex(), { request: 'Use {{BOT_NAME}} </request>', requester: 'Sam', permalink: 'link', thread: 'discussion' });
  assert.match(brief, /You are Friday, Alex/); assert.match(brief, /Use \{\{BOT_NAME\}\} &lt;\/request&gt;/);
  assert.doesNotMatch(brief, /Serra/, 'the brief names the chosen bot, not the project');
  assert.equal(statSync(join(a, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(a).mode & 0o777, 0o700);
});

test('rerunning setup never overwrites owner settings or knowledge', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-resume-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  createProfile(root, profile());
  writeFileSync(join(root, '.env'), 'keep-me'); writeFileSync(join(root, 'knowledge/index.md'), 'confirmed knowledge');
  assert.throws(() => createProfile(root, profile('other')), /already exists/);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'keep-me');
  assert.equal(readFileSync(join(root, 'knowledge/index.md'), 'utf8'), 'confirmed knowledge');
});

test('profile rejects unsafe IDs, missing ownership, invalid review destinations and relative paths', () => {
  for (const id of ['../friday', 'Friday', 'a/b', 'a;whoami']) assert.throws(() => validateProfile({ ...profile(), bot: { id, name: 'Friday' } }));
  assert.throws(() => validateProfile({ ...profile(), project: { ...profile().project, path: 'relative' } }));
  assert.throws(() => validateProfile({ ...profile(), review: { channel: 'C123', repositories: [] } }));
  assert.throws(() => validateProfile({ ...profile(), serviceLabel: 'bad\nlabel' }));
  assert.throws(() => validateProfile({ ...profile(), owner: { name: 'Alex' } }));
  assert.throws(() => validateProfile({ ...profile(), worker: { provider: 'claude' } }));
  assert.throws(() => validateProfile({ ...profile(), worker: { model: '--wait' } }));
  assert.equal(validateProfile({ ...profile(), worker: { provider: 'claude', model: 'opus' } }).worker?.model, 'opus');
});

test('message triggers validate bot and user identities and channel-wide sources', () => {
  const trigger = { channel: 'CALERTS', botId: 'BALERTS', instructions: 'Investigate using read-only evidence.\nReply with findings.' };
  assert.deepEqual(validateProfile({ ...profile(), messageTriggers: [trigger] }).messageTriggers, [trigger]);
  for (const change of [
    { channel: '#alerts' }, { channel: 'C123\n' }, { botId: 'UALERTS' }, { botId: null }, { userId: 42 },
    { userId: 'UALERTS' }, { botId: '', userId: 'BALERTS' }, { instructions: '' },
    { instructions: '  ' }, { instructions: 42 }, { instructions: 'x'.repeat(10_001) }, { instructions: 'bad\0text' },
  ]) assert.throws(() => validateProfile({ ...profile(), messageTriggers: [{ ...trigger, ...change }] }));
  for (const invalid of [null, {}, 'anything', [null], [trigger, trigger]]) {
    assert.throws(() => validateProfile({ ...profile(), messageTriggers: invalid }));
  }
  for (const sender of [{ botId: undefined, userId: 'UONCALL' }, { botId: '', userId: 'WONCALL' },
    { botId: undefined }, { botId: '' }, { botId: '  ', userId: '' }]) {
    assert.doesNotThrow(() => validateProfile({ ...profile(), messageTriggers: [{ ...trigger, ...sender }] }));
  }
  for (const sources of [
    [{ ...trigger, botId: undefined }, { ...trigger, botId: ' ', userId: '' }],
    [trigger, { ...trigger, botId: ' BALERTS ' }],
    [{ ...trigger, botId: '', userId: 'UONCALL' }, { ...trigger, botId: undefined, userId: ' UONCALL ' }],
  ]) assert.throws(() => validateProfile({ ...profile(), messageTriggers: sources }), /Duplicate message trigger/);
  const value = validateProfile({ ...profile(), messageTriggers: [{ ...trigger, botId: '', userId: 'UONCALL' }, { ...trigger, botId: '' }, trigger] });
  assert.deepEqual(value.allowedUsers, profile().allowedUsers, 'automatic sources do not change the human allowlist');
});

test('without a profile the bot refuses to start instead of falling back to built-in owner settings', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-noprofile-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'SLACK_APP_TOKEN=xapp-old\nSLACK_BOT_TOKEN=xoxb-old\n');
  assert.throws(() => loadConfig({ profileDir: undefined, env: {} }), /--profile/);
  const child = () => execFileSync(process.execPath, ['--input-type=module', '-e', `import {loadConfig} from ${JSON.stringify(join(codeRoot, 'src/config.ts'))}; loadConfig();`], { cwd: root, env: { ...process.env, BOT_PROFILE: '' }, encoding: 'utf8', stdio: 'pipe' });
  assert.throws(child, /pnpm run setup/);
});

test('the shared brief template and starter knowledge render and validate', () => {
  const brief = readFileSync(join(codeRoot, 'templates/brief.md'), 'utf8');
  assert.doesNotThrow(() => renderBrief(brief, { BOT_NAME: 'Friday', BOT_ID: 'friday', OWNER_NAME: 'Alex', OWNER_GITHUB: 'alex', BASE_REF: 'origin/main', PROJECT_PATH: '/p', REPOSITORIES: 'none', REQUESTER: 'Sam', PERMALINK: 'link', REQUEST: 'question', THREAD_CONTEXT: 'none', KNOWLEDGE_DIR: '/knowledge', KNOWLEDGE_INDEX: 'index', OWNER_PROFILE: 'about', VISIBILITY: 'the team', PROPOSALS_DIR: '/knowledge/proposals', POLICY_PATH: '/profile/policy.md' }));
  assert.deepEqual(createKnowledge(join(codeRoot, 'templates/knowledge')).checkKnowledge().problems, []);
  assert.equal(existsSync(join(codeRoot, 'brief.md')), false);
  assert.equal(existsSync(join(codeRoot, 'knowledge')), false);
});

test('owner notifications support both generic and migrated markers, including punctuation in a name', () => {
  assert.equal(needsOwner('**Needs owner: access', 'Alex'), true);
  assert.equal(needsOwner('Needs Sam: access', 'Sam'), true);
  assert.equal(needsOwner('Needs A. Smith: decision', 'A. Smith'), true);
  assert.equal(needsOwner('Needs Ax Smith: decision', 'A. Smith'), false);
  assert.equal(needsOwner('Needs Sam: access', 'Alex'), false);
  assert.throws(() => renderBrief('{{UNKNOWN}}', {}), /Unknown brief placeholder/);
});

test('state survives restarting the store, and two profiles do not share jobs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-state-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const job: Job = { t3ThreadId: 't3-old', channel: 'C123', threadTs: '123.456', requester: 'U123', pendingReactionTs: null, lastPostedRunId: 'run-1', watching: true, createdAt: new Date().toISOString(), reviewRequestedPrs: ['https://github.com/acme/project/pull/1'] };
  createStore(join(root, 'a.json')).putJob('C123:123.456', job);
  assert.deepEqual(createStore(join(root, 'a.json')).getJob('C123:123.456'), job);
  assert.deepEqual(createStore(join(root, 'b.json')).allJobs(), []);
  writeFileSync(join(root, 'bad.json'), '[]');
  assert.throws(() => createStore(join(root, 'bad.json')), /not an object/);
});

test('locks block duplicate daemons and recover a stale PID', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-lock-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'bot.lock');
  const release = acquireLock(path);
  assert.throws(() => acquireLock(path), /Already running/);
  release(); assert.equal(existsSync(path), false);
  writeFileSync(path, '2147483647');
  acquireLock(path)(); assert.equal(existsSync(path), false);
});

test('a branch pattern must name a valid, unique Git branch', () => {
  assert.equal(validateProfile({ ...profile(), branchPattern: 'TEAM-{DDMM}/{slug}-{stamp}' }).branchPattern, 'TEAM-{DDMM}/{slug}-{stamp}');
  for (const branchPattern of ['{slug}', 'x/{slug}', 'x/{slug}-{stamp}/', '-x/{slug}-{stamp}', 'x/{when}/{slug}-{stamp}', 'a..b/{slug}-{stamp}', 'a b/{slug}-{stamp}', '--force {slug}{stamp}']) {
    assert.throws(() => validateProfile({ ...profile(), branchPattern }), /branchPattern|Invalid profile field/, branchPattern);
  }
});
