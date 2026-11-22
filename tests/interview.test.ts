// The guided knowledge interview (APP-26): the brief from templates/interview.md, the thread started like a task
// against a fake `t3`, the IPC handlers, and the proposals it writes reaching the Proposals queue without a restart.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { proposalsHandlers } from '../app/main/ipc/proposals.ts';
import { tasksHandlers } from '../app/main/ipc/tasks.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { followProposals } from '../app/main/proposals-watch.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { defaultFolder, folderChoices, interviewStartedText } from '../app/renderer/screens/proposals.logic.ts';
import { codeRoot, loadConfig } from '../src/config.ts';
import { createProfile, onboardingPrompt } from '../src/setup.ts';
import {
  INTERVIEW_PROGRESS, INTERVIEW_TEMPLATE, INTERVIEW_TITLE, interviewBrief, previewInterview, readTasks, startInterview,
} from '../src/tasks.ts';

const NOW = new Date(2026, 10, 19, 10, 0, 0);
const TODAY = '2026-11-19';

interface Call { args: string[]; input: string }

/** A new profile whose `t3Bin` is a fake that records every call and answers like T3 does. */
const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-interview-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profile');
  const bin = join(root, 't3');
  const calls = join(root, 'calls.jsonl');
  createProfile(profileDir, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' },
    allowedUsers: [], t3Bin: bin,
  });
  writeFileSync(join(profileDir, '.env'), 'SLACK_APP_TOKEN=xapp-fixture\nSLACK_BOT_TOKEN=xoxb-fixture\n');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, input }) + '\\n');
  if (args[1] === 'start') console.log(JSON.stringify({ threadId: 'interview-thread' }));
  else if (args[1] === 'show') console.log(JSON.stringify({ thread: { threadId: args.at(-1), link: 'https://t3.test/' + args.at(-1), status: 'running', latestRunId: 'r', activeRunId: 'r' }, messages: [] }));
});
`, { mode: 0o700 });
  const recorded = (): Call[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Call) : []);
  return { root, profileDir, knowledgeDir: join(profileDir, 'knowledge'), recorded };
};

const noFetch = async (): Promise<void> => {};

const context = (profileDir: string): HandlerContext => ({
  profileDirOrNull: () => profileDir,
  profileDir: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

/** A proposal as the interview writes one: a new page, with `target:` naming where it goes. */
const proposal = `---
type: preference
description: What the owner is responsible for
written: ${TODAY}
verified: no
target: owner/role.md
sources:
  - Owner interview, ${TODAY}
---

Leads the billing team.
`;

const waitFor = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('the interview brief fills every placeholder with the profile, and ships in templates/', (t) => {
  const { profileDir, knowledgeDir } = fixture(t);
  assert.ok(INTERVIEW_TEMPLATE.startsWith(join(codeRoot, 'templates')), 'templates/ is packaged with the app; docs/ is not');
  const brief = interviewBrief(loadConfig({ profileDir, env: {} }), NOW);
  assert.doesNotMatch(brief, /\{\{/);
  assert.match(brief, /knowledge interview for Friday, Alex's engineering assistant/);
  assert.match(brief, /one question at a time/i);
  assert.ok(brief.includes(`The bot's profile is ${profileDir}.`));
  assert.ok(brief.includes(`${knowledgeDir}/proposals/${TODAY}-<page>.md`));
  assert.ok(brief.includes('/Users/you/project'));
  assert.match(brief, /`target: owner\/role\.md`/);
  assert.match(brief, /This is the first interview for this profile/);
  assert.ok(!brief.includes('xoxb-fixture') && !brief.includes('xapp-fixture'), 'no token reaches the brief');
  assert.throws(() => interviewBrief(loadConfig({ profileDir, env: {} }), NOW, 'Hi {{NOPE}}'), /Unknown brief placeholder: NOPE/);
});

test('startInterview starts a T3 thread with the interview brief, like a task, and records it for Jobs', async (t) => {
  const { profileDir, recorded } = fixture(t);
  const task = await startInterview(profileDir, { fetchBase: noFetch, now: () => NOW });

  const [start] = recorded();
  assert.deepEqual(start!.args.slice(0, 4), ['thread', 'start', '--worktree', 'origin/main']);
  assert.match(start!.args[5]!, /^friday\/knowledge-interview/);
  assert.deepEqual(start!.args.slice(6), ['--title', `Friday: ${INTERVIEW_TITLE}`, '--json', '/Users/you/project', '-']);
  assert.equal(start!.input, interviewBrief(loadConfig({ profileDir, env: {} }), NOW), 'the thread gets the interview brief');
  assert.equal(start!.input, previewInterview(profileDir, NOW).brief, 'the preview is what gets sent');

  assert.equal(task.title, INTERVIEW_TITLE);
  assert.equal(task.link, 'https://t3.test/interview-thread');
  assert.deepEqual(readTasks(profileDir).map((row) => row.t3ThreadId), ['interview-thread']);
});

test('an interview after an earlier one carries on from its progress notes', (t) => {
  const { profileDir, knowledgeDir } = fixture(t);
  assert.equal(previewInterview(profileDir, NOW).resumes, false);
  writeFileSync(join(knowledgeDir, INTERVIEW_PROGRESS), 'Topics done: role\nNext: team\n');
  const { brief, resumes } = previewInterview(profileDir, NOW);
  assert.equal(resumes, true);
  assert.ok(brief.includes(`An earlier interview left notes in ${join(knowledgeDir, INTERVIEW_PROGRESS)}`));
  assert.doesNotMatch(brief, /first interview/);
});

test('IPC: previewInterview and startInterview never return a token, and share the one-start guard with tasks', async (t) => {
  const { profileDir } = fixture(t);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handlers = tasksHandlers(context(profileDir), { fetchBase: () => gate, now: () => NOW });

  const preview = await handlers.previewInterview();
  assert.equal(preview.resumes, false);
  assert.ok(!JSON.stringify(preview).includes('xoxb-fixture'));

  const first = handlers.startInterview();
  await assert.rejects(Promise.resolve().then(() => handlers.startInterview()), /already starting/);
  await assert.rejects(Promise.resolve().then(() => handlers.start('fix it')), /already starting/);
  release();
  const task = await first;
  assert.equal(task.title, INTERVIEW_TITLE);
  assert.ok(!JSON.stringify(task).includes('xoxb-fixture') && !JSON.stringify(task).includes('xapp-fixture'));
});

test('a proposal the interview writes reaches the queue without a restart, and promotes into its new folder', async (t) => {
  const { profileDir, knowledgeDir } = fixture(t);
  await startInterview(profileDir, { fetchBase: noFetch, now: () => NOW });

  let pushes = 0;
  const watcher = followProposals(() => { pushes += 1; }, { debounceMs: 20, log: (message) => assert.fail(message) });
  t.after(() => watcher.close());
  watcher.follow(profileDir);
  const proposals = proposalsHandlers(context(profileDir));
  assert.deepEqual(await proposals.list(), []);

  // A page elsewhere in knowledge/ is not a proposal: no push.
  writeFileSync(join(knowledgeDir, 'log.md'), '# Knowledge changes\n- edited\n');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pushes, 0, 'only proposals/ changes push');

  // What the interview's worker does once the owner confirms a topic.
  writeFileSync(join(knowledgeDir, 'proposals', `${TODAY}-role.md`), proposal);
  await waitFor(() => pushes > 0, 'the proposals push');
  const [listed] = await proposals.list();
  assert.deepEqual(listed, { path: `${TODAY}-role.md`, date: TODAY, description: 'What the owner is responsible for', target: null, folder: 'owner' });

  // A fresh profile has no folders yet: the picker offers the one the proposal names, and promoting creates it.
  const { folders } = await proposals.targets();
  assert.deepEqual(folders, []);
  assert.deepEqual(folderChoices(listed!, folders), ['owner']);
  assert.equal(defaultFolder(listed!, folders), 'owner');
  const shownDiff = await proposals.diff(listed!.path);
  await proposals.promote(listed!.path, undefined, { proposal: shownDiff.proposed, path: shownDiff.proposal.target, page: shownDiff.current });
  assert.ok(existsSync(join(knowledgeDir, 'owner', 'role.md')));
  assert.match(readFileSync(join(knowledgeDir, 'index.md'), 'utf8'), /`owner\/role\.md`/);
});

test('the watcher follows the profile, and a profile without knowledge/ only logs', async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  let pushes = 0;
  const logs: string[] = [];
  const watcher = followProposals(() => { pushes += 1; }, { debounceMs: 20, log: (message) => logs.push(message) });
  t.after(() => watcher.close());

  watcher.follow(first.profileDir);
  watcher.follow(second.profileDir);
  writeFileSync(join(first.knowledgeDir, 'proposals', `${TODAY}-old.md`), proposal);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pushes, 0, 'the profile it left is no longer watched');
  // A nested folder under proposals/ counts too.
  mkdirSync(join(second.knowledgeDir, 'proposals', 'product'));
  writeFileSync(join(second.knowledgeDir, 'proposals', 'product', `${TODAY}-billing.md`), proposal);
  await waitFor(() => pushes > 0, 'the push for the followed profile');

  watcher.follow(join(second.root, 'missing'));
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /not watching .*missing\/knowledge\/proposals/);
  watcher.follow(null);
});

test('setup and pnpm onboard point at the app and the interview brief', (t) => {
  const { profileDir } = fixture(t);
  assert.match(onboardingPrompt(profileDir), /Start interview/);
  assert.match(readFileSync(join(profileDir, 'onboarding.md'), 'utf8'), /pnpm onboard --profile/);
  assert.equal(interviewStartedText({ branch: 'friday/knowledge-interview' }), 'Interview started in T3 on friday/knowledge-interview. What you confirm there shows up here.');
});
