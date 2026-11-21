// The interview eval: does the onboarding interview capture what the bot needs to know its owner?
//
// A Claude Code worker runs the real interview brief (`interviewBrief` on a new profile) and a second model plays the
// owner from evals/persona.md (the same invented Robin as the fixture). They talk for up to --turns answers. Then the
// proposals the interview wrote are graded, with no model in the loop:
//
//   people     each colleague and the customer is recorded with who they are (their own page 1, a mention 0.5)
//   voice      a voice page with at least three of the owner's style rules
//   samples    the owner's choice on samples is kept: their real message when they gave one, none when they declined
//   offlimits  pay and hiring, and customer dates, are recorded as off-limits
//   audience   each page has the audience the owner chose: role, working style, voice, off-limits and colleagues
//              for the team; the unannounced move only for the owner
//   team       the facts a teammate's About me would carry once approved: role, the Tuesday rule, a voice rule, Priya
//   private    the unannounced move, when recorded, is only in an owner-only page (left out when it isn't recorded)
//
//   node evals/interview.ts --label my-change [--runs 2] [--turns 14] [--template path] [--persona evals/persona-no-samples.md]
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { frontmatter } from '../src/knowledge-rules.ts';
import { gradeInterview } from './interview-grade.ts';
import { interviewBrief } from '../src/tasks.ts';

const root = new URL('..', import.meta.url).pathname;
const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'interview' },
    runs: { type: 'string', default: '2' },
    turns: { type: 'string', default: '14' },
    model: { type: 'string', default: 'sonnet' },
    template: { type: 'string' },
    persona: { type: 'string', default: 'evals/persona.md' },
    /** The starter knowledge folder the new profile gets (its README tells the interviewer the page format). */
    knowledge: { type: 'string', default: 'templates/knowledge' },
  },
});

const claude = (prompt: string, { cwd, tools, resume, system }: { cwd: string; tools: string; resume?: string; system?: string }): Promise<{ text: string; session: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', prompt, '--restricted', '--strict-mcp-config', '--tools', tools, '--model', args.model!, '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'none', '--output-format', 'json', ...(resume ? ['--resume', resume] : []), ...(system ? ['--append-system-prompt', system] : []),
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { result?: string; session_id?: string };
        resolve({ text: parsed.result ?? '', session: parsed.session_id ?? '' });
      } catch { reject(new Error(`claude failed: ${out.slice(0, 300)}`)); }
    });
  });

const persona = readFileSync(join(root, args.persona!), 'utf8');
const offersSamples = /if asked for samples/i.test(persona);
const TIME = 'This is an evaluation run: Robin has about fifteen minutes, so keep moving. When a topic is confirmed, write its proposal straight away.';

interface Graded { run: number; scores: Record<string, number | null>; proposals: string[]; turns: number }

const runOne = async (run: number): Promise<Graded> => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-interview-'));
  try {
    const profileDir = join(dir, 'profile'); const project = join(dir, 'project');
    cpSync(args.knowledge!.startsWith('/') ? args.knowledge! : join(root, args.knowledge!), join(profileDir, 'knowledge'), { recursive: true });
    cpSync(join(root, 'evals/fixture/project'), project, { recursive: true });
    writeFileSync(join(profileDir, 'profile.json'), readFileSync(join(root, 'evals/fixture/profile.json'), 'utf8').replace('PROJECT_PATH', project));
    writeFileSync(join(profileDir, 'brief.md'), readFileSync(join(root, 'templates/brief.md'), 'utf8'));
    const config = loadConfig({ profileDir, env: {} });
    const template = args.template ? readFileSync(args.template, 'utf8') : undefined;
    const brief = interviewBrief(config, new Date('2026-11-21T10:00:00Z'), template);

    const transcript: string[] = [];
    let { text, session } = await claude(`${brief}\n\n${TIME}`, { cwd: profileDir, tools: 'Read,Write,Edit,Glob,Grep' });
    let turns = 0;
    for (; turns < Number(args.turns); turns++) {
      transcript.push(`Interviewer: ${text}`);
      const answer = await claude(`The interview so far:\n\n${transcript.join('\n\n')}\n\nReply to the interviewer's last message as Robin. Only Robin's words.`, {
        cwd: tmpdir(), tools: '', system: persona,
      });
      transcript.push(`Robin: ${answer.text}`);
      ({ text, session } = await claude(answer.text, { cwd: profileDir, tools: 'Read,Write,Edit,Glob,Grep', resume: session }));
    }
    await claude('Robin has to go now. Write the proposals for every topic Robin confirmed that you haven\'t written yet, then stop.', {
      cwd: profileDir, tools: 'Read,Write,Edit,Glob,Grep', resume: session,
    });

    const proposalsDir = join(profileDir, 'knowledge/proposals');
    const files = existsSync(proposalsDir)
      ? readdirSync(proposalsDir, { recursive: true }).map(String).filter((file) => file.endsWith('.md') && !['README.md', 'onboarding-progress.md'].includes(basename(file)))
      : [];
    const proposals = files.map((file) => ({ file, text: readFileSync(join(proposalsDir, file), 'utf8') }));
    mkdirSync(join(root, 'evals/results/interviews'), { recursive: true });
    writeFileSync(join(root, 'evals/results/interviews', `${args.label}-${run}.md`), [
      `# ${args.label}, run ${run}`, '', ...transcript, '', '## Proposals', '', ...proposals.map((p) => `### ${p.file}\n\n${p.text}`),
    ].join('\n'));
    return {
      run, turns, proposals: proposals.map((p) => `${p.file} → ${frontmatter(p.text)?.get('target')?.trim() || '(no target)'}`),
      scores: gradeInterview(proposals, offersSamples),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const results = await Promise.all(Array.from({ length: Number(args.runs) }, (_, run) => runOne(run + 1)));
const keys = Object.keys(results[0]!.scores);
/** A category's mean over the runs where it applies (private is left out of runs that never recorded the fact). */
const mean = (key: string): number | null => {
  const values = results.map((r) => r.scores[key]).filter((value): value is number => typeof value === 'number');
  return values.length ? Math.round((100 * values.reduce((a, b) => a + b, 0)) / values.length) : null;
};
const shown = keys.map((key) => ({ key, value: mean(key) }));
const counted = shown.filter((item): item is { key: string; value: number } => item.value !== null);
const lines = [
  `# Interview eval: ${args.label}`, '',
  `Interviewer and owner ${args.model}, persona ${args.persona}, ${args.runs} runs of up to ${args.turns} answers, ${new Date().toISOString().slice(0, 10)}.`, '',
  '| Category | Score |', '|---|---|', ...shown.map(({ key, value }) => `| ${key} | ${value ?? 'n/a (not recorded)'} |`),
  `| **overall** | **${Math.round(counted.reduce((sum, item) => sum + item.value, 0) / Math.max(counted.length, 1))}** |`, '',
  ...results.flatMap((r) => [`Run ${r.run}: ${r.proposals.length} proposals. ${r.proposals.join('; ')}`]),
];
writeFileSync(join(root, 'evals/results', `${args.label}.md`), lines.join('\n') + '\n');
writeFileSync(join(root, 'evals/results', `${args.label}.json`), JSON.stringify(results, null, 2) + '\n');
console.log(lines.join('\n'));
