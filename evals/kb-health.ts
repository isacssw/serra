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

const { fixtures } = JSON.parse(readFileSync(join(root, 'evals/retrieval-cases.json'), 'utf8')) as { fixtures: Record<string, { request: string; pages: string[] }[]> };
console.log('## Relevance (right page in the top 1 / top 3)\n\n| Fixture | Cases | Pages + rows | Rows only | Misses |\n|---|---|---|---|---|');
for (const [dir, cases] of Object.entries(fixtures)) {
  const files = tree(join(root, dir));
  const cards = pageCards(files.find((file) => file.path === 'index.md')!.text, files);
  const rowsOnly = cards.map((card) => ({ ...card, body: '', headings: '' }));
  const run = (using: typeof cards) => cases.map((item) => {
    const ranked = rankPages(item.request, using).map((page) => page.path);
    return { item, top1: item.pages.includes(ranked[0] ?? ''), top3: ranked.some((path) => item.pages.includes(path)) };
  });
  const full = run(cards);
  const rows = run(rowsOnly);
  const share = (list: typeof full, key: 'top1' | 'top3') => list.filter((entry) => entry[key]).length / list.length;
  const misses = full.filter((entry) => !entry.top3).map((entry) => `"${entry.item.request}"`).join('; ');
  console.log(`| ${dir} | ${cases.length} | ${pct(share(full, 'top1'))} / ${pct(share(full, 'top3'))} | ${pct(share(rows, 'top1'))} / ${pct(share(rows, 'top3'))} | ${misses || 'none'} |`);
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
