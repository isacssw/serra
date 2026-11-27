// Pure rules for Settings › Worker › Agent backend: parsing an ACP command line, deriving a stable agent ID, and
// validating the "Add ACP agent" dialog before saving. Free of React, Electron and Node so `node --test` tests it directly.
import type { AcpAgentChoice } from '../../../../src/agent/acp-agents.ts';

export interface ParsedCommand {
  command: string;
  args: string[];
}

/**
 * Splits a single-line command into its executable and arguments, supporting single and double quotes (e.g. for an
 * absolute path with spaces). Returns an error sentence when empty, multiline or malformed.
 */
export const parseCommandLine = (raw: string): ParsedCommand | { error: string } => {
  if (/[\r\n\0]/.test(raw)) return { error: 'The command must be one line.' };
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        const next = raw[i + 1]!;
        if (next === '"' || next === '\\') { current += next; i += 1; continue; }
      }
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ''; inToken = false; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inToken = true; continue; }
    if (ch === '\\' && i + 1 < raw.length) { current += raw[i + 1]!; inToken = true; i += 1; continue; }
    current += ch;
    inToken = true;
  }
  if (quote) return { error: 'Close the quote in the command.' };
  if (inToken) tokens.push(current);
  const [command, ...args] = tokens;
  if (!command) return { error: 'Enter a command.' };
  if (command.startsWith('-')) return { error: 'The command can’t start with a hyphen.' };
  if (!command.startsWith('/') && command.includes('/')) return { error: 'Use a command name on your PATH or an absolute path.' };
  return { command, args };
};

/** Derives a stable lowercase ID from a display name, matching `agent-backend.json`'s ID rule. */
export const slugifyAgentId = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export interface CustomAgentDraft {
  name: string;
  commandLine: string;
}

export interface CustomAgentFormResult {
  value: { id: string; name: string; command: string; args: string[] } | null;
  errors: { name?: string; command?: string };
}

/** Validates the Add ACP agent form against the currently configured agents. */
export const validateCustomAgentForm = (
  draft: CustomAgentDraft,
  existing: readonly Pick<AcpAgentChoice, 'id' | 'name' | 'custom'>[],
): CustomAgentFormResult => {
  const errors: { name?: string; command?: string } = {};
  const name = draft.name.trim();
  const id = slugifyAgentId(name);
  if (!name) errors.name = 'Enter a name.';
  else if (/[\r\n\0]/.test(name)) errors.name = 'The name must be one line.';
  else if (name.length > 40) errors.name = 'Use at most 40 characters.';
  else if (!id) errors.name = 'Use letters or numbers in the name.';
  else {
    const clash = existing.find((entry) => entry.id === id);
    if (clash) {
      errors.name = clash.custom
        ? `An agent named "${clash.name}" is already added.`
        : `"${clash.name}" is already a built-in ACP agent.`;
    }
  }
  const parsed = parseCommandLine(draft.commandLine);
  if ('error' in parsed) errors.command = parsed.error;
  if (errors.name || errors.command || 'error' in parsed) return { value: null, errors };
  return { value: { id, name, command: parsed.command, args: parsed.args }, errors };
};

/** Only the agents the owner added themselves (from the UI or `agent-backend.json`). */
export const customAgents = (agents: readonly AcpAgentChoice[]): AcpAgentChoice[] =>
  agents.filter((agent) => agent.custom);

// ---------------------------------------------------------------------------------------------------------------
// The Agent picker on Settings › Worker
// ---------------------------------------------------------------------------------------------------------------

/** Which mark an agent or a T3 provider shows: a brand where Serra has one, else a generic glyph. */
export type AgentMark = 't3' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'cursor' | 'antigravity' | 'custom';

const MARKS: Record<string, AgentMark> = {
  claude: 'claude', claudeagent: 'claude', codex: 'codex', opencode: 'opencode', gemini: 'gemini', cursor: 'cursor',
  antigravity: 'antigravity',
};

/** The mark for an ACP agent id or a T3 driver kind (`claudeAgent`, `codex`, …). Unknown ones are `custom`. */
export const agentMark = (id: string): AgentMark => MARKS[id.toLowerCase()] ?? 'custom';

/** One choice in the Agent picker: T3, or an ACP agent. `value` is `t3` or `acp:<id>`. */
export interface AgentOption {
  value: string;
  name: string;
  /** The muted line under the name: what it is, or why it can't be picked. */
  detail: string;
  mark: AgentMark;
  disabled: boolean;
  /** A custom agent the owner added, which can be removed. */
  custom: boolean;
}

/** T3 first (the default), then the built-in ACP agents, then the owner's own. */
export const agentOptions = (agents: readonly AcpAgentChoice[]): AgentOption[] => [
  { value: 't3', name: 'T3 Code', detail: 'Default · any provider', mark: 't3', disabled: false, custom: false },
  ...[...agents.filter((agent) => !agent.custom), ...agents.filter((agent) => agent.custom)].map((agent): AgentOption => ({
    value: `acp:${agent.id}`,
    name: agent.name,
    detail: !agent.installed ? (agent.custom ? 'Not on PATH' : 'Not installed') : agent.custom ? 'Custom · ACP' : 'ACP',
    mark: agent.custom ? 'custom' : agentMark(agent.id),
    disabled: !agent.installed,
    custom: agent.custom,
  })),
];

/** The picker's draft: the chosen option and, for an ACP agent, its model (empty for the agent's default). */
export interface AgentDraft { choice: string; model: string }

/** What is saved now, as a draft. */
export const savedAgentDraft = (view: { backend: 't3' | 'acp'; agent: string | null; models: Record<string, string> }): AgentDraft =>
  view.backend === 'acp' && view.agent ? { choice: `acp:${view.agent}`, model: view.models[view.agent] ?? '' } : { choice: 't3', model: '' };

/** Whether Save has something to send. */
export const agentDraftChanged = (saved: AgentDraft, draft: AgentDraft): boolean =>
  saved.choice !== draft.choice || (draft.choice !== 't3' && saved.model !== draft.model.trim());

/** The `setAgentBackend` call for a draft. */
export const agentChoice = (draft: AgentDraft): { backend: 't3' } | { backend: 'acp'; agent: string; model: string } =>
  draft.choice === 't3' ? { backend: 't3' } : { backend: 'acp', agent: draft.choice.slice(4), model: draft.model.trim() };
