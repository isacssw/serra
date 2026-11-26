// Live check that meeting runs work without T3 (Phase 3 of the agent-backends work): one meeting-run-style ask, the
// read-only kind the weekly knowledge review makes, through a real ACP agent and then through T3, with each reply and
// how long it took. Uses the owner's own logins; spends a little of their plan. Not part of `pnpm test`.
//
//   node evals/acp-live.ts                       Claude Code over ACP (the adapter Serra ships, on your `claude`), then T3
//   node evals/acp-live.ts --acp codex --skip-t3  another agent from src/agent/acp-agents.ts
//   node evals/acp-live.ts --command "some-acp-agent --stdio"   any ACP command on PATH instead
//
// Every agent process it starts is stopped when its run ends; the script checks none is left.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAcpBackend } from '../src/agent/acp.ts';
import { KNOWN_ACP_AGENTS, launchFor, type AcpAgent } from '../src/agent/acp-agents.ts';
import { loginEnvironment } from '../src/shell-path.ts';
import type { AgentBackend } from '../src/agent/backend.ts';
import { createMeetingRuns } from '../src/meeting-runs.ts';

const { values: args } = parseArgs({
  options: {
    acp: { type: 'string', default: 'claude' },
    command: { type: 'string' },
    'skip-t3': { type: 'boolean', default: false },
  },
});

const known = KNOWN_ACP_AGENTS.find((agent) => agent.id === args.acp);
if (!known) throw new Error(`No ACP agent "${args.acp}".`);
const [command, ...rest] = (args.command ?? '').split(' ');
const agent: AcpAgent = args.command ? { id: 'custom', name: command!, command: command!, args: rest } : known;
// The owner's login environment, as the daemon gives an agent (src/agent/select.ts).
const login = await loginEnvironment();
const env = { ...(login.env ?? process.env), PATH: login.path };
const launch = launchFor(agent, login.path);
if ('missing' in launch) throw new Error(launch.missing);
const commandLine = [launch.command, ...launch.args].join(' ');

const PROMPT = [
  'Three notes from a team knowledge base:',
  '1. deploy.md: "Production deploys happen on Tuesdays and Thursdays only."',
  '2. release.md: "We deploy to production every weekday after 2 pm."',
  '3. oncall.md: "The on-call engineer approves every production deploy."',
  '',
  'Which two notes contradict each other? Answer with exactly <pair>N,M</pair> and one short sentence why.',
].join('\n');

const ask = async (label: string, backend?: () => AgentBackend): Promise<void> => {
  const workspace = mkdtempSync(join(tmpdir(), 'serra-acp-live-'));
  const runs = createMeetingRuns({ t3Bin: process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3'), pollMs: 500, ...(backend ? { backend, workspace } : {}), log: (line) => console.log(`  · ${line}`) });
  const started = Date.now();
  try {
    const answer = await runs.ask('Serra: ACP live check', PROMPT);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const pair = /<pair>\s*(\d)\s*,\s*(\d)\s*<\/pair>/.exec(answer);
    const right = pair !== null && new Set([pair[1], pair[2]]).size === 2 && [pair[1], pair[2]].every((n) => n === '1' || n === '2');
    console.log(`\n${label}: ${seconds} s, ${right ? 'right (1,2)' : 'WRONG'}\n  ${answer.trim().replace(/\n/g, '\n  ')}\n`);
  } catch (error) {
    console.log(`\n${label}: failed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
};

await ask(`${agent.name} over ACP (${commandLine})`, () => createAcpBackend({
  agent, env: async () => env,
  log: (line) => console.log(`  · ${line}`),
}));
if (!args['skip-t3']) await ask('T3 (its default provider and model)');

// Nothing the ACP run started may still be running.
let left = '';
try { left = execFileSync('pgrep', ['-fl', agent.bundled ? agent.bundled.package : agent.command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* pgrep exits 1 when nothing matches */ }
console.log(left ? `Still running:\n${left}` : 'No ACP agent process left running.');
