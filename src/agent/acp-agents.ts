// Which agent backend the owner picked, and the ACP agents Serra can offer. Stored in `agent-backend.json` in the
// profile, read on every run, so a change applies to the next one. Without the file, T3 runs everything.
//
// The common ACP agents come built in. Claude Code's and Codex's ACP adapters ship with Serra (pinned dependencies,
// resolved from Serra's own node_modules and run with Serra's own Node or Electron), like T3 ships the Claude Agent
// SDK: the owner only needs the `claude` or `codex` CLI, signed in, and the adapter runs that CLI (not a copy of its
// own: the SDK's and Codex's bundled binaries are left out, see `pnpm.ignoredOptionalDependencies`). OpenCode and
// Gemini CLI are the agents themselves, offered when their command is on the owner's PATH. Serra never installs one. The owner can add their own in the file (name, command, args, env); env values come from the owner's
// own file, never from Serra's code, and are never shown or logged.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../config.ts';
import { isRecord, parseJson } from '../json-guards.ts';

/** An adapter Serra ships: the npm package, the CLI it drives, and the variable that tells it where that CLI is. */
interface BundledAdapter {
  package: string;
  /** `import.meta.resolve` of its package.json, written out per adapter so the dependency checker sees each one. */
  manifest: () => string;
  cli: string;
  cliEnv: string;
}

/** One ACP agent the owner can pick: a command that speaks ACP on stdio, or an adapter Serra ships. */
export interface AcpAgent {
  id: string;
  name: string;
  /** The command to run, or for a bundled adapter, the CLI it drives (what the owner must have installed). */
  command: string;
  args: string[];
  /** Extra environment for the agent. Never a secret in Serra's code: the owner's own file or shell holds those. */
  env?: Record<string, string>;
  bundled?: BundledAdapter;
}

export const AGENT_BACKEND_FILE = 'agent-backend.json';

/** Where a profile's agent backend choice and custom ACP agents live. */
export const agentBackendPath = (profileDir: string): string => join(profileDir, AGENT_BACKEND_FILE);

/** The ACP agents Serra knows, in the order it offers them. Each one's own login stays with it. */
export const KNOWN_ACP_AGENTS: readonly AcpAgent[] = [
  // Claude Code through the ACP project's adapter (on the Claude Agent SDK), running the owner's own `claude` and its login.
  { id: 'claude', name: 'Claude Code', command: 'claude', args: [], bundled: { package: '@agentclientprotocol/claude-agent-acp', manifest: () => import.meta.resolve('@agentclientprotocol/claude-agent-acp/package.json'), cli: 'claude', cliEnv: 'CLAUDE_CODE_EXECUTABLE' } },
  // Codex through the ACP project's adapter, running the owner's own `codex app-server` and its login.
  { id: 'codex', name: 'Codex', command: 'codex', args: [], bundled: { package: '@agentclientprotocol/codex-acp', manifest: () => import.meta.resolve('@agentclientprotocol/codex-acp/package.json'), cli: 'codex', cliEnv: 'CODEX_PATH' } },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
];

export interface AgentBackendSettings {
  backend: 't3' | 'acp';
  /** The ACP agent's id, when `backend` is `acp`. */
  agent: string | null;
  /** Agents the owner added in the file, or built-in ones they changed (same id). */
  custom: AcpAgent[];
  /** The model the owner picked per agent id; the agent's own default when absent. */
  models: Record<string, string>;
}

const DEFAULTS: AgentBackendSettings = { backend: 't3', agent: null, custom: [], models: {} };

const AGENT_ID = /^[\w-]{1,40}$/;

/** A model name as an agent takes it: letters, digits and `-._:/[]`, never a flag. */
const isModel = (value: unknown): value is string => typeof value === 'string' && /^[\w.:/[\]-]{1,80}$/.test(value) && !value.startsWith('-');

const slugifyId = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const commandProblem = (command: string): string | null => {
  if (!command) return 'Enter a command.';
  if (/[\r\n\0]/.test(command)) return 'The command must be one line.';
  if (command.startsWith('-')) return 'The command can’t start with a hyphen.';
  if (!isAbsolute(command) && command.includes('/')) return 'Use a command name on your PATH or an absolute path.';
  return null;
};

const agentFrom = (value: unknown): AcpAgent | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.command !== 'string') return null;
  const command = value.command.trim();
  if (!AGENT_ID.test(value.id) || commandProblem(command) !== null) return null;
  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string' && !/[\r\n\0]/.test(arg)) : [];
  const env = isRecord(value.env) ? Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
  return { id: value.id, name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 40) : value.id, command, args, ...(env ? { env } : {}) };
};

export const readAgentBackend = (profileDir: string): AgentBackendSettings => {
  let text: string;
  try { text = readFileSync(agentBackendPath(profileDir), 'utf8'); } catch { return DEFAULTS; }
  const value = parseJson(text);
  if (!isRecord(value)) return DEFAULTS;
  const custom = Array.isArray(value.agents) ? value.agents.map(agentFrom).filter((agent): agent is AcpAgent => agent !== null) : [];
  const agent = typeof value.agent === 'string' ? value.agent : null;
  const models = isRecord(value.models) ? Object.fromEntries(Object.entries(value.models).filter((entry): entry is [string, string] => isModel(entry[1]))) : {};
  return { backend: value.backend === 'acp' && agent ? 'acp' : 't3', agent, custom, models };
};

const isNotFound = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT';

/** Reports a syntax or shape problem in an existing `agent-backend.json`, or null when missing or valid. */
export const agentBackendConfigError = (profileDir: string): string | null => {
  let text: string;
  try { text = readFileSync(agentBackendPath(profileDir), 'utf8'); } catch (error) {
    if (isNotFound(error)) return null;
    return `Could not read ${AGENT_BACKEND_FILE}.`;
  }
  const value = parseJson(text);
  if (!isRecord(value)) return `${AGENT_BACKEND_FILE} is not valid JSON. Fix the file to load custom agents.`;
  if (value.agents !== undefined) {
    if (!Array.isArray(value.agents)) return `The "agents" field in ${AGENT_BACKEND_FILE} must be a list.`;
    if (value.agents.some((entry) => agentFrom(entry) === null)) return `One or more entries in ${AGENT_BACKEND_FILE} are missing a valid id or command.`;
  }
  return null;
};

/** Reads the raw config object before writing, refusing to overwrite a file that has invalid JSON. */
const readRawConfig = (profileDir: string): Record<string, unknown> => {
  let text: string;
  try { text = readFileSync(agentBackendPath(profileDir), 'utf8'); } catch (error) {
    if (isNotFound(error)) return {};
    throw new Error(`Could not read ${AGENT_BACKEND_FILE}.`);
  }
  const parsed = parseJson(text);
  if (!isRecord(parsed)) throw new Error(`${AGENT_BACKEND_FILE} is not valid JSON. Fix the file before saving.`);
  return parsed;
};

/** Saves the owner's choice, keeping the agents they added. */
export const writeAgentBackend = (profileDir: string, choice: { backend: 't3' | 'acp'; agent?: string | null; model?: string | null }): AgentBackendSettings => {
  const current = readAgentBackend(profileDir);
  if (choice.backend === 'acp' && !choice.agent) throw new Error('Pick an ACP agent.');
  const model = choice.model?.trim();
  if (model && !isModel(model)) throw new Error('That isn’t a model name.');
  const raw = readRawConfig(profileDir);
  // A model is the chosen agent's; an empty one goes back to the agent's default.
  const models = { ...current.models };
  if (choice.backend === 'acp' && choice.agent && choice.model !== undefined) {
    if (model) models[choice.agent] = model; else delete models[choice.agent];
  }
  const next = { ...raw, backend: choice.backend, agent: choice.backend === 'acp' ? choice.agent : current.agent, models };
  writeFileAtomic(agentBackendPath(profileDir), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return readAgentBackend(profileDir);
};

export interface CustomAcpAgentInput {
  id?: string;
  name: string;
  command: string;
  args?: string[];
}

/** Adds one custom ACP agent to `agent-backend.json`, keeping the existing choice, models and other agents (with their env). */
export const addCustomAcpAgent = (profileDir: string, input: CustomAcpAgentInput): AgentBackendSettings => {
  const name = input.name.trim();
  if (!name) throw new Error('Enter a name for the agent.');
  if (/[\r\n\0]/.test(name)) throw new Error('The agent name must be one line.');
  if (name.length > 40) throw new Error('Use at most 40 characters for the agent name.');
  const id = input.id?.trim() || slugifyId(name);
  if (!AGENT_ID.test(id)) throw new Error('Enter a name with letters or numbers.');
  if (KNOWN_ACP_AGENTS.some((known) => known.id === id)) throw new Error(`"${id}" is already a built-in ACP agent.`);
  const command = input.command.trim();
  const problem = commandProblem(command);
  if (problem) throw new Error(problem);
  const args = (input.args ?? []).filter((arg) => arg.length > 0);
  if (args.some((arg) => /[\r\n\0]/.test(arg))) throw new Error('Arguments must be single-line.');
  const raw = readRawConfig(profileDir);
  const existing = Array.isArray(raw.agents) ? raw.agents : [];
  if (existing.some((entry) => isRecord(entry) && entry.id === id)) throw new Error(`An ACP agent named "${id}" is already added.`);
  const next = {
    backend: 't3', agent: null, models: {},
    ...raw,
    agents: [...existing, { id, name, command, args }],
  };
  writeFileAtomic(agentBackendPath(profileDir), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return readAgentBackend(profileDir);
};

/** Removes a custom ACP agent from `agent-backend.json`. Falls back to T3 if it was the selected backend. */
export const removeCustomAcpAgent = (profileDir: string, id: string): AgentBackendSettings => {
  if (!AGENT_ID.test(id)) throw new Error('Agent ID is missing.');
  const raw = readRawConfig(profileDir);
  const existing = Array.isArray(raw.agents) ? raw.agents : [];
  const agents = existing.filter((entry) => !(isRecord(entry) && entry.id === id));
  const isBuiltIn = KNOWN_ACP_AGENTS.some((known) => known.id === id);
  const models = isRecord(raw.models) ? { ...raw.models } : {};
  if (!isBuiltIn) delete models[id];
  const wasActive = raw.backend === 'acp' && raw.agent === id && !isBuiltIn;
  const next = {
    ...raw,
    ...(wasActive ? { backend: 't3', agent: null } : {}),
    models,
    agents,
  };
  writeFileAtomic(agentBackendPath(profileDir), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return readAgentBackend(profileDir);
};

/** Ensures `agent-backend.json` exists in the profile with a valid starter structure, and returns its path. */
export const ensureAgentBackendFile = (profileDir: string): string => {
  const file = agentBackendPath(profileDir);
  if (!existsSync(file)) {
    writeFileAtomic(file, `${JSON.stringify({ backend: 't3', agent: null, models: {}, agents: [] }, null, 2)}\n`, { mode: 0o600 });
  }
  return file;
};

/** Every agent Serra can offer: the built-in ones, with the owner's own changes and additions. */
export const acpAgents = (settings: AgentBackendSettings): AcpAgent[] => {
  const custom = new Map(settings.custom.map((agent) => [agent.id, agent]));
  return [...KNOWN_ACP_AGENTS.map((agent) => custom.get(agent.id) ?? agent), ...settings.custom.filter((agent) => !KNOWN_ACP_AGENTS.some((known) => known.id === agent.id))];
};

/** The command's full path on `path`, or null. An absolute command is checked as is. */
const findCommand = (command: string, path: string): string | null => {
  const executable = (file: string): boolean => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };
  if (isAbsolute(command)) return executable(command) ? command : null;
  if (command.includes('/')) return null;
  for (const folder of path.split(delimiter)) if (folder && executable(join(folder, command))) return join(folder, command);
  return null;
};

/** A bundled adapter's entry script in Serra's own node_modules, or null when it isn't there. */
const adapterEntry = (adapter: BundledAdapter): string | null => {
  try {
    const manifest = fileURLToPath(adapter.manifest());
    const value = parseJson(readFileSync(manifest, 'utf8'));
    const bin = isRecord(value) && isRecord(value.bin) ? Object.values(value.bin).find((entry) => typeof entry === 'string') : undefined;
    return typeof bin === 'string' ? join(dirname(manifest), bin) : null;
  } catch { return null; }
};

/** How to start an agent: its command, or a bundled adapter run by this Node (or Electron as Node) on the owner's CLI. */
export interface AcpLaunch { command: string; args: string[]; env: Record<string, string> }

/** The agent's launch on `path`, or a plain sentence saying what's missing. */
export const launchFor = (agent: AcpAgent, path: string): AcpLaunch | { missing: string } => {
  const cli = findCommand(agent.command, path);
  if (!agent.bundled) return cli ? { command: cli, args: agent.args, env: {} } : { missing: `Serra can't find \`${agent.command}\`. Install ${agent.name}, or pick another agent.` };
  if (!cli) return { missing: `Serra can't find the \`${agent.bundled.cli}\` command. Install ${agent.name} and sign in, then try again.` };
  const entry = adapterEntry(agent.bundled);
  if (!entry) return { missing: `Serra's ${agent.name} adapter is missing. Reinstall Serra.` };
  // ELECTRON_RUN_AS_NODE: in the app, `process.execPath` is Electron, which then runs the script as plain Node.
  return { command: process.execPath, args: [entry, ...agent.args], env: { ELECTRON_RUN_AS_NODE: '1', [agent.bundled.cliEnv]: cli } };
};

/** One agent as the Settings picker shows it: whether it can start here, and whether the owner added it. Never its env. */
export interface AcpAgentChoice { id: string; name: string; command: string; installed: boolean; custom: boolean }

export const agentChoices = (settings: AgentBackendSettings, path: string): AcpAgentChoice[] => {
  const customIds = new Set(settings.custom.map((agent) => agent.id));
  return acpAgents(settings).map((agent) => ({
    id: agent.id, name: agent.name, command: [agent.command, ...agent.args].join(' '),
    installed: !('missing' in launchFor(agent, path)), custom: customIds.has(agent.id),
  }));
};

/** Settings › Worker's agent backend card: the choice, every agent with whether it's installed, and the config file path. */
export interface AgentBackendView {
  backend: 't3' | 'acp';
  agent: string | null;
  agents: AcpAgentChoice[];
  models: Record<string, string>;
  configPath: string;
  configError: string | null;
}
