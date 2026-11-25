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
/** `extra` writes more pages before the approved copy is taken, so the review reads them. */
const profile = (t: TestContext, extra?: (knowledge: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knowledge = join(dir, 'knowledge');
  cpSync(new URL('../evals/fixture/knowledge', import.meta.url).pathname, knowledge, { recursive: true });
  const style = join(knowledge, 'owner/working-style.md');
  writeFileSync(style, readFileSync(style, 'utf8').replace('- A bug fix starts with a failing test.', '- A bug fix starts with a failing test.\n- Risky releases ship on Thursday now.'));
  extra?.(knowledge);
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

  // Approved, the rewrite keeps the page's own confirmed date: dating it today would make every rule the review left
  // alone look newer than a later page that changed it.
  writeFileSync(style, page);
  const before = readFileSync(style, 'utf8').match(/^verified: (.+)$/m)?.[1];
  const shown = proposals.readProposal(listed[0]!.path);
  proposals.promoteProposal(listed[0]!.path, { folder: 'owner', reviewed: { proposal: shown.proposed, path: 'owner/working-style.md', page: shown.current } });
  assert.equal(readFileSync(style, 'utf8').match(/^verified: (.+)$/m)?.[1], before);
  assert.match(before ?? '', /^\d{4}-\d{2}-\d{2}$/);
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

test('a change the detector can\'t see goes to the model as a question, and its rewrite must say the newer rule', async (t) => {
  const { dir, knowledge } = profile(t);
  const support = join(knowledge, 'product/support.md');
  writeFileSync(support, readFileSync(support, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-03-01'));
  writeFileSync(join(knowledge, 'product/escalation.md'), '---\ntype: product\ndescription: Where things get triaged\naudience: team\nwritten: 2026-11-15\nverified: 2026-11-15\nsources:\n  - Robin\n---\n\n- Payments bugs now go to #payments-bugs; #ledgerline-triage is for everything else.\n');
  writeFileSync(join(knowledge, 'index.md'), `${readFileSync(join(knowledge, 'index.md'), 'utf8').trimEnd()}\n| triage channels | \`product/escalation.md\` | Where things get triaged |\n`);
  rmSync(join(dir, '.knowledge-approved'), { recursive: true, force: true });
  createJournal(knowledge).seed();
  const page = readFileSync(support, 'utf8');
  const old = '- Tier 1 is the support team; payments bugs go to #ledgerline-triage.\n';
  const fixed = page.replace(old, '- Tier 1 is the support team.\n- Payments bugs now go to #payments-bugs; #ledgerline-triage is for everything else.\n').trimEnd() + `\n\n## Replaced\n\n- Until 2026-11-15: ${old.slice(2)}`;
  let prompt = '';
  const review = await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, now: NOW, ask: async (title, text) => {
    if (title.includes('weekly review')) { prompt = text; return JSON.stringify({ summary: 'One.', rewrites: [{ page: 'product/support.md', text: fixed, why: 'Payments bugs moved channel.' }] }); }
    return 'An answer.';
  } });
  assert.match(prompt, /Maybe: product\/support\.md \(older\) says "Tier 1 is the support team; payments bugs go to #ledgerline-triage\."/);
  assert.deepEqual(review.suggestions.filter((item) => item.kind === 'replace').map((item) => item.page), ['product/support.md']);
});

test('a page a newer page may have overtaken is never a before/after example', async (t) => {
  const { dir, knowledge } = profile(t, (knowledge) => writeFileSync(join(knowledge, 'product/plans.md'), [
    '---', 'type: product', 'description: Plans and limits', 'audience: team', 'written: 2026-11-20', 'verified: 2026-11-20', 'sources:', '  - Owner interview, 2026-11-20', '---',
    '# Plans and limits', '', '- 250 requests per second per merchant, burst 400.', '',
  ].join('\n')));
  // The week's most used page, so only the overtaken check keeps it out of the examples.
  for (const day of [5, 6]) recordKnowledgeUse(dir, { at: new Date(NOW.getTime() - day * 86_400_000).toISOString(), runId: `limit-${day}`, visibility: 'team', cited: ['product/rate-limits.md'], offered: 30, request: `what is our rate limit? (${day})`, reply: '100 per second.' });
  const asked: string[] = [];
  const ask = async (title: string): Promise<string> => {
    asked.push(title);
    if (title.includes('weekly review')) return JSON.stringify({ summary: 'A quiet week.', rewrites: [] });
    return title.includes('with the page') ? 'Under 400 changed lines.' : 'I don\'t know.';
  };
  const review = await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, ask, now: NOW });
  assert.ok(review.used.some((item) => item.page === 'product/rate-limits.md'), 'the page was used this week');
  assert.ok(!review.examples.some((item) => item.page === 'product/rate-limits.md'), 'but a newer page says otherwise, so it proves nothing');
  assert.ok(review.examples.some((item) => item.page === 'owner/working-style.md'));
});

test('the review offers Retire for a page on the same topic only when the other page holds every rule it has', async (t) => {
  const page = (rules: string[]) => ['---', 'type: product', 'description: Sandbox reset schedule', 'audience: team', 'written: 2026-11-01', 'verified: 2026-11-01', 'sources:', '  - Owner interview, 2026-11-01', '---', '# Sandbox', '', ...rules.map((rule) => `- ${rule}`), ''].join('\n');
  const run = async (cite: string) => {
    const { dir, knowledge } = profile(t, (knowledge) => {
      writeFileSync(join(knowledge, 'product/sandbox-a.md'), page(['The sandbox is wiped every Sunday at 02:00 UTC.']));
      writeFileSync(join(knowledge, 'product/sandbox-b.md'), page(['The sandbox is wiped every Sunday at 02:00 UTC.', 'Ask Jonas to skip a reset before a demo.']));
    });
    recordKnowledgeUse(dir, { at: new Date(NOW.getTime() - 86_400_000).toISOString(), runId: `sandbox-${cite}`, visibility: 'team', cited: [cite], offered: 30, request: 'when is the sandbox wiped?', reply: 'Sunday 02:00 UTC.' });
    const review = await runKnowledgeReview({ profileDir: dir, knowledgeDir: knowledge, ask: async () => JSON.stringify({ summary: 'A quiet week.', rewrites: [] }), now: NOW });
    return review.suggestions.filter((item) => item.kind === 'retire').map((item) => item.page);
  };
  assert.deepEqual(await run('product/sandbox-b.md'), ['product/sandbox-a.md'], 'the smaller page says nothing the other does not');
  assert.deepEqual(await run('product/sandbox-a.md'), [], 'retiring the bigger page would lose the demo rule');
});
