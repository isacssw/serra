// The weekly knowledge review: what it reads, what it asks T3 (faked here), what it writes, and when it runs.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createJournal } from '../src/knowledge-journal.ts';
import { reviewDue, runKnowledgeReview } from '../src/knowledge-review.ts';
import { latestReview, setReviewWeekly } from '../src/knowledge-review-store.ts';
import { recordKnowledgeUse } from '../src/knowledge-usage.ts';
import { createProposals } from '../src/proposals.ts';
import { knowledgeOverview } from '../src/knowledge-overview.ts';

const NOW = new Date('2026-11-25T12:00:00Z');

/** Robin's fixture, with a rule that disagrees on the release page and a week of replies. */
const profile = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knowledge = join(dir, 'knowledge');
  cpSync(new URL('../evals/fixture/knowledge', import.meta.url).pathname, knowledge, { recursive: true });
  const style = join(knowledge, 'owner/working-style.md');
  writeFileSync(style, readFileSync(style, 'utf8').replace('- A bug fix starts with a failing test.', '- A bug fix starts with a failing test.\n- Risky releases ship on Thursday now.'));
  createJournal(knowledge).seed();
  const reply = (day: number, cited: string[], request: string, reply: string, missing?: string[]) => recordKnowledgeUse(dir, {
    at: new Date(NOW.getTime() - day * 86_400_000).toISOString(), runId: `r${day}-${request}`, visibility: 'team', cited, offered: 30, request, reply, ...(missing ? { missing } : {}),
  });
  reply(1, ['owner/working-style.md', 'workflows/release.md'], 'can we ship the webhook retry change this Thursday?', 'Not this Thursday: risky releases ship on Tuesday.');
  reply(2, ['owner/working-style.md'], 'how big can my PR be?', 'Under 400 changed lines.');
  reply(3, ['product/rate-limits.md'], 'what is the rate limit?', '100 requests per second per merchant.', ['who approves refunds over 500 EUR']);
  reply(4, [], 'thanks!', 'You’re welcome.', ['who approves refunds over 500 EUR']);
  return { dir, knowledge };
};

test('the weekly review writes a checked rewrite as a proposal, a before/after example, and the week in numbers', async (t) => {
  const { dir, knowledge } = profile(t);
  const asked: string[] = [];
  const tuesday = '- Risky releases (anything touching money movement or webhooks) ship on Tuesday, never Thursday or Friday, so there\'s a week to fix them.\n';
  const page = readFileSync(join(knowledge, 'owner/working-style.md'), 'utf8');
  const fixed = page.replace(tuesday, '').trimEnd() + `\n\n## Replaced\n\n- Until 2026-11-20: ${tuesday.slice(2)}`;
  // A rewrite that quietly drops a rule (the failing-test one) is refused.
  const lossy = fixed.replace('- A bug fix starts with a failing test.\n', '');
  const ask = async (title: string, prompt: string): Promise<string> => {
    asked.push(prompt);
    if (title.includes('weekly review')) {
      return `Here you go: ${JSON.stringify({ summary: 'Your notes answered 3 of 4 replies. Settle the release day.', rewrites: [
        { page: 'owner/working-style.md', text: lossy, why: 'drops a rule' },
        { page: 'owner/working-style.md', text: fixed, why: 'Keeps Thursday, the newer rule.' },
        { page: 'owner/role.md', text: 'not a page', why: 'invalid' },
        { page: 'product/sdks.md', text: 'never asked for', why: 'not a page to fix' },
      ] })}`;
    }
    return title.includes('with the page') ? 'Keep it under 400 changed lines.' : 'I don\'t know which day risky releases ship.';
  };
  const review = await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, ask, now: NOW });

  assert.equal(review.summary, 'Your notes answered 3 of 4 replies. Settle the release day.');
  assert.equal(review.replies, 4);
  assert.equal(review.withKnowledge, 3);
  assert.deepEqual(review.missing, [{ topic: 'who approves refunds over 500 EUR', count: 2 }], 'shown as first written');
  assert.equal(review.used[0]?.page, 'owner/working-style.md');
  // Only the checked rewrite becomes a proposal; a broken page and a page nobody asked to fix are dropped.
  const replace = review.suggestions.filter((item) => item.kind === 'replace');
  assert.deepEqual(replace.map((item) => item.page), ['owner/working-style.md']);
  const proposals = createProposals({ knowledgeDir: knowledge });
  const listed = proposals.listProposals();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.target, 'owner/working-style.md');
  assert.equal(listed[0]!.from?.who, 'Weekly review');
  assert.match(proposals.readProposal(listed[0]!.path).proposed, /^verified: no$/m);
  // The before/after: the week's most used page, its latest request, the real reply and the answer without it.
  assert.equal(review.examples[0]?.page, 'owner/working-style.md');
  assert.equal(review.examples[0]?.request, 'how big can my PR be?');
  assert.equal(review.examples[0]?.withPage, 'Keep it under 400 changed lines.', 'both answers come from the same prompt, one page apart');
  assert.equal(review.examples[0]?.without, 'I don\'t know which day risky releases ship.');
  assert.ok(asked[1]!.includes('ship on Tuesday, never Thursday'), 'the "with" run sees the page');
  assert.ok(!asked[2]!.includes('ship on Tuesday, never Thursday'), 'the "without" run never sees the page it is answering without');
  assert.ok(asked[0]!.includes('two rules that disagree') && asked[0]!.includes('<page path="owner/working-style.md">'));
  assert.deepEqual(latestReview(dir), review);

  // Overview offers the one-click Approve only while the page is as the review saw it.
  assert.equal(knowledgeOverview({ knowledgeDir: knowledge, profileDir: dir, now: NOW }).review?.suggestions.some((item) => item.kind === 'replace'), true);
  const style = join(knowledge, 'owner/working-style.md');
  writeFileSync(style, `${readFileSync(style, 'utf8').trimEnd()}\n- A new rule the owner just added.\n`);
  assert.equal(knowledgeOverview({ knowledgeDir: knowledge, profileDir: dir, now: NOW }).review?.suggestions.some((item) => item.kind === 'replace'), false, 'a rewrite never lands over a page that changed since');
});

test('a review whose model run fails still saves what plain code found', async (t) => {
  const { dir, knowledge } = profile(t);
  const review = await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, ask: async () => { throw new Error('Usage limit reached'); }, now: NOW });
  assert.equal(review.error, 'Usage limit reached');
  assert.equal(review.replies, 4);
  assert.deepEqual(review.examples, []);
  assert.ok(!existsSync(join(knowledge, 'proposals/from-review')) || readdirSync(join(knowledge, 'proposals/from-review')).length === 0);
});

test('the review runs weekly, only after a week with replies, and the owner can turn it off', async (t) => {
  const { dir, knowledge } = profile(t);
  assert.equal(reviewDue(dir, NOW), true);
  await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, ask: async () => '{}', now: NOW });
  assert.equal(reviewDue(dir, new Date(NOW.getTime() + 3 * 86_400_000)), false, 'not again within the week');
  assert.equal(reviewDue(dir, new Date(NOW.getTime() + 7 * 86_400_000)), false, 'a week later, but no replies that week');
  setReviewWeekly(dir, false);
  assert.equal(reviewDue(dir, NOW), false);
  const quiet = mkdtempSync(join(tmpdir(), 'serra-review-quiet-'));
  t.after(() => rmSync(quiet, { recursive: true, force: true }));
  assert.equal(reviewDue(quiet, NOW), false, 'a bot with no replies has nothing to review');
});

test('a rewrite that settles a rule changed on another page must say the current rule, and is stamped as the review\'s', async (t) => {
  const { dir, knowledge } = profile(t);
  const header = (description: string, date: string) => `---\ntype: product\ndescription: ${description}\naudience: team\nwritten: ${date}\nverified: ${date}\nsources:\n  - Robin, ${date}\n---\n\n`;
  writeFileSync(join(knowledge, 'product/plans.md'), `${header('Plans', '2026-11-20')}- The API rate limit is 250 requests per second per merchant on every plan.\n`);
  const limits = join(knowledge, 'product/rate-limits.md');
  writeFileSync(limits, readFileSync(limits, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-06-01'));
  writeFileSync(join(knowledge, 'index.md'), `${readFileSync(join(knowledge, 'index.md'), 'utf8').trimEnd()}\n| plans | \`product/plans.md\` | Plans |\n`);
  rmSync(join(dir, '.knowledge-approved'), { recursive: true, force: true });
  createJournal(knowledge).seed();
  const old = '- 100 requests per second per merchant, burst 200.\n';
  const page = readFileSync(limits, 'utf8');
  const loses = page.replace(old, '').trimEnd() + `\n\n## Replaced\n\n- Until 2026-11-20: ${old.slice(2)}`;
  const settles = page.replace(old, '- The API rate limit is 250 requests per second per merchant on every plan.\n').trimEnd() + `\n\n## Replaced\n\n- Until 2026-11-20: ${old.slice(2)}`;
  const run = (text: string) => runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, now: NOW,
    ask: async (title) => (title.includes('weekly review') ? JSON.stringify({ summary: 'One. Two. Three.', rewrites: [{ page: 'product/rate-limits.md', text, why: 'Settles the limit.' }] }) : 'An answer.') });
  const refused = await run(loses);
  assert.deepEqual(refused.suggestions.filter((item) => item.kind === 'replace'), [], 'moving the old rule away without the current one leaves the page answering nothing');
  assert.equal(refused.summary, 'One. Two.', 'the summary is two sentences, cut where one ends');
  const kept = await run(settles);
  const proposal = kept.suggestions.find((item) => item.kind === 'replace')!;
  const text = readFileSync(join(knowledge, 'proposals', proposal.proposal!), 'utf8');
  assert.match(text, /^written: 2026-11-25$/m);
  assert.match(text, /^  - Weekly review, 2026-11-25, settled with product\/plans\.md$/m);
  assert.match(text, /^verified: no$/m);
});

test('"Still true" is offered for a stale page the week used, but never for one a newer page on its topic may have changed', async (t) => {
  const { dir, knowledge } = profile(t);
  const stale = (page: string) => { const file = join(knowledge, page); writeFileSync(file, readFileSync(file, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-05-01')); };
  stale('product/feature-flags.md');
  stale('product/sandbox.md');
  writeFileSync(join(knowledge, 'product/release-policy.md'), '---\ntype: product\ndescription: Rollouts\naudience: team\nwritten: 2026-11-05\nverified: 2026-11-05\nsources:\n  - Robin\n---\n\n- Feature flags roll out 10%, 50%, 100% over two days.\n');
  writeFileSync(join(knowledge, 'index.md'), `${readFileSync(join(knowledge, 'index.md'), 'utf8').trimEnd()}\n| announcing changes | \`product/release-policy.md\` | Rollouts |\n`);
  rmSync(join(dir, '.knowledge-approved'), { recursive: true, force: true });
  createJournal(knowledge).seed();
  for (const page of ['product/feature-flags.md', 'product/sandbox.md']) recordKnowledgeUse(dir, { at: new Date(NOW.getTime() - 3600e3).toISOString(), runId: page, visibility: 'team', cited: [page], offered: 30, request: 'q', reply: 'a' });
  const review = await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, ask: async () => '{}', now: NOW });
  const confirms = review.suggestions.filter((item) => item.kind === 'confirm').map((item) => item.page);
  assert.deepEqual(confirms, ['product/sandbox.md']);
});

test('two answers with the same numbers and mostly the same words are the same answer, so no example shows them', async (t) => {
  const { dir, knowledge } = profile(t);
  const review = await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, now: NOW,
    ask: async (title) => (title.includes('weekly review') ? '{}' : title.includes('with the page') ? 'No. Split it into three PRs under 400 lines each.' : 'No, split it into three smaller PRs of under 400 lines.') });
  assert.deepEqual(review.examples, []);
});
