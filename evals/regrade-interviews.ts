// Grades saved interview transcripts again with the current grader (interview-grade.ts), without rerunning them, and
// prints the pooled scores for each group of labels.
//
//   node evals/regrade-interviews.ts --group main=iv3-main-samples,iv3-main-nosamples,iv4-main --group new=iv2-new-samples,...
//
// A label whose name contains "nosamples" was run with the persona that declines voice samples.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gradeInterview, type InterviewScores } from './interview-grade.ts';

const root = new URL('..', import.meta.url).pathname;
const dir = join(root, 'evals/results/interviews');
const { values: args } = parseArgs({ options: { group: { type: 'string', multiple: true } } });

/** The proposals a transcript file lists after `## Proposals`, as `### <file>` sections. */
const proposalsOf = (text: string): { file: string; text: string }[] => {
  const after = text.split('\n## Proposals\n')[1] ?? '';
  return after.split(/^### /m).slice(1).map((section) => {
    const [file = '', ...rest] = section.split('\n');
    return { file: file.trim(), text: rest.join('\n').trim() + '\n' };
  });
};

const regrade = (label: string): InterviewScores[] => {
  const runs = readdirSync(dir).filter((name) => name.startsWith(`${label}-`) && /-\d+\.md$/.test(name)).sort();
  const scores = runs.map((name) => gradeInterview(proposalsOf(readFileSync(join(dir, name), 'utf8')), !label.includes('nosamples')));
  const json = join(root, 'evals/results', `${label}.json`);
  if (existsSync(json)) {
    const saved = JSON.parse(readFileSync(json, 'utf8')) as { run: number; scores: InterviewScores }[];
    saved.forEach((run, index) => { if (scores[index]) run.scores = scores[index]!; });
    writeFileSync(json, JSON.stringify(saved, null, 2) + '\n');
  }
  return scores;
};

const lines: string[] = [];
for (const group of args.group ?? []) {
  const [name, labels = ''] = group.split('=');
  const scores = labels.split(',').flatMap(regrade);
  const keys = Object.keys(scores[0] ?? {});
  const mean = (key: string): string => {
    const values = scores.map((s) => s[key]).filter((v): v is number => typeof v === 'number');
    return values.length ? `${Math.round((100 * values.reduce((a, b) => a + b, 0)) / values.length)} (${values.length})` : 'n/a';
  };
  lines.push(`${name}: ${scores.length} runs. ${keys.map((key) => `${key} ${mean(key)}`).join(', ')}`);
}
console.log(lines.join('\n'));
