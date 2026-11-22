import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBridge, type InvokeResult } from '../app/main/bridge.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { createHandlers, registerHandlers, type IpcRegistrar } from '../app/main/ipc/index.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import {
  BRIEF_PLACEHOLDERS, briefProblems, createBriefService, fillBrief, fillBriefText, NO_THREAD, REQUIRED_PLACEHOLDERS,
  sampleBriefInput,
} from '../src/brief.ts';
import { emptyDraft, isDirty, loadedDraft, proposedLabel, replacesLine } from '../app/renderer/screens/brief.logic.ts';
import { codeRoot, loadConfig } from '../src/config.ts';
import { createKnowledge } from '../src/knowledge.ts';

const TEMPLATE = readFileSync(join(codeRoot, 'templates/brief.md'), 'utf8');
const POLICY = '# Owner policy\n\nOpen draft PRs.\n';

const tempProfile = (t: TestContext): string => {
  const directory = mkdtempSync(join(tmpdir(), 'serra-brief-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'profile.json'), JSON.stringify({
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  }, null, 2) + '\n');
  // A token in .env proves the brief screen never needs or shows one.
  writeFileSync(join(directory, '.env'), 'SLACK_BOT_TOKEN=xoxb-fixture\nSLACK_APP_TOKEN=xapp-fixture\n');
  writeFileSync(join(directory, 'brief.md'), TEMPLATE);
  writeFileSync(join(directory, 'policy.md'), POLICY);
  cpSync(join(codeRoot, 'templates/knowledge'), join(directory, 'knowledge'), { recursive: true });
  return directory;
};

const propose = (directory: string, name: string, files: Record<string, string>): string => {
  const dir = join(directory, 'proposed', name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
};

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

// --- validation -------------------------------------------------------------------------------------------------

test('the shipped brief template is valid and uses every required placeholder', () => {
  assert.deepEqual(briefProblems('brief', TEMPLATE), []);
  for (const name of REQUIRED_PLACEHOLDERS) assert.ok(TEMPLATE.includes(`{{${name}}}`), name);
});

test('an unknown placeholder is reported by name, including a lowercase or spaced typo', () => {
  const [problem, ...rest] = briefProblems('brief', `${TEMPLATE}\n{{REQUESTOR}} {{request}} {{ REQUEST }}`);
  assert.equal(rest.length, 0);
  assert.match(problem ?? '', /Unknown placeholders: \{\{REQUESTOR\}\}, \{\{request\}\}, \{\{ REQUEST \}\}/);
  assert.match(problem ?? '', /Known: BOT_NAME/);
});

test('a missing required placeholder is reported', () => {
  assert.deepEqual(briefProblems('brief', TEMPLATE.replaceAll('{{REQUEST}}', 'the request')), ['Missing required placeholder: {{REQUEST}}.']);
  assert.deepEqual(briefProblems('brief', 'Hello {{BOT_NAME}}'), ['Missing required placeholders: {{REQUEST}}, {{THREAD_CONTEXT}}, {{KNOWLEDGE_INDEX}}.']);
  assert.deepEqual(briefProblems('brief', '  \n'), [
    'The brief is empty.', 'Missing required placeholders: {{REQUEST}}, {{THREAD_CONTEXT}}, {{KNOWLEDGE_INDEX}}.',
  ]);
});

test('the policy is read as written, so a placeholder there is a problem', () => {
  assert.deepEqual(briefProblems('policy', POLICY), []);
  assert.match(briefProblems('policy', 'Ask {{OWNER_NAME}} first.')[0] ?? '', /placeholders aren't filled: \{\{OWNER_NAME\}\}/);
});

test('every listed placeholder is one fillBrief fills', (t) => {
  const config = loadConfig({ profileDir: tempProfile(t), env: {} });
  const template = Object.keys(BRIEF_PLACEHOLDERS).map((name) => `{{${name}}}`).join('\n');
  const filled = fillBriefText(template, config, 'index', sampleBriefInput(config, 'Fix the login page'));
  assert.doesNotMatch(filled, /\{\{/);
});

// --- read and save ----------------------------------------------------------------------------------------------

test('save validates first: a rejected brief leaves the file untouched', (t) => {
  const directory = tempProfile(t);
  const service = createBriefService({ profileDir: directory });
  assert.throws(() => service.save('brief', `${TEMPLATE}{{NOPE}}`), /Unknown placeholder: \{\{NOPE\}\}/);
  assert.throws(() => service.save('brief', 'No placeholders'), /Missing required/);
  assert.throws(() => service.save('policy', '{{OWNER_NAME}}'), /aren't filled/);
  assert.equal(readFileSync(join(directory, 'brief.md'), 'utf8'), TEMPLATE);
  assert.equal(readFileSync(join(directory, 'policy.md'), 'utf8'), POLICY);

  service.save('brief', `${TEMPLATE}\nBe brief.\n`);
  service.save('policy', '# Owner policy\n\nOpen ready PRs.\n');
  assert.match(service.read('brief'), /Be brief\.\n$/);
  assert.match(service.read('policy'), /Open ready PRs/);
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.tmp')), []);
});

test('a profile without policy.md reads it as empty, and saving creates it', (t) => {
  const directory = tempProfile(t);
  rmSync(join(directory, 'policy.md'));
  const service = createBriefService({ profileDir: directory });
  assert.equal(service.read('policy'), '');
  service.save('policy', POLICY);
  assert.equal(readFileSync(join(directory, 'policy.md'), 'utf8'), POLICY);
});

// --- preview ----------------------------------------------------------------------------------------------------

test('the preview is exactly what a worker gets for the same request', async (t) => {
  const directory = tempProfile(t);
  const bridge = bridgeFor(directory);
  const request = 'Why does the login page time out?';
  const preview = await bridge.brief.preview(request);

  // What the daemon's startJob does for a new thread from the owner.
  const config = loadConfig({ profileDir: directory, env: {} });
  const worker = fillBrief(config, createKnowledge(config.knowledgeDir).briefKnowledge('owner'),
    { request, requester: 'Alex', permalink: 'link unavailable (preview)', thread: NO_THREAD });
  assert.equal(preview, worker);
  assert.match(preview, /You are Friday, Alex's engineering assistant/);
  assert.match(preview, /<request>\nWhy does the login page time out\?\n<\/request>/);
  assert.doesNotMatch(preview, /xoxb-fixture|xapp-fixture/);

  // A draft previews like the same text saved.
  const draft = `${TEMPLATE}\nDraft line for {{BOT_NAME}}.\n`;
  const fromDraft = await bridge.brief.preview(request, draft);
  assert.match(fromDraft, /Draft line for Friday\.\n$/);
  await bridge.brief.save('brief', draft);
  assert.equal(await bridge.brief.preview(request), fromDraft);

  await assert.rejects(bridge.brief.preview(request, `${draft}{{NOPE}}`), /Unknown placeholder/);
  await assert.rejects(bridge.brief.preview('  '), /sample request is missing/);
});

test('bridge check and save report problems and refuse unknown documents', async (t) => {
  const directory = tempProfile(t);
  const bridge = bridgeFor(directory);
  assert.deepEqual(await bridge.brief.check('brief', TEMPLATE), []);
  assert.match((await bridge.brief.check('brief', 'x'))[0] ?? '', /Missing required/);
  await assert.rejects(bridge.brief.save('brief', 'x'), /Missing required/);
  await assert.rejects(bridge.brief.read('profile' as 'brief'), /Unknown document: profile/);
  assert.equal(await bridge.brief.read('policy'), POLICY);
});

// --- proposed rewrites ------------------------------------------------------------------------------------------

test('applying a proposal backs up the current files and moves the proposal out of the list', async (t) => {
  const directory = tempProfile(t);
  const lean = `${TEMPLATE.slice(0, 2000)}\n{{THREAD_CONTEXT}} {{KNOWLEDGE_INDEX}} {{REQUEST}}\n`;
  propose(directory, '2026-11-17-lean-brief', { 'brief.md': lean, 'notes.md': 'why' });
  propose(directory, '2026-11-18-policy', { 'policy.md': '# Owner policy\n\nReady PRs.\n' });
  mkdirSync(join(directory, 'proposed', 'empty'));
  const bridge = bridgeFor(directory);

  assert.deepEqual(await bridge.brief.listProposed(), ['2026-11-17-lean-brief', '2026-11-18-policy']);
  assert.deepEqual(await bridge.brief.readProposed('2026-11-17-lean-brief'), { brief: lean });

  const service = createBriefService({ profileDir: directory, now: () => new Date('2026-11-19T10:00:00Z') });
  const backup = service.applyProposed('2026-11-17-lean-brief');
  assert.equal(readFileSync(join(directory, 'brief.md'), 'utf8'), lean);
  assert.equal(readFileSync(join(directory, 'policy.md'), 'utf8'), POLICY, 'a proposal without policy.md leaves it alone');
  assert.equal(readFileSync(join(backup, 'previous', 'brief.md'), 'utf8'), TEMPLATE);
  assert.equal(existsSync(join(backup, 'previous', 'policy.md')), false);
  assert.equal(readFileSync(join(backup, 'proposal', 'notes.md'), 'utf8'), 'why');
  assert.match(backup, /backups\/brief\/2026-11-19T10-00-00-000Z-2026-11-17-lean-brief$/);
  assert.deepEqual(service.listProposed(), ['2026-11-18-policy']);

  await bridge.brief.applyProposed('2026-11-18-policy');
  assert.match(readFileSync(join(directory, 'policy.md'), 'utf8'), /Ready PRs/);
  assert.deepEqual(await bridge.brief.listProposed(), []);
});

test('an invalid proposal is refused before anything is written', async (t) => {
  const directory = tempProfile(t);
  propose(directory, 'broken', { 'brief.md': `${TEMPLATE}{{UNKNOWN}}`, 'policy.md': '# Fine\n' });
  const bridge = bridgeFor(directory);
  await assert.rejects(bridge.brief.applyProposed('broken'), /proposed\/broken\/brief\.md: Unknown placeholder: \{\{UNKNOWN\}\}/);
  assert.equal(readFileSync(join(directory, 'brief.md'), 'utf8'), TEMPLATE);
  assert.equal(readFileSync(join(directory, 'policy.md'), 'utf8'), POLICY);
  assert.deepEqual(await bridge.brief.listProposed(), ['broken']);
  assert.equal(existsSync(join(directory, 'backups')), false);

  await assert.rejects(bridge.brief.applyProposed('../knowledge'), /Not a proposal name/);
  await assert.rejects(bridge.brief.applyProposed('..'), /Not a proposal name/);
  await assert.rejects(bridge.brief.applyProposed('missing'), /No proposal missing/);
});

// --- screen helpers ---------------------------------------------------------------------------------------------

test('screen helpers: proposal labels, dirty drafts and the apply line', () => {
  assert.deepEqual(proposedLabel('2026-11-17-lean-brief'), { date: '2026-11-17', title: 'Lean brief' });
  assert.deepEqual(proposedLabel('shorter_policy'), { date: null, title: 'Shorter policy' });
  assert.deepEqual(proposedLabel('2026-11-17'), { date: '2026-11-17', title: '2026-11-17' });
  assert.equal(isDirty(emptyDraft()), false);
  assert.equal(isDirty(loadedDraft('a')), false);
  assert.equal(isDirty({ saved: 'a', text: 'b' }), true);
  assert.match(replacesLine(['policy', 'brief']), /^Replaces brief\.md and policy\.md\./);
});
