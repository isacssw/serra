import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { proposalsHandlers } from '../app/main/ipc/proposals.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import {
  dateLabel, defaultFolder, diffRows, diffStats, folderLabel, folderOf, groupByDate, nextSelection, pendingLabel, proposalBody, proposalTitle,
  withoutTarget,
} from '../app/renderer/screens/proposals.logic.ts';
import type { Proposal } from '../src/contracts.ts';

const proposal = (path: string, date: string | null, target: string | null = null): Proposal => ({ path, date, target });

// ---------------------------------------------------------------------------------------------------------------
// Grouping and labels
// ---------------------------------------------------------------------------------------------------------------

test('groups the queue by date, newest first, undated last, keeping order inside a group', () => {
  const groups = groupByDate([
    proposal('2026-11-16-ci.md', '2026-11-16'),
    proposal('notes.md', null),
    proposal('2026-11-19-b.md', '2026-11-19'),
    proposal('2026-11-19-a.md', '2026-11-19'),
    proposal('2026-11-18-access.md', '2026-11-18'),
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.proposals.map((p) => p.path)]), [
    ['Nov 19', ['2026-11-19-b.md', '2026-11-19-a.md']],
    ['Nov 18', ['2026-11-18-access.md']],
    ['Nov 16', ['2026-11-16-ci.md']],
    ['Undated', ['notes.md']],
  ]);
  assert.deepEqual(groupByDate([]), []);
});

test('date labels read the calendar date with no time zone shift', () => {
  assert.equal(dateLabel('2026-01-01'), 'Jan 1');
  assert.equal(dateLabel('2026-12-31'), 'Dec 31');
  assert.equal(dateLabel(null), 'Undated');
  assert.equal(dateLabel('2026-13-01'), 'Undated');
});

test('titles come from the file name without folder, date or extension', () => {
  assert.equal(proposalTitle({ path: '2026-11-19-ci-rerun-guide.md' }), 'Ci rerun guide');
  assert.equal(proposalTitle({ path: 'runbooks/2026-11-18-retry_policy.md' }), 'Retry policy');
  assert.equal(proposalTitle({ path: 'notes.md' }), 'Notes');
  assert.equal(proposalTitle({ path: '2026-11-19.md' }), '2026-11-19.md');
  assert.equal(pendingLabel(18), '18 pending');
  assert.equal(pendingLabel(0), 'Nothing waiting');
});

test('folder picker: starts on the target page folder when it exists, else the first folder', () => {
  const folders = ['owner', 'runbooks', 'runbooks/ci'];
  assert.equal(folderOf('runbooks/ci/retries.md'), 'runbooks/ci');
  assert.equal(folderOf('top.md'), null);
  assert.equal(folderLabel('runbooks/ci'), 'Runbooks / ci');
  assert.equal(defaultFolder({ target: 'runbooks/ci/retries.md' }, folders), 'runbooks/ci');
  assert.equal(defaultFolder({ target: 'gone/page.md' }, folders), 'owner');
  assert.equal(defaultFolder({ target: null }, folders), 'owner');
  assert.equal(defaultFolder({ target: null }, []), null);
});

test('after a proposal leaves the queue, the next one is selected, else the one before', () => {
  const list = [proposal('a.md', null), proposal('b.md', null), proposal('c.md', null)];
  assert.equal(nextSelection(list, 'a.md'), 'b.md');
  assert.equal(nextSelection(list, 'b.md'), 'c.md');
  assert.equal(nextSelection(list, 'c.md'), 'b.md');
  assert.equal(nextSelection([proposal('a.md', null)], 'a.md'), null);
  assert.equal(nextSelection(list, 'missing.md'), 'a.md');
});

// ---------------------------------------------------------------------------------------------------------------
// Diff line model
// ---------------------------------------------------------------------------------------------------------------

const show = (rows: ReturnType<typeof diffRows>): string[] => rows.map(({ current, proposed }) =>
  `${current ? `${current.kind[0]}${current.number} ${current.text}` : '·'} | ${proposed ? `${proposed.kind[0]}${proposed.number} ${proposed.text}` : '·'}`);

test('diff: a changed line sits next to its replacement, unchanged lines line up', () => {
  const rows = diffRows('# Retries\nRetry once after 5 min.\nCheck the run log.\n', '# Retries\nRetry twice after 2 min.\nCheck the run log.\n');
  assert.deepEqual(show(rows), [
    's1 # Retries | s1 # Retries',
    'r2 Retry once after 5 min. | a2 Retry twice after 2 min.',
    's3 Check the run log. | s3 Check the run log.',
  ]);
  assert.deepEqual(diffStats(rows), { removed: 1, added: 1 });
});

test('diff: added and removed runs of different lengths leave the shorter side empty, numbers stay per side', () => {
  const rows = diffRows('a\nx\nb\n', 'a\ny1\ny2\nb\nc');
  assert.deepEqual(show(rows), [
    's1 a | s1 a',
    'r2 x | a2 y1',
    '· | a3 y2',
    's3 b | s4 b',
    '· | a5 c',
  ]);
  assert.deepEqual(show(diffRows('a\nb\nc\n', 'a\nc\n')), ['s1 a | s1 a', 'r2 b | ·', 's3 c | s2 c']);
});

test('diff: a new page has only proposed lines; identical texts have no changes; CRLF is the same as LF', () => {
  const rows = diffRows(null, 'one\ntwo\n');
  assert.deepEqual(show(rows), ['· | a1 one', '· | a2 two']);
  assert.deepEqual(diffStats(diffRows('same\ntext\n', 'same\ntext\n')), { removed: 0, added: 0 });
  assert.deepEqual(diffStats(diffRows('a\r\nb\r\n', 'a\nb\n')), { removed: 0, added: 0 });
  assert.deepEqual(diffRows('', ''), []);
});

// ---------------------------------------------------------------------------------------------------------------
// IPC handlers on APP-3's services
// ---------------------------------------------------------------------------------------------------------------

const page = (description: string, text: string, target?: string): string => [
  '---', 'type: preference', `description: ${description}`, 'written: 2026-11-16', 'verified: no',
  ...(target ? [`target: ${target}`] : []), 'sources:', '  - Owner interview, 2026-11-16', '---', '', text, '',
].join('\n');

const INDEX = '# Knowledge index\n\n| When the request | Open | What it gives you |\n|---|---|---|\n| who owns what | `owner/role.md` | The owner\'s role |\n';

const profile = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-app-proposals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knowledge = join(dir, 'knowledge');
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(knowledge, path)), { recursive: true });
    writeFileSync(join(knowledge, path), text);
  };
  write('index.md', INDEX);
  write('log.md', '# Knowledge changes\n');
  write('README.md', '# Owner knowledge\n');
  write('owner/role.md', page('The owner\'s role', 'Owns the API.'));
  mkdirSync(join(knowledge, 'runbooks'));
  write('proposals/README.md', '# Knowledge proposals\n');
  write('proposals/2026-11-16-deploys.md', page('How deploys work', 'Deploys go out on Tuesdays.'));
  write('proposals/2026-11-18-reviews.md', page('Review style', 'Also reviews every PR.', 'owner/role.md'));
  const files = ['index.md', 'log.md', 'owner/role.md', 'proposals/2026-11-16-deploys.md', 'proposals/2026-11-18-reviews.md', 'runbooks/deploys.md', 'owner/reviews.md'];
  const snapshot = () => Object.fromEntries(files.map((path) => {
    const absolute = join(knowledge, path);
    return [path, existsSync(absolute) ? readFileSync(absolute, 'utf8') : null];
  }));
  const context: HandlerContext = {
    profileDir: () => dir,
    profileDirOrNull: () => dir,
    prefs: memoryPrefs(),
    status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
    openExternal: async () => {},
    openPath: async () => {},
  };
  return { knowledge, snapshot, handlers: proposalsHandlers(context) };
};

test('handlers: list, diff and the folder and page pickers come from the profile', async (t) => {
  const { handlers } = profile(t);
  assert.deepEqual((await handlers.list()).map((p) => p.path), ['2026-11-18-reviews.md', '2026-11-16-deploys.md']);
  const diff = await handlers.diff('2026-11-18-reviews.md');
  assert.match(diff.current ?? '', /Owns the API\./);
  assert.deepEqual(await handlers.targets(), { folders: ['owner', 'runbooks'], pages: ['owner/role.md'] });
});

/** What the screen shows before an approval, as the handlers get it back. */
const shown = async (handlers: { diff: (path: string) => unknown }, path: string) => {
  const { proposed, current, proposal } = await handlers.diff(path) as { proposed: string; current: string | null; proposal: { target: string | null } };
  return { proposal: proposed, path: proposal.target, page: current };
};

test('handlers: promoting then undoing restores every file', async (t) => {
  const { handlers, snapshot } = profile(t);
  const before = snapshot();
  const { undoId } = await handlers.promote('2026-11-16-deploys.md', 'runbooks', await shown(handlers, '2026-11-16-deploys.md'));
  const after = snapshot();
  assert.equal(after['proposals/2026-11-16-deploys.md'], null);
  assert.match(after['runbooks/deploys.md'] ?? '', /Deploys go out on Tuesdays\./);
  assert.match(after['index.md'] ?? '', /`runbooks\/deploys\.md`/);
  assert.deepEqual((await handlers.list()).map((p) => p.path), ['2026-11-18-reviews.md']);
  await handlers.undo(undoId);
  assert.deepEqual(snapshot(), before);
  await assert.rejects(async () => handlers.undo(undoId), /already undone/);
});

test('handlers: promote without a folder uses the target page folder, or asks for one', async (t) => {
  const { handlers, snapshot } = profile(t);
  await assert.rejects(async () => handlers.promote('2026-11-16-deploys.md', undefined, await shown(handlers, '2026-11-16-deploys.md')), /Pick a folder/);
  await assert.rejects(async () => handlers.promote('2026-11-18-reviews.md', undefined, undefined as never), /Review the proposal/);
  await handlers.promote('2026-11-18-reviews.md', undefined, await shown(handlers, '2026-11-18-reviews.md'));
  // The proposal names owner/role.md, so it replaces that page instead of landing beside it.
  assert.match(snapshot()['owner/role.md'] ?? '', /Also reviews every PR\./);
  assert.equal(snapshot()['owner/reviews.md'], null);
});

test('handlers: merge and discard can be undone too, and bad input is refused', async (t) => {
  const { handlers, snapshot } = profile(t);
  const before = snapshot();
  const merged = await handlers.mergeInto('2026-11-18-reviews.md', 'owner/role.md', undefined, await shown(handlers, '2026-11-18-reviews.md'));
  assert.match(snapshot()['owner/role.md'] ?? '', /Also reviews every PR\./);
  const discarded = await handlers.discard('2026-11-16-deploys.md');
  assert.deepEqual(await handlers.list(), []);
  await handlers.undo(discarded.undoId);
  await handlers.undo(merged.undoId);
  assert.deepEqual(snapshot(), before);
  await assert.rejects(async () => handlers.mergeInto('2026-11-18-reviews.md', '', undefined, await shown(handlers, '2026-11-18-reviews.md')), /Page to merge into is missing/);
  await assert.rejects(async () => handlers.promote('2026-11-16-deploys.md', '../outside', await shown(handlers, '2026-11-16-deploys.md')), /inside knowledge/);
  await assert.rejects(async () => handlers.diff(42 as unknown as string), /Proposal is missing/);
});

test('the merge dialog starts from the proposal as a page, or from its text under the current page', () => {
  const proposal = '---\ntype: preference\ndescription: Releases\ntarget: owner/role.md\nverified: no\n---\n# Robin\n\n- Ship on Tuesday.\n';
  assert.equal(withoutTarget(proposal), '---\ntype: preference\ndescription: Releases\nverified: no\n---\n# Robin\n\n- Ship on Tuesday.\n');
  assert.equal(proposalBody(proposal), '# Robin\n\n- Ship on Tuesday.');
});
