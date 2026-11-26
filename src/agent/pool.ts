// The agent backends a long-running Serra follows threads on: T3, and each ACP agent the owner picked (an ACP agent
// is one process for all its runs; an edit to its setup or model starts a new one for the next job). New work goes to the owner's
// current choice (`agent-backend.json`, read each time); a job or task keeps the backend it started on, by its key
// (`t3`, `acp:<agent>`), so changing the choice never moves a running job.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { passedEnv } from '../exec.ts';
import { loginEnvironment, type LoginEnvironment } from '../shell-path.ts';
import { createAcpBackend, readRunRecord } from './acp.ts';
import { acpAgents, readAgentBackend } from './acp-agents.ts';
import type { AgentBackend } from './backend.ts';

export interface AgentBackends {
  /** The backend new work starts on. */
  current: () => AgentBackend;
  /** The backend a thread started on. Throws a plain sentence for one Serra can't run any more. */
  get: (key: string) => AgentBackend;
  /** Stops every ACP agent. Runs with a record carry on after the next start. */
  close: () => Promise<void>;
  /** Reopens the ACP runs a stop cut off mid-turn, so they carry on without waiting to be read. Never throws. */
  resume?: () => Promise<void>;
}

/** One backend for everything: T3 alone, as before agent backends, and in tests. */
export const singleBackend = (backend: AgentBackend): AgentBackends => ({
  current: () => backend,
  get: (key) => {
    if (key !== backend.key) throw new Error(`This thread runs on ${key}, which this Serra doesn't run.`);
    return backend;
  },
  close: () => backend.close(),
});

/** Where ACP runs are recorded in a profile: their transcripts, and what a restart carries on. */
export const agentRunsDir = (profileDir: string): string => join(profileDir, 'agent-runs');

/**
 * The login environment an ACP agent runs in: the owner's shell, as T3 gives its providers, with Serra's search PATH.
 * Without it (the login shell timed out or failed), only the safe part of Serra's own (home, user, locale, proxies,
 * config folders), never all of it: the daemon's environment can hold its Slack tokens.
 */
export const agentEnv = async (login: () => Promise<LoginEnvironment> = loginEnvironment, source: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> => {
  const found = await login();
  return { ...(found.env ?? passedEnv(source)), PATH: found.path };
};

export const createBackendPool = ({ profileDir, t3, log = () => {}, makeAcp = createAcpBackend }: {
  profileDir: string;
  t3: AgentBackend;
  log?: (message: string) => void;
  makeAcp?: typeof createAcpBackend;
}): AgentBackends => {
  // Each agent's newest instance, and the setup it was made from. An edit to the agent (command, args, env, name)
  // or its model in `agent-backend.json` makes a new instance for the next job; the old one is kept for the turns
  // still going on it, then closed once it has none. A thread goes to the instance whose turn it is, else the newest.
  const newest = new Map<string, { setup: string; backend: AgentBackend }>();
  const retired = new Map<string, AgentBackend[]>();
  const routers = new Map<string, AgentBackend>();

  const sweep = (key: string): void => {
    const old = retired.get(key) ?? [];
    const keep = old.filter((backend) => backend.busy?.() === true);
    for (const backend of old) if (!keep.includes(backend)) void backend.close();
    if (keep.length) retired.set(key, keep); else retired.delete(key);
  };

  const latest = (key: string): AgentBackend => {
    const id = key.slice(4);
    const settings = readAgentBackend(profileDir);
    const agent = acpAgents(settings).find((entry) => entry.id === id);
    const held = newest.get(key);
    if (!agent) {
      if (held) return held.backend;
      throw new Error(`Serra has no ACP agent "${id}" any more. Add it back in agent-backend.json to carry on its threads.`);
    }
    const model = settings.models[agent.id];
    const setup = JSON.stringify([agent.name, agent.command, agent.args, agent.env ?? {}, model ?? null]);
    if (held?.setup === setup) return held.backend;
    if (held) {
      retired.set(key, [...retired.get(key) ?? [], held.backend]);
      log(`${agent.name}'s setup changed: new work starts on it as saved.`);
    }
    const backend = makeAcp({ agent, env: agentEnv, runsDir: agentRunsDir(profileDir), attachmentsDir: join(profileDir, 'attachments'), log, ...(model ? { model } : {}) });
    newest.set(key, { setup, backend });
    sweep(key);
    return backend;
  };

  /**
   * The instance thread `threadId` runs on: the one with its turn going, question waiting or messages queued, else
   * the newest. The current instance is asked first, before any setup change is looked for, so an edit made while a
   * thread runs never moves that thread to a new instance (which would start a second turn on it).
   */
  const owner = (key: string, threadId: string): AgentBackend => {
    const current = newest.get(key)?.backend;
    if (current?.busy?.(threadId) === true) return current;
    sweep(key);
    return retired.get(key)?.find((backend) => backend.busy?.(threadId) === true) ?? latest(key);
  };

  const router = (key: string): AgentBackend => {
    const first = latest(key);
    const on = (threadId: string): AgentBackend => owner(key, threadId);
    return {
      id: first.id,
      key,
      get label() { return latest(key).label; },
      capabilities: first.capabilities,
      start: (input) => latest(key).start(input),
      send: (threadId, message, options) => on(threadId).send(threadId, message, options),
      interrupt: (threadId, reason) => on(threadId).interrupt(threadId, reason),
      read: (threadId, messages) => on(threadId).read(threadId, messages),
      wait: (threadId, options) => on(threadId).wait(threadId, options),
      list: (input) => latest(key).list(input),
      settle: (threadId) => on(threadId).settle(threadId),
      toolCall: async (threadId, runId, match) => (await on(threadId).toolCall?.(threadId, runId, match)) ?? null,
      questions: {
        list: async (threadId) => (await on(threadId).questions?.list(threadId)) ?? [],
        answer: async (threadId, requestId, answers) => { await on(threadId).questions?.answer(threadId, requestId, answers); },
      },
      images: async () => (await latest(key).images?.()) ?? true,
      busy: (threadId) => [newest.get(key)?.backend, ...retired.get(key) ?? []].some((backend) => backend?.busy?.(threadId) === true),
      close: async () => {
        await Promise.all([newest.get(key)?.backend, ...retired.get(key) ?? []].flatMap((backend) => (backend ? [backend.close()] : [])));
        newest.delete(key);
        retired.delete(key);
        routers.delete(key);
      },
    };
  };

  const get = (key: string): AgentBackend => {
    if (key === 't3') return t3;
    const found = routers.get(key);
    if (found) return found;
    const made = router(key);
    routers.set(key, made);
    return made;
  };
  return {
    current: () => {
      const settings = readAgentBackend(profileDir);
      return settings.backend === 'acp' && settings.agent ? get(`acp:${settings.agent}`) : t3;
    },
    get,
    resume: async () => {
      let names: string[] = [];
      try { names = readdirSync(agentRunsDir(profileDir)).filter((name) => name.endsWith('.json')); } catch { return; }
      for (const name of names) {
        const record = readRunRecord(agentRunsDir(profileDir), decodeURIComponent(name.slice(0, -5)));
        if (!record?.active || !record.agent) continue;
        try {
          await get(`acp:${record.agent}`).read(record.sessionId);
        } catch (error) {
          log(`Couldn't carry on ${record.agent} run ${record.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    close: async () => {
      await Promise.all([...routers.values()].map((backend) => backend.close()));
      routers.clear();
      await t3.close();
    },
  };
};
