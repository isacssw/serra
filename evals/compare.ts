// Compares live eval results, pooling several result files per side, with a rough margin per category.
//
//   node evals/compare.ts --before baseline,step2-approval --after step4-about-me [--out evals/results/compare.md]
//
// A category's score is the mean of every graded reply in it (0–100). The margin is two standard errors of that mean:
// a difference smaller than both margins together is noise. Runs vary a lot (two runs of byte-identical briefs moved
// one category 11 points), so pool runs before deciding anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const root = new URL('..', import.meta.url).pathname;
const { values: args } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' } } });
if (!args.before || !args.after) throw new Error('Pass --before and --after: comma-separated result labels.');

interface Result { id: string; category: string; score: number; error?: string }
const load = (labels: string): Result[] => labels.split(',').flatMap((label) =>
  (JSON.parse(readFileSync(join(root, 'evals/results', `${label}.json`), 'utf8')) as { results: Result[] }).results.filter((result) => !result.error));

const stats = (scores: number[]): { mean: number; margin: number; n: number } => {
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / Math.max(n - 1, 1);
  return { mean: 100 * mean, margin: 100 * 2 * Math.sqrt(variance / Math.max(n, 1)), n };
};

const before = load(args.before);
const after = load(args.after);
const categories = [...new Set(before.map((result) => result.category))];
const row = (name: string, a: Result[], b: Result[]): string => {
  const x = stats(a.map((r) => r.score)); const y = stats(b.map((r) => r.score));
  const delta = y.mean - x.mean;
  const verdict = Math.abs(delta) <= x.margin + y.margin ? 'within noise' : delta > 0 ? 'better' : 'worse';
  return `| ${name} | ${x.mean.toFixed(0)} ±${x.margin.toFixed(0)} | ${y.mean.toFixed(0)} ±${y.margin.toFixed(0)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(0)} | ${verdict} |`;
};
const lines = [
  `Before: ${args.before} (${before.length} replies). After: ${args.after} (${after.length} replies).`, '',
  '| Category | Before | After | Change | Verdict |', '|---|---|---|---|---|',
  ...categories.map((category) => row(category, before.filter((r) => r.category === category), after.filter((r) => r.category === category))),
  row('**overall**', before, after),
];
console.log(lines.join('\n'));
if (args.out) writeFileSync(join(root, args.out), lines.join('\n') + '\n');
