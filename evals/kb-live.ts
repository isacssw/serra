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
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBrief, type EvalCase } from './capture.ts';
import { takeKnowledgeUsed } from '../src/knowledge-usage.ts';
import { ensureProject, showThread, startFolderThread } from '../src/t3.ts';
import { openT3Session } from '../src/t3-session.ts';
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
  },
});
const t3Bin = process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3');

interface Case extends EvalCase { id: string; category: string; include?: string[]; exclude?: string[] }
const SETS = [
  { fixture: 'evals/fixture', cases: 'evals/cases.json' },
  { fixture: 'evals/fixture-heldout', cases: 'evals/cases-heldout.json' },
];
// Cases a regex can grade, from both owners; the held-out owner's were never used to tune anything here.
const cases = SETS.flatMap((set) => (JSON.parse(readFileSync(join(root, set.cases), 'utf8')) as { cases: Case[] }).cases
  .filter((item) => item.include?.length && (!args.only || args.only.split(',').includes(item.id)))
  .map((item) => ({ ...item, fixture: set.fixture })));

const project = join(homedir(), '.local/share/serra-evals/kb-live');
const HINT = /\n*Pages that look closest to this request, best first: [^\n]*\n*/;

interface Result {
  id: string; arm: 'hint' | 'no-hint'; run: number; fixture: string; pass: boolean; named: string[]; opened: string[];
  hinted: string[]; error?: string; seconds: number; reply: string;
  /** Pages the brief carried whole, in About me: naming one is honest without opening it. */
  carried: string[];
}

const scratch = (fixture: string): { dir: string; profileDir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-kb-live-'));
  const profileDir = join(dir, 'profile');
  cpSync(join(root, fixture, 'knowledge'), join(profileDir, 'knowledge'), { recursive: true });
  writeFileSync(join(profileDir, 'profile.json'), readFileSync(join(root, fixture, 'profile.json'), 'utf8').replace('PROJECT_PATH', project));
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
        if (item.runId !== runId || /message/i.test(String(item.type))) continue;
        const text = JSON.stringify(item);
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
  const base = { id: item.id, arm, run, fixture: item.fixture, pass: false, named: [], opened: [], hinted: [], carried: [], reply: '' };
  try {
    let brief = await buildBrief(profileDir, item);
    const hinted = /closest to this request, best first: ([^\n]*)/.exec(brief)?.[1]?.match(/`[^`]+`/g)?.map((path) => path.slice(1, -1)) ?? [];
    const carried = [...brief.matchAll(/^From ([\w/.-]+\.md) \(confirmed/gm)].map((match) => match[1]!);
    if (arm === 'no-hint') brief = brief.replace(HINT, '\n\n');
    const threadId = await startFolderThread({ project, title: `Serra KB eval: ${item.id} (${arm})`, brief, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) }, t3Bin);
    const deadline = Date.now() + Number(args.timeout) * 1000;
    for (;;) {
      await new Promise((resolve) => { setTimeout(resolve, 5000); });
      const { thread, messages } = await showThread(threadId, t3Bin, 3);
      if ((thread.pendingRequestCount ?? 0) > 0) throw new Error(`stopped for approval: ${thread.link}`);
      if (thread.activeRunId === null && thread.latestRunId !== null) {
        const text = messages.findLast((message) => message.role === 'assistant' && message.runId === thread.latestRunId)?.text ?? '';
        const { reply, cited } = takeKnowledgeUsed(text);
        const pages = readFileSync(join(root, item.fixture, 'knowledge/index.md'), 'utf8').match(/`[^`\s]+\.md`/g)?.map((path) => path.slice(1, -1)) ?? [];
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

const jobs = cases.flatMap((item) => (['hint', 'no-hint'] as const).flatMap((arm) => Array.from({ length: Number(args.runs) }, (_, run) => () => runOne(item, arm, run + 1))));
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
  const named = done.filter((result) => result.named.length > 0);
  const honest = named.filter((result) => result.named.every((path) => result.opened.includes(path) || result.carried.includes(path)));
  const openedAny = done.filter((result) => result.opened.length > 0);
  const followed = done.filter((result) => result.hinted.length > 0 && result.hinted.some((path) => result.opened.includes(path)));
  return { runs: done.length, pass: pct(done.filter((result) => result.pass).length, done.length), named: pct(named.length, done.length), honest: pct(honest.length, named.length), opened: pct(openedAny.length, done.length), followed: pct(followed.length, done.filter((result) => result.hinted.length > 0).length) };
};
const lines = [
  `# Knowledge live eval: ${args.label}`, '',
  `Through Serra's T3 layer, on ${args.provider ? `${args.provider} ${args.model ?? ''}` : "T3's default provider"}, ${args.runs} run(s) of ${cases.length} cases per arm, ${new Date().toISOString().slice(0, 10)}. ${results.filter((result) => result.error).length} run(s) failed in the harness and are left out.`, '',
  '| Arm | Owner | Runs | Answer right | Named pages used | Named pages were opened or in About me | Opened a page | Opened a hinted page |', '|---|---|---|---|---|---|---|---|',
  ...(['hint', 'no-hint'] as const).flatMap((arm) => [undefined, ...SETS.map((set) => set.fixture)].map((fixture) => {
    const row = summary(arm, fixture);
    return `| ${arm} | ${fixture ? fixture.replace('evals/', '') : 'both'} | ${row.runs} | ${row.pass} | ${row.named} | ${row.honest} | ${row.opened} | ${row.followed} |`;
  })),
];
const outDir = join(root, 'evals/results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${args.label}.json`), JSON.stringify({ results }, null, 2) + '\n');
writeFileSync(join(outDir, `${args.label}.md`), lines.join('\n') + '\n');
console.log(lines.join('\n'));
