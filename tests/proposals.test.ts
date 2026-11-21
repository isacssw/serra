import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createKnowledge } from '../src/knowledge.ts';
import { runCli } from '../src/manage.ts';
import { createProposals } from '../src/proposals.ts';

/** What the app shows the owner before an approval: the proposal and the page it would change. */
const shown = (service: { readProposal: (id: string) => { proposed: string; current: string | null; proposal: { target: string | null } } }, id: string) => {
  try {
    const { proposed, current, proposal } = service.readProposal(id);
    return { proposal: proposed, path: proposal.target, page: current };
  } catch {
    return { proposal: '', path: null, page: null };
  }
};

const NOW = new Date('2026-11-19T12:00:00Z');

const page = (fields: { description: string; verified?: string; sources?: string[]; target?: string }, text: string): string => [
  '---', 'type: preference', `description: ${fields.description}`, 'written: 2026-11-16', `verified: ${fields.verified ?? 'no'}`,
  ...(fields.target ? [`target: ${fields.target}`] : []),
  'sources:', ...(fields.sources ?? ['Owner interview, 2026-11-16']).map((source) => `  - ${source}`), '---', '', text, '',
].join('\n');

const INDEX = '# Knowledge index\n\n| When the request | Open | What it gives you |\n|---|---|---|\n| who owns what | `owner/role.md` | The owner\'s role |\n';
const ROLE = page({ description: 'The owner\'s role', verified: '2026-11-10' }, 'Owns the API.');

/** A profile with one indexed page and three proposals: two new pages and one that names its target. */
const profile = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-proposals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knowledge = join(dir, 'knowledge');
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(knowledge, path)), { recursive: true });
    writeFileSync(join(knowledge, path), text);
  };
  write('index.md', INDEX);
  write('log.md', '# Knowledge changes\n');
  write('README.md', '# Owner knowledge\n');
  write('owner/role.md', ROLE);
  write('proposals/README.md', '# Knowledge proposals\n');
  write('proposals/onboarding-progress.md', 'Topics done: none\n');
  write('proposals/2026-11-16-deploys.md', page({ description: 'How deploys work', sources: ['https://slack.test/archives/C1/p1'] }, 'Deploys go out on Tuesdays.'));
  write('proposals/2026-11-18-reviews.md', page({ description: 'Review style', target: 'owner/role.md', sources: ['https://slack.test/archives/C1/p2'] }, 'Also reviews every PR.'));
  write('proposals/notes.md', page({ description: 'Undated' }, 'Some note.'));
  const read = (path: string): string | null => existsSync(join(knowledge, path)) ? readFileSync(join(knowledge, path), 'utf8') : null;
  const snapshot = () => Object.fromEntries(['index.md', 'log.md', 'owner/role.md', 'proposals/2026-11-16-deploys.md', 'proposals/2026-11-18-reviews.md', 'ops/deploys.md'].map((path) => [path, read(path)]));
  return { dir, knowledge, write, read, snapshot, service: createProposals({ knowledgeDir: knowledge, now: () => NOW }) };
};

test('lists proposals newest first, skipping the README and onboarding progress, with dates and targets', (t) => {
  const { service } = profile(t);
  assert.deepEqual(service.listProposals(), [
    { path: '2026-11-18-reviews.md', date: '2026-11-18', description: 'Review style', target: 'owner/role.md' },
    { path: '2026-11-16-deploys.md', date: '2026-11-16', description: 'How deploys work', target: null },
    { path: 'notes.md', date: null, description: 'Undated', target: null },
  ]);
});

test('reads a proposal next to the page it changes, or null for a new page', (t) => {
  const { service } = profile(t);
  const diff = service.readProposal('2026-11-18-reviews.md');
  assert.equal(diff.current, ROLE);
  assert.match(diff.proposed, /Also reviews every PR\./);
  assert.equal(service.readProposal('2026-11-16-deploys.md').current, null);
  assert.throws(() => service.readProposal('missing.md'), /No proposal missing\.md/);
  assert.throws(() => service.readProposal('README.md'), /not a proposal/);
});

test('promote moves the page, adds its index row and a log line, verifies it, and writes a backup', (t) => {
  const { dir, knowledge, read, service } = profile(t);
  const change = service.promoteProposal('2026-11-16-deploys.md', { reviewed: shown(service, '2026-11-16-deploys.md'), folder: 'ops', when: 'a deploy question' });

  assert.equal(change.page, 'ops/deploys.md');
  assert.equal(read('proposals/2026-11-16-deploys.md'), null, 'gone from proposals/');
  assert.match(read('ops/deploys.md')!, /^verified: 2026-11-19$/m);
  assert.match(read('ops/deploys.md')!, /Deploys go out on Tuesdays\./);
  assert.ok(read('index.md')!.endsWith('| a deploy question | `ops/deploys.md` | How deploys work |\n'));
  assert.match(read('log.md')!, /^- 2026-11-19: promoted `proposals\/2026-11-16-deploys\.md` to `ops\/deploys\.md`/m);

  const backup = JSON.parse(readFileSync(join(dir, 'backups', 'knowledge', change.id, 'change.json'), 'utf8'));
  assert.equal(backup.action, 'promote');
  assert.equal(backup.files.find((file: { path: string }) => file.path === 'proposals/2026-11-16-deploys.md').after, null);
  assert.match(backup.files.find((file: { path: string }) => file.path === 'proposals/2026-11-16-deploys.md').before, /Tuesdays/);

  // The result passes the knowledge check, and the proposal no longer counts as waiting.
  const report = createKnowledge(knowledge).checkKnowledge({ now: NOW });
  assert.deepEqual(report.problems, []);
  assert.ok(!report.proposals.includes('proposals/2026-11-16-deploys.md'));
  assert.ok(!report.pages.some((path) => path.includes('backups')), 'backups live outside knowledge/');
});

test('promote replaces the page a proposal targets and keeps its index row; undo brings the old page back', (t) => {
  // QA: the interview writes a page update as the whole page with `target:` naming it, but Promote put it next to
  // that page as owner/reviews.md, a duplicate, and Merge appended the whole page to the old one.
  const { read, snapshot, service } = profile(t);
  const before = snapshot();
  const change = service.promoteProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), folder: 'owner' });

  assert.equal(change.page, 'owner/role.md');
  const page = read('owner/role.md')!;
  assert.match(page, /^verified: 2026-11-19$/m);
  assert.match(page, /^description: Review style$/m);
  assert.match(page, /Also reviews every PR\.\n$/);
  assert.doesNotMatch(page, /Owns the API/, 'the proposal is the whole page, not an addition');
  assert.doesNotMatch(page, /^target:/m, 'a confirmed page no longer names a target');
  assert.equal(read('owner/reviews.md'), null, 'no duplicate page');
  assert.equal(read('index.md'), before['index.md'], 'the page keeps its one index row');
  assert.match(read('log.md')!, /^- 2026-11-19: replaced `owner\/role\.md` with `proposals\/2026-11-18-reviews\.md`/m);
  assert.equal(read('proposals/2026-11-18-reviews.md'), null);

  service.undoProposalChange(change.id);
  assert.deepEqual(snapshot(), before);
});

test('a targeted proposal promoted into another folder becomes a new page there', (t) => {
  const { read, service } = profile(t);
  const role = read('owner/role.md');
  const change = service.promoteProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), folder: 'ops' });
  assert.equal(change.page, 'ops/reviews.md');
  assert.doesNotMatch(read('ops/reviews.md')!, /^target:/m);
  assert.equal(read('owner/role.md'), role);
  assert.match(read('index.md')!, /`ops\/reviews\.md`/);
});

test('undo restores every file a promotion touched, once', (t) => {
  const { snapshot, service } = profile(t);
  const before = snapshot();
  const change = service.promoteProposal('2026-11-16-deploys.md', { reviewed: shown(service, '2026-11-16-deploys.md'), folder: 'ops' });
  assert.notDeepEqual(snapshot(), before);
  service.undoPromotion(change.id);
  assert.deepEqual(snapshot(), before);
  assert.throws(() => service.undoPromotion(change.id), /already undone/);
});

test('undo refuses when a file changed after the promotion, and changes nothing', (t) => {
  const { write, snapshot, service } = profile(t);
  const change = service.promoteProposal('2026-11-16-deploys.md', { reviewed: shown(service, '2026-11-16-deploys.md'), folder: 'ops' });
  write('ops/deploys.md', 'Edited by hand after promoting.\n');
  const edited = snapshot();
  assert.throws(() => service.undoProposalChange(change.id), /ops\/deploys\.md changed outside Serra/, "a hand edit is reviewed in Pages before anything is undone over it");
  assert.deepEqual(snapshot(), edited);
  assert.throws(() => service.undoProposalChange('../../etc'), /Not a backup ID/);
  assert.throws(() => service.undoProposalChange('nope'), /No backup nope/);
});

test('promote refuses targets outside knowledge/, inside proposals/, onto special files or existing pages', (t) => {
  const { dir, snapshot, service } = profile(t);
  const before = snapshot();
  const promote = (folder: string, name?: string) => () => service.promoteProposal('2026-11-16-deploys.md', { reviewed: shown(service, '2026-11-16-deploys.md'), folder, ...(name ? { name } : {}) });
  assert.throws(promote('../outside'), /inside knowledge\//);
  assert.throws(promote('/tmp'), /inside knowledge\//);
  assert.throws(promote('ops/../../outside'), /inside knowledge\//);
  assert.throws(promote('proposals'), /can't be inside proposals\//);
  assert.throws(promote('ops', '../x.md'), /file name, not a path/);
  assert.throws(promote('ops', 'deploys.txt'), /must be a \.md file/);
  assert.throws(promote('owner', 'role.md'), /already exists\. Merge/);
  assert.throws(promote(''), /Pick a folder/);
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'knowledge', 'linked'));
  assert.throws(promote('linked'), /outside knowledge\//, 'a symlinked folder cannot lead out');
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(readdirSync(join(dir, 'elsewhere')), []);
  assert.ok(!existsSync(join(dir, 'backups')), 'a refused promotion writes no backup');
});

test('promote refuses a proposal that would fail the knowledge check or overflow the index', (t) => {
  const { write, read, service } = profile(t);
  write('proposals/2026-11-17-bare.md', 'No header at all.\n');
  assert.throws(() => service.promoteProposal('2026-11-17-bare.md', { reviewed: shown(service, '2026-11-17-bare.md'), folder: 'ops' }), /no header/);
  write('index.md', INDEX + '| row |\n'.repeat(60));
  assert.throws(() => service.promoteProposal('2026-11-16-deploys.md', { reviewed: shown(service, '2026-11-16-deploys.md'), folder: 'ops' }), /cap is 60/);
  assert.notEqual(read('proposals/2026-11-16-deploys.md'), null);
  assert.throws(() => service.promoteProposal('../index.md', { reviewed: shown(service, '../index.md'), folder: 'ops' }), /inside knowledge\//);
});

test('merge replaces the page with the proposal, adds the sources, verifies the page and can be undone', (t) => {
  const { read, snapshot, service } = profile(t);
  const before = snapshot();
  const change = service.mergeProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), into: 'owner/role.md' });
  const merged = read('owner/role.md')!;
  assert.match(merged, /\nAlso reviews every PR\.\n$/);
  assert.doesNotMatch(merged, /Owns the API/, 'the proposal is the whole page: nothing is appended beside the old text');
  assert.doesNotMatch(merged, /^target:/m);
  assert.match(merged, /^verified: 2026-11-19$/m);
  assert.match(merged, /sources:\n {2}- Owner interview, 2026-11-16\n {2}- https:\/\/slack\.test\/archives\/C1\/p2\n---/);
  assert.equal(merged.match(/^---$/gm)?.length, 2, 'one header only');
  assert.equal(read('proposals/2026-11-18-reviews.md'), null);
  assert.equal(read('index.md'), INDEX, 'no new index row');
  assert.match(read('log.md')!, /merged `proposals\/2026-11-18-reviews\.md` into `owner\/role\.md`/);
  service.undoProposalChange(change.id);
  assert.deepEqual(snapshot(), before);
});

test('merge takes the owner\'s edited text, and refuses missing, outside or invalid targets', (t) => {
  const { read, service } = profile(t);
  assert.throws(() => service.mergeProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), into: 'owner/nobody.md' }), /doesn't exist\. Promote/);
  assert.throws(() => service.mergeProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), into: '../profile.json' }), /inside knowledge\//);
  assert.throws(() => service.mergeProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), into: 'index.md' }), /not a page/);
  assert.throws(() => service.mergeProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), into: 'owner/role.md', text: 'no header' }), /no header/);
  const edited = page({ description: 'The owner\'s role', verified: '2026-11-19' }, 'Owns the API and reviews every PR.');
  service.mergeProposal('2026-11-18-reviews.md', { reviewed: shown(service, '2026-11-18-reviews.md'), into: 'owner/role.md', text: edited });
  assert.match(read('owner/role.md')!, /\nOwns the API and reviews every PR\.\n$/);
  assert.match(read('owner/role.md')!, /https:\/\/slack\.test\/archives\/C1\/p2/, 'the proposal\'s sources are kept');
});

test('merging a proposal that is not a whole page for the target needs the owner\'s edited page', (t) => {
  const { service } = profile(t);
  assert.throws(() => service.mergeProposal('2026-11-16-deploys.md', { reviewed: shown(service, '2026-11-16-deploys.md'), into: 'owner/role.md' }), /isn't a whole page for owner\/role\.md/);
});

test('discard removes the proposal and undo brings it back', (t) => {
  const { read, service } = profile(t);
  const text = read('proposals/notes.md');
  const change = service.discardProposal('notes.md');
  assert.equal(read('proposals/notes.md'), null);
  assert.equal(read('log.md'), '# Knowledge changes\n', 'a discard is not a knowledge change');
  service.undoProposalChange(change.id);
  assert.equal(read('proposals/notes.md'), text);
});

test('pnpm bot proposals lists and shows, and refuses to approve: that is the owner\'s, in the app', async (t) => {
  const { dir, read } = profile(t);
  const run = async (...args: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const code = await runCli(['proposals', ...args, '--profile', dir], { log: (line) => out.push(line), error: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const list = await run();
  assert.equal(list.code, 0);
  assert.match(list.out, /^3 proposals waiting:\n {2}2026-11-18-reviews\.md \(changes owner\/role\.md\) - Review style/);
  assert.match((await run('show', '2026-11-18-reviews.md')).out, /--- current: knowledge\/owner\/role\.md/);
  for (const action of [['promote', '2026-11-16-deploys.md', '--folder', 'ops'], ['merge', '2026-11-16-deploys.md', '--into', 'owner/role.md'], ['discard', '2026-11-16-deploys.md'], ['undo', 'x']]) {
    const refused = await run(...action);
    assert.equal(refused.code, 1, action[0]);
    assert.match(refused.err, /approved in the Serra app/);
  }
  assert.equal(read('ops/deploys.md'), null);
  assert.notEqual(read('proposals/2026-11-16-deploys.md'), null);
});
