// The live "knows you" eval: how well a worker that gets Serra's brief knows its owner.
//
// Each case is a message to the fixture bot (evals/fixture: an invented owner, Robin, and invented colleagues). The
// brief is built by Serra's own code (a real `createBot` with a recording chat client, or `taskBrief` for app tasks),
// so the eval measures exactly what the code under test sends a worker. A read-only Claude Code worker answers it from
// a scratch copy of the fixture profile, and the reply is graded by regex checks and, where a case has a rubric, by a
// second model. Scores are per category, 0–100.
//
//   node evals/live.ts --label baseline [--runs 2] [--model sonnet] [--judge sonnet] [--only id,id] [--concurrency 6]
//   [--fixture dir] [--cases file] [--untagged] [--no-about]
//
// Results go to evals/results/<label>.json (every reply, for audit) and <label>.md (the table).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBrief, type EvalCase } from './capture.ts';

const root = new URL('..', import.meta.url).pathname;

interface Case extends EvalCase {
  id: string;
  category: string;
  include?: string[];
  exclude?: string[];
  judge?: string;
}

interface Graded { id: string; category: string; run: number; reply: string; score: number; parts: Record<string, number>; why?: string; error?: string; briefHash?: string }

const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    runs: { type: 'string', default: '2' },
    model: { type: 'string', default: 'sonnet' },
    judge: { type: 'string', default: 'sonnet' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '6' },
    fixture: { type: 'string', default: 'evals/fixture' },
    cases: { type: 'string', default: 'evals/cases.json' },
    untagged: { type: 'boolean', default: false },
    'no-about': { type: 'boolean', default: false },
  },
});

const cases = (JSON.parse(readFileSync(join(root, args.cases!), 'utf8')) as { cases: Case[] }).cases
  .filter((item) => !args.only || args.only.split(',').includes(item.id));

/** Runs `claude -p` with no user settings, memory, MCP servers or tools beyond `tools`, and returns its final text. */
const claude = (prompt: string, { cwd, tools, model, addDirs = [] }: { cwd: string; tools: string; model: string; addDirs?: string[] }): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', prompt, '--restricted', '--strict-mcp-config', '--tools', tools, '--model', model,
      '--no-session-persistence', '--permission-prompts', 'none', '--output-format', 'json',
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (parsed.is_error || typeof parsed.result !== 'string') reject(new Error(`claude failed: ${out.slice(0, 300)}`));
        else resolve(parsed.result);
      } catch { reject(new Error(`claude exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`)); }
    });
  });

const JUDGE_PROMPT = (rubric: string, request: string, reply: string): string => `You grade one reply from an assistant bot. Score it 0, 1 or 2 against the rubric, and nothing else.

Rubric: ${rubric}

The request the bot answered:
<request>
${request}
</request>

The bot's reply:
<reply>
${reply}
</reply>

Answer with only a JSON object: {"score": 0|1|2, "why": "<one short sentence>"}`;

const grade = async (item: Case, run: number, reply: string): Promise<Graded> => {
  const parts: Record<string, number> = {};
  for (const pattern of item.include ?? []) parts[`include ${pattern}`] = new RegExp(pattern, 'iu').test(reply) ? 1 : 0;
  if (item.exclude?.length) parts.exclude = item.exclude.every((pattern) => !new RegExp(pattern, 'iu').test(reply)) ? 1 : 0;
  let why: string | undefined;
  if (item.judge) {
    const verdict = await claude(JUDGE_PROMPT(item.judge, item.text, reply), { cwd: tmpdir(), tools: '', model: args.judge! });
    const match = /\{[\s\S]*\}/.exec(verdict);
    const parsed = match ? JSON.parse(match[0]) as { score: number; why: string } : { score: 0, why: `unparsable: ${verdict}` };
    parts.judge = Math.max(0, Math.min(2, Number(parsed.score))) / 2;
    why = parsed.why;
  }
  const scores = Object.values(parts);
  return { id: item.id, category: item.category, run, reply, parts, score: scores.reduce((a, b) => a + b, 0) / scores.length, ...(why ? { why } : {}) };
};

/** A fresh scratch copy of the fixture profile and project per run, so no run sees another's files. */
const scratch = (): { dir: string; profileDir: string; project: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-eval-'));
  const profileDir = join(dir, 'profile'); const project = join(dir, 'project');
  cpSync(join(root, args.fixture!, 'knowledge'), join(profileDir, 'knowledge'), { recursive: true });
  cpSync(join(root, args.fixture!, 'project'), project, { recursive: true });
  // --untagged: the profile as it was before audiences existed, with no page saying who may hear it.
  if (args.untagged) {
    for (const file of readdirSync(join(profileDir, 'knowledge'), { recursive: true }).map(String).filter((name) => name.endsWith('.md'))) {
      const path = join(profileDir, 'knowledge', file);
      writeFileSync(path, readFileSync(path, 'utf8').replace(/^audience:.*\n/m, ''));
    }
  }
  const profile = readFileSync(join(root, args.fixture!, 'profile.json'), 'utf8').replace('PROJECT_PATH', project);
  writeFileSync(join(profileDir, 'profile.json'), profile);
  writeFileSync(join(profileDir, 'brief.md'), readFileSync(join(root, 'templates/brief.md'), 'utf8'));
  writeFileSync(join(profileDir, '.env'), 'SLACK_APP_TOKEN=xapp-eval\nSLACK_BOT_TOKEN=xoxb-eval\n');
  return { dir, profileDir, project };
};

const runOne = async (item: Case, run: number): Promise<Graded> => {
  const { dir, profileDir, project } = scratch();
  try {
    const brief = await buildBrief(profileDir, item, { noAbout: args['no-about'] });
    // The brief with the scratch folder's path taken out, so the same code always gives the same hash.
    const briefHash = createHash('sha256').update(brief.replaceAll(dir, '<scratch>')).digest('hex').slice(0, 16);
    const reply = await claude(brief, { cwd: project, tools: 'Read,Grep,Glob', model: args.model!, addDirs: [profileDir] });
    return { ...await grade(item, run, reply), briefHash };
  } catch (error) {
    return { id: item.id, category: item.category, run, reply: '', score: 0, parts: {}, error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const git = (...command: string[]): string => { try { return execFileSync('git', ['-C', root, ...command], { encoding: 'utf8' }).trim(); } catch { return ''; } };
// Which code produced these results, read before any run starts: the commit, and whether the code had changes on top.
const startedFrom = { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'src', 'templates', 'evals/capture.ts', 'evals/live.ts') !== '' };

const jobs = cases.flatMap((item) => Array.from({ length: Number(args.runs) }, (_, run) => () => runOne(item, run + 1)));
const results: Graded[] = [];
let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    const result = await job();
    results.push(result);
    process.stderr.write(`${result.error ? 'ERR' : result.score.toFixed(2)}  ${result.id} #${result.run}\n`);
  }
}));

results.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
const categories = [...new Set(cases.map((item) => item.category))];
const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
// A run the harness couldn't finish (the CLI failed or timed out) is left out, not scored 0: it says nothing about the brief.
const graded = results.filter((r) => !r.error);
const byCategory = Object.fromEntries(categories.map((category) => [category, Math.round(100 * mean(graded.filter((r) => r.category === category).map((r) => r.score)))]));
const overall = Math.round(100 * mean(graded.map((r) => r.score)));

const outDir = join(root, 'evals/results');
mkdirSync(outDir, { recursive: true });
const meta = { label: args.label, noAbout: args['no-about'], model: args.model, judge: args.judge, runs: Number(args.runs), cases: cases.length, at: new Date().toISOString(), ...startedFrom };
writeFileSync(join(outDir, `${args.label}.json`), JSON.stringify({ meta, byCategory, overall, results }, null, 2) + '\n');
const lines = [
  `# Live eval: ${args.label}`, '',
  `Worker ${args.model}, judge ${args.judge}, ${args.runs} runs of ${cases.length} cases (${args.cases}, ${args.fixture}${args.untagged ? ', audiences removed' : ''}${args['no-about'] ? ', About me left out' : ''}), ${meta.at.slice(0, 10)}.${results.length > graded.length ? ` ${results.length - graded.length} runs failed in the harness and are left out.` : ''}`, '',
  '| Category | Score |', '|---|---|',
  ...categories.map((category) => `| ${category} | ${byCategory[category]} |`),
  `| **overall** | **${overall}** |`, '',
  '| Case | Runs |', '|---|---|',
  ...cases.map((item) => `| ${item.id} | ${results.filter((r) => r.id === item.id).map((r) => (r.error ? 'error' : r.score.toFixed(2))).join(', ')} |`),
];
writeFileSync(join(outDir, `${args.label}.md`), lines.join('\n') + '\n');
console.log(lines.slice(0, 6 + categories.length + 1).join('\n'));
