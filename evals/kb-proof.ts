// The before/after proof: one fixed set of cases (evals/proof-cases.json), one invented owner whose notes have grown
// messy (Robin, eight months on), three arms, every run through Serra's own T3 layer:
//
//   none    no knowledge at all: what a model can do without the owner's notes (the floor)
//   before  the briefs `main` builds (Serra's code at --before, default a checkout of main)
//   after   the briefs this checkout builds
//
// Each reply is graded on the case's regexes and, where it has one, a rubric a second T3 run scores 0-2. Every run's
// brief, reply and grade are saved, so nothing is cherry-picked: results/<label>/<arm>/<case>-<run>.md, plus a summary.
//
//   git worktree add /tmp/serra-main <main sha> && ln -s "$PWD/node_modules" /tmp/serra-main/node_modules
//   node evals/kb-proof.ts --label proof --runs 3 --before /tmp/serra-main [--provider codex --model gpt-6.1-sol] [--out <dir>]
//
// Needs T3 Code running. Invented owner and people only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { takeKnowledgeUsed } from '../src/knowledge-usage.ts';
import { ensureProject } from '../src/t3.ts';
import { createEvalRunner, MAX_RUNNING } from './t3-hygiene.ts';
import { listQuestions } from '../src/t3-questions.ts';
import type { EvalCase } from './capture.ts';
import { proofProfile } from './proof-fixture.ts';

const root = new URL('..', import.meta.url).pathname;
const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'proof' },
    runs: { type: 'string', default: '3' },
    before: { type: 'string' },
    arms: { type: 'string', default: 'none,before,after' },
    provider: { type: 'string' },
    model: { type: 'string' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    out: { type: 'string' },
    regrade: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
  },
});
const t3Bin = process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3');
const project = join(homedir(), '.local/share/serra-evals/kb-live');
type Arm = 'none' | 'before' | 'after';
const arms = args.arms!.split(',') as Arm[];
if (arms.includes('before') && !args.before) throw new Error('--before <checkout of main> is needed for the "before" arm');

interface Case extends EvalCase { id: string; category: string; include: string[]; exclude?: string[]; judge?: string }
const allCases = (JSON.parse(readFileSync(join(root, 'evals/proof-cases.json'), 'utf8')) as { cases: Case[] }).cases;
const cases = allCases.filter((item) => !args.only || args.only.split(',').includes(item.id));
// A regrade with --only grades those cases again and keeps every other result as it was; the summary shows them all.
const shown = args.regrade ? allCases : cases;

// --- Runs through T3 ------------------------------------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** One T3 run of `brief`, followed to its end; its final answer, and what it ran on. Provider failures throw. */
// Every thread goes through the self-settling runner: approval-required, at most three at once, settled once its
// answer is saved (also on failure), and swept at the end (evals/t3-hygiene.ts).
const runner = createEvalRunner({ bin: t3Bin, project, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) });

/** What a worker that stopped is asking: its questions as text, or nothing when it stopped for a tool approval. */
const questionText = async (threadId: string): Promise<string> => (await listQuestions(threadId, t3Bin))
  .flatMap((request) => request.questions.map((question) => [question.question, ...question.options.map((option) => `${option.label} ${option.description}`)].join(' '))).join('\n');

/**
 * One T3 run of `brief`: its final answer, and what it ran on. A worker that stops to ask the owner a question answers
 * with that question (graded like any reply). One that stops for a tool approval says nothing about its brief: eval
 * threads run approval-required, so that is a harness error, never a fail, in every arm alike.
 */
const runT3 = async (title: string, brief: string): Promise<{ answer: string; ranOn: string; link: string }> => {
  const run = await runner.run(title, brief, { readAsk: questionText });
  if (run.asked && !run.answer) throw new Error(`stopped for a tool approval: ${run.link}`);
  return { answer: run.asked ? `(asked the owner) ${run.answer}` : run.answer, ranOn: run.ranOn, link: run.link };
};

/** Every arm's brief gets the same line: eval threads can read files but run no commands, so none waits on approval. */
const EVAL_NOTE = '\n\n(Eval note, the same in every run: read files with your file tools only; run no shell commands, and change nothing.)\n';

/** Three grader runs, majority wins (the middle score): one grader's off answer can't fail a right reply. */
const judge = async (rubric: string, question: string, reply: string): Promise<number | null> => {
  const scores = (await Promise.all([0, 1, 2].map(() => judgeOnce(rubric, question, reply).catch(() => null)))).filter((score): score is number => score !== null).sort((a, b) => a - b);
  return scores.length === 0 ? null : scores[Math.floor((scores.length - 1) / 2)]!;
};

/** The three-grader vote, tried up to three times while T3 is too busy to answer. */
const judgeWithRetry = async (rubric: string, question: string, reply: string): Promise<number | null> => {
  for (let tries = 0; tries < 3; tries += 1) {
    const score = await judge(rubric, question, reply);
    if (score !== null) return score;
    await sleep(15_000);
  }
  return null;
};

const judgeOnce = async (rubric: string, question: string, reply: string): Promise<number | null> => {
  const prompt = `You grade one reply from an assistant. Don't open any file or run anything. Answer with one line: SCORE: 0, 1 or 2.\n\nRubric: ${rubric}\n\nQuestion:\n${question}\n\nReply:\n${reply}`;
  const { answer } = await runT3('Serra KB proof: grade', prompt);
  const score = /SCORE:\s*([012])/i.exec(answer)?.[1];
  return score === undefined ? null : Number(score);
};

// --- One run ----------------------------------------------------------------------------------------------------
interface Result { id: string; category: string; arm: Arm; run: number; pass: boolean; regex: boolean; score: number | null; reply: string; ranOn: string; cited?: string[]; missing?: string[]; error?: string }

/** The page that holds each case's answer: a reply naming it shows its "used" line can be trusted. */
const ANSWER_PAGE: Record<string, string[]> = {
  priorities: ['owner/role.md'], friday: ['owner/role.md'], signoff: ['people/jonas.md', 'workflows/release.md'], scope: ['people/priya.md'],
  'release-steps': ['workflows/release.md'], incident: ['workflows/incident.md'], discount: ['owner/private-notes.md'], 'invoice-numbers': ['product/invoices.md'],
  'payload-retention': ['product/privacy.md'], 'payments-bugs': ['product/escalation.md'], 'usd-live': ['product/launches.md'], 'partial-refund': ['product/refund-rules.md'],
  'log-retention': ['product/observability.md'], 'rota-swap': ['workflows/rota-changes.md'], 'sandbox-reset': ['product/sandbox.md'], flags: ['product/release-policy.md'], jpy: ['product/currencies.md'],
  'release-day': ['owner/working-style.md'], 'rate-limit': ['product/plans.md'], handover: ['workflows/rota-changes.md'], 'friday-release': ['owner/working-style.md'],
  'pr-limit': ['owner/working-style.md'], 'fx-time': ['product/treasury.md'], 'pr-size': ['owner/working-style.md'], dana: ['people/dana.md'], 'priya-style': ['people/priya.md'], 'pdf-cache': ['product/invoices.md'],
  'event-bus': ['product/platform-notes.md'], 'go-sdk': ['product/platform-notes.md'], 'dashboards-tool': ['product/platform-notes.md'], 'refund-endpoint': ['product/platform-notes.md'],
  'status-page': ['workflows/november-planning.md'], changelog: ['workflows/november-planning.md'], 'new-dashboard': ['workflows/november-planning.md'],
  french: ['product/q4-updates.md'], 'dashboard-login': ['product/q4-updates.md'], 'kyc-docs': ['product/q4-updates.md'],
};

const builders = new Map<string, (profileDir: string, item: EvalCase) => Promise<string>>();
const builder = async (arm: Arm): Promise<(profileDir: string, item: EvalCase) => Promise<string>> => {
  const code = arm === 'before' ? resolve(args.before!) : root;
  if (!builders.has(code)) builders.set(code, ((await import(join(code, 'evals/capture.ts'))) as { buildBrief: (profileDir: string, item: EvalCase) => Promise<string> }).buildBrief);
  return builders.get(code)!;
};

const outDir = resolve(args.out ?? join(root, 'evals/results', args.label!));
const results: Result[] = [];
const save = (result: Result, brief: string): void => {
  const dir = join(outDir, result.arm);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${result.id}-${result.run}.md`), [
    `# ${result.id} · ${result.arm} · run ${result.run}`, '',
    `Ran on: ${result.ranOn}. ${result.error ? `Harness error: ${result.error}` : `Regexes ${result.regex ? 'held' : 'failed'}; judge ${result.score ?? '–'}; ${result.pass ? 'PASS' : 'FAIL'}.`}`, '',
    '## Reply', '', result.reply || '(none)', '', '## Brief', '', '```', brief.replaceAll(/\/(?:private\/)?(?:var|tmp)\/[^\s`)]*serra-kb-proof-[^/\s`)]+/g, '<scratch>'), '```', '',
  ].join('\n'));
};

const runOne = async (item: Case, arm: Arm, run: number): Promise<Result> => {
  const { dir, profileDir } = proofProfile(arm !== 'none', project, join(project, 'runs'));
  let brief = '';
  const base = { id: item.id, category: item.category, arm, run, pass: false, regex: false, score: null, reply: '', ranOn: 'unknown' };
  try {
    brief = `${await (await builder(arm))(profileDir, item)}${EVAL_NOTE}`;
    const { answer, ranOn } = await runT3(`Serra KB proof: ${item.id} (${arm})`, brief);
    const { reply, cited, missing } = takeKnowledgeUsed(answer);
    const regex = item.include.every((pattern) => new RegExp(pattern, 'iu').test(reply)) && !(item.exclude ?? []).some((pattern) => new RegExp(pattern, 'iu').test(reply));
    // A reply that fails its regexes fails, whatever a grader would say; graders only decide the rest.
    const score = item.judge && regex ? await judgeWithRetry(item.judge, item.text, reply) : null;
    // A grader that failed three times over says nothing about the reply: a harness error, not a fail.
    if (item.judge && regex && score === null) throw new Error('the grading run failed');
    const result = { ...base, regex, score, reply, ranOn, cited, missing, pass: regex && (item.judge ? score === 2 : true) };
    save(result, brief);
    return result;
  } catch (error) {
    const result = { ...base, error: error instanceof Error ? error.message : String(error) };
    save(result, brief);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// --regrade: grade the replies a run already saved again with today's cases and graders, every arm alike, and write
// summary-regraded.md beside the original summary. Nothing is re-asked; only the grading changes.
if (args.regrade) {
  const saved = (JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as { results: Result[] }).results;
  const regraded: Result[] = [];
  let at = 0;
  await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
    while (at < saved.length) {
      const result = saved[at++]!;
      const item = cases.find((candidate) => candidate.id === result.id);
      if (!item || result.error) { regraded.push(result); continue; }
      const regex = item.include.every((pattern) => new RegExp(pattern, 'iu').test(result.reply)) && !(item.exclude ?? []).some((pattern) => new RegExp(pattern, 'iu').test(result.reply));
      const score = item.judge && regex ? await judgeWithRetry(item.judge, item.text, result.reply) : null;
      regraded.push(item.judge && regex && score === null ? { ...result, error: 'the grading run failed' } : { ...result, regex, score, pass: regex && (item.judge ? score === 2 : true) });
    }
  }));
  results.push(...regraded);
} else {
if (!existsSync(project)) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Scratch project for Serra\'s knowledge evals\n\nNothing here is real.\n');
}
await ensureProject(project, 'Serra KB evals', t3Bin);
// Results are saved as they come (partial.json), so a run cut short loses nothing; --resume carries on from there.
const partial = join(outDir, 'partial.json');
const earlier: Result[] = args.resume && existsSync(partial) ? (JSON.parse(readFileSync(partial, 'utf8')) as { results: Result[] }).results
  // Runs that stopped for an approval were once counted as fails: they run again.
  .filter((result) => !result.error && !result.reply.startsWith('(the run stopped')) : [];
results.push(...earlier);
const jobs = cases.flatMap((item) => arms.flatMap((arm) => Array.from({ length: Number(args.runs) }, (_, run) => run + 1)
  .filter((run) => !earlier.some((result) => result.id === item.id && result.arm === arm && result.run === run))
  .map((run) => () => runOne(item, arm, run))));
let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < jobs.length) {
    const result = await jobs[next++]!();
    results.push(result);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(partial, `${JSON.stringify({ args, results }, null, 2)}\n`);
    process.stderr.write(`${result.error ? 'ERR ' : result.pass ? 'pass' : 'FAIL'}  ${result.arm.padEnd(6)} ${result.id} #${result.run}${result.error ? ` ${result.error}` : ''}\n`);
  }
}));
}

// Nothing left behind: every thread this run made is settled, and any leftover in the project too.
const swept = await runner.sweep();
runner.close();
process.stderr.write(`T3 hygiene: ${swept.settled} leftover thread(s) settled at the end; ${swept.left} unsettled in the evals project.\n`);

const pct = (part: number, whole: number): string => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const done = (arm: Arm, filter: (result: Result) => boolean = () => true) => results.filter((result) => result.arm === arm && !result.error && filter(result));
const categories = [...new Set(shown.map((item) => item.category))];
const commit = (code: string): string => { try { return execFileSync('git', ['-C', code, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
/** A 95% Wilson interval for a pass rate, so a small gap reads as what it is. */
const wilson = (passes: number, runs: number): string => {
  if (runs === 0) return '–';
  const z = 1.96; const p = passes / runs; const d = 1 + (z * z) / runs;
  const centre = (p + (z * z) / (2 * runs)) / d; const half = (z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs))) / d;
  return `${Math.round(100 * Math.max(0, centre - half))}–${Math.round(100 * Math.min(1, centre + half))}%`;
};
const cites = (arm: Arm) => done(arm, (result) => (result.cited?.length ?? 0) > 0);
const lines = [
  `# Knowledge before/after proof: ${args.label}`, '',
  `Runs that stopped for a tool approval (harness errors, left out): ${arms.map((arm) => `${arm} ${results.filter((result) => result.arm === arm && result.error?.startsWith('stopped for a tool approval')).length}`).join(', ')}.`, '',
  `T3 hygiene: every eval thread ran approval-required, at most ${MAX_RUNNING} at once, and was settled once its answer was saved; ${swept.left} unsettled thread(s) left in the evals project at the end.`, '',
  args.regrade ? `Replies from the original run (its code is in summary.md); graded again at ${commit(root)} with three grader runs per rubric, every arm alike.` : `Code: after = ${commit(root)}${arms.includes('before') ? `, before = ${commit(resolve(args.before!))}` : ''}.`, '',
  `${new Date().toISOString().slice(0, 10)}. Through Serra's T3 layer on ${[...new Set(results.map((result) => result.ranOn))].join(', ')}. ${shown.length} cases × ${args.runs} runs per arm. ${results.filter((result) => result.error).length} run(s) failed in the harness and are left out (listed in the arm folders).`, '',
  `| Arm | Runs | Pass | 95% interval | Worst case (errors count as fails) | ${categories.join(' | ')} | Named the answer's page (of all runs) |`, `|---|---|---|---|---|${categories.map(() => '---').join('|')}|---|`,
  ...arms.map((arm) => `| ${arm} | ${done(arm).length} | ${pct(done(arm, (result) => result.pass).length, done(arm).length)} | ${wilson(done(arm, (result) => result.pass).length, done(arm).length)} | ${pct(done(arm, (result) => result.pass).length, results.filter((result) => result.arm === arm).length)} | ${categories.map((category) => pct(done(arm, (result) => result.category === category && result.pass).length, done(arm, (result) => result.category === category).length)).join(' | ')} | ${arm === 'before' || arm === 'none' ? '–' : pct(cites(arm).filter((result) => result.cited!.some((path) => (ANSWER_PAGE[result.id] ?? []).includes(path))).length, done(arm).length)} |`),
  '', '| Case | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---').join('|') + '|',
  ...shown.map((item) => `| ${item.id} | ${arms.map((arm) => {
    const runs = results.filter((result) => result.id === item.id && result.arm === arm).sort((a, b) => a.run - b.run);
    return runs.map((result) => (result.error ? 'err' : result.pass ? '✓' : '✗')).join(' ');
  }).join(' | ')} |`),
];
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, args.regrade ? 'summary-regraded.md' : 'summary.md'), `${lines.join('\n')}\n`);
writeFileSync(join(outDir, args.regrade ? 'results-regraded.json' : 'results.json'), `${JSON.stringify({ args, results }, null, 2)}\n`);
console.log(lines.join('\n'));
