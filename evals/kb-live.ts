// Does the knowledge reach the answer, through Serra's own T3 layer? Each knows-you case's brief is built by Serra's
// code (evals/capture.ts) on a scratch copy of an invented owner's profile, then run as a T3 thread on T3's default
// provider (or the one named), exactly the way a job starts (src/t3.ts). Two arms: the brief as it ships, and the same
// brief without the "closest pages" hint. Each reply is graded on the case's regexes, on whether it named the pages it
// used, and on whether T3's record of the run shows those pages were really opened.
//
//   node evals/kb-live.ts --label kb-r2 [--runs 1] [--provider codex --model gpt-6.1-sol] [--only id,id] [--concurrency 4]
//
// Needs T3 Code running. Runs are read-only by brief, in one scratch project folder Serra makes once
// (~/.local/share/serra-evals/kb-live). Results go to evals/results/<label>.{md,json} (git-ignored).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBrief, type EvalCase } from './capture.ts';
import { simulateGrowth } from './kb-growth-sim.ts';
import { takeKnowledgeUsed } from '../src/knowledge-usage.ts';
import { ensureProject, showThread, startFolderThread } from '../src/t3.ts';
import { openT3Session } from '../src/t3-session.ts';
import { listQuestions } from '../src/t3-questions.ts';
import { isRecord } from '../src/lib/guards.ts';

const root = new URL('..', import.meta.url).pathname;
const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'kb-live' },
    runs: { type: 'string', default: '1' },
    provider: { type: 'string' },
    model: { type: 'string' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    timeout: { type: 'string', default: '420' },
    set: { type: 'string', default: 'owners' },
  },
});
const t3Bin = process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3');

interface Case extends EvalCase { id: string; category: string; include?: string[]; exclude?: string[]; expected?: string[] }
const SETS = [
  { fixture: 'evals/fixture', cases: 'evals/cases.json' },
  { fixture: 'evals/fixture-heldout', cases: 'evals/cases-heldout.json' },
];
// Cases a regex can grade, from both owners; the held-out owner's were never used to tune anything here.
const ownerCases = SETS.flatMap((set) => (JSON.parse(readFileSync(join(root, set.cases), 'utf8')) as { cases: Case[] }).cases
  .filter((item) => item.include?.length && (!args.only || args.only.split(',').includes(item.id)))
  .map((item) => ({ ...item, fixture: set.fixture })));

// --set messy: the growth simulation's owner (Alex) at their messiest, before any tidy: two rules that disagree, a
// rule on two pages, every page stale. Arms: the brief as it ships, which marks the disagreeing rows, and without
// those marks. A right answer names the current rule and says the other exists, or asks.
const OWNER = 'UROBIN0001';
const messyCases: (Case & { fixture: string })[] = [
  { id: 'messy-release-day', category: 'conflict', via: 'dm', user: OWNER, text: 'which day do risky releases ship?', include: ['Thursday', 'Tuesday|disagree|conflict|confirm|two rules|both'], expected: ['owner/working-style.md', 'owner/releases.md'], fixture: 'messy' },
  { id: 'messy-pr-size', category: 'conflict', via: 'dm', user: OWNER, text: 'how big can a PR be before I should split it?', include: ['300|400', '(300[\\s\\S]*400|400[\\s\\S]*300)|disagree|conflict|confirm|two rules|both'], expected: ['owner/working-style.md'], fixture: 'messy' },
  { id: 'messy-webhook-retries', category: 'repeat', via: 'dm', user: OWNER, text: 'how many times do webhooks retry before we give up?', include: ['\\b5\\b|five'], expected: ['product/webhooks.md', 'product/webhook-retries.md'], fixture: 'messy' },
  { id: 'messy-priya', category: 'repeat', via: 'dm', user: OWNER, text: 'how does Priya like to get updates?', include: ['written|summary|numbers'], expected: ['people/priya.md', 'people/priya-nair.md'], fixture: 'messy' },
];
const cases = args.set === 'messy' ? messyCases.filter((item) => !args.only || args.only.split(',').includes(item.id)) : ownerCases;
const ARMS = args.set === 'messy' ? (['notes', 'no-notes'] as const) : (['hint', 'no-hint'] as const);
const messyStage = args.set === 'messy' ? simulateGrowth().stages.find((stage) => stage.label === 'Before tidying')! : null;

const project = join(homedir(), '.local/share/serra-evals/kb-live');
const HINT = /\n*Pages that look closest to this request, best first: [^\n]*\n*/;

interface Result {
  id: string; arm: 'hint' | 'no-hint' | 'notes' | 'no-notes'; run: number; expected: string[]; fixture: string; pass: boolean; named: string[]; opened: string[];
  hinted: string[]; error?: string; seconds: number; reply: string;
  /** The worker stopped to ask the owner instead of answering. */
  asked?: boolean;
  /** Pages the brief carried whole, in About me: naming one is honest without opening it. */
  carried: string[];
}

const scratch = (fixture: string): { dir: string; profileDir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-kb-live-'));
  const profileDir = join(dir, 'profile');
  if (fixture === 'messy') {
    for (const file of messyStage!.files) {
      mkdirSync(dirname(join(profileDir, 'knowledge', file.path)), { recursive: true });
      writeFileSync(join(profileDir, 'knowledge', file.path), file.text);
    }
  } else cpSync(join(root, fixture, 'knowledge'), join(profileDir, 'knowledge'), { recursive: true });
  const profile = readFileSync(join(root, fixture === 'messy' ? 'evals/fixture' : fixture, 'profile.json'), 'utf8').replace('PROJECT_PATH', project);
  writeFileSync(join(profileDir, 'profile.json'), fixture === 'messy' ? profile.replaceAll('Robin', 'Alex') : profile);
  writeFileSync(join(profileDir, 'brief.md'), readFileSync(join(root, 'templates/brief.md'), 'utf8'));
  writeFileSync(join(profileDir, '.env'), 'SLACK_APP_TOKEN=xapp-eval\nSLACK_BOT_TOKEN=xoxb-eval\n');
  return { dir, profileDir };
};

/** Every page path T3's record of the run shows a tool touching: what the worker really opened, whatever it says. */
const openedPages = async (threadId: string, runId: string, pages: string[]): Promise<string[]> => {
  const session = await openT3Session({ bin: t3Bin });
  try {
    const seen = new Set<string>();
    let after = -1;
    for (let page = 0; page < 30; page += 1) {
      const out = await session.call('t3_thread_read', { threadId, view: 'activity', afterPosition: after, limit: 100, maxCharsPerItem: 4000 });
      const items = Array.isArray(out.items) ? out.items.filter(isRecord) : [];
      for (const item of items) {
        // Tool work that finished: a command or file read. Not the brief, the worker's own words or its reasoning, and not a failed call.
        if (item.runId !== runId || /message|reasoning|checkpoint|plan/i.test(String(item.type)) || item.status !== 'completed' || item.title === 'Workspace ready') continue;
        const text = `${typeof item.title === 'string' ? item.title : ''} ${typeof item.text === 'string' ? item.text : ''}`;
        for (const path of pages) if (text.includes(path)) seen.add(path);
      }
      if (out.hasMore !== true || typeof out.nextPosition !== 'number' || out.nextPosition <= after) break;
      after = out.nextPosition;
    }
    return [...seen].sort();
  } finally { await session.close(); }
};

const runOne = async (item: Case & { fixture: string }, arm: Result['arm'], run: number): Promise<Result> => {
  const started = Date.now();
  const { dir, profileDir } = scratch(item.fixture);
  const base = { id: item.id, arm, run, fixture: item.fixture, expected: item.expected ?? [], pass: false, named: [], opened: [], hinted: [], carried: [], reply: '' };
  try {
    let brief = await buildBrief(profileDir, item);
    const hinted = /closest to this request, best first: ([^\n]*)/.exec(brief)?.[1]?.match(/`[^`]+`/g)?.map((path) => path.slice(1, -1)) ?? [];
    const carried = [...brief.matchAll(/^From ([\w/.-]+\.md) \(confirmed/gm)].map((match) => match[1]!);
    if (arm === 'no-hint') brief = brief.replace(HINT, '\n\n');
    if (arm === 'no-notes') brief = brief.replace(/;? ?two rules disagree: .*?or ask the owner/g, '').replace(/ \(\s*;?\s*\)/g, '').replace(/\(; /g, '(');
    const threadId = await startFolderThread({ project, title: `Serra KB eval: ${item.id} (${arm})`, brief, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) }, t3Bin);
    const deadline = Date.now() + Number(args.timeout) * 1000;
    for (;;) {
      await new Promise((resolve) => { setTimeout(resolve, 5000); });
      const { thread, messages } = await showThread(threadId, t3Bin, 3);
      if ((thread.pendingRequestCount ?? 0) > 0) {
        // The worker stopped to ask the owner a question: for two rules that disagree, that is a right answer. The
        // question's text is graded as the reply, then the run is stopped.
        const asked = await listQuestions(threadId, t3Bin).catch(() => []);
        const text = asked.flatMap((request) => request.questions.map((question) => [question.question, ...question.options.map((option) => `${option.label} ${option.description}`)].join(' '))).join('\n');
        if (!text) throw new Error(`stopped for approval: ${thread.link}`);
        const session = await openT3Session({ bin: t3Bin });
        try { await session.call('t3_thread_interrupt', { threadId, stop: true, reason: 'Eval graded the question.' }); } catch { /* the eval only reads it */ } finally { await session.close(); }
        const pass = (item.include ?? []).every((pattern) => new RegExp(pattern, 'iu').test(text));
        return { ...base, pass, asked: true, named: [], opened: [], hinted, carried, reply: `(asked) ${text}`, seconds: (Date.now() - started) / 1000 };
      }
      if (thread.activeRunId === null && thread.latestRunId !== null) {
        const text = messages.findLast((message) => message.role === 'assistant' && message.runId === thread.latestRunId)?.text ?? '';
        const { reply, cited } = takeKnowledgeUsed(text);
        const pages = readFileSync(join(profileDir, 'knowledge/index.md'), 'utf8').match(/`[^`\s]+\.md`/g)?.map((path) => path.slice(1, -1)) ?? [];
        const opened = await openedPages(threadId, thread.latestRunId, pages);
        const pass = (item.include ?? []).every((pattern) => new RegExp(pattern, 'iu').test(reply)) && !(item.exclude ?? []).some((pattern) => new RegExp(pattern, 'iu').test(reply));
        return { ...base, pass, named: cited, opened, hinted, carried, reply, seconds: (Date.now() - started) / 1000 };
      }
      if (Date.now() > deadline) throw new Error(`timed out: ${thread.link}`);
    }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error), seconds: (Date.now() - started) / 1000 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

if (!existsSync(project)) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Scratch project for Serra\'s knowledge evals\n\nNothing here is real. Runs read the knowledge pages their brief names and answer.\n');
}
await ensureProject(project, 'Serra KB evals', t3Bin);

const jobs = cases.flatMap((item) => ARMS.flatMap((arm) => Array.from({ length: Number(args.runs) }, (_, run) => () => runOne(item, arm, run + 1))));
const results: Result[] = [];
let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < jobs.length) {
    const result = await jobs[next++]!();
    results.push(result);
    process.stderr.write(`${result.error ? 'ERR ' : result.pass ? 'pass' : 'FAIL'}  ${result.arm.padEnd(7)} ${result.id} named [${result.named.join(', ')}] opened [${result.opened.join(', ')}]${result.error ? ` ${result.error}` : ''}\n`);
  }
}));

const pct = (part: number, whole: number): string => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const summary = (arm: Result['arm'], fixture?: string) => {
  const done = results.filter((result) => result.arm === arm && !result.error && (!fixture || result.fixture === fixture));
  const answered = done.filter((result) => !result.asked);
  const graded = answered.filter((result) => result.expected.length > 0);
  const namedRight = graded.filter((result) => result.named.some((path) => result.expected.includes(path)));
  const named = answered.filter((result) => result.named.length > 0);
  const honest = named.filter((result) => result.named.every((path) => result.opened.includes(path) || result.carried.includes(path)));
  const openedAny = done.filter((result) => result.opened.length > 0);
  const followed = done.filter((result) => result.hinted.length > 0 && result.hinted.some((path) => result.opened.includes(path)));
  return { runs: done.length, pass: pct(done.filter((result) => result.pass).length, done.length), named: pct(named.length, answered.length), honest: pct(honest.length, named.length), opened: pct(openedAny.length, done.length), followed: pct(followed.length, done.filter((result) => result.hinted.length > 0).length), namedRight: pct(namedRight.length, graded.length), asked: pct(done.filter((result) => result.asked).length, done.length) };
};
const lines = [
  `# Knowledge live eval: ${args.label}`, '',
  `Through Serra's T3 layer, on ${args.provider ? `${args.provider} ${args.model ?? ''}` : "T3's default provider"}, ${args.runs} run(s) of ${cases.length} cases per arm, ${new Date().toISOString().slice(0, 10)}. ${results.filter((result) => result.error).length} run(s) failed in the harness and are left out.`, '',
  '| Arm | Owner | Runs | Answer right | Named pages used | Named pages were opened or in About me | Named an expected page | Opened a page | Opened a hinted page | Asked the owner |', '|---|---|---|---|---|---|---|---|---|---|',
  ...ARMS.flatMap((arm) => (args.set === 'messy' ? ['messy'] : [undefined, ...SETS.map((set) => set.fixture)]).map((fixture) => {
    const row = summary(arm, fixture);
    return `| ${arm} | ${fixture ? fixture.replace('evals/', '') : 'both'} | ${row.runs} | ${row.pass} | ${row.named} | ${row.honest} | ${row.namedRight} | ${row.opened} | ${row.followed} | ${row.asked} |`;
  })),
];
const outDir = join(root, 'evals/results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${args.label}.json`), JSON.stringify({ results }, null, 2) + '\n');
writeFileSync(join(outDir, `${args.label}.md`), lines.join('\n') + '\n');
console.log(lines.join('\n'));
