// The interview eval: does the onboarding interview capture what the bot needs to know its owner?
//
// A Claude Code worker runs the real interview brief (`interviewBrief` on a new profile) and a second model plays the
// owner from evals/persona.md (the same invented Robin as the fixture). They talk for up to --turns answers. Then the
// proposals the interview wrote are graded, with no model in the loop:
//
//   people     the three colleagues and customer are recorded (a person page each counts fully, a mention half)
//   voice      a voice page with the owner's style rules, and one of their real messages as a sample
//   offlimits  pay and hiring, and customer dates, are recorded as off-limits
//   audience   every proposal says who may hear it (audience: owner, team or external)
//   team       what a teammate's About me would carry from these pages once approved (4 owner pages = full marks)
//   private    the unannounced move, if recorded at all, is only in an owner-only page
//
//   node evals/interview.ts --label my-change [--runs 2] [--turns 14] [--template path/to/interview.md]
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { frontmatter } from '../src/knowledge-rules.ts';
import { compileAboutMe, pageAudience } from '../src/owner-model.ts';
import { interviewBrief } from '../src/tasks.ts';

const root = new URL('..', import.meta.url).pathname;
const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'interview' },
    runs: { type: 'string', default: '2' },
    turns: { type: 'string', default: '14' },
    model: { type: 'string', default: 'sonnet' },
    template: { type: 'string' },
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

const persona = readFileSync(join(root, 'evals/persona.md'), 'utf8');
const TIME = 'This is an evaluation run: Robin has about fifteen minutes, so keep moving. When a topic is confirmed, write its proposal straight away.';

interface Graded { run: number; scores: Record<string, number>; proposals: string[]; turns: number }

const runOne = async (run: number): Promise<Graded> => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-interview-'));
  try {
    const profileDir = join(dir, 'profile'); const project = join(dir, 'project');
    cpSync(join(root, 'templates/knowledge'), join(profileDir, 'knowledge'), { recursive: true });
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
    const all = proposals.map((p) => p.text).join('\n');
    const targetOf = (text: string): string => frontmatter(text)?.get('target')?.trim() ?? '';

    const person = (name: string): number => {
      const own = proposals.some((p) => /^people\//.test(targetOf(p.text)) && new RegExp(name, 'i').test(p.text));
      return own ? 1 : new RegExp(name, 'i').test(all) ? 0.5 : 0;
    };
    const voicePage = proposals.find((p) => /voice/i.test(targetOf(p.text)) || /voice/i.test(p.file))?.text ?? '';
    const styleRules = [/exclamation/i, /British/i, /lead with|answer first|answer up front/i, /emoji/i, /hope this helps/i].filter((rule) => rule.test(voicePage)).length;
    const sample = /EUR and GBP are live|Webhook retries are fixed/.test(voicePage) ? 1 : 0;
    const offlimits = (/(pay|salar|hiring|performance)/i.test(all) ? 0.5 : 0) + (/customer[\s\S]{0,80}date|date[\s\S]{0,80}customer|promise[\s\S]{0,40}date/i.test(all) ? 0.5 : 0);
    const tagged = proposals.length ? proposals.filter((p) => /^audience:\s*(owner|team|external)\s*$/m.test(p.text)).length / proposals.length : 0;
    const asPages = proposals.map((p) => ({ path: targetOf(p.text) || `owner/${p.file.replace(/^\d{4}-\d{2}-\d{2}-/, '')}`, text: p.text.replace(/^verified: no$/m, 'verified: 2026-11-21') }));
    const team = Math.min(1, compileAboutMe(asPages, 'team', new Date('2026-11-21T10:00:00Z')).included.length / 4);
    const privateLeak = proposals.some((p) => /Platform team/i.test(p.text) && pageAudience(frontmatter(p.text)) !== 'owner');

    mkdirSync(join(root, 'evals/results/interviews'), { recursive: true });
    writeFileSync(join(root, 'evals/results/interviews', `${args.label}-${run}.md`), [
      `# ${args.label}, run ${run}`, '', ...transcript, '', '## Proposals', '', ...proposals.map((p) => `### ${p.file}\n\n${p.text}`),
    ].join('\n'));
    return {
      run, turns, proposals: proposals.map((p) => `${p.file} → ${targetOf(p.text) || '(no target)'}`),
      scores: {
        people: (person('Priya') + person('Jonas') + person('Dana')) / 3,
        voice: (Math.min(styleRules, 3) / 3) * 0.6 + sample * 0.4,
        offlimits,
        audience: tagged,
        team,
        private: privateLeak ? 0 : 1,
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const results = await Promise.all(Array.from({ length: Number(args.runs) }, (_, run) => runOne(run + 1)));
const keys = Object.keys(results[0]!.scores);
const mean = (key: string): number => Math.round(100 * results.reduce((sum, r) => sum + r.scores[key]!, 0) / results.length);
const lines = [
  `# Interview eval: ${args.label}`, '',
  `Interviewer and owner ${args.model}, ${args.runs} runs of up to ${args.turns} answers, ${new Date().toISOString().slice(0, 10)}.`, '',
  '| Category | Score |', '|---|---|', ...keys.map((key) => `| ${key} | ${mean(key)} |`),
  `| **overall** | **${Math.round(keys.reduce((sum, key) => sum + mean(key), 0) / keys.length)}** |`, '',
  ...results.flatMap((r) => [`Run ${r.run}: ${r.proposals.length} proposals. ${r.proposals.join('; ')}`]),
];
writeFileSync(join(root, 'evals/results', `${args.label}.md`), lines.join('\n') + '\n');
writeFileSync(join(root, 'evals/results', `${args.label}.json`), JSON.stringify(results, null, 2) + '\n');
console.log(lines.join('\n'));
