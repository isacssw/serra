// The MCP servers each provider really gives a job, from the provider's own CLI (SERRA-39). `claude mcp list` also
// shows claude.ai connectors and plugin servers, with a health check, which the config files can't; `codex mcp
// list --json` shows the servers Codex adds itself. When a CLI is missing or fails, the config files (src/mcp.ts)
// are used instead, and the overview says so. Read-only: nothing here adds, removes or signs in to a server.
//
// The CLIs print commands and URLs, which can carry tokens. Parsing happens here, in the main process, and only a
// server's name, transport, host and status leave this module (`reported`).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Profile } from './config.ts';
import { exec, findExecutable, type Exec, type ExecResult } from './exec.ts';
import {
  missingToolWarnings, readClaude, readCodex, reported, requiredTools, workerDrivers,
  type McpHealth, type McpListing, type McpOptions, type McpOverview, type McpScope, type McpTransport, type ReadServer, type WorkerDriver,
} from './mcp.ts';
import { toolSearchPath } from './shell-path.ts';

export interface LiveMcpOptions extends McpOptions {
  run?: Exec;
  /** The PATH to find `claude` and `codex` on. Defaults to the login shell's (src/shell-path.ts). */
  path?: string;
}

/** One line of `claude mcp list`: `name: target - ✔ Connected`. */
export interface ClaudeListEntry { name: string; target: string; transport: McpTransport; health: McpHealth | null; disabled: boolean }

const hostOf = (url: string): string | null => {
  try { return new URL(url).host || null; } catch { return null; }
};

const claudeHealth = (status: string): { health: McpHealth | null; disabled: boolean } => {
  if (/disabled/i.test(status)) return { health: null, disabled: true };
  if (/pending|approval/i.test(status)) return { health: 'pending', disabled: false };
  if (/auth/i.test(status)) return { health: 'needs-auth', disabled: false };
  if (/fail|error|✘/i.test(status)) return { health: 'failed', disabled: false };
  if (/connected|✔/i.test(status)) return { health: 'connected', disabled: false };
  return { health: null, disabled: false };
};

/** The servers in `claude mcp list` output. Lines that aren't a server (the "Checking…" header) are skipped. */
export const parseClaudeMcpList = (text: string): ClaudeListEntry[] => {
  const entries: ClaudeListEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon <= 0 || dash <= colon) continue;
    const name = line.slice(0, colon).trim();
    let target = line.slice(colon + 2, dash).trim();
    const kind = /\s\((HTTP|SSE)\)$/i.exec(target);
    if (kind) target = target.slice(0, kind.index).trim();
    const remote = /^https?:\/\//i.test(target);
    const transport: McpTransport = remote ? (kind?.[1]?.toUpperCase() === 'SSE' ? 'sse' : 'http') : 'stdio';
    entries.push({ name, target, transport, ...claudeHealth(line.slice(dash + 3)) });
  }
  return entries;
};

/** One server from `codex mcp list --json`. */
export interface CodexListEntry { name: string; enabled: boolean; transport: McpTransport | null; url: string; command: string; args: string; needsAuth: boolean }

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The servers in `codex mcp list --json`. Throws when the output isn't the JSON array Codex prints. */
export const parseCodexMcpList = (json: string): CodexListEntry[] => {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error('Not a server list');
  return value.map((item) => {
    const fields = record(item);
    const transport = record(fields.transport);
    const type = text(transport.type);
    return {
      name: text(fields.name),
      enabled: fields.enabled !== false,
      transport: (type === 'stdio' ? 'stdio' : /http/.test(type) ? 'http' : type === 'sse' ? 'sse' : null) as McpTransport | null,
      url: text(transport.url),
      command: text(transport.command),
      args: Array.isArray(transport.args) ? transport.args.filter((arg): arg is string => typeof arg === 'string').join(' ') : '',
      needsAuth: text(fields.auth_status) === 'not_logged_in',
    };
  }).filter((entry) => entry.name);
};

/** Where a server the files didn't have comes from, by its name in `claude mcp list`. */
const claudeOrigin = (name: string): { scope: McpScope; source: string } =>
  name.startsWith('claude.ai ') ? { scope: 'connector', source: 'claude.ai connector' }
    : name.startsWith('plugin:') ? { scope: 'plugin', source: 'Claude plugin' }
      : { scope: 'provider', source: 'Claude' };

/** The file entry for a name, preferring user scope (what a worktree job surely gets). */
const fileMatch = (servers: readonly ReadServer[], name: string): ReadServer | undefined =>
  servers.find((server) => server.name === name && server.scope === 'user') ?? servers.find((server) => server.name === name);

const loadFor = (health: McpHealth | null, file: ReadServer | undefined, disabled: boolean): Pick<ReadServer, 'load' | 'note'> => {
  if (disabled) return { load: 'disabled', note: file?.note ?? null };
  if (health === 'pending') return { load: 'unsure', note: file?.note ?? "Claude waits for this project's approval, and a T3 job can't give it." };
  if (file?.load === 'unsure') return { load: 'unsure', note: file.note };
  return { load: 'loads', note: null };
};

const merge = (listed: ReadServer[], files: readonly ReadServer[]): ReadServer[] => {
  const names = new Set(listed.map((server) => server.name));
  // Servers in the files that the CLI didn't list (a project server it skipped, a local one for another folder).
  return [...listed, ...files.filter((server) => !names.has(server.name))];
};

type Read = { servers: ReadServer[]; files: McpOverview['files']; listing: McpListing };

const failure = (cli: string, result: { missing: boolean; timedOut: boolean; code: number | null }): string =>
  result.missing ? `\`${cli}\` isn't installed, so this list is from the config files and can miss connectors and plugins.`
    : result.timedOut ? `\`${cli} mcp list\` took too long, so this list is from the config files.`
      : `\`${cli} mcp list\` failed (exit ${result.code ?? '?'}), so this list is from the config files.`;

/** Runs a provider CLI found on `path`, or reports it missing without spawning anything. */
const runCli = async (name: string, args: string[], run: Exec, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<ExecResult> => {
  const bin = findExecutable(name, env.PATH ?? '');
  if (!bin) return { code: null, stdout: '', stderr: '', missing: true, timedOut: false };
  return run(bin, args, { cwd, env, timeoutMs });
};

const listClaude = async (projectPath: string, home: string, options: LiveMcpOptions, run: Exec, env: NodeJS.ProcessEnv): Promise<Read> => {
  const fromFiles = readClaude(projectPath, home, options.env ?? process.env);
  // `claude mcp list` health-checks every server, so it gets time, but not forever. It runs in the project's
  // checkout so project servers show; a job's worktree is a copy of the same repository.
  const result = await runCli('claude', ['mcp', 'list'], run, env, existsSync(projectPath) ? projectPath : home, 45_000);
  const entries = result.code === 0 ? parseClaudeMcpList(result.stdout) : null;
  if (!entries) return { ...fromFiles, listing: { driver: 'claude', method: 'files', note: failure('claude', result) } };
  const listed = entries.map((entry): ReadServer => {
    const file = fileMatch(fromFiles.servers, entry.name);
    const origin = file ? { scope: file.scope, source: file.source } : claudeOrigin(entry.name);
    return {
      name: entry.name, driver: 'claude', ...origin,
      transport: entry.transport, host: entry.transport === 'stdio' ? null : hostOf(entry.target),
      health: entry.health, ...loadFor(entry.health, file, entry.disabled),
      fingerprint: [entry.name, entry.target, file?.fingerprint ?? ''].join(' '),
    };
  });
  return { servers: merge(listed, fromFiles.servers), files: fromFiles.files, listing: { driver: 'claude', method: 'cli', note: null } };
};

const listCodex = async (projectPath: string, home: string, options: LiveMcpOptions, run: Exec, env: NodeJS.ProcessEnv): Promise<Read> => {
  const fromFiles = readCodex(projectPath, home, options.env ?? process.env);
  const result = await runCli('codex', ['mcp', 'list', '--json'], run, env, existsSync(projectPath) ? projectPath : home, 20_000);
  let entries: CodexListEntry[] | null = null;
  if (result.code === 0) { try { entries = parseCodexMcpList(result.stdout); } catch { entries = null; } }
  if (!entries) return { ...fromFiles, listing: { driver: 'codex', method: 'files', note: failure('codex', result) } };
  const listed = entries.map((entry): ReadServer => {
    const file = fileMatch(fromFiles.servers, entry.name);
    const health: McpHealth | null = entry.needsAuth ? 'needs-auth' : null;
    return {
      name: entry.name, driver: 'codex',
      scope: file?.scope ?? 'provider', source: file?.source ?? 'Codex',
      transport: entry.transport ?? file?.transport ?? null, host: entry.url ? hostOf(entry.url) : file?.host ?? null,
      health, ...loadFor(health, file, !entry.enabled),
      fingerprint: [entry.name, entry.url, entry.command, entry.args].join(' '),
    };
  });
  return { servers: merge(listed, fromFiles.servers), files: fromFiles.files, listing: { driver: 'codex', method: 'cli', note: null } };
};

/**
 * The MCP servers the profile's worker will load, from each provider's CLI where it can, its config files where it
 * can't. Runs `claude mcp list` (which health-checks each server) and `codex mcp list --json`; writes nothing.
 */
export const liveMcpOverview = async (
  profile: Pick<Profile, 'project' | 'worker' | 'messageTriggers'>,
  options: LiveMcpOptions = {},
): Promise<McpOverview> => {
  const home = options.home ?? homedir();
  const run = options.run ?? exec;
  const path = options.path ?? await toolSearchPath({ home });
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PATH: path, NO_COLOR: '1' };
  const worker = workerDrivers(profile.worker?.provider);
  const reads = await Promise.all(worker.drivers.map((driver: WorkerDriver) =>
    (driver === 'claude' ? listClaude : listCodex)(profile.project.path, home, options, run, env)));
  const servers = reads.flatMap((read) => read.servers);
  return {
    worker,
    servers: servers.map(reported),
    warnings: missingToolWarnings(requiredTools(profile.messageTriggers), servers, worker.drivers),
    files: reads.flatMap((read) => read.files),
    listing: reads.map((read) => read.listing),
  };
};
