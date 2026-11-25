// Knowledge quality, measured: whether the pages a worker is pointed at fit the request, whether the health check
// finds the mess a real owner's knowledge picks up (and nothing on clean fixtures), whether the history rebuilt from
// backups shows it, and whether the pages a reply used are recorded and never posted. Fixtures only; no model.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { simulateGrowth, PLANTED } from '../evals/kb-growth-sim.ts';
import {
  assessKnowledge, findOverlaps, HEALTH_WEIGHTS, knowledgeHistory, markIndexRows, pageCards, pageFacts, rankPages, relevanceNote, similarPages,
  type KnowledgeFile,
} from '../src/knowledge-health.ts';
import { readKnowledgeUse, recordKnowledgeUse, takeKnowledgeUsed } from '../src/knowledge-usage.ts';
import { knowledgeOverview } from '../src/knowledge-overview.ts';
import { createJournal } from '../src/knowledge-journal.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { changeText, groupByDay, scoreChart, scoreWord } from '../app/renderer/screens/overview.logic.ts';

const NOW = new Date('2026-11-25T12:00:00Z');

const tree = (dir: string, relativeDir = ''): KnowledgeFile[] => readdirSync(join(dir, relativeDir), { withFileTypes: true }).flatMap((entry) => {
  const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return entry.name === 'proposals' ? [] : tree(dir, path);
  return entry.name.endsWith('.md') ? [{ path, text: readFileSync(join(dir, path), 'utf8') }] : [];
});

interface RetrievalCase { request: string; pages: string[] }
const retrieval = JSON.parse(readFileSync(new URL('../evals/retrieval-cases.json', import.meta.url), 'utf8')) as { fixtures: Record<string, RetrievalCase[]>; none: { requests: string[] } };

/** For a ranker: right page first, a right page in the top three, how often it hints at all, and how often a hint is right. */
const score = (cases: RetrievalCase[], rank: (request: string) => string[]) => {
  const runs = cases.map((item) => ({ item, ranked: rank(item.request) }));
  const hinted = runs.filter((run) => run.ranked.length > 0);
  const hit = (run: (typeof runs)[number]): boolean => run.ranked.slice(0, 3).some((path) => run.item.pages.includes(path));
  return {
    top1: runs.filter((run) => run.item.pages.includes(run.ranked[0] ?? '')).length / runs.length,
    top3: runs.filter(hit).length / runs.length,
    precision: hinted.filter(hit).length / Math.max(1, hinted.length),
  };
};

test('relevance: the pages a brief points at fit the request, on the tuned owner and the held-out one, and nothing is hinted when nothing fits', () => {
  for (const [dir, cases] of Object.entries(retrieval.fixtures)) {
    const heldOut = dir.includes('heldout');
    const files = tree(new URL(`../${dir}`, import.meta.url).pathname);
    const index = files.find((file) => file.path === 'index.md')!.text;
    const cards = pageCards(index, files);
    assert.equal(cards.length, files.filter((file) => file.path !== 'index.md' && file.path.includes('/')).length, `${dir}: every indexed page has a card`);
    const full = score(cases, (request) => rankPages(request, cards).map((page) => page.path));
    // A hint is either right or absent: when the brief names pages, one of them fits.
    assert.ok(full.precision >= 0.85, `${dir}: ${Math.round(full.precision * 100)}% of hints hold a right page`);
    assert.ok(full.top3 >= (heldOut ? 0.7 : 0.8), `${dir}: a right page in the top 3 for ${Math.round(full.top3 * 100)}% of requests`);
    const falseHints = retrieval.none.requests.filter((request) => rankPages(request, cards).length > 0);
    assert.ok(falseHints.length <= 2, `${dir}: requests no page helps get no hint (${falseHints.length} of ${retrieval.none.requests.length} did: ${falseHints.join('; ')})`);
  }
});

test('relevance: the brief names the closest pages, without the owner\'s own name steering it, and asks which were used', () => {
  const files = tree(new URL('../evals/fixture/knowledge', import.meta.url).pathname);
  const cards = pageCards(files.find((file) => file.path === 'index.md')!.text, files);
  const note = relevanceNote('Robin, a merchant keeps getting 429 Too Many Requests', cards, ['Robin']);
  assert.match(note, /closest to this request, best first: `product\/rate-limits\.md`/);
  assert.match(note, /<knowledge-used>/);
  assert.doesNotMatch(relevanceNote('ok thanks', cards), /closest/, 'no guess when nothing matches');
});

test('the index tells the worker which pages are drafts or out of date', () => {
  const page = (verified: string): string => `---\ntype: rule\ndescription: x\nwritten: 2026-01-01\nverified: ${verified}\nsources:\n  - Owner\n---\n- A rule.\n`;
  const index = '| When | Open | Gives |\n|---|---|---|\n| a | `owner/a.md` | A |\n| b | `owner/b.md` | B |\n| c | `owner/c.md` | C |';
  const marked = markIndexRows(index, [{ path: 'owner/a.md', text: page('2026-11-20') }, { path: 'owner/b.md', text: page('2026-08-01') }, { path: 'owner/c.md', text: page('no') }], NOW);
  assert.match(marked, /\| a \| `owner\/a\.md` \| A \|/, 'a fresh page is left as it is');
  assert.match(marked, /`owner\/b\.md` \| B \(confirmed 2026-08-01; may be out of date\) \|/);
  assert.match(marked, /`owner\/c\.md` \| C \(draft: not confirmed\) \|/);
});

test('health: the clean fixtures have nothing to tidy', () => {
  for (const dir of ['evals/fixture/knowledge', 'evals/fixture-heldout/knowledge']) {
    const files = tree(new URL(`../${dir}`, import.meta.url).pathname);
    const health = assessKnowledge(files, new Date('2026-11-25T00:00:00Z'));
    const noise = health.issues.filter((issue) => ['conflict', 'duplicate', 'overlap', 'unstructured', 'unindexed'].includes(issue.kind));
    assert.deepEqual(noise, [], `${dir}: no false conflicts or repeats`);
    assert.ok(health.score >= 90, `${dir}: ${health.score}`);
  }
});

test('health: conflicts and repeats are told apart from rules that merely look alike', () => {
  const facts = (path: string, lines: string[]) => pageFacts(path, `---\ntype: rule\n---\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
  const gold: { a: string; b: string; is: 'conflict' | 'duplicate' | 'neither' }[] = [
    { a: 'Risky releases ship on Tuesday, never Friday.', b: 'Risky releases ship on Thursday so the weekend is quiet.', is: 'conflict' },
    { a: 'Keep PRs under 400 changed lines.', b: 'Keep PRs under 300 changed lines.', is: 'conflict' },
    { a: 'Standup is at 09:30 every day.', b: 'Standup is at 10:00 every day.', is: 'conflict' },
    { a: 'Always ask Priya before changing payout scope.', b: 'Never ask Priya before changing payout scope.', is: 'conflict' },
    { a: 'Webhooks retry 5 times over 24 hours.', b: 'Webhooks retry 5 times over 24 hours with backoff.', is: 'duplicate' },
    { a: 'Product manager for payouts. Decides scope.', b: 'Product manager for payouts, decides scope.', is: 'duplicate' },
    { a: 'A bug fix starts with a failing test.', b: 'Every bug fix starts with a failing test.', is: 'duplicate' },
    { a: 'Lead with the answer, then the reason.', b: 'Short sentences, no exclamation marks.', is: 'neither' },
    { a: 'Payment records are kept 7 years.', b: 'Logs are kept 14 days.', is: 'neither' },
    { a: 'Jonas runs the on-call rota.', b: 'Priya runs the payouts roadmap.', is: 'neither' },
    { a: 'Deploy to staging and run the smoke suite.', b: 'Tag from main after CI is green.', is: 'neither' },
    { a: 'Refunds over 500 EUR need Robin.', b: 'Rate limit increases need a load test.', is: 'neither' },
  ];
  const found = gold.map((pair) => {
    const { duplicates, conflicts } = findOverlaps([...facts('one.md', [pair.a]), ...facts('two.md', [pair.b])]);
    return conflicts.length > 0 ? 'conflict' : duplicates.length > 0 ? 'duplicate' : 'neither';
  });
  assert.deepEqual(found, gold.map((pair) => pair.is));

  // Two people's cards hold two true facts, never a conflict; two cards for one person are compared.
  const card = (name: string, line: string): string => `---\ntype: person\ndescription: Who ${name} is\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner\n---\n# ${name}\n\n- ${line}\n`;
  const index = '| a | `people/ana.md` | Ana |\n| b | `people/bruno.md` | Bruno |\n| c | `people/ana-silva.md` | Ana |';
  const people = assessKnowledge([
    { path: 'index.md', text: index },
    { path: 'people/ana.md', text: card('Ana', 'Reviews pull requests on Monday.') },
    { path: 'people/bruno.md', text: card('Bruno', 'Reviews pull requests on Friday.') },
  ], NOW);
  assert.deepEqual(people.issues.filter((issue) => issue.kind === 'conflict'), []);
  const same = assessKnowledge([
    { path: 'index.md', text: index },
    { path: 'people/ana.md', text: card('Ana', 'Reviews pull requests on Monday.') },
    { path: 'people/ana-silva.md', text: card('Ana Silva', 'Reviews pull requests on Friday.') },
  ], NOW);
  assert.equal(same.issues.filter((issue) => issue.kind === 'conflict').length, 1);
});

test('growth: six months of an owner\'s knowledge, through the real approval code, rot and recover the way the score says', () => {
  const sim = simulateGrowth();
  const [interview, messy, tidy] = sim.stages.map((stage) => ({ ...stage, health: assessKnowledge(stage.files, new Date(stage.at)) }));
  // Everything planted is found, on the pages it was planted on.
  for (const planted of PLANTED.conflicts) {
    assert.ok(messy!.health.issues.some((issue) => issue.kind === 'conflict' && planted.pages.every((page) => issue.pages.includes(page))), `found: ${planted.note}`);
  }
  for (const planted of PLANTED.duplicates) {
    assert.ok(messy!.health.issues.some((issue) => issue.kind === 'duplicate' && planted.pages.every((page) => issue.pages.includes(page))), `found: ${planted.note}`);
  }
  assert.ok(messy!.health.score < interview!.health.score - 20, `the mess costs points: ${interview!.health.score} → ${messy!.health.score}`);
  assert.ok(tidy!.health.score >= 95, `one tidy pass recovers: ${tidy!.health.score}`);
  assert.deepEqual(tidy!.health.issues, [], 'nothing left to tidy');
  assert.ok(tidy!.health.facts > interview!.health.facts, 'and the bot still knows more than after the interview');

  // The history rebuilt from the backups alone agrees with the folder as it was at each stage.
  const history = knowledgeHistory(sim.files, sim.changes, sim.now);
  for (const stage of [interview!, messy!, tidy!]) {
    const point = [...history.points].reverse().find((item) => item.at <= stage.at)!;
    assert.equal(point.score, assessKnowledge(stage.files, new Date(point.at)).score, `history at ${stage.label}`);
  }
  assert.equal(history.points[0]!.at.slice(0, 10), '2026-05-04', 'it starts on the day of the interview');
  assert.ok(history.points.length >= 20, 'a point a week at least, so pages ageing shows too');
  const kinds = new Set(history.events.map((event) => event.kind));
  for (const kind of ['learned', 'updated', 'replaced', 'removed', 'confirmed'] as const) assert.ok(kinds.has(kind), `the timeline shows ${kind}`);
  assert.ok(history.events.find((event) => event.page === 'owner/releases.md' && event.kind === 'learned')?.added.includes('Risky releases ship on Thursday so the weekend is quiet.'));

  // What the screen draws from it.
  const chart = scoreChart(history.points, 640, 168);
  assert.equal(chart.dots.length, history.points.length);
  assert.ok(chart.dots.every((dot) => dot.x >= 36 && dot.x <= 632 && dot.y >= 10 && dot.y <= 138));
  const days = groupByDay(history.events, sim.now);
  assert.equal(days[0]!.confirmed.length, 8, 'eight re-confirmations fold into one line');
  assert.equal(scoreWord(messy!.health.score, 11).tone, 'down');
  assert.equal(changeText(90, 82, '2026-10-26T00:00:00Z'), '+8 since Oct 26');
  assert.ok(chart.grid[0]!.label !== '0', 'the axis starts near the lowest score, so a dip shows');
});

test('the score weighs consistency and freshness most', () => {
  assert.equal(Object.values(HEALTH_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 1);
  assert.ok(HEALTH_WEIGHTS.consistent >= HEALTH_WEIGHTS.unique && HEALTH_WEIGHTS.fresh >= HEALTH_WEIGHTS.coverage);
});

test('a new proposal that repeats a page is pointed at that page', () => {
  const files = tree(new URL('../evals/fixture/knowledge', import.meta.url).pathname);
  const proposal = '---\ntype: product\ndescription: Rate limits\nwritten: 2026-11-25\nverified: no\nsources:\n  - Robin\n---\n- 100 requests per second per merchant, burst 300.\n';
  const [best] = similarPages(proposal, files);
  assert.equal(best?.path, 'product/rate-limits.md');
  assert.ok(best!.shared[0]!.startsWith('100 requests per second'));
  assert.deepEqual(similarPages('---\ntype: x\ndescription: Lunch order\n---\n- Pizza on Friday for the whole floor.\n', files), []);
  // A proposal that changes a rule says so, with both lines.
  const change = '---\ntype: product\ndescription: Rate limits\n---\n- 300 requests per second per merchant, burst 200.\n';
  assert.deepEqual(similarPages(change, files)[0]?.disagrees, { page: '100 requests per second per merchant, burst 200.', proposal: '300 requests per second per merchant, burst 200.' });
});

test('the pages a reply used are recorded once per run and never posted', (t) => {
  const reply = 'Ship it on Thursday.\n\n<knowledge-used>owner/working-style.md, `people/priya.md`, ../secrets.json</knowledge-used>\n';
  const { reply: posted, cited } = takeKnowledgeUsed(reply);
  assert.equal(posted, 'Ship it on Thursday.');
  assert.deepEqual(cited, ['owner/working-style.md', 'people/priya.md']);
  assert.deepEqual(takeKnowledgeUsed('No knowledge here.'), { reply: 'No knowledge here.', cited: [] });

  const profile = mkdtempSync(join(tmpdir(), 'serra-usage-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  recordKnowledgeUse(profile, { at: '2026-11-24T10:00:00Z', runId: 'r1', visibility: 'team', cited: ['owner/role.md'], offered: 3 });
  recordKnowledgeUse(profile, { at: '2026-11-24T10:00:05Z', runId: 'r1', visibility: 'team', cited: ['owner/role.md'], offered: 3 });
  recordKnowledgeUse(profile, { at: '2026-11-24T11:00:00Z', runId: 'r2', visibility: 'owner', cited: [], offered: 3 });
  assert.equal(readKnowledgeUse(profile).length, 2, 'a run posted twice counts once');
  const overview = knowledgeOverview({ knowledgeDir: new URL('../evals/fixture/knowledge', import.meta.url).pathname, profileDir: profile, now: NOW });
  assert.deepEqual(overview.usage.pages, [{ path: 'owner/role.md', uses: 1, last: '2026-11-24T10:00:05Z' }]);
  assert.equal(overview.usage.withKnowledge, 1);
  assert.equal(overview.usage.replies, 2);
});

test('a rule pasted twice on one page counts as a repeat', () => {
  const text = '---\ntype: rule\ndescription: How I work\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner\n---\n# How I work\n\n- A bug fix starts with a failing test.\n- Keep PRs small.\n- A bug fix starts with a failing test.\n';
  const health = assessKnowledge([{ path: 'index.md', text: '| a | `owner/work.md` | b |' }, { path: 'owner/work.md', text }], NOW);
  assert.deepEqual(health.issues.map((issue) => issue.kind), ['duplicate']);
});

test('Overview counts what the bot reads: a hand edit waits for review before it changes the score', (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'serra-overview-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const knowledge = join(profile, 'knowledge');
  cpSync(new URL('../evals/fixture/knowledge', import.meta.url).pathname, knowledge, { recursive: true });
  createJournal(knowledge).seed();
  const before = knowledgeOverview({ knowledgeDir: knowledge, profileDir: profile, now: NOW });
  const role = join(knowledge, 'owner/working-style.md');
  writeFileSync(role, `${readFileSync(role, 'utf8').trimEnd()}\n- Risky releases ship on Monday.\n`);
  const after = knowledgeOverview({ knowledgeDir: knowledge, profileDir: profile, now: NOW });
  assert.equal(after.health.score, before.health.score, 'an unreviewed conflict is not the bot\'s knowledge yet');
  assert.equal(after.unreviewed, 1);
});

test('the index tells the worker when two rules disagree, so it never picks one silently', () => {
  const page = (body: string): string => `---\ntype: rule\ndescription: How I work\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner\n---\n${body}\n`;
  const index = '| releases | `owner/working-style.md` | How I decide |\n| voice | `owner/voice.md` | How I write |';
  const marked = markIndexRows(index, [
    { path: 'owner/working-style.md', text: page('- Risky releases ship on Tuesday.\n- Risky releases ship on Thursday now.') },
    { path: 'owner/voice.md', text: page('- Lead with the answer.') },
  ], NOW);
  assert.match(marked, /`owner\/working-style\.md` \| How I decide \(two rules disagree: "Risky releases ship on Tuesday\." and "Risky releases ship on Thursday now\."; don't pick one silently/);
  assert.match(marked, /\| voice \| `owner\/voice\.md` \| How I write \|$/m, 'a settled page is left alone');
});

test('a rule is compared wherever it is written, and two people with alike cards are never merged', () => {
  const page = (type: string, description: string, body: string): string => `---\ntype: ${type}\ndescription: ${description}\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner\n---\n${body}\n`;
  const index = '| a | `owner/style.md` | a |\n| b | `workflows/release.md` | b |\n| c | `people/ana.md` | c |\n| d | `people/bruno.md` | d |';
  const health = assessKnowledge([
    { path: 'index.md', text: index },
    { path: 'owner/style.md', text: page('rule', 'How I decide', '- Risky releases ship on Tuesday.') },
    { path: 'workflows/release.md', text: page('process', 'The release runbook', '- Risky releases ship on Thursday.') },
    { path: 'people/ana.md', text: page('person', 'Project manager and communication preferences', '# Ana\n\n- Likes a short written update.') },
    { path: 'people/bruno.md', text: page('person', 'Project manager and communication preferences', '# Bruno\n\n- Prefers a call.') },
  ], NOW);
  assert.deepEqual(health.issues.map((issue) => `${issue.kind} ${issue.pages.join(' ')}`), ['conflict workflows/release.md owner/style.md']);
});

test('history ends where the knowledge is, an accepted hand edit included', (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'serra-history-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const knowledge = join(profile, 'knowledge');
  cpSync(new URL('../evals/fixture/knowledge', import.meta.url).pathname, knowledge, { recursive: true });
  const service = createKnowledge(knowledge);
  service.seedApproved();
  const path = join(knowledge, 'owner/working-style.md');
  writeFileSync(path, `${readFileSync(path, 'utf8').trimEnd()}\n- Risky releases ship on Monday.\n`);
  service.acceptDrift('owner/working-style.md', readFileSync(path, 'utf8'));
  const overview = knowledgeOverview({ knowledgeDir: knowledge, profileDir: profile, now: NOW });
  const last = overview.points.at(-1)!;
  assert.equal(last.score, overview.health.score);
  assert.equal(last.facts, overview.health.facts);
  assert.ok(overview.events.some((event) => event.page === 'owner/working-style.md' && event.added.includes('Risky releases ship on Monday.')), 'the accepted edit is in the timeline');
});
