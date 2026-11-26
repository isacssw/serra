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
  if (!command) return { error: 'Enter a command, like agy acp.' };
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
  if (!name) errors.name = 'Enter a name, like Antigravity.';
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
