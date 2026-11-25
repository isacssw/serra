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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { takeKnowledgeUsed } from '../src/knowledge-usage.ts';
import { ensureProject, showThread, startFolderThread } from '../src/t3.ts';
import { isRecord } from '../src/lib/guards.ts';
import type { EvalCase } from './capture.ts';

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

// --- The owner, eight months on -------------------------------------------------------------------------------
const header = (type: string, description: string, verified: string): string =>
  `---\ntype: ${type}\ndescription: ${description}\naudience: team\nwritten: ${verified}\nverified: ${verified}\nsources:\n  - Robin, ${verified}\n---\n\n`;
const DISTRACTORS: [string, string, string][] = [
  ['payouts', 'Merchant payouts', '- Payouts run daily at 04:00 UTC to the merchant\'s settlement account.\n- A failed payout retries the next day.'],
  ['disputes', 'Card disputes', '- Disputes arrive from the acquirer; evidence is due within 7 days.\n- The disputes queue is in the admin console.'],
  ['kyc', 'Merchant onboarding checks', '- New merchants pass KYC before their first payout.\n- KYC documents are kept by the compliance team.'],
  ['ledger', 'The internal ledger', '- Every money movement is a double-entry pair.\n- Ledger entries are immutable; corrections are new entries.'],
  ['reporting', 'Finance reporting', '- Month-end reports go to finance on the second working day.\n- Reports come from the ledger, not the API.'],
  ['search', 'Admin search', '- Admin search indexes merchants and invoices, refreshed every 5 minutes.'],
  ['emails', 'Merchant emails', '- Transactional emails go through the mail service; templates live with product.'],
  ['localisation', 'Localisation', '- The dashboard is in English, Portuguese and German.'],
  ['status-page', 'The status page', '- Incidents are posted on the public status page by Jonas.'],
  ['access', 'Admin access', '- Production admin access needs a ticket and expires after 8 hours.'],
  ['backups', 'Database backups', '- Databases are backed up hourly and kept for 35 days.'],
  ['load-tests', 'Load tests', '- Load tests run in the perf environment on Wednesday nights.'],
  ['partners', 'Partner integrations', '- Partner integrations use their own API keys and lower rate limits.'],
  ['pricing', 'Merchant pricing', '- Pricing is set by sales; engineering never quotes prices.'],
  ['roadmap', 'Public roadmap', '- The public roadmap is updated by product each quarter.'],
];
const ROWS: [string, string, string][] = [
  ['pricing plans or packaging', 'product/plans.md', 'Plans and packaging for sales'],
  ['rota changes', 'workflows/rota-changes.md', 'Changes to how the team works'],
  ...DISTRACTORS.map(([name, description]): [string, string, string] => [description.toLowerCase(), `product/${name}.md`, description]),
];

/** A scratch profile with Robin's knowledge as it is now (or none), for one run. */
const scratch = (withKnowledge: boolean): { dir: string; profileDir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-kb-proof-'));
  const profileDir = join(dir, 'profile');
  const knowledge = join(profileDir, 'knowledge');
  cpSync(join(root, 'evals/fixture/knowledge'), knowledge, { recursive: true });
  if (!withKnowledge) {
    // No notes: the shipped empty index and nothing else.
    rmSync(knowledge, { recursive: true, force: true });
    cpSync(join(root, 'templates/knowledge'), knowledge, { recursive: true });
  } else {
    const style = join(knowledge, 'owner/working-style.md');
    writeFileSync(style, readFileSync(style, 'utf8').replace('- A bug fix starts with a failing test.', '- A bug fix starts with a failing test.\n- Risky releases ship on Thursday now (since 2026-10-01), never Friday.'));
    const oncall = join(knowledge, 'product/oncall.md');
    writeFileSync(oncall, readFileSync(oncall, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-05-01'));
    const limits = join(knowledge, 'product/rate-limits.md');
    writeFileSync(limits, readFileSync(limits, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-06-01'));
    writeFileSync(join(knowledge, 'product/plans.md'), `${header('product', 'Plans and packaging for sales', '2026-10-20')}# Plans\n\n- Standard and Plus plans; Plus adds priority support.\n- The API rate limit is 250 requests per second per merchant on every plan.\n`);
    writeFileSync(join(knowledge, 'workflows/rota-changes.md'), `${header('process', 'Changes to how the team works', '2026-11-10')}# Team changes\n\n- The on-call handover moved to Tuesday at 09:00.\n- Standup is async in #ledgerline-standup.\n`);
    for (const [name, description, body] of DISTRACTORS) writeFileSync(join(knowledge, `product/${name}.md`), `${header('product', description, '2026-11-01')}# ${description}\n\n${body}\n`);
    const index = join(knowledge, 'index.md');
    writeFileSync(index, `${readFileSync(index, 'utf8').trimEnd()}\n${ROWS.map(([when, path, gives]) => `| ${when} | \`${path}\` | ${gives} |`).join('\n')}\n`);
  }
  writeFileSync(join(profileDir, 'profile.json'), readFileSync(join(root, 'evals/fixture/profile.json'), 'utf8').replace('PROJECT_PATH', project));
  writeFileSync(join(profileDir, 'brief.md'), readFileSync(join(root, 'templates/brief.md'), 'utf8'));
  writeFileSync(join(profileDir, '.env'), 'SLACK_APP_TOKEN=xapp-eval\nSLACK_BOT_TOKEN=xoxb-eval\n');
  return { dir, profileDir };
};

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

const judge = async (rubric: string, question: string, reply: string): Promise<number | null> => {
  const prompt = `You grade one reply from an assistant. Don't open any file or run anything. Answer with one line: SCORE: 0, 1 or 2.\n\nRubric: ${rubric}\n\nQuestion:\n${question}\n\nReply:\n${reply}`;
  const { answer } = await runT3('Serra KB proof: grade', prompt);
  const score = /SCORE:\s*([012])/i.exec(answer)?.[1];
  return score === undefined ? null : Number(score);
};

// --- One run ----------------------------------------------------------------------------------------------------
interface Result { id: string; category: string; arm: Arm; run: number; pass: boolean; regex: boolean; score: number | null; reply: string; ranOn: string; error?: string }

const builders = new Map<string, (profileDir: string, item: EvalCase) => Promise<string>>();
const builder = async (arm: Arm): Promise<(profileDir: string, item: EvalCase) => Promise<string>> => {
  const code = arm === 'before' ? resolve(args.before!) : root;
  if (!builders.has(code)) builders.set(code, ((await import(join(code, 'evals/capture.ts'))) as { buildBrief: (profileDir: string, item: EvalCase) => Promise<string> }).buildBrief);
  return builders.get(code)!;
};

const outDir = resolve(args.out ?? join(root, 'evals/results', args.label!));
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
  const { dir, profileDir } = scratch(arm !== 'none');
  let brief = '';
  const base = { id: item.id, category: item.category, arm, run, pass: false, regex: false, score: null, reply: '', ranOn: 'unknown' };
  try {
    brief = await (await builder(arm))(profileDir, item);
    const { answer, ranOn } = await runT3(`Serra KB proof: ${item.id} (${arm})`, brief);
    const { reply } = takeKnowledgeUsed(answer);
    const regex = item.include.every((pattern) => new RegExp(pattern, 'iu').test(reply)) && !(item.exclude ?? []).some((pattern) => new RegExp(pattern, 'iu').test(reply));
    const score = item.judge ? await judge(item.judge, item.text, reply).catch(() => null) : null;
    // A grader run that failed says nothing about the reply: a harness error, not a fail.
    if (item.judge && score === null) throw new Error('the grading run failed');
    const result = { ...base, regex, score, reply, ranOn, pass: regex && (item.judge ? score === 2 : true) };
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

if (!existsSync(project)) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Scratch project for Serra\'s knowledge evals\n\nNothing here is real.\n');
}
await ensureProject(project, 'Serra KB evals', t3Bin);
const jobs = cases.flatMap((item) => arms.flatMap((arm) => Array.from({ length: Number(args.runs) }, (_, run) => () => runOne(item, arm, run + 1))));
const results: Result[] = [];
let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < jobs.length) {
    const result = await jobs[next++]!();
    results.push(result);
    process.stderr.write(`${result.error ? 'ERR ' : result.pass ? 'pass' : 'FAIL'}  ${result.arm.padEnd(6)} ${result.id} #${result.run}${result.error ? ` ${result.error}` : ''}\n`);
  }
}));

const pct = (part: number, whole: number): string => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const done = (arm: Arm, filter: (result: Result) => boolean = () => true) => results.filter((result) => result.arm === arm && !result.error && filter(result));
const categories = [...new Set(cases.map((item) => item.category))];
const lines = [
  `# Knowledge before/after proof: ${args.label}`, '',
  `${new Date().toISOString().slice(0, 10)}. Through Serra's T3 layer on ${[...new Set(results.map((result) => result.ranOn))].join(', ')}. ${cases.length} cases × ${args.runs} runs per arm. ${results.filter((result) => result.error).length} run(s) failed in the harness and are left out (listed in the arm folders).`, '',
  `| Arm | Runs | Pass | ${categories.join(' | ')} |`, `|---|---|---|${categories.map(() => '---').join('|')}|`,
  ...arms.map((arm) => `| ${arm} | ${done(arm).length} | ${pct(done(arm, (result) => result.pass).length, done(arm).length)} | ${categories.map((category) => pct(done(arm, (result) => result.category === category && result.pass).length, done(arm, (result) => result.category === category).length)).join(' | ')} |`),
  '', '| Case | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---').join('|') + '|',
  ...cases.map((item) => `| ${item.id} | ${arms.map((arm) => {
    const runs = results.filter((result) => result.id === item.id && result.arm === arm).sort((a, b) => a.run - b.run);
    return runs.map((result) => (result.error ? 'err' : result.pass ? '✓' : '✗')).join(' ');
  }).join(' | ')} |`),
];
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
writeFileSync(join(outDir, 'results.json'), `${JSON.stringify({ args, results }, null, 2)}\n`);
console.log(lines.join('\n'));
