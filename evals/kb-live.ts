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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBrief, type EvalCase } from './capture.ts';
import { simulateGrowth } from './kb-growth-sim.ts';
import { takeKnowledgeUsed } from '../src/knowledge-usage.ts';
import { ensureProject } from '../src/t3.ts';
import { createEvalRunner, MAX_RUNNING } from './t3-hygiene.ts';
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
    concurrency: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '420' },
    set: { type: 'string', default: 'owners' },
    judge: { type: 'boolean', default: false },
  },
});
const t3Bin = process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3');

interface Case extends EvalCase { id: string; category: string; include?: string[]; exclude?: string[]; expected?: string[]; judge?: string }
const SETS = [
  { fixture: 'evals/fixture', cases: 'evals/cases.json' },
  { fixture: 'evals/fixture-heldout', cases: 'evals/cases-heldout.json' },
];
// Cases a regex can grade, from both owners; the held-out owner's were never used to tune anything here.
/** The pages each owner case needs: a reply that names one of them used the right knowledge. */
const EXPECTED: Record<string, string[]> = {
  'identity-owner-asks': ['owner/role.md'], 'identity-who-owns': ['owner/role.md', 'product/rate-limits.md'], 'identity-hours': ['owner/role.md'],
  'people-signoff': ['workflows/release.md', 'people/jonas.md', 'people/priya.md'], 'people-dana': ['people/dana.md'], 'people-message-priya': ['people/priya.md'],
  'people-jonas-style': ['people/jonas.md'], 'voice-tuesday-post': ['owner/voice.md'], 'process-thursday': ['owner/working-style.md', 'workflows/release.md'],
  'process-release-steps': ['workflows/release.md'], 'process-incident': ['workflows/incident.md'], 'privacy-owner-still-knows': ['owner/private-notes.md'],
  'people-who-decides': ['people/priya.md'], 'process-big-pr': ['owner/working-style.md'], 'process-prod-patch': ['workflows/incident.md', 'owner/working-style.md', 'product/refunds-api.md'],
  'privacy-owner-discount': ['owner/private-notes.md'], 'h-identity-tuesday': ['owner/role.md'], 'h-identity-hiring': ['owner/role.md'],
  'h-people-payments-review': ['people/lena-fischer.md', 'product/payments-app.md'], 'h-people-sync': ['people/kenji-sato.md', 'product/offline-sync.md'],
  'h-people-ask-kenji': ['people/kenji-sato.md'], 'h-process-ios-monday': ['workflows/app-release.md', 'owner/how-i-work.md'], 'h-process-hotfix': ['workflows/hotfix.md', 'people/omar-haddad.md'],
  'h-process-crash': ['workflows/crash-triage.md'], 'h-process-branch': ['owner/how-i-work.md', 'product/feature-flags.md'], 'h-priv-owner': ['owner/private.md'],
};

const ownerCases = SETS.flatMap((set) => (JSON.parse(readFileSync(join(root, set.cases), 'utf8')) as { cases: Case[] }).cases
  .filter((item) => item.include?.length && (!args.only || args.only.split(',').includes(item.id)))
  .map((item) => ({ ...item, fixture: set.fixture, expected: EXPECTED[item.id] ?? [] })));

// --set messy: the growth simulation's owner (Alex) at their messiest, before any tidy: two rules that disagree, a
// rule on two pages, every page stale. Arms: the brief as it ships, which marks the disagreeing rows, and without
// those marks. A right answer names the current rule and says the other exists, or asks.
const OWNER = 'UROBIN0001';
const messyCases: (Case & { fixture: string })[] = [
  { id: 'messy-release-day', category: 'conflict', via: 'dm', user: OWNER, text: 'which day do risky releases ship?', include: ['Thursday', 'Tuesday|disagree|conflict|confirm|two rules|both'], expected: ['owner/working-style.md', 'owner/releases.md'], fixture: 'messy',
    judge: 'Two notes disagree: an older one says risky releases ship on Tuesday, a newer one (2026-06-15) says Thursday. 2 = treats Thursday as current or asks which holds, and says the Tuesday rule exists or is out of date; 1 = gives Thursday without mentioning the other rule; 0 = says Tuesday, or invents another day.' },
  { id: 'messy-pr-size', category: 'conflict', via: 'dm', user: OWNER, text: 'how big can a PR be before I should split it?', include: ['300|400', '(300[\\s\\S]*400|400[\\s\\S]*300)|disagree|conflict|confirm|two rules|both'], expected: ['owner/working-style.md'], fixture: 'messy',
    judge: 'The page says both "under 400 changed lines" (older) and "under 300 changed lines" (added later). 2 = says the two disagree and names one as current or asks; 1 = gives one number without noting the other; 0 = invents a different number.' },
  { id: 'messy-webhook-retries', category: 'repeat', via: 'dm', user: OWNER, text: 'how many times do webhooks retry before we give up?', include: ['\\b5\\b|five'], expected: ['product/webhooks.md', 'product/webhook-retries.md'], fixture: 'messy',
    judge: 'Webhooks retry 5 times over 24 hours with exponential backoff, then the merchant gets an email. 2 = says 5 times (24 hours or backoff a plus); 1 = right count, wrong details; 0 = wrong count.' },
  { id: 'messy-priya', category: 'repeat', via: 'dm', user: OWNER, text: 'how does Priya like to get updates?', include: ['written|summary|numbers'], expected: ['people/priya.md', 'people/priya-nair.md'], fixture: 'messy',
    judge: 'Priya prefers a short written summary before any call and likes numbers in the first line. 2 = says both; 1 = says one; 0 = says something else.' },
  { id: 'messy-rate-limit', category: 'conflict', via: 'dm', user: OWNER, text: 'a merchant is getting 429s, what is our API rate limit per merchant?', include: ['250'], expected: ['product/plans.md', 'product/rate-limits.md'], fixture: 'messy',
    judge: 'Two pages disagree: product/rate-limits.md (confirmed 2026-06-01) says 100 requests per second per merchant; product/plans.md (confirmed 2026-09-20, newer) says 250. 2 = says 250 is current and notes the older 100 (or asks which holds); 1 = says 250 without noting the other; 0 = says 100.' },
];
const cases = args.set === 'messy' ? messyCases.filter((item) => !args.only || args.only.split(',').includes(item.id)) : ownerCases;
const ARMS = args.set === 'messy' ? (['notes', 'no-notes'] as const) : (['hint', 'no-hint'] as const);
const messyStage = args.set === 'messy' ? simulateGrowth().stages.find((stage) => stage.label === 'Before tidying')! : null;

const project = join(homedir(), '.local/share/serra-evals/kb-live');
const HINT = /\n*Pages that look closest to this request, best first: [^\n]*\n*/;

interface Result {
  id: string; arm: 'hint' | 'no-hint' | 'notes' | 'no-notes'; run: number; expected: string[]; fixture: string; pass: boolean; named: string[]; opened: string[];
  hinted: string[]; error?: string; seconds: number; reply: string;
  /** The provider and model T3 ran the reply on, read back from the thread. */
  ranOn?: string;
  /** The judge's 0–2, with --judge, for a case with a rubric. */
  score?: number;
  /** The worker stopped to ask the owner instead of answering. */
  asked?: boolean;
  /** Pages the brief carried whole, in About me: naming one is honest without opening it. */
  carried: string[];
}

const scratch = (fixture: string): { dir: string; profileDir: string } => {
  // Inside the eval project, so a worker in approval-required mode reads the pages without asking.
  mkdirSync(join(project, 'runs'), { recursive: true });
  const dir = mkdtempSync(join(project, 'runs', 'serra-kb-live-'));
  const profileDir = join(dir, 'profile');
  if (fixture === 'messy') {
    for (const file of messyStage!.files) {
      mkdirSync(dirname(join(profileDir, 'knowledge', file.path)), { recursive: true });
      writeFileSync(join(profileDir, 'knowledge', file.path), file.text);
    }
    // A limit that changed, written on a second page with no "now" in it: only the dates say which is current.
    const limit = (description: string, date: string, line: string): string => `---\ntype: product\ndescription: ${description}\naudience: team\nwritten: ${date}\nverified: ${date}\nsources:\n  - Owner, ${date}\n---\n\n# ${description}\n\n- ${line}\n- Increases are approved by Alex after a load test.\n`;
    writeFileSync(join(profileDir, 'knowledge/product/rate-limits.md'), limit('API rate limits', '2026-06-01', 'The API rate limit is 100 requests per second per merchant.'));
    // The newer limit sits on a page about plans, whose row doesn't match a rate-limit question: only the conflict
    // note on the rate-limits row points there.
    writeFileSync(join(profileDir, 'knowledge/product/plans.md'), limit('Plans and packaging for sales', '2026-09-20', 'The API rate limit is 250 requests per second per merchant.'));
    const index = join(profileDir, 'knowledge/index.md');
    writeFileSync(index, `${readFileSync(index, 'utf8').trimEnd()}\n| rate limits or 429s | \`product/rate-limits.md\` | API rate limits |\n| pricing plans or packaging | \`product/plans.md\` | Plans and packaging for sales |\n`);
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


/**
 * A second T3 run reads the case's rubric, the question and the reply, and scores it 0–2: whether the answer is right,
 * not only whether it has the right words. Same T3 layer and provider as the reply.
 */
// Every thread goes through the self-settling runner (evals/t3-hygiene.ts): approval-required, at most three at once,
// settled once its answer is saved, also on failure; the project is swept at the end.
const runner = createEvalRunner({ bin: t3Bin, project, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) });

/**
 * A second T3 run reads the case's rubric, the question and the reply, and scores it 0–2: whether the answer is right,
 * not only whether it has the right words. Same T3 layer and provider as the reply.
 */
const judge = async (rubric: string, question: string, reply: string): Promise<number | null> => {
  const prompt = `You grade one reply from an assistant. Don't open any file or run anything. Answer with one line: SCORE: 0, 1 or 2.\n\nRubric: ${rubric}\n\nQuestion:\n${question}\n\nReply:\n${reply}`;
  const { answer } = await runner.run('Serra KB eval: grade', prompt);
  const score = /SCORE:\s*([012])/i.exec(answer)?.[1];
  return score === undefined ? null : Number(score);
};

/** What a worker that stopped is asking: its questions and their options, as text to grade. */
const questionText = async (threadId: string): Promise<string> => (await listQuestions(threadId, t3Bin))
  .flatMap((request) => request.questions.map((question) => [question.question, ...question.options.map((option) => `${option.label} ${option.description}`)].join(' '))).join('\n');

const runOne = async (item: Case & { fixture: string }, arm: Result['arm'], run: number): Promise<Result> => {
  const started = Date.now();
  const { dir, profileDir } = scratch(item.fixture);
  const base = { id: item.id, arm, run, fixture: item.fixture, expected: item.expected ?? [], pass: false, named: [], opened: [], hinted: [], carried: [], reply: '' };
  try {
    let brief = await buildBrief(profileDir, item);
    const hinted = /closest to this request, best first: ([^\n]*)/.exec(brief)?.[1]?.match(/`[^`]+`/g)?.map((path) => path.slice(1, -1)) ?? [];
    const carried = [...brief.matchAll(/^From ([\w/.-]+\.md) \(confirmed/gm)].map((match) => match[1]!);
    if (arm === 'no-hint') brief = brief.replace(HINT, '\n\n');
    if (arm === 'no-notes') {
      brief = brief.replace(/;? ?two rules disagree: see below/g, '').replace(/ \(\s*;?\s*\)/g, '').replace(/\(; /g, '(')
        .replace(/\n\nRules that disagree\. [^\n]*(?:\n- [^\n]*)*/g, '');
      // The control arm must really lack the notes, or the comparison means nothing.
      if (/two rules disagree|Rules that disagree/.test(brief)) throw new Error('the no-notes brief still has a conflict note');
    } else if (arm === 'notes' && item.category === 'conflict' && !brief.includes('two rules disagree')) throw new Error('the notes brief has no conflict note');
    const run = await runner.run(`Serra KB eval: ${item.id} (${arm})`, brief, { timeoutMs: Number(args.timeout) * 1000, readAsk: questionText });
    if (run.asked) {
      // The worker stopped to ask the owner: for two rules that disagree, that is a right answer. Its question is graded.
      if (!run.answer) throw new Error(`stopped for approval: ${run.link}`);
      const pass = (item.include ?? []).every((pattern) => new RegExp(pattern, 'iu').test(run.answer));
      const score = args.judge && item.judge ? await judge(item.judge, item.text, `(The assistant stopped to ask the owner:) ${run.answer}`).catch(() => null) : null;
      return { ...base, pass, asked: true, named: [], opened: [], hinted, carried, reply: `(asked) ${run.answer}`, ranOn: run.ranOn, ...(score === null ? {} : { score }), seconds: (Date.now() - started) / 1000 };
    }
    const { reply, cited } = takeKnowledgeUsed(run.answer);
    const pages = readFileSync(join(profileDir, 'knowledge/index.md'), 'utf8').match(/`[^`\s]+\.md`/g)?.map((path) => path.slice(1, -1)) ?? [];
    const opened = await openedPages(run.threadId, run.runId, pages);
    const pass = (item.include ?? []).every((pattern) => new RegExp(pattern, 'iu').test(reply)) && !(item.exclude ?? []).some((pattern) => new RegExp(pattern, 'iu').test(reply));
    const score = args.judge && item.judge ? await judge(item.judge, item.text, reply).catch(() => null) : null;
    return { ...base, pass, named: cited, opened, hinted, carried, reply, ranOn: run.ranOn, ...(score === null ? {} : { score }), seconds: (Date.now() - started) / 1000 };
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

const swept = await runner.sweep();
runner.close();
process.stderr.write(`T3 hygiene: ${swept.settled} leftover thread(s) settled at the end; ${swept.left} unsettled in the evals project.\n`);

const pct = (part: number, whole: number): string => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const summary = (arm: Result['arm'], fixture?: string) => {
  const done = results.filter((result) => result.arm === arm && !result.error && (!fixture || result.fixture === fixture));
  const answered = done.filter((result) => !result.asked);
  const graded = answered.filter((result) => result.expected.length > 0);
  const namedRight = graded.filter((result) => result.named.some((path) => result.expected.includes(path)));
  const named = answered.filter((result) => result.named.length > 0);
  const honest = named.filter((result) => result.named.every((path) => result.opened.includes(path) || result.carried.includes(path)));
  const openedAny = answered.filter((result) => result.opened.length > 0);
  const followed = answered.filter((result) => result.hinted.length > 0 && result.hinted.some((path) => result.opened.includes(path)));
  return { runs: done.length, pass: pct(done.filter((result) => result.pass).length, done.length), named: pct(named.length, answered.length), honest: pct(honest.length, named.length), opened: pct(openedAny.length, answered.length), followed: pct(followed.length, answered.filter((result) => result.hinted.length > 0).length), namedRight: pct(namedRight.length, graded.length), asked: pct(done.filter((result) => result.asked).length, done.length),
    judged: (() => { const scored = done.filter((result) => result.score !== undefined); return scored.length ? `${(scored.reduce((sum, result) => sum + result.score!, 0) / scored.length).toFixed(2)} (${scored.length})` : '–'; })() };
};
const lines = [
  `# Knowledge live eval: ${args.label}`, '',
  `T3 hygiene: every eval thread ran approval-required, at most ${MAX_RUNNING} at once, and was settled once its answer was saved; ${swept.left} unsettled thread(s) left in the evals project at the end.`, '',
  `Through Serra's T3 layer, on ${[...new Set(results.flatMap((result) => (result.ranOn ? [result.ranOn] : [])))].join(', ') || (args.provider ? `${args.provider} ${args.model ?? ''}` : "T3's default provider")}, ${args.runs} run(s) of ${cases.length} cases per arm, ${new Date().toISOString().slice(0, 10)}. ${results.filter((result) => result.error).length} run(s) failed in the harness and are left out.`, '',
  '| Arm | Owner | Runs | Answer right | Named pages used | Named pages were opened or in About me | Named an expected page | Opened a page | Opened a hinted page | Asked the owner | Judge 0–2 (cases with a rubric) |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...ARMS.flatMap((arm) => (args.set === 'messy' ? ['messy'] : [undefined, ...SETS.map((set) => set.fixture)]).map((fixture) => {
    const row = summary(arm, fixture);
    return `| ${arm} | ${fixture ? fixture.replace('evals/', '') : 'both'} | ${row.runs} | ${row.pass} | ${row.named} | ${row.honest} | ${row.namedRight} | ${row.opened} | ${row.followed} | ${row.asked} | ${row.judged} |`;
  })),
];
const outDir = join(root, 'evals/results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${args.label}.json`), JSON.stringify({ results }, null, 2) + '\n');
writeFileSync(join(outDir, `${args.label}.md`), lines.join('\n') + '\n');
console.log(lines.join('\n'));
