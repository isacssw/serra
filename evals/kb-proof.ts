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
import { ensureProject, showThread, startFolderThread } from '../src/t3.ts';
import { isRecord } from '../src/lib/guards.ts';
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
    concurrency: { type: 'string', default: '8' },
    out: { type: 'string' },
    regrade: { type: 'boolean', default: false },
  },
});
const t3Bin = process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3');
const project = join(homedir(), '.local/share/serra-evals/kb-live');
type Arm = 'none' | 'before' | 'after';
const arms = args.arms!.split(',') as Arm[];
if (arms.includes('before') && !args.before) throw new Error('--before <checkout of main> is needed for the "before" arm');

interface Case extends EvalCase { id: string; category: string; include: string[]; exclude?: string[]; judge?: string }
const cases = (JSON.parse(readFileSync(join(root, 'evals/proof-cases.json'), 'utf8')) as { cases: Case[] }).cases
  .filter((item) => !args.only || args.only.split(',').includes(item.id));

// --- Runs through T3 ------------------------------------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** One T3 run of `brief`, followed to its end; its final answer, and what it ran on. Provider failures throw. */
const runT3 = async (title: string, brief: string): Promise<{ answer: string; ranOn: string; link: string }> => {
  const threadId = await startFolderThread({ project, title, brief, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) }, t3Bin);
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    await sleep(5000);
    const { thread } = await showThread(threadId, t3Bin, 2);
    if (thread.status === 'failed') throw new Error(`T3 run failed (provider error): ${thread.link}`);
    if ((thread.pendingRequestCount ?? 0) > 0) return { answer: '(the run stopped to ask a question instead of answering)', ranOn: ranOnOf(threadId), link: thread.link };
    if (thread.activeRunId === null && thread.latestRunId !== null) {
      // Wait until the run's last message stops changing: some providers post a preamble before the answer.
      let last = '';
      for (let tries = 0; tries < 6; tries += 1) {
        await sleep(2500);
        const { messages } = await showThread(threadId, t3Bin, 30);
        const text = messages.findLast((message) => message.role === 'assistant' && message.runId === thread.latestRunId)?.text ?? '';
        if (text && text === last) break;
        last = text;
      }
      return { answer: last, ranOn: ranOnOf(threadId), link: thread.link };
    }
    if (Date.now() > deadline) throw new Error(`T3 run timed out: ${thread.link}`);
  }
};

const ranOnOf = (threadId: string): string => {
  try {
    const raw = execFileSync(t3Bin, ['thread', 'show', '--json', threadId], { encoding: 'utf8' });
    const value: unknown = JSON.parse(raw.slice(raw.indexOf('{')));
    const thread = isRecord(value) && isRecord(value.thread) ? value.thread : null;
    return thread && typeof thread.providerInstanceId === 'string' ? `${thread.providerInstanceId} ${typeof thread.model === 'string' ? thread.model : ''}`.trim() : 'unknown';
  } catch { return 'unknown'; }
};

/** Three grader runs, majority wins (the middle score): one grader's off answer can't fail a right reply. */
const judge = async (rubric: string, question: string, reply: string): Promise<number | null> => {
  const scores = (await Promise.all([0, 1, 2].map(() => judgeOnce(rubric, question, reply).catch(() => null)))).filter((score): score is number => score !== null).sort((a, b) => a - b);
  return scores.length === 0 ? null : scores[Math.floor((scores.length - 1) / 2)]!;
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
  'payload-retention': ['product/privacy.md'], 'sandbox-reset': ['product/sandbox.md'], flags: ['product/release-policy.md'], jpy: ['product/currencies.md'],
  'release-day': ['owner/working-style.md'], 'rate-limit': ['product/plans.md'], handover: ['workflows/rota-changes.md'], 'friday-release': ['owner/working-style.md'],
  'pr-limit': ['owner/working-style.md'], 'fx-time': ['product/treasury.md'], 'pr-size': ['owner/working-style.md'], dana: ['people/dana.md'], 'priya-style': ['people/priya.md'], 'pdf-cache': ['product/invoices.md'],
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
  const { dir, profileDir } = proofProfile(arm !== 'none', project);
  let brief = '';
  const base = { id: item.id, category: item.category, arm, run, pass: false, regex: false, score: null, reply: '', ranOn: 'unknown' };
  try {
    brief = await (await builder(arm))(profileDir, item);
    const { answer, ranOn } = await runT3(`Serra KB proof: ${item.id} (${arm})`, brief);
    const { reply, cited, missing } = takeKnowledgeUsed(answer);
    const regex = item.include.every((pattern) => new RegExp(pattern, 'iu').test(reply)) && !(item.exclude ?? []).some((pattern) => new RegExp(pattern, 'iu').test(reply));
    const score = item.judge ? await judge(item.judge, item.text, reply).catch(() => null) : null;
    // A grader run that failed says nothing about the reply: a harness error, not a fail.
    if (item.judge && score === null) throw new Error('the grading run failed');
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
      const score = item.judge ? await judge(item.judge, item.text, result.reply) : null;
      regraded.push(item.judge && score === null ? { ...result, error: 'the grading run failed' } : { ...result, regex, score, pass: regex && (item.judge ? score === 2 : true) });
    }
  }));
  results.push(...regraded);
} else {
if (!existsSync(project)) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Scratch project for Serra\'s knowledge evals\n\nNothing here is real.\n');
}
await ensureProject(project, 'Serra KB evals', t3Bin);
const jobs = cases.flatMap((item) => arms.flatMap((arm) => Array.from({ length: Number(args.runs) }, (_, run) => () => runOne(item, arm, run + 1))));
let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < jobs.length) {
    const result = await jobs[next++]!();
    results.push(result);
    process.stderr.write(`${result.error ? 'ERR ' : result.pass ? 'pass' : 'FAIL'}  ${result.arm.padEnd(6)} ${result.id} #${result.run}${result.error ? ` ${result.error}` : ''}\n`);
  }
}));
}

const pct = (part: number, whole: number): string => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const done = (arm: Arm, filter: (result: Result) => boolean = () => true) => results.filter((result) => result.arm === arm && !result.error && filter(result));
const categories = [...new Set(cases.map((item) => item.category))];
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
  args.regrade ? `Replies from the original run (its code is in summary.md); graded again at ${commit(root)} with three grader runs per rubric, every arm alike.` : `Code: after = ${commit(root)}${arms.includes('before') ? `, before = ${commit(resolve(args.before!))}` : ''}.`, '',
  `${new Date().toISOString().slice(0, 10)}. Through Serra's T3 layer on ${[...new Set(results.map((result) => result.ranOn))].join(', ')}. ${cases.length} cases × ${args.runs} runs per arm. ${results.filter((result) => result.error).length} run(s) failed in the harness and are left out (listed in the arm folders).`, '',
  `| Arm | Runs | Pass | 95% interval | ${categories.join(' | ')} | Named the answer's page |`, `|---|---|---|---|${categories.map(() => '---').join('|')}|---|`,
  ...arms.map((arm) => `| ${arm} | ${done(arm).length} | ${pct(done(arm, (result) => result.pass).length, done(arm).length)} | ${wilson(done(arm, (result) => result.pass).length, done(arm).length)} | ${categories.map((category) => pct(done(arm, (result) => result.category === category && result.pass).length, done(arm, (result) => result.category === category).length)).join(' | ')} | ${arm === 'before' || arm === 'none' ? '–' : pct(cites(arm).filter((result) => result.cited!.some((path) => (ANSWER_PAGE[result.id] ?? []).includes(path))).length, cites(arm).length)} |`),
  '', '| Case | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---').join('|') + '|',
  ...cases.map((item) => `| ${item.id} | ${arms.map((arm) => {
    const runs = results.filter((result) => result.id === item.id && result.arm === arm).sort((a, b) => a.run - b.run);
    return runs.map((result) => (result.error ? 'err' : result.pass ? '✓' : '✗')).join(' ');
  }).join(' | ')} |`),
];
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, args.regrade ? 'summary-regraded.md' : 'summary.md'), `${lines.join('\n')}\n`);
writeFileSync(join(outDir, args.regrade ? 'results-regraded.json' : 'results.json'), `${JSON.stringify({ args, results }, null, 2)}\n`);
console.log(lines.join('\n'));
