// Prints the knowledge-quality numbers the PR and docs quote: relevance on both fixtures (with the same ranker on
// index rows alone for comparison), the health check on the clean fixtures, and six months of the growth simulation.
// Deterministic, no model, no network: `node evals/kb-health.ts`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simulateGrowth } from './kb-growth-sim.ts';
import { assessKnowledge, knowledgeHistory, pageCards, rankPages, type KnowledgeFile } from '../src/knowledge-health.ts';

const root = new URL('..', import.meta.url).pathname;
const tree = (dir: string, relativeDir = ''): KnowledgeFile[] => readdirSync(join(dir, relativeDir), { withFileTypes: true }).flatMap((entry) => {
  const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return entry.name === 'proposals' ? [] : tree(dir, path);
  return entry.name.endsWith('.md') ? [{ path, text: readFileSync(join(dir, path), 'utf8') }] : [];
});
const pct = (value: number): string => `${Math.round(value * 100)}%`;

const { fixtures, none } = JSON.parse(readFileSync(join(root, 'evals/retrieval-cases.json'), 'utf8')) as { fixtures: Record<string, { request: string; pages: string[] }[]>; none: { requests: string[] } };
console.log('## Relevance hint\n\nTop 1 / top 3: a right page first / among the three named. Precision: of the requests that got a hint, how many named a right page. No-page hints: of the requests no page helps with, how many still got one.\n');
console.log('| Fixture | Cases | Top 1 | Top 3 | Hinted | Precision | No-page hints | Misses |\n|---|---|---|---|---|---|---|---|');
for (const [dir, cases] of Object.entries(fixtures)) {
  const files = tree(join(root, dir));
  const cards = pageCards(files.find((file) => file.path === 'index.md')!.text, files);
  const runs = cases.map((item) => {
    const ranked = rankPages(item.request, cards).map((page) => page.path);
    return { item, ranked, top1: item.pages.includes(ranked[0] ?? ''), top3: ranked.some((path) => item.pages.includes(path)) };
  });
  const hinted = runs.filter((run) => run.ranked.length > 0);
  const falseHints = none.requests.filter((request) => rankPages(request, cards).length > 0).length;
  const misses = runs.filter((run) => !run.top3).map((run) => `"${run.item.request}"${run.ranked.length ? ` → ${run.ranked[0]}` : ' (no hint)'}`).join('; ');
  console.log(`| ${dir} | ${cases.length} | ${pct(runs.filter((run) => run.top1).length / runs.length)} | ${pct(runs.filter((run) => run.top3).length / runs.length)} | ${pct(hinted.length / runs.length)} | ${pct(hinted.filter((run) => run.top3).length / Math.max(1, hinted.length))} | ${falseHints} of ${none.requests.length} | ${misses || 'none'} |`);
}

console.log('\n## Health of the clean fixtures\n');
for (const dir of Object.keys(fixtures)) {
  const health = assessKnowledge(tree(join(root, dir)), new Date('2026-11-25T00:00:00Z'));
  console.log(`- ${dir}: ${health.score}/100, ${health.pages} pages, ${health.facts} facts, ${health.issues.length} issues`);
}

const sim = simulateGrowth();
console.log('\n## Growth simulation (six months, real approval code)\n\n| Stage | Score | Pages | Facts | Conflicts | Repeats | Stale |\n|---|---|---|---|---|---|---|');
for (const stage of sim.stages) {
  const health = assessKnowledge(stage.files, new Date(stage.at));
  const count = (kinds: string[]) => health.issues.filter((issue) => kinds.includes(issue.kind)).length;
  console.log(`| ${stage.label} (${stage.at.slice(0, 10)}) | ${health.score} | ${health.pages} | ${health.facts} | ${count(['conflict'])} | ${count(['duplicate', 'overlap'])} | ${health.stale} |`);
}
const history = knowledgeHistory(sim.files, sim.changes, sim.now);
console.log(`\nScore by week: ${history.points.map((point) => `${point.at.slice(5, 10)} ${point.score}`).join(', ')}`);
