import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pagesHandlers } from '../src/handlers/pages.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../src/status-source.ts';
import {
  badgeCounts, badgeLabel, badgeTitle, badgeTone, editorState, filterPages, groupByFolder, keepSelection, localDate, markVerified,
  pagesSummary,
} from '../app/renderer/screens/pages.logic.ts';
import type { KnowledgePage, PageBadge } from '../src/contracts.ts';
import { engineContext, type AppContext } from './fakes/app-context.ts';

const header = (verified: string): string =>
  ['---', 'type: product', 'description: Billing rules', 'written: 2026-11-01', `verified: ${verified}`, 'sources: code', '---', ''].join('\n');

const listed = (path: string, badge: PageBadge, description?: string): KnowledgePage =>
  ({ path, badge, verified: badge === 'unverified' ? null : '2026-11-01', lines: 10, problems: [], warnings: [], ...(description ? { description } : {}) });

// ---------------------------------------------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------------------------------------------

test('badges: label, tone and tooltip for each badge', () => {
  assert.deepEqual((['verified', 'stale', 'unverified'] as const).map((badge) => [badgeLabel(badge), badgeTone(badge)]), [
    ['Verified', 'up'], ['Stale', 'warn'], ['Unverified', 'neutral'],
  ]);
  assert.equal(badgeTitle({ badge: 'verified', verified: '2026-11-16' }), 'Verified 2026-11-16.');
  assert.match(badgeTitle({ badge: 'stale', verified: '2026-09-01' }), /more than 60 days ago/);
  assert.match(badgeTitle({ badge: 'unverified', verified: null }), /not confirmed/);
});

test('summary, counts, filter and folder grouping', () => {
  const pages = [listed('owner/role.md', 'verified'), listed('product/billing.md', 'stale', 'How invoices work'), listed('top.md', 'unverified'), listed('product/api.md', 'verified')];
  assert.equal(pagesSummary(pages), '4 pages · 2 verified · 1 stale · 1 unverified');
  assert.equal(pagesSummary([listed('a.md', 'verified')]), '1 page · 1 verified');
  assert.equal(pagesSummary([]), 'No pages yet');
  assert.deepEqual(badgeCounts(pages), { all: 4, verified: 2, stale: 1, unverified: 1 });
  assert.deepEqual(filterPages(pages, 'verified').map((page) => page.path), ['owner/role.md', 'product/api.md']);
  assert.deepEqual(filterPages(pages, 'all', 'INVOICES').map((page) => page.path), ['product/billing.md'], 'matches the description, any case');
  assert.deepEqual(filterPages(pages, 'stale', 'owner'), []);
  assert.deepEqual(groupByFolder(pages).map((group) => [group.folder, group.pages.map((page) => page.path)]), [
    ['', ['top.md']], ['owner', ['owner/role.md']], ['product', ['product/billing.md', 'product/api.md']],
  ]);
  assert.equal(keepSelection(pages, 'product/api.md'), 'product/api.md');
  assert.equal(keepSelection(pages, 'gone.md'), 'owner/role.md');
  assert.equal(keepSelection([], 'gone.md'), null);
});

test('editor: clean, dirty, and blocked over the cap or with a broken header', () => {
  const saved = `${header('no')}Body.\n`;
  const clean = editorState('owner/role.md', saved, saved);
  assert.deepEqual([clean.dirty, clean.canSave, clean.refusal, clean.linesLabel], [false, false, null, '8 / 120 lines']);
  assert.equal(editorState('owner/role.md', saved, saved.replace(/\n/g, '\r\n') + '\n\n').dirty, false, 'line endings and trailing blank lines are not edits');

  const edited = editorState('owner/role.md', saved, `${saved}More.\n`);
  assert.deepEqual([edited.dirty, edited.canSave], [true, true]);

  const long = editorState('owner/role.md', saved, `${saved}${'line\n'.repeat(120)}`);
  assert.equal(long.overCap, true);
  assert.equal(long.canSave, false);
  assert.equal(long.refusal, 'Not saved. Fix the page first:\nowner/role.md: 128 lines. The cap is 120; split the page.');

  const noHeader = editorState('owner/role.md', saved, 'Just text.\n');
  assert.equal(noHeader.canSave, false);
  assert.match(noHeader.refusal ?? '', /owner\/role\.md: no header/);
});

test('mark verified sets the header date, and today is the local calendar date', () => {
  assert.match(markVerified(`${header('no')}Body.\n`, '2026-11-19'), /\nverified: 2026-11-19\n/);
  assert.equal(markVerified('No header.\n', '2026-11-19'), 'No header.\n');
  assert.equal(localDate(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
});

// ---------------------------------------------------------------------------------------------------------------
// Handlers, on a temp profile
// ---------------------------------------------------------------------------------------------------------------

const profile = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-app-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knowledge = join(dir, 'knowledge');
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(knowledge, path)), { recursive: true });
    writeFileSync(join(knowledge, path), text);
  };
  write('index.md', '# Index\n\n| `product/billing.md` |\n');
  write('product/billing.md', `${header('no')}Invoices go out monthly.\n`);
  const context: AppContext = {
    profileDir: () => dir,
    profileDirOrNull: () => dir,
    prefs: memoryPrefs(),
    status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
    openExternal: async () => {},
    openPath: async () => {},
  };
  return { knowledge, handlers: pagesHandlers(engineContext(context)) };
};

test('handlers: list, read and save a page without a profile.json', async (t) => {
  const { knowledge, handlers } = profile(t);
  assert.deepEqual((await handlers.list()).map((page) => [page.path, page.badge]), [['product/billing.md', 'unverified']]);
  const text = await handlers.read('product/billing.md');
  const updated = await handlers.save('product/billing.md', markVerified(text, localDate(new Date())));
  assert.equal(updated.badge, 'verified');
  assert.match(readFileSync(join(knowledge, 'product/billing.md'), 'utf8'), /Invoices go out monthly\./);
});

test('handlers: a save the editor blocks is refused with the editor\'s message, and the file is untouched', async (t) => {
  const { knowledge, handlers } = profile(t);
  const before = readFileSync(join(knowledge, 'product/billing.md'), 'utf8');
  const draft = `${before}${'more\n'.repeat(130)}`;
  const { refusal } = editorState('product/billing.md', before, draft);
  assert.ok(refusal);
  await assert.rejects(async () => handlers.save('product/billing.md', draft), (error: Error) => error.message === refusal);
  await assert.rejects(async () => handlers.save('', draft), /Page is missing/);
  await assert.rejects(async () => handlers.save('product/billing.md', 42 as unknown as string), /A page is text/);
  await assert.rejects(async () => handlers.read('../profile.json'), /inside knowledge\//);
  assert.equal(readFileSync(join(knowledge, 'product/billing.md'), 'utf8'), before);
});
