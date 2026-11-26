// Which backend a short run (a meeting run, the weekly review) runs on: the owner's choice in `agent-backend.json`
// (src/agent/acp-agents.ts), read on every run, so a change applies to the next one without a restart. T3 when
// nothing is chosen. Long-running work (Slack jobs, app tasks, the interview) goes through the pool (src/agent/pool.ts).
import { loginEnvironment } from '../shell-path.ts';
import { createAcpBackend } from './acp.ts';
import { acpAgents, launchFor, readAgentBackend, type AcpAgent } from './acp-agents.ts';
import type { AgentBackend } from './backend.ts';
import { agentEnv } from './pool.ts';
import { createT3Backend } from './t3.ts';

/** The ACP agent the owner picked, or null when they run on T3. Throws when the pick is no longer in Serra's list. */
export const chosenAcpAgent = (profileDir: string): AcpAgent | null => {
  const settings = readAgentBackend(profileDir);
  if (settings.backend !== 'acp') return null;
  const agent = acpAgents(settings).find((entry) => entry.id === settings.agent);
  if (!agent) throw new Error(`Serra has no ACP agent "${settings.agent}". Pick one in Settings › Meetings.`);
  return agent;
};

/** A new backend for one run, as the owner chose it. */
export const chosenBackend = (profileDir: string, { t3Bin, log }: { t3Bin: string; log?: (message: string) => void }): AgentBackend => {
  const agent = chosenAcpAgent(profileDir);
  const model = agent ? readAgentBackend(profileDir).models[agent.id] : undefined;
  return agent ? createAcpBackend({ agent, env: agentEnv, ...(model ? { model } : {}), ...(log ? { log } : {}) }) : createT3Backend({ bin: t3Bin });
};

/** Who runs meetings on an ACP agent, for Settings › Meetings: read from files and PATH, never a model call. */
export const acpRunner = async (agent: AcpAgent): Promise<{ label: string; model: null; ready: boolean; detail: string }> => {
  const launch = launchFor(agent, (await loginEnvironment()).path);
  return 'missing' in launch
    ? { label: `${agent.name} (ACP)`, model: null, ready: false, detail: `${launch.missing} Or pick T3.` }
    : { label: `${agent.name} (ACP)`, model: null, ready: true, detail: `Runs on ${agent.name} over ACP, on its own login, in Serra’s own empty folder.` };
};
