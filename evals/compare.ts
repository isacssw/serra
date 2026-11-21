// Compares live eval results case by case, pooling several result files per side.
//
//   node evals/compare.ts --before baseline,step2-approval --after final [--out evals/results/compare.md]
//
// Each case counts once: its score on each side is the mean of its runs there. A category's change is the mean of its
// cases' changes, with a margin of two standard errors of that mean across cases (paired: the same case before and
// after). Runs of one case are not independent evidence, so they never shrink the margin. The table also says how many
// cases got better or worse by more than 0.1, and how many were already at full marks before (they can't show a gain).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const root = new URL('..', import.meta.url).pathname;
const { values: args } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' } } });
if (!args.before || !args.after) throw new Error('Pass --before and --after: comma-separated result labels.');

interface Result { id: string; category: string; score: number; error?: string }
const load = (labels: string): Result[] => labels.split(',').flatMap((label) =>
  (JSON.parse(readFileSync(join(root, 'evals/results', `${label}.json`), 'utf8')) as { results: Result[] }).results.filter((result) => !result.error));

const byCase = (results: Result[]): Map<string, { category: string; mean: number; runs: number }> => {
  const cases = new Map<string, { category: string; total: number; runs: number }>();
  for (const result of results) {
    const entry = cases.get(result.id) ?? { category: result.category, total: 0, runs: 0 };
    entry.total += result.score; entry.runs += 1;
    cases.set(result.id, entry);
  }
  return new Map([...cases].map(([id, { category, total, runs }]) => [id, { category, mean: total / runs, runs }]));
};

const before = byCase(load(args.before));
const after = byCase(load(args.after));
const paired = [...before].filter(([id]) => after.has(id)).map(([id, b]) => ({ id, category: b.category, before: b.mean, after: after.get(id)!.mean }));

const summarize = (name: string, cases: typeof paired): string => {
  const n = cases.length;
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  const deltas = cases.map((c) => c.after - c.before);
  const delta = mean(deltas);
  const sd = Math.sqrt(deltas.reduce((sum, d) => sum + (d - delta) ** 2, 0) / Math.max(n - 1, 1));
  const margin = 2 * sd / Math.sqrt(Math.max(n, 1));
  const better = deltas.filter((d) => d > 0.1).length;
  const worse = deltas.filter((d) => d < -0.1).length;
  const ceiling = cases.filter((c) => c.before >= 0.999).length;
  const verdict = n < 2 ? 'too few cases' : Math.abs(delta) <= margin ? 'within noise' : delta > 0 ? 'better' : 'worse';
  const pct = (value: number): string => (100 * value).toFixed(0);
  return `| ${name} | ${n} | ${pct(mean(cases.map((c) => c.before)))} | ${pct(mean(cases.map((c) => c.after)))} | ${delta >= 0 ? '+' : ''}${pct(delta)} ±${pct(margin)} | ${better} / ${worse} | ${ceiling} | ${verdict} |`;
};

const categories = [...new Set(paired.map((c) => c.category))];
const lines = [
  `Before: ${args.before}. After: ${args.after}. ${paired.length} cases, each counted once (the mean of its runs).`, '',
  '| Category | Cases | Before | After | Change ±2 SE | Better / worse | At 100 before | Verdict |', '|---|---|---|---|---|---|---|---|',
  ...categories.map((category) => summarize(category, paired.filter((c) => c.category === category))),
  summarize('**overall**', paired),
  '', 'Cases that moved by more than 0.1:', '',
  ...paired.filter((c) => Math.abs(c.after - c.before) > 0.1).map((c) => `- ${c.id}: ${(100 * c.before).toFixed(0)} → ${(100 * c.after).toFixed(0)}`),
];
console.log(lines.join('\n'));
if (args.out) writeFileSync(join(root, args.out), lines.join('\n') + '\n');
