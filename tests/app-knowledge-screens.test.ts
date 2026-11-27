import assert from 'node:assert/strict';
import test from 'node:test';
import { aboutCard, leftOutLine, sectionTitle } from '../app/renderer/screens/about.logic.ts';
import { groupFixes, todoTally, type FixItem } from '../app/renderer/screens/overview.logic.ts';
import { groupByArea, joinHeader, pageDetail, pageLabel, pageMeta, splitHeader } from '../app/renderer/screens/pages.logic.ts';
import { proposalMeta, sourceLine } from '../app/renderer/screens/proposals.logic.ts';
import type { KnowledgePage } from '../src/contracts.ts';
import { OFFLIMITS_PREFACE, PEOPLE_PREFACE } from '../src/owner-model.ts';

// What the Knowledge screens show as names and one-line summaries: a title said once, counts folded into one row,
// and meta lines that leave out what wasn't recorded.

test('About me: a card takes its title from the page heading and drops it from the body', () => {
  assert.deepEqual(aboutCard('owner/role.md', '# Role\n\nOwns the API.'), { title: 'Role', body: 'Owns the API.' });
  assert.deepEqual(aboutCard('owner/pr-style.md', '## **PR** style\nSmall PRs.'), { title: 'PR style', body: 'Small PRs.' });
});

test('About me: the line the brief adds for the bot is not shown, and a page with no heading is named from its file', () => {
  assert.deepEqual(aboutCard('owner/off-limits.md', `${OFFLIMITS_PREFACE}\n## Off-limits\nNever merge.`, [OFFLIMITS_PREFACE]), { title: 'Off-limits', body: 'Never merge.' });
  assert.deepEqual(aboutCard('people/', `${PEOPLE_PREFACE}\n- Maya Chen: design lead`, [PEOPLE_PREFACE]), { title: 'People', body: '- Maya Chen: design lead' });
  assert.equal(aboutCard('owner/working-hours.md', 'Replies 9 to 6.').title, 'Working hours');
});

test('About me: file names keep their acronyms', () => {
  assert.equal(sectionTitle('owner/pr-style.md'), 'PR style');
  assert.equal(sectionTitle('owner/api_limits.md'), 'API limits');
  assert.equal(sectionTitle('outsiders'), 'Rules for outsiders');
});

test('About me: pages left out read as one line, with the reason when they share one', () => {
  assert.equal(leftOutLine([]), null);
  assert.equal(leftOutLine([{ reason: 'not verified yet' }, { reason: 'not verified yet' }, { reason: 'not verified yet' }]), '3 pages left out until verified');
  assert.equal(leftOutLine([{ reason: 'over the size limit' }]), '1 page left out: over the size limit');
  assert.equal(leftOutLine([{ reason: 'not verified yet' }, { reason: 'expired 2026-01-01' }]), '2 pages left out');
});

const page = (path: string, extra: Partial<KnowledgePage> = {}): KnowledgePage =>
  ({ path, verified: null, badge: 'unverified', lines: 5, problems: [], warnings: [], ...extra });

test('Pages: a row is the page name with its description under it, only when it adds something', () => {
  const tom = page('people/tom-reyes.md', { title: 'Tom Reyes', description: 'Billing engineer', area: 'People' });
  assert.equal(pageLabel(tom), 'Tom Reyes');
  assert.equal(pageDetail(tom), 'Billing engineer');
  assert.equal(pageDetail(page('workflows/deploys.md', { title: 'Deploys', description: 'deploys' })), null);
  assert.equal(pageLabel(page('team/tools.md', { description: 'Tools we use' })), 'Tools we use');
  assert.equal(pageLabel(page('team/tools.md')), 'tools.md');
  // Sorted by what the list shows, not the description.
  assert.deepEqual(groupByArea([tom, page('people/ana.md', { title: 'Ana Silva', description: 'Zed', area: 'People' })])[0]!.pages.map(pageLabel), ['Ana Silva', 'Tom Reyes']);
});

test('Pages: the meta line says the area and when it was written (the badge says whether it is verified)', () => {
  assert.equal(pageMeta({ area: 'Processes', written: '2026-10-24' }), 'Processes · written Oct 24');
  assert.equal(pageMeta({ area: 'People' }), 'People');
});

test('Proposals: the meta line leaves out a source that was not recorded', () => {
  assert.equal(sourceLine(undefined), null);
  assert.deepEqual(proposalMeta({ date: '2026-11-25' }), ['Nov 25']);
  assert.deepEqual(proposalMeta({ date: null, from: { who: 'Robin', owner: true, via: 'app' } }), ['From your task']);
  assert.deepEqual(sourceLine({ who: 'Sam Okafor', owner: false, via: 'slack' }), { text: 'From Sam Okafor’s thread', careful: true });
});

const item = (id: string, title: string): FixItem => ({ id, title, why: 'x', lines: [], pages: [], action: 'Open' });

test('Overview: proposals and pages to confirm fold into one row each, in the place the first one had', () => {
  const items = [item('conflict:a.md', 'Deploys'), item('proposal:1', 'Sentry'), item('draft:b.md', 'Billing'), item('proposal:2', 'On-call'), item('draft:c.md', 'Search')];
  const grouped = groupFixes(items);
  assert.deepEqual(grouped.map((one) => one.title), ['Deploys', '2 proposals', '2 pages to confirm']);
  assert.equal(grouped[1]!.why, 'Sentry, On-call');
  assert.equal(grouped[1]!.href, '/knowledge/proposals');
  assert.equal(grouped[2]!.href, '/knowledge/pages');
  // One of a kind stays its own row.
  assert.deepEqual(groupFixes([item('proposal:1', 'Sentry')]).map((one) => [one.title, one.why]), [['Sentry', 'Proposal']]);
  // To review counts the rows Needs you shows: two proposals fold into one, and so do two pages to confirm.
  assert.deepEqual(todoTally(items), { count: 3, text: '3 other' });
  assert.deepEqual(todoTally([]), { count: 0, text: 'Nothing to do' });
});

test('Pages: the editor folds the header away and puts the page back exactly', () => {
  const text = '---\ntype: process\nverified: 2026-11-18\n---\n\n# Deploys\n\nTuesdays.\n';
  const { header, body } = splitHeader(text);
  assert.equal(header, 'type: process\nverified: 2026-11-18');
  assert.equal(body, '\n# Deploys\n\nTuesdays.\n');
  assert.equal(joinHeader(header, body), text);
  assert.equal(joinHeader(header, '\n# Deploys\n\nThursdays.\n'), text.replace('Tuesdays', 'Thursdays'));
  // A page without a header is all body; the editor's checks then say it needs one.
  assert.deepEqual(splitHeader('no header at all\n'), { header: null, body: 'no header at all\n' });
  assert.equal(joinHeader(null, 'no header at all\n'), 'no header at all\n');
});
