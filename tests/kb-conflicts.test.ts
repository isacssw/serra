// SERRA-117: the knowledge base conflict review. A rule learned again on a later day (its day written into the line)
// is a repeat, not a conflict; real disagreements are still caught; each pair is its own row; "Keep newer for all"
// moves only the lines it should, after a backup; "Both hold" never touches a page; and nothing is written to
// knowledge/ by looking. Fixtures only (tests/fakes/kb-conflicts.ts): no model, no real knowledge base.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pagesHandlers } from '../app/main/ipc/pages.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { groupLine, groupPairs, isSafe, keepNames, keepNewerForAll, rowNames, sideNames, versus, wordDiff, type PairIssue } from '../app/renderer/screens/conflicts.logic.ts';
import { keepNewerOnPages, keepOne, keepOver } from '../app/renderer/screens/keep.ts';
import { fixItems, needsYou, todoTally } from '../app/renderer/screens/overview.logic.ts';
import { currentRules } from '../app/renderer/screens/pages.logic.ts';
import { dismissedPairs } from '../src/knowledge-dismissals.ts';
import { assessKnowledge, findOverlaps, learnedOn, markIndexRows, pageFacts, pairId, ruleText, type KnowledgeFile } from '../src/knowledge-health.ts';
import { knowledgeGraph, knowledgeOverview } from '../src/knowledge-overview.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { oldFormatKnowledge, OLD_FORMAT_PAGES } from './fakes/kb-conflicts.ts';

const NOW = new Date('2026-11-27T12:00:00Z');
const TODAY = '2026-11-27';

const pairsOf = (files: KnowledgeFile[], dismissed?: Set<string>) => assessKnowledge(files, NOW, undefined, { dismissed }).issues
  .filter((issue): issue is typeof issue & PairIssue => (issue.kind === 'conflict' || issue.kind === 'duplicate') && issue.pair !== undefined);

/** A profile with the fake knowledge base on disk, and the app's own page handlers on it. */
const profile = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-kb-conflicts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knowledge = join(dir, 'knowledge');
  for (const file of oldFormatKnowledge()) {
    mkdirSync(dirname(join(knowledge, file.path)), { recursive: true });
    writeFileSync(join(knowledge, file.path), file.text);
  }
  const context: HandlerContext = {
    profileDir: () => dir, profileDirOrNull: () => dir, prefs: memoryPrefs(), status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' }, openExternal: async () => {}, openPath: async () => {},
  };
  // As the app does on first open: the approved copy the bot reads, so an edit outside Serra shows as one.
  createKnowledge(knowledge).seedApproved();
  const handlers = pagesHandlers(context);
  // The renderer's bridge, as far as keep.ts uses it: the same handlers the app calls.
  const bridge = { pages: { read: async (path: string) => handlers.read(path), save: async (path: string, text: string, expected?: string) => handlers.save(path, text, expected) } } as Parameters<typeof keepOne>[0];
  return { dir, knowledge, handlers, bridge, backups: join(dir, 'backups', 'knowledge') };
};

/** Every file under a folder, by path, with a hash of its bytes and its modified time. */
const snapshot = (root: string, at = ''): Record<string, string> => Object.fromEntries(readdirSync(join(root, at), { withFileTypes: true }).flatMap((entry) => {
  const path = at ? `${at}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return Object.entries(snapshot(root, path));
  const full = join(root, path);
  return [[path, `${createHash('sha256').update(readFileSync(full)).digest('hex')}@${statSync(full).mtimeMs}`]];
}));

const backupsOf = (dir: string): { action: string; page: string; files: { path: string; before: string; after: string }[] }[] => (existsSync(dir)
  ? readdirSync(dir).map((id) => JSON.parse(readFileSync(join(dir, id, 'change.json'), 'utf8')) as { action: string; page: string; files: { path: string; before: string; after: string }[] })
  : []);

// ---------------------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------------------

test('a rule learned again on a later day reads the same: dates, (date, source) notes, links and meeting tags are not compared', () => {
  assert.equal(ruleText('Open every PR as a draft and link the Linear issue (2026-11-16)'), 'Open every PR as a draft and link the Linear issue');
  assert.equal(ruleText('Refunds v2 ships on Tuesday (2026-11-20, Payments sync: Ana; LIN-482) <!-- m:a1b2c3 -->'), 'Refunds v2 ships on Tuesday');
  assert.equal(ruleText('Read [the runbook](https://wiki.acme.dev/x) before a rollback (from #team-dx, Nov 16)'), 'Read the runbook before a rollback');
  assert.equal(ruleText('Always rebase before merge — learned 2026-11-17'), 'Always rebase before merge');
  // A bare date at either end, or two dates in one bracket, may be the rule's own value: they stay.
  assert.equal(ruleText('2026-12-01: code freeze for mobile releases begins'), '2026-12-01: code freeze for mobile releases begins');
  assert.equal(ruleText('Code freeze for mobile releases begins - 2026-12-01'), 'Code freeze for mobile releases begins - 2026-12-01');
  assert.equal(ruleText('Code freeze runs (2026-12-01 – 2026-12-15)'), 'Code freeze runs (2026-12-01 – 2026-12-15)');
  // A date the rule is about stays: it's a value that can change.
  assert.equal(ruleText('The code freeze starts 2026-12-01.'), 'The code freeze starts 2026-12-01.');
  assert.equal(ruleText('Code freeze runs (2026-12-01 to 2026-12-15) for payouts'), 'Code freeze runs (2026-12-01 to 2026-12-15) for payouts');
  assert.equal(learnedOn('Rule (2026-11-16)'), '2026-11-16');
  assert.equal(learnedOn('Rule (2026-11-20, Payments sync) <!-- m:abcdef -->'), '2026-11-20');
  assert.equal(learnedOn('The code freeze starts 2026-12-01.'), null, 'a value is not when it was learned');
});

test('the old-format pages from the repro give 0 date conflicts: only the two real disagreements are conflicts', () => {
  const pairs = pairsOf(oldFormatKnowledge());
  const conflicts = pairs.filter((issue) => issue.kind === 'conflict');
  assert.deepEqual(conflicts.map((issue) => issue.pages[0]).sort(), ['projects/live-breach.md', 'workflows/code-change.md']);
  // Every repeat on the dated pages is the same rule learned again, newer on the right.
  const repeats = pairs.filter((issue) => issue.kind === 'duplicate');
  assert.ok(repeats.length >= 10);
  assert.ok(repeats.every((issue) => issue.pair.order === 'date' && issue.pair.older.learned! < issue.pair.newer.learned!));
  // Meeting decisions keep their dates; the same decision from two meetings is a repeat, not a conflict.
  assert.ok(repeats.some((issue) => issue.pages[0] === 'decisions/payments.md'));
  assert.ok(!conflicts.some((issue) => issue.pages[0] === 'decisions/payments.md'));
});

test('real conflicts are still caught with dated notes on every line: a number, a day, a "never", a date the rule is about', () => {
  const kind = (a: string, b: string): string => {
    const { duplicates, conflicts } = findOverlaps(pageFacts('a.md', `---\ntype: rule\n---\n- ${a}\n- ${b}\n`));
    return conflicts.length > 0 ? 'conflict' : duplicates.length > 0 ? 'duplicate' : 'neither';
  };
  const cases: [string, string, string][] = [
    ['Each Live Breach exercise runs 3 hours with the client team (2026-11-16)', 'Each Live Breach exercise runs 4 hours with the client team (2026-11-17)', 'conflict'],
    ['Risky releases ship on Tuesday (2026-11-02)', 'Risky releases ship on Thursday now (2026-11-20)', 'conflict'],
    ['Never merge a PR before Sam reviews it (2026-11-16)', 'Merge a PR before Sam reviews it when CI is green (2026-11-18)', 'conflict'],
    ['Keep PRs under 400 changed lines (2026-11-01, Eng sync)', 'Keep PRs under 300 changed lines (2026-11-20, Eng sync)', 'conflict'],
    ['The payouts code freeze starts 2026-12-01 (2026-11-10)', 'The payouts code freeze starts 2026-12-15 (2026-11-20)', 'conflict'],
    ['Risky releases ship on Tuesday, never Thursday or Friday.', 'Risky releases ship on Thursday now (since 2026-10-01), never Friday.', 'conflict'],
    ['Run database migrations before deploying the app (2026-11-16)', 'Run database migrations after deploying the app (2026-11-17)', 'conflict'],
    ['Code freeze for releases runs (2026-12-01 – 2026-12-15)', 'Code freeze for releases runs (2026-12-08 – 2026-12-22)', 'conflict'],
    ['2026-12-01: code freeze for mobile releases begins', '2026-12-08: code freeze for mobile releases begins', 'conflict'],
    ['Code freeze for mobile releases begins - 2026-12-01', 'Code freeze for mobile releases begins - 2026-12-08', 'conflict'],
    ['Code freeze for payments service begins (since 2026-12-01)', 'Code freeze for payments service begins (since 2026-12-15)', 'conflict'],
    ['Open every PR as a draft (2026-11-16)', 'Open every PR as a draft (2026-11-17)', 'duplicate'],
    ['Webhooks retry 5 times (2026-11-16)', 'Invoices retry 3 times (2026-11-17)', 'neither'],
  ];
  for (const [a, b, expected] of cases) assert.equal(kind(a, b), expected, `${a} / ${b}`);
});

test('each pair has its own id, made from both lines: unique per pair, the same either way round', () => {
  const pairs = pairsOf(oldFormatKnowledge());
  const ids = pairs.map((issue) => issue.pair.id);
  assert.equal(new Set(ids).size, ids.length, 'no two pairs share an id');
  const [a, b] = [{ page: 'p.md', text: 'One rule (2026-11-16)' }, { page: 'p.md', text: 'One rule (2026-11-17)' }];
  assert.equal(pairId(a, b), pairId(b, a));
  assert.notEqual(pairId(a, b), pairId(a, { ...b, page: 'q.md' }));
  assert.match(pairId(a, b), /^[0-9a-z]{14}$/);
  // Needs you rows are keyed by those ids: as many distinct keys as pairs, none of them the page's name.
  const items = fixItems({ value: [], review: null, health: assessKnowledge(oldFormatKnowledge(), NOW) } as unknown as Parameters<typeof fixItems>[0]);
  const pairItems = items.filter((item) => item.pair);
  assert.equal(new Set(pairItems.map((item) => item.id)).size, pairItems.length);
});

test('Keep on one pair leaves the page\'s other rows, and the page itself changes only by that one line', async (t) => {
  const { knowledge, bridge, backups } = profile(t);
  const items = fixItems({ value: [], review: null, health: assessKnowledge(oldFormatKnowledge(), NOW) } as unknown as Parameters<typeof fixItems>[0]);
  const page = 'owner/quick-vs-right.md';
  const onPage = items.filter((item) => item.pair && item.pages.includes(page));
  assert.equal(onPage.length, 3);
  const settled = onPage[0]!;
  // What FixList hides after the click: that pair's id, and nothing else.
  const left = needsYou(items.filter((item) => item.id !== settled.id && item.pair?.id !== settled.pair!.id));
  assert.equal(left.repeats.find((group) => group.pages[0] === page)?.pairs.length, 2, 'the other two pairs on the page stay listed');
  const before = readFileSync(join(knowledge, page), 'utf8');
  const result = await keepOne(bridge, settled.pair!.newer, settled.pair!.older);
  assert.notEqual(result, 'open');
  const after = readFileSync(join(knowledge, page), 'utf8');
  assert.deepEqual(currentRules(after), currentRules(before).filter((line) => line !== settled.pair!.older.text), 'only the older line left the current rules');
  assert.match(after, new RegExp(`## Replaced\\n\\n- Until 2026-11-17: ${settled.pair!.older.text.replace(/[()]/g, '\\$&')}\\n$`));
  assert.equal(backupsOf(backups).length, 1, 'backed up before the write');
  assert.equal(backupsOf(backups)[0]!.files[0]!.before, before);
});

// ---------------------------------------------------------------------------------------------------------------
// Keep newer for all
// ---------------------------------------------------------------------------------------------------------------

test('"Keep newer for all" only takes pairs where the newer line says everything; "Newer drops detail" is asked instead', () => {
  const { repeats } = groupPairs(pairsOf(oldFormatKnowledge()));
  const prs = repeats.find((group) => group.pages[0] === 'owner/pr-rules.md')!;
  const drops = prs.pairs.find((pair) => pair.older.plain === 'Branch names use type/short-name, lowercase only')!;
  assert.equal(drops.covers, false);
  assert.ok(!isSafe(drops) && !prs.safe.includes(drops), 'a newer line that drops "lowercase only" is never kept in bulk');
  assert.equal(prs.dropsDetail, 1);
  assert.equal(groupLine(prs), '4 rules learned again · 1 needs a look');
  // A newer line that drops a small word ("before", "all") never covers the older one.
  const flip = pairsOf([{ path: 'a.md', text: '---\ntype: rule\n---\n- Ping all reviewers when the PR is ready (2026-11-16)\n- Ping reviewers when the PR is ready (2026-11-17)\n' }]);
  assert.equal(flip.length, 1);
  assert.equal(flip[0]!.pair.covers, false, '"all" was dropped');
  // The same words in another order say something else: never safe to keep in bulk.
  for (const [older, newer] of [
    ['Run database migrations before the deploy starts (2026-11-16)', 'Run the deploy before database migrations starts (2026-11-17)'],
    ['Ana reviews code from Ben on the payouts team (2026-11-16)', 'Ben reviews code from Ana on the payouts team (2026-11-17)'],
  ]) {
    const swapped = pairsOf([{ path: 'a.md', text: `---\ntype: rule\n---\n- ${older}\n- ${newer}\n` }]);
    assert.ok(swapped.every((issue) => !issue.pair.covers && !isSafe(issue.pair)), `${older} / ${newer}`);
  }
});

test('bulk keep moves only the intended lines, keeps the newest of a chain, and leaves every other byte', () => {
  const page = OLD_FORMAT_PAGES.find((file) => file.path === 'owner/pr-rules.md')!;
  const { repeats } = groupPairs(pairsOf(oldFormatKnowledge()));
  const group = repeats.find((one) => one.pages[0] === page.path)!;
  const { text, moved } = keepNewerForAll(page.text, page.path, group.safe, TODAY);
  assert.deepEqual(moved.sort(), [
    'End each commit message with the co-author line for the agent (2026-11-16)',
    'Open every PR as a draft and link the Linear issue (2026-11-16)',
    'Open every PR as a draft and link the Linear issue (2026-11-17)',
    'Say in the PR description which agent and model did the work (2026-11-17)',
  ]);
  const kept = currentRules(text);
  assert.ok(kept.includes('Open every PR as a draft, link the Linear issue and attach proof (2026-11-18)'), 'the newest of the chain stays');
  assert.ok(kept.includes('Branch names use type/short-name, lowercase only (2026-11-16)') && kept.includes('Branch names use type/short-name (2026-11-17)'), 'a pair that drops detail is left for the owner');
  assert.deepEqual(kept, currentRules(page.text).filter((line) => !moved.includes(line)), 'nothing else left the page, and the order holds');
  // Everything above the new section is the page as it was, minus the moved lines.
  const head = text.slice(0, text.indexOf('\n\n## Replaced'));
  assert.equal(head, page.text.split('\n').filter((line) => !moved.includes(line.replace(/^- /, ''))).join('\n').trimEnd());
  // Each moved line is dated the day its newer line was learned.
  assert.match(text, /- Until 2026-11-18: Open every PR as a draft and link the Linear issue \(2026-11-17\)/);
  // Nothing to keep: the text comes back byte for byte.
  assert.deepEqual(keepNewerForAll(page.text, page.path, [], TODAY), { text: page.text, moved: [] });
});

test('bulk keep backs up each page before writing it, writes only those pages, and undoes to the same bytes', async (t) => {
  const { knowledge, bridge, backups } = profile(t);
  const before = snapshot(knowledge);
  const { repeats } = groupPairs(pairsOf(oldFormatKnowledge()));
  const chosen = repeats.filter((group) => group.safe.length > 0 && ['owner/pr-rules.md', 'owner/quick-vs-right.md'].includes(group.pages[0]!));
  assert.equal(chosen.length, 2);
  const result = await keepNewerOnPages(bridge, chosen, TODAY);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.pages.sort(), ['owner/pr-rules.md', 'owner/quick-vs-right.md']);
  const after = snapshot(knowledge);
  const changed = Object.keys(after).filter((path) => after[path] !== before[path] && !path.startsWith('.'));
  assert.deepEqual(changed.sort(), ['owner/pr-rules.md', 'owner/quick-vs-right.md'], 'no other page was written');
  const changes = backupsOf(backups);
  assert.deepEqual(changes.map((change) => change.page).sort(), ['owner/pr-rules.md', 'owner/quick-vs-right.md'], 'one backup per page');
  for (const change of changes) {
    assert.equal(change.action, 'edit');
    assert.equal(change.files[0]!.before, OLD_FORMAT_PAGES.find((page) => page.path === change.page)!.text, 'the backup holds the page as it was');
  }
  await result.undo();
  for (const page of ['owner/pr-rules.md', 'owner/quick-vs-right.md']) {
    assert.equal(readFileSync(join(knowledge, page), 'utf8'), OLD_FORMAT_PAGES.find((file) => file.path === page)!.text, `${page} is back, byte for byte`);
  }
});

test('bulk keep never overwrites a page that changed since: it stops there and says why', async (t) => {
  const { knowledge, bridge } = profile(t);
  const { repeats } = groupPairs(pairsOf(oldFormatKnowledge()));
  const group = repeats.find((one) => one.pages[0] === 'owner/quick-vs-right.md')!;
  // The owner's hand edit lands between Overview loading and the click.
  const path = join(knowledge, 'owner/quick-vs-right.md');
  const edited = `${readFileSync(path, 'utf8')}- A hand-added rule about reviews and claims.\n`;
  writeFileSync(path, edited);
  const result = await keepNewerOnPages(bridge, [group], TODAY);
  assert.match(String(result.error), /changed outside Serra/);
  assert.deepEqual(result.pages, []);
  assert.equal(readFileSync(path, 'utf8'), edited, 'the edit is untouched');
});

// ---------------------------------------------------------------------------------------------------------------
// Both hold, and looking writes nothing
// ---------------------------------------------------------------------------------------------------------------

test('"Both hold, not a conflict" is kept outside the pages, hides only that pair, and comes back on Undo', async (t) => {
  const { dir, knowledge, handlers } = profile(t);
  const before = snapshot(knowledge);
  const conflict = pairsOf(oldFormatKnowledge()).find((issue) => issue.kind === 'conflict' && issue.pages[0] === 'projects/live-breach.md')!;
  await handlers.bothHold(conflict.pair.id);
  assert.deepEqual(snapshot(knowledge), before, 'no knowledge file was written');
  assert.ok(existsSync(join(dir, 'knowledge-dismissed.json')));
  assert.deepEqual([...dismissedPairs(dir)], [conflict.pair.id]);
  const overview = knowledgeOverview({ knowledgeDir: knowledge, profileDir: dir, now: NOW });
  assert.ok(!overview.health.issues.some((issue) => issue.pair?.id === conflict.pair.id), 'Overview no longer lists it');
  assert.ok(overview.health.issues.some((issue) => issue.kind === 'conflict' && issue.pages[0] === 'workflows/code-change.md'), 'the other conflict is still there');
  assert.ok(!(await handlers.list()).find((page) => page.path === 'projects/live-breach.md')?.disputed, 'Pages no longer marks the page');
  await handlers.undoBothHold(conflict.pair.id);
  assert.ok(knowledgeOverview({ knowledgeDir: knowledge, profileDir: dir, now: NOW }).health.issues.some((issue) => issue.pair?.id === conflict.pair.id));
  assert.throws(() => handlers.bothHold('not-a-pair'), /Pick the two rules/);
  assert.throws(() => handlers.bothHold('0000000aaaaaaa'), /changed since you looked/);
});

test('a dismissed pair comes back when either line is edited', () => {
  const files = oldFormatKnowledge();
  const conflict = pairsOf(files).find((issue) => issue.kind === 'conflict')!;
  const dismissed = new Set([conflict.pair.id]);
  assert.ok(!pairsOf(files, dismissed).some((issue) => issue.pair.id === conflict.pair.id));
  const edited = files.map((file) => (file.path === conflict.pages[0] ? { ...file, text: file.text.replace(conflict.pair.newer.text, conflict.pair.newer.text.replace('4 hours', '5 hours')) } : file));
  assert.ok(pairsOf(edited, dismissed).some((issue) => issue.kind === 'conflict' && issue.pages[0] === conflict.pages[0]));
});

test('nothing is written to knowledge/ on load or update: Overview, Pages, the graph and the page checks only read', async (t) => {
  const { dir, knowledge, handlers } = profile(t);
  const before = snapshot(knowledge);
  createKnowledge(knowledge).seedApproved(); // as the daemon does at every start, after an update too
  await handlers.list();
  await handlers.issues('owner/pr-rules.md');
  await handlers.canConfirm('owner/pr-rules.md');
  knowledgeOverview({ knowledgeDir: knowledge, profileDir: dir, now: NOW });
  knowledgeGraph({ knowledgeDir: knowledge, profileDir: dir, now: NOW });
  assert.deepEqual(snapshot(knowledge), before, 'every page has the same bytes and the same modified time');
  assert.ok(!existsSync(join(dir, 'backups', 'knowledge')), 'and no backup, since nothing changed');
});

test('pages round-trip byte-identical when no action is taken: saving the text as loaded writes nothing', async (t) => {
  const { knowledge, handlers, backups } = profile(t);
  for (const page of OLD_FORMAT_PAGES) {
    const text = await handlers.read(page.path);
    assert.equal(text, page.text);
    await handlers.save(page.path, text, text);
    assert.equal(readFileSync(join(knowledge, page.path), 'utf8'), page.text);
  }
  assert.deepEqual(backupsOf(backups), []);
});

// ---------------------------------------------------------------------------------------------------------------
// What the screen says
// ---------------------------------------------------------------------------------------------------------------

test('the changed words are marked, older on the left, with buttons that say older and newer', () => {
  assert.deepEqual(wordDiff('Open every PR as a draft and link the Linear issue', 'Open every PR as a draft, link the Linear issue and attach proof'), [
    { op: 'same', text: 'Open every PR as a draft' }, { op: 'del', text: ' and' }, { op: 'add', text: ',' }, { op: 'same', text: ' link the Linear issue' }, { op: 'add', text: ' and attach proof' },
  ]);
  assert.equal(versus('Each exercise runs 3 hours', 'Each exercise runs 4 hours'), '“3” vs “4”');
  assert.equal(versus('Never merge a PR before Sam reviews it', 'Merge a PR before Sam reviews it when CI is green and the fix is small'), '“Never” vs “when CI is green…”');
  assert.deepEqual(sideNames({ order: 'date', older: { learned: '2026-11-16' }, newer: { learned: '2026-11-17' } } as Parameters<typeof sideNames>[0]), ['Nov 16', 'Nov 17']);
  assert.deepEqual(keepNames({ order: 'date' }), ['Keep older', 'Keep newer']);
  assert.deepEqual(keepNames({ order: 'length' }), ['Keep shorter', 'Keep longer'], 'a rule written twice offers the longer one');
});

test('Needs you shows one row per page, in "learned again", "really disagree" and "tidy up", and counts what it shows', () => {
  const files = oldFormatKnowledge();
  const items = fixItems({ value: [], review: null, health: assessKnowledge(files, NOW) } as unknown as Parameters<typeof fixItems>[0]);
  const view = needsYou(items);
  assert.deepEqual(view.repeats.map((group) => group.pages[0]).sort(), ['decisions/payments.md', 'owner/pr-rules.md', 'owner/quick-vs-right.md', 'product/squad-products.md']);
  assert.deepEqual(view.disagree.map((group) => group.pages[0]).sort(), ['projects/live-breach.md', 'workflows/code-change.md']);
  assert.equal(view.disagree.find((group) => group.pages[0] === 'projects/live-breach.md') && groupLine(view.disagree.find((group) => group.pages[0] === 'projects/live-breach.md')!), '“3” vs “4”');
  // To review and Needs you count the same rows: a page of repeats is one, however many pairs it has.
  assert.deepEqual(todoTally(items), { count: view.rows, text: '2 disagree · 4 repeat' });
});

test('a rule restated three times is one row, Nov 16, Nov 17 → Nov 18, and Keep newer moves both older lines in one save', async (t) => {
  const { knowledge, bridge, backups } = profile(t);
  const { repeats } = groupPairs(pairsOf(oldFormatKnowledge()));
  const prs = repeats.find((group) => group.pages[0] === 'owner/pr-rules.md')!;
  assert.equal(prs.pairs.length, 6);
  assert.equal(prs.rows.length, 4, 'three versions of the PR rule are one row');
  const chain = prs.rows.find((row) => row.olders.length === 2)!;
  assert.deepEqual(rowNames(chain), ['Nov 16, Nov 17', 'Nov 18']);
  assert.equal(chain.newer.text, 'Open every PR as a draft, link the Linear issue and attach proof (2026-11-18)');
  assert.equal(chain.all.length, 3, '"Both hold" on the row sets aside the Nov 16 / Nov 17 pair too');
  const left = groupPairs(pairsOf(oldFormatKnowledge(), new Set(chain.all.map((pair) => pair.id)))).repeats.find((group) => group.pages[0] === 'owner/pr-rules.md')!;
  assert.ok(!left.rows.some((row) => row.newer.text.startsWith('Open every PR') || row.olders.some((side) => side.text.startsWith('Open every PR'))), 'the rule does not come back as a shorter chain');
  const before = readFileSync(join(knowledge, 'owner/pr-rules.md'), 'utf8');
  const result = await keepOver(bridge, chain.newer, chain.olders);
  assert.notEqual(result, 'open');
  const after = readFileSync(join(knowledge, 'owner/pr-rules.md'), 'utf8');
  assert.deepEqual(currentRules(after), currentRules(before).filter((line) => !chain.olders.some((side) => side.text === line)));
  assert.equal(backupsOf(backups).length, 1, 'one save, one backup');
  if (result !== 'open') await result.undo();
  assert.equal(readFileSync(join(knowledge, 'owner/pr-rules.md'), 'utf8'), before);
});

test('"Both hold" works on the pair Overview showed, even when the page has an edit waiting for review', async (t) => {
  const { dir, knowledge, handlers } = profile(t);
  const conflict = pairsOf(oldFormatKnowledge()).find((issue) => issue.kind === 'conflict' && issue.pages[0] === 'projects/live-breach.md')!;
  const path = join(knowledge, 'projects/live-breach.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}- An edit made outside Serra about the debrief.\n`);
  await handlers.bothHold(conflict.pair.id);
  assert.deepEqual([...dismissedPairs(dir)], [conflict.pair.id]);
});

test('Undo never overwrites an edit made after the Keep: it is refused and the edit stays', async (t) => {
  const { knowledge, bridge, handlers } = profile(t);
  const pair = pairsOf(oldFormatKnowledge()).find((issue) => issue.pages[0] === 'owner/quick-vs-right.md')!.pair;
  const result = await keepOne(bridge, pair.newer, pair.older);
  assert.notEqual(result, 'open');
  const kept = await handlers.read('owner/quick-vs-right.md');
  const edited = kept.replace('# Trade-offs', '# Trade-offs\n\n- A rule the owner added after the Keep.');
  await handlers.save('owner/quick-vs-right.md', edited, kept);
  if (result !== 'open') await assert.rejects(result.undo(), /changed since you opened it/);
  assert.equal(readFileSync(join(knowledge, 'owner/quick-vs-right.md'), 'utf8'), edited);
});

test('bulk keep leaves rules inside longer text, cross-page pairs and changed links to the owner', () => {
  // A rule that is one sentence of a longer bullet can't be moved by a click.
  const prose = { path: 'p.md', text: '---\ntype: rule\n---\n- Tag each release in git (2026-11-16). Then post the notes.\n- Tag each release in git (2026-11-17)\n' };
  const prosePairs = pairsOf([prose]);
  assert.equal(prosePairs.length, 1);
  assert.deepEqual(keepNewerForAll(prose.text, 'p.md', prosePairs.map((issue) => issue.pair), TODAY), { text: prose.text, moved: [] });
  // The same rule on two pages is never kept in bulk: which page keeps it is the owner's call.
  const cross = pairsOf([
    { path: 'owner/a.md', text: '---\ntype: rule\n---\n- Tag each release in git with its version (2026-11-16)\n' },
    { path: 'owner/b.md', text: '---\ntype: rule\n---\n- Tag each release in git with its version (2026-11-17)\n' },
  ]);
  assert.equal(cross.length, 1);
  assert.ok(!isSafe(cross[0]!.pair));
  assert.equal(groupPairs(cross).repeats[0]!.safeRows, 0);
  // A newer line that points somewhere else doesn't say what the older one does.
  const squad = groupPairs(pairsOf(oldFormatKnowledge())).repeats.find((group) => group.pages[0] === 'product/squad-products.md')!;
  assert.equal(squad.rows.find((row) => row.newer.plain.startsWith('See the squad wiki'))!.covers, false, 'the wiki link changed');
});

test('a range with a plain hyphen stays a value: a moved freeze is a conflict, not a repeat', () => {
  const pairs = pairsOf([{ path: 'a.md', text: '---\ntype: rule\n---\n- Holiday code freeze for payouts (2026-12-01 - 2026-12-15)\n- Holiday code freeze for payouts (2026-12-08 - 2026-12-22)\n' }]);
  assert.deepEqual(pairs.map((issue) => issue.kind), ['conflict']);
  assert.equal(learnedOn('Holiday code freeze for payouts (2026-12-01 - 2026-12-15)'), null);
});

test('the worker brief honours "Both hold": the pair is no longer marked as rules that disagree', () => {
  const files = oldFormatKnowledge();
  const index = files.find((file) => file.path === 'index.md')!.text;
  const conflict = pairsOf(files).find((issue) => issue.kind === 'conflict' && issue.pages[0] === 'projects/live-breach.md')!;
  const marked = markIndexRows(index, files, NOW);
  assert.match(marked, /Current: "Each Live Breach exercise runs 4 hours[^\n]*It replaces "Each Live Breach exercise runs 3 hours/, 'the learned dates say which is current');
  const kept = markIndexRows(index, files, NOW, { dismissed: new Set([conflict.pair.id]) });
  assert.doesNotMatch(kept, /Each Live Breach exercise/);
  assert.match(kept, /Never merge a PR before Sam reviews it/, 'the other disagreement is still there');
});

test('each side of a disagreement reads as written: its own case and spacing, its own words in bold', () => {
  const older = wordDiff('Never merge a PR (before review)', 'Merge a PR (after review)', 'older');
  assert.equal(older.map((part) => part.text).join(''), 'Never merge a PR (before review)');
  assert.deepEqual(older.filter((part) => part.op !== 'same').map((part) => part.text.trim()), ['Never', 'before']);
  const newer = wordDiff('Never merge a PR (before review)', 'Merge a PR (after review)', 'newer');
  assert.equal(newer.map((part) => part.text).join(''), 'Merge a PR (after review)');
});

test('a value in brackets that starts like a month is not a date note, and a link inside a note still dates it', () => {
  assert.equal(ruleText('Cards use the wide padding (margin 16) (2026-11-16)'), 'Cards use the wide padding (margin 16)');
  const pairs = pairsOf([{ path: 'a.md', text: '---\ntype: rule\n---\n- Cards use the wide padding (margin 16) (2026-11-16)\n- Cards use the wide padding (margin 24) (2026-11-17)\n' }]);
  assert.deepEqual(pairs.map((issue) => issue.kind), ['conflict']);
  assert.equal(learnedOn('Ship it behind a flag (2026-11-17, [PR #42](https://github.com/acme/project/pull/42))'), '2026-11-17');
});

test('a line pasted twice word for word is one row that Keep can settle, never an empty "Review 0"', () => {
  const line = 'Tag each release in git with its version number';
  const { repeats } = groupPairs(pairsOf([{ path: 'a.md', text: `---\ntype: rule\n---\n- ${line}\n- ${line}\n` }]));
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0]!.rows.length, 1);
  assert.equal(groupLine(repeats[0]!), '1 rule learned again or written twice');
  assert.equal(repeats[0]!.safeRows, 0, 'two identical undated lines are never kept in bulk');
});
