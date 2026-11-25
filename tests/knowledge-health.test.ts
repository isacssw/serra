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
import { changeText, fixItems, groupByDay, headline, scoreChart, scoreWord, valueLabel, valueSummary } from '../app/renderer/screens/overview.logic.ts';
import { currentRules, groupByArea, keepLabel, keepRule, newerRule, replacedOn } from '../app/renderer/screens/pages.logic.ts';
import { swapRule } from '../app/renderer/screens/proposals.logic.ts';

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
    // Same shape, different subjects: two true facts, not a conflict.
    { a: 'Webhooks retry 5 times over 24 hours.', b: 'Invoices retry 3 times over 24 hours.', is: 'neither' },
    { a: 'The API rate limit is 100 requests per minute.', b: 'The dashboard rate limit is 20 requests per minute.', is: 'neither' },
    { a: 'Retry webhooks 5 times.', b: 'Retry invoices 3 times.', is: 'neither' },
    // The same rule, phrased as an order.
    { a: 'Risky releases ship on Tuesday.', b: 'Ship risky releases on Thursday.', is: 'conflict' },
    // An update in other words.
    { a: 'API rate limit is 100 requests per minute.', b: 'Rate limit is now 200 requests per minute.', is: 'conflict' },
    { a: 'Release day is Tuesday.', b: 'We now release on Thursday.', is: 'conflict' },
    { a: 'Keep pull requests under 400 lines.', b: 'Pull requests should stay under 200 lines.', is: 'conflict' },
    // The proof fixture's own changed rules, as written.
    { a: 'Risky releases (anything touching money movement or webhooks) ship on Tuesday, never Thursday or Friday, so there\'s a week to fix them.', b: 'Risky releases ship on Thursday now (since 2026-10-01), never Friday.', is: 'conflict' },
    { a: '100 requests per second per merchant, burst 200.', b: 'The API rate limit is 250 requests per second per merchant on every plan.', is: 'conflict' },
    // One bullet holding several facts is read a sentence at a time.
    { a: 'Payment records are kept 7 years. Webhook payloads 30 days. Logs 14 days.', b: 'Webhook payloads are kept 14 days.', is: 'conflict' },
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
  assert.deepEqual(takeKnowledgeUsed('No knowledge here.'), { reply: 'No knowledge here.', cited: [], missing: [] });
  assert.deepEqual(takeKnowledgeUsed('Ask Priya.\n<knowledge-missing>who approves refunds over 500 EUR</knowledge-missing>'), { reply: 'Ask Priya.', cited: [], missing: ['who approves refunds over 500 EUR'] });

  const profile = mkdtempSync(join(tmpdir(), 'serra-usage-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  recordKnowledgeUse(profile, { at: '2026-11-24T10:00:00Z', runId: 'r1', visibility: 'team', cited: ['owner/role.md'], offered: 3 });
  recordKnowledgeUse(profile, { at: '2026-11-24T10:00:05Z', runId: 'r1', visibility: 'team', cited: ['owner/role.md'], offered: 3 });
  recordKnowledgeUse(profile, { at: '2026-11-24T11:00:00Z', runId: 'r2', visibility: 'owner', cited: [], offered: 3 });
  assert.equal(readKnowledgeUse(profile).length, 2, 'a run posted twice counts once');
  const overview = knowledgeOverview({ knowledgeDir: new URL('../evals/fixture/knowledge', import.meta.url).pathname, profileDir: profile, now: NOW });
  assert.deepEqual(overview.usage.pages, [{ path: 'owner/role.md', uses: 1, last: '2026-11-24T10:00:05Z', title: "Robin's role, team, hours and priorities" }]);
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
  assert.match(marked, /`owner\/working-style\.md` \| How I decide \(two rules disagree: see below\) \|/);
  assert.match(marked, /\| voice \| `owner\/voice\.md` \| How I write \|$/m, 'a settled page is left alone');
  assert.match(marked, /Rules that disagree\. Follow the current one .*\n- Current: "Risky releases ship on Thursday now\." \(`owner\/working-style\.md`, confirmed 2026-11-20\)\. It replaces "Risky releases ship on Tuesday\." on the same page\.$/);
  // Across pages, the page confirmed later holds the current rule; with nothing to tell them apart, the worker is told so.
  const limits = (date: string, line: string): string => `---\ntype: product\ndescription: Limits\nwritten: ${date}\nverified: ${date}\nsources:\n  - Owner\n---\n- ${line}\n`;
  const across = markIndexRows('| a | `product/rate-limits.md` | a |\n| b | `product/plans.md` | b |', [
    { path: 'product/rate-limits.md', text: limits('2026-06-01', 'The API rate limit is 100 requests per second.') },
    { path: 'product/plans.md', text: limits('2026-10-20', 'The API rate limit is 250 requests per second.') },
  ], NOW);
  assert.match(across, /- Current: "The API rate limit is 250 requests per second\." \(`product\/plans\.md`, confirmed 2026-10-20\)\. It replaces "The API rate limit is 100 requests per second\." \(`product\/rate-limits\.md`, confirmed 2026-06-01\)\./);
  const tie = markIndexRows('| a | `owner/a.md` | a |', [{ path: 'owner/a.md', text: limits('2026-11-20', 'Keep PRs under 400 lines.\n- Keep PRs under 300 lines.') }], NOW);
  assert.match(tie, /can't tell which is newer\.$/);
});

test('a newer rule that says what it ended replaces the older rules still naming it', () => {
  const page = (date: string, body: string): string => `---\ntype: product\ndescription: Notes\nwritten: ${date}\nverified: ${date}\nsources:\n  - Owner\n---\n${body}\n`;
  const marked = markIndexRows('| a | `product/auth.md` | a |\n| b | `product/q4.md` | b |\n| c | `product/status.md` | c |', [
    { path: 'product/auth.md', text: page('2026-11-02', '- Merchants use secret keys; dashboards use OAuth.') },
    { path: 'product/status.md', text: page('2026-11-02', '- Incidents go on the public status page.') },
    { path: 'product/q4.md', text: page('2026-11-19', '- Dashboard login moved to SSO through Okta; OAuth login was removed.\n- The public changelog is replaced by a monthly digest.') },
  ], NOW);
  assert.match(marked, /- Current: "Dashboard login moved to SSO through Okta; OAuth login was removed\." \(`product\/q4\.md`, confirmed 2026-11-19\)\. It replaces "Merchants use secret keys; dashboards use OAuth\." \(`product\/auth\.md`, confirmed 2026-11-02\)\./);
  assert.doesNotMatch(marked, /status page/, 'a shared common word ("public") is no reason to pair two rules');
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
  // Accepting is stamped with the real clock, so the overview is read just after it.
  const overview = knowledgeOverview({ knowledgeDir: knowledge, profileDir: profile, now: new Date(Date.now() + 60_000) });
  const last = overview.points.at(-1)!;
  assert.equal(last.score, overview.health.score);
  assert.equal(last.facts, overview.health.facts);
  assert.ok(overview.events.some((event) => event.page === 'owner/working-style.md' && event.added.includes('Risky releases ship on Monday.')), 'the accepted edit is in the timeline');
});

test('pages whose rows carry a conflict note stay in the relevance hint', () => {
  const page = (body: string): string => `---\ntype: rule\ndescription: Release days\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner\n---\n${body}\n`;
  const files = [
    { path: 'owner/style.md', text: page('- Risky releases ship on Tuesday.') },
    { path: 'owner/releases.md', text: page('- Risky releases ship on Thursday.') },
  ];
  const marked = markIndexRows('| release days | `owner/style.md` | How I ship |\n| release days | `owner/releases.md` | When I ship |', files, NOW);
  assert.match(marked, /two rules disagree/);
  assert.deepEqual(pageCards(marked, files).map((card) => card.path), ['owner/style.md', 'owner/releases.md']);
  assert.equal(rankPages('which day do risky releases ship?', pageCards(marked, files)).length, 2);
});

test('two people are never one: a shared surname or role is not the same person, in health or in Proposals', () => {
  const card = (name: string, line: string): string => `---\ntype: person\ndescription: Who ${name} is\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner\n---\n# ${name}\n\n- ${line}\n`;
  const files = [
    { path: 'index.md', text: '| a | `people/ana-silva.md` | a |\n| b | `people/bruno-silva.md` | b |' },
    { path: 'people/ana-silva.md', text: card('Ana Silva', 'Reviews pull requests on Monday.') },
    { path: 'people/bruno-silva.md', text: card('Bruno Silva', 'Reviews pull requests on Friday.') },
  ];
  assert.deepEqual(assessKnowledge(files, NOW).issues, []);
  const bruno = '---\ntype: person\ndescription: Who Bruno is\n---\n# Bruno\n\n- Reviews pull requests on Wednesday.\n';
  assert.deepEqual(similarPages(bruno, files.filter((file) => file.path !== 'people/bruno-silva.md')), [], 'a Bruno proposal is never said to change Ana\'s card');
});

test('keeping one of two rules moves the other under Replaced, dated, where the bot no longer reads it', () => {
  const text = '---\ntype: rule\n---\n# How I work\n\n- Risky releases ship on Tuesday.\n- A bug fix starts with a failing test.\n- Risky releases ship on Thursday now.\n';
  const kept = keepRule(text, 'Risky releases ship on Tuesday.', '2026-11-25');
  assert.equal(kept, '---\ntype: rule\n---\n# How I work\n\n- A bug fix starts with a failing test.\n- Risky releases ship on Thursday now.\n\n## Replaced\n\n- Until 2026-11-25: Risky releases ship on Tuesday.\n');
  assert.deepEqual(assessKnowledge([{ path: 'index.md', text: '| a | `owner/work.md` | a |' }, { path: 'owner/work.md', text: kept.replace('type: rule', 'type: rule\ndescription: How I work\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner') }], NOW).issues, []);
  assert.equal(keepRule(kept, 'Not on the page.', '2026-11-25'), kept);
});

test('keeping a rule settles the pair: amounts survive, the kept page reads as settled, and prose is left to edit by hand', () => {
  const header = '---\ntype: rule\ndescription: Refunds\nwritten: 2026-11-01\nverified: 2026-11-20\nsources:\n  - Owner\n---\n';
  const text = `${header}- Refunds over $100 need Robin.\n- Refunds over $250 need Robin now.\n\n## Replaced\n\n- Until 2026-10-01: Refunds over $50 needed Robin.\n`;
  const kept = keepRule(text, 'Refunds over $100 need Robin.', '2026-11-25');
  assert.match(kept, /## Replaced\n\n- Until 2026-11-25: Refunds over \$100 need Robin\.\n- Until 2026-10-01: Refunds over \$50 needed Robin\.\n$/);
  assert.deepEqual(currentRules(kept), ['Refunds over $250 need Robin now.']);
  assert.equal(newerRule('Refunds over $100 need Robin.', 'Refunds over $250 need Robin now.'), 1);
  assert.equal(newerRule('Ship on Tuesday.', 'Ship on Thursday.'), null);
  assert.equal(newerRule('Never deploy on Friday since on-call is thin.', 'Deploy any day.'), null, 'a causal "since" is no date');
  assert.equal(newerRule('Deploy on Tuesday.', 'Deploy on Thursday since 2026-06-15.'), 1);
  // The page as the owner saves it has nothing left to settle.
  const issues = assessKnowledge([{ path: 'index.md', text: '| a | `owner/refunds.md` | a |' }, { path: 'owner/refunds.md', text: kept }], NOW).issues;
  assert.deepEqual(issues, []);
});

test('merging a proposal that changes a rule swaps it and keeps everything else the proposal adds', () => {
  const page = '---\ntype: rule\n---\n# How I work\n\n- Risky releases ship on Tuesday.\n- A bug fix starts with a failing test.\n\n## Replaced\n\n- Until 2026-01-01: Releases on Monday.\n';
  const merged = swapRule(page, { page: 'Risky releases ship on Tuesday.', proposal: 'Risky releases ship on Thursday.' }, '- Risky releases ship on Thursday.\n- Every release has a rollback plan.\n', '2026-11-25');
  assert.equal(merged, '---\ntype: rule\n---\n# How I work\n\n- Risky releases ship on Thursday.\n- A bug fix starts with a failing test.\n- Every release has a rollback plan.\n\n## Replaced\n\n- Until 2026-11-25: Risky releases ship on Tuesday.\n- Until 2026-01-01: Releases on Monday.\n');
});

test('a year of history on a full knowledge base is worked out in well under the time a screen may block', () => {
  const files = tree(new URL('../evals/fixture/knowledge', import.meta.url).pathname);
  const all = [...files, ...files.filter((file) => file.path.includes('/')).map((file) => ({ path: file.path.replace('.md', '-2.md'), text: file.text.replace(/^- /gm, '- Also, ') }))];
  const changes = Array.from({ length: 400 }, (_, at) => {
    const page = all[1 + (at % (all.length - 1))]!;
    return { id: `c${at}`, action: 'edit', at: new Date(Date.parse('2025-11-25T00:00:00Z') + at * 21.9 * 3600e3).toISOString(), files: [{ path: page.path, before: `${page.text}- An older line.\n`, after: page.text }] };
  });
  const started = performance.now();
  const history = knowledgeHistory(all, changes, NOW);
  assert.ok(history.points.length > 300);
  // Well under a second on an idle Mac; the bound leaves room for a busy CI runner.
  assert.ok(performance.now() - started < 6000, `${Math.round(performance.now() - started)} ms for ${all.length} files and 400 changes`);
});

test('To do puts every organising job in one list, one-click review fixes first, a page never listed twice', () => {
  const overview = {
    value: [{ path: 'owner/style.md', title: 'How I decide', area: 'How you work', uses: 3, last: null, state: 'earns' as const, examples: [] }],
    review: { suggestions: [{ id: 'replace:owner/style.md', kind: 'replace' as const, page: 'owner/style.md', title: 'How I decide', why: 'Keeps Thursday.', proposal: 'from-review/x.md' }] },
    health: { issues: [
      { kind: 'conflict' as const, pages: ['owner/style.md'], text: '', detail: ['Tuesday', 'Thursday'] },
      { kind: 'stale' as const, pages: ['product/old.md'], text: '' },
      { kind: 'unindexed' as const, pages: ['product/lost.md'], text: '' },
    ] },
  } as unknown as Parameters<typeof fixItems>[0];
  const items = fixItems(overview);
  assert.deepEqual(items.map((item) => [item.title, item.action]), [['How I decide', 'Approve'], ['product/old.md', 'Still true'], ['product/lost.md', 'Open']]);
  assert.equal(items[1]!.suggestion?.kind, 'confirm', 'a stale page is one click too');
  // A stale page a newer page may have changed opens instead; waiting proposals sit in the same list.
  const held = fixItems({ ...overview, confirmHeldBack: ['product/old.md'], proposals: [{ id: 'from-slack/x/2026-11-20-days.md', title: 'Release days' }] });
  assert.deepEqual(held.map((item) => [item.title, item.action]), [['How I decide', 'Approve'], ['Release days', 'Review'], ['product/old.md', 'Open'], ['product/lost.md', 'Open']]);
});

test('Pages groups by topic, and each page reads in plain words', () => {
  const page = (path: string, area: string, description: string) => ({ path, area, description, verified: null, badge: 'verified' as const, lines: 3, problems: [], warnings: [] });
  assert.deepEqual(groupByArea([page('people/b.md', 'People', 'Who Bo is'), page('owner/r.md', 'Who you are', 'Role'), page('people/a.md', 'People', 'Who Al is')])
    .map((group) => [group.area, group.pages.map((item) => item.description)]), [['Who you are', ['Role']], ['People', ['Who Al is', 'Who Bo is']]]);
  assert.deepEqual((['earns', 'some', 'carried', 'idle', 'unknown'] as const).map((state) => valueLabel(state, 5)), ['Used in 5 replies', 'Used once', 'Always in the brief', 'Not used', 'Not used yet']);
});

test('two rules to settle get buttons that say which', () => {
  assert.equal(keepLabel('Risky releases ship on Thursday now.', 'Risky releases ship on Tuesday.'), 'Keep Thursday');
  assert.equal(keepLabel('Keep PRs under 300 changed lines now.', 'Keep PRs under 400 changed lines.'), 'Keep 300');
  assert.equal(keepLabel('Payments bugs go to #payments-bugs.', 'Payments bugs go to #ledgerline-triage.'), 'Keep #payments-bugs');
  assert.equal(keepLabel('ship it later', 'ship it sooner'), 'Keep this one');
});

test('the value line never counts pages that ride in every brief as having helped', () => {
  assert.equal(valueSummary(['earns', 'earns', 'some', 'carried', 'carried'], 30), '3 of 3 pages helped in the last 30 days · 2 always in the brief');
  assert.equal(valueSummary(['earns', 'idle', 'unknown'], 30), '1 of 3 pages helped in the last 30 days · 1 not used');
});

test('an old rule is replaced from the date the kept rule gives, as the weekly review writes it, else today', () => {
  assert.equal(replacedOn('Risky releases ship on Thursday since 2026-10-01.', '2026-11-25'), '2026-10-01');
  assert.equal(replacedOn('Risky releases ship on Thursday now.', '2026-11-25'), '2026-11-25');
  assert.equal(replacedOn('From 2027-01-01 releases ship on Monday.', '2026-11-25'), '2026-11-25', 'a plan, not a start');
});

test('Overview leads with one number: replies the notes shaped this week, else over the usage window, else nothing', () => {
  const usage = { replies: 9, withKnowledge: 6, days: 30 };
  const now = new Date('2026-11-25T12:00:00Z');
  assert.deepEqual(headline({ review: { replies: 5, withKnowledge: 4, to: '2026-11-24' }, usage } as unknown as Parameters<typeof headline>[0], now), { used: 4, replies: 5, period: 'this week' });
  assert.deepEqual(headline({ review: { replies: 5, withKnowledge: 4, to: '2026-10-20' }, usage } as unknown as Parameters<typeof headline>[0], now), { used: 6, replies: 9, period: 'in 30 days' }, 'an old review is never "this week"');
  assert.deepEqual(headline({ review: null, usage } as unknown as Parameters<typeof headline>[0]), { used: 6, replies: 9, period: 'in 30 days' });
  assert.equal(headline({ review: null, usage: { replies: 0, withKnowledge: 0, days: 30 } } as unknown as Parameters<typeof headline>[0]), null);
});

test('To do is the one place to act: rules that disagree (with Keep buttons), hand edits, what replies missed', () => {
  const facts = [{ page: 'owner/style.md', text: 'Risky releases ship on Tuesday.' }, { page: 'owner/style.md', text: 'Risky releases ship on Thursday now.' }];
  const items = fixItems({
    value: [], unreviewed: 2,
    review: { suggestions: [], missing: [{ topic: 'who approves refunds over 500 EUR', count: 2 }] },
    health: { issues: [{ kind: 'conflict', pages: ['owner/style.md'], text: '', detail: [], facts }] },
  } as unknown as Parameters<typeof fixItems>[0]);
  assert.deepEqual(items.map((item) => [item.title, item.action]), [['owner/style.md', 'Settle'], ['2 pages edited outside Serra', 'Review'], ['who approves refunds over 500 EUR', 'Tell it']], 'what shapes replies now comes first');
  assert.deepEqual(items[0]!.keep, facts, 'the conflict is settled right there, one Keep per rule');
  assert.equal(items[1]!.href, '/knowledge/pages');
  assert.equal(items[2]!.tell, 'who approves refunds over 500 EUR');
});
