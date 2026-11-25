// A real weekly review, end to end through T3: the proof's invented owner, a week of replies taken from a proof run's
// "after" arm (the real requests, replies and the pages each named), then `runKnowledgeReview` with a read-only T3 run
// on the provider named. Saves the digest, the proposals it wrote and the knowledge it read, so the digest in the PR is
// one a model really produced.
//
//   node evals/kb-review-demo.ts --from <proof out>/results.json --out <dir> [--provider claudeAgent --model claude-opus-5-5]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createJournal } from '../src/knowledge-journal.ts';
import { runKnowledgeReview } from '../src/knowledge-review.ts';
import { recordKnowledgeUse } from '../src/knowledge-usage.ts';
import { createMeetingRuns } from '../src/meeting-runs.ts';
import { proofProfile } from './proof-fixture.ts';

const { values: args } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' } } });
if (!args.from || !args.out) throw new Error('--from <results.json> and --out <dir> are needed');
const out = resolve(args.out);
const cases = (JSON.parse(readFileSync(new URL('./proof-cases.json', import.meta.url), 'utf8')) as { cases: { id: string; text: string }[] }).cases;
const results = (JSON.parse(readFileSync(resolve(args.from), 'utf8')) as { results: { id: string; arm: string; run: number; reply: string; cited?: string[]; missing?: string[]; error?: string }[] }).results
  .filter((result) => result.arm === 'after' && result.run === 1 && !result.error);

const { dir, profileDir } = proofProfile(true, join(homedir(), '.local/share/serra-evals/kb-live'));
try {
  createJournal(join(profileDir, 'knowledge')).seed();
  const now = new Date();
  // The week: one reply per case, spread over the last six days, as the bot would have recorded them.
  results.forEach((result, at) => recordKnowledgeUse(profileDir, {
    at: new Date(now.getTime() - ((at % 6) + 1) * 86_400_000 + at * 60_000).toISOString(), runId: `demo-${result.id}`, visibility: 'team',
    cited: result.cited ?? [], offered: 40, request: cases.find((item) => item.id === result.id)?.text ?? result.id,
    reply: result.reply.replace(/\s+/g, ' ').trim().slice(0, 400), ...(result.missing?.length ? { missing: result.missing } : {}),
  }));
  const runs = createMeetingRuns({ t3Bin: process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3'), ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) });
  const review = await runKnowledgeReview({ profileDir, knowledgeDir: join(profileDir, 'knowledge'), ask: runs.ask, now });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
  cpSync(join(profileDir, 'knowledge/proposals'), join(out, 'proposals'), { recursive: true });
  cpSync(join(profileDir, 'logs/knowledge-usage.jsonl'), join(out, 'week.jsonl'));
  console.log(JSON.stringify({ summary: review.summary, suggestions: review.suggestions.map((item) => `${item.kind} ${item.page}`), examples: review.examples.map((item) => item.page), missing: review.missing, error: review.error ?? null }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
