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
import { exec, findExecutable, toolEnv, type Exec, type ExecResult } from './exec.ts';
import {
  missingToolWarnings, readClaude, readCodex, reported, requiredTools, workerDrivers,
  type McpHealth, type McpListing, type McpOptions, type McpOverview, type McpScope, type McpTransport, type ReadServer, type WorkerDriver,
} from './mcp.ts';
import { loginEnvironment } from './shell-path.ts';

export interface LiveMcpOptions extends McpOptions {
  run?: Exec;
  /** The PATH to find `claude` and `codex` on. Defaults to the login shell's (src/shell-path.ts). */
  path?: string;
  /** Ask the login shell again instead of using its cached environment. */
  fresh?: boolean;
}

/** One line of `claude mcp list`: `name: target - ✔ Connected`. */
export interface ClaudeListEntry { name: string; target: string; transport: McpTransport; health: McpHealth | null; disabled: boolean; unknown: boolean }

const hostOf = (url: string): string | null => {
  try { return new URL(url).host || null; } catch { return null; }
};

/** Where the status starts: the first ` - ` followed by something Claude prints as a status. */
const CLAUDE_ROW = /^(.+?): (.*?) - ((?:[✓✔✗✘!⏸⊘○•-]\s(?=\p{L})|Connected|Failed|Needs|Pending|Disabled|Rejected|Blocked|Connection|Not configured).*)$/u;

/**
 * What a status says, from its start only: Claude can append detail (`✗ Failed to connect — timeout`,
 * `⏸ Pending approval (run \`claude\` to approve)`), which is never kept. A status Serra doesn't know is `unknown`:
 * the row is kept, marked uncertain, rather than dropped.
 */
const claudeStatus = (status: string): { health: McpHealth | null; disabled: boolean; unknown: boolean } => {
  const text = status.replace(/^[^\p{L}]+/u, '');
  const found = (health: McpHealth | null, disabled = false) => ({ health, disabled, unknown: false });
  if (/^(Disabled|Rejected|Blocked)\b/i.test(text)) return found(null, true);
  if (/^Not configured\b/i.test(text)) return found('failed');
  if (/^Pending approval\b/i.test(text)) return found('pending');
  if (/^Needs auth/i.test(text)) return found('needs-auth');
  if (/^(Failed|Connection (error|failed|closed))\b/i.test(text)) return found('failed');
  // `! Connected · tools fetch failed` connected but can't list tools: not healthy.
  if (/^Connected\b/i.test(text)) return /fail|error/i.test(text) ? found('failed') : found('connected');
  return { health: null, disabled: false, unknown: true };
};

/** A server name worth showing: letters, digits, spaces and a little punctuation, never a line of arbitrary output. */
const SERVER_NAME = /^[\p{L}\p{N}_ .:@/+&()'-]{1,100}$/u;

/**
 * The servers in `claude mcp list` output, or null when the output has neither a server row nor Claude's "no
 * servers" sentence: that's output Serra doesn't understand, and the caller falls back to the config files.
 */
export const parseClaudeMcpList = (text: string): ClaudeListEntry[] | null => {
  const entries: ClaudeListEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = CLAUDE_ROW.exec(raw.trim());
    if (!match) continue;
    const name = match[1]!.trim();
    if (!SERVER_NAME.test(name)) continue;
    let target = match[2]!.trim();
    const kind = /\s\((HTTP|SSE)\)$/i.exec(target);
    if (kind) target = target.slice(0, kind.index).trim();
    const remote = /^https?:\/\//i.test(target);
    const transport: McpTransport = remote ? (kind?.[1]?.toUpperCase() === 'SSE' ? 'sse' : 'http') : 'stdio';
    entries.push({ name, target, transport, ...claudeStatus(match[3]!) });
  }
  return entries.length || /no mcp servers configured/i.test(text) ? entries : null;
};

/** One server from `codex mcp list --json`. */
export interface CodexListEntry { name: string; enabled: boolean; transport: McpTransport | null; url: string; command: string; args: string; needsAuth: boolean }

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The servers in `codex mcp list --json`. Throws when the output isn't the JSON array of servers Codex prints. */
export const parseCodexMcpList = (json: string): CodexListEntry[] => {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error('Not a server list');
  return value.map((item) => {
    const fields = record(item);
    const transport = record(fields.transport);
    if (!SERVER_NAME.test(text(fields.name)) || typeof transport.type !== 'string') throw new Error('Not a server row');
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

/** Claude's precedence when one name is defined in several places: local, then project, then user. */
const PRECEDENCE: Record<string, number> = { local: 0, project: 1, user: 2 };

/** The file entry the CLI's row stands for: the one with the same name that wins in Claude's precedence. */
const fileMatch = (servers: readonly ReadServer[], name: string): ReadServer | undefined =>
  servers.filter((server) => server.name === name).sort((a, b) => (PRECEDENCE[a.scope] ?? 9) - (PRECEDENCE[b.scope] ?? 9))[0];

const loadFor = (health: McpHealth | null, file: ReadServer | undefined, disabled: boolean): Pick<ReadServer, 'load' | 'note'> => {
  if (disabled) return { load: 'disabled', note: file?.note ?? null };
  if (health === 'pending') return { load: 'unsure', note: file?.note ?? "Claude waits for this project's approval, and a T3 job can't give it." };
  if (file?.load === 'unsure') return { load: 'unsure', note: file.note };
  return { load: 'loads', note: null };
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

const unreadable = (cli: string): string => `Serra couldn't read \`${cli} mcp list\`, so this list is from the config files.`;

const listClaude = async (projectPath: string, home: string, options: LiveMcpOptions, run: Exec, env: NodeJS.ProcessEnv): Promise<Read> => {
  const fromFiles = readClaude(projectPath, home, options.env ?? process.env);
  // `claude mcp list` health-checks every server, so it gets time, but not forever. It runs in the project's
  // checkout so project servers show; a job's worktree is a copy of the same repository.
  const result = await runCli('claude', ['mcp', 'list'], run, env, existsSync(projectPath) ? projectPath : home, 45_000);
  const entries = result.code === 0 ? parseClaudeMcpList(result.stdout) : null;
  if (!entries) return { ...fromFiles, listing: { driver: 'claude', method: 'files', note: result.code === 0 ? unreadable('claude') : failure('claude', result) } };
  const listed = entries.map((entry): ReadServer => {
    const file = fileMatch(fromFiles.servers, entry.name);
    const origin = file ? { scope: file.scope, source: file.source } : claudeOrigin(entry.name);
    return {
      name: entry.name, driver: 'claude', ...origin,
      transport: entry.transport, host: entry.transport === 'stdio' ? null : hostOf(entry.target),
      health: entry.health,
      ...(entry.unknown ? { load: 'unsure' as const, note: "Claude reported a status Serra doesn't recognise." } : loadFor(entry.health, file, entry.disabled)),
      fingerprint: [entry.name, entry.target, file?.fingerprint ?? ''].join(' '),
    };
  });
  // The CLI is the authority: a server only in the files (turned off by policy, or for another folder) isn't shown.
  return { servers: listed, files: fromFiles.files, listing: { driver: 'claude', method: 'cli', note: null } };
};

const listCodex = async (projectPath: string, home: string, options: LiveMcpOptions, run: Exec, env: NodeJS.ProcessEnv): Promise<Read> => {
  const fromFiles = readCodex(projectPath, home, options.env ?? process.env);
  const result = await runCli('codex', ['mcp', 'list', '--json'], run, env, existsSync(projectPath) ? projectPath : home, 20_000);
  let entries: CodexListEntry[] | null = null;
  if (result.code === 0) { try { entries = parseCodexMcpList(result.stdout); } catch { entries = null; } }
  if (!entries) return { ...fromFiles, listing: { driver: 'codex', method: 'files', note: result.code === 0 ? unreadable('codex') : failure('codex', result) } };
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
  return { servers: listed, files: fromFiles.files, listing: { driver: 'codex', method: 'cli', note: null } };
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
  const login = options.path !== undefined ? { path: options.path, env: null } : await loginEnvironment({ home, fresh: options.fresh });
  // The provider CLIs get the login environment, as T3 gives its jobs: a health check needs the variables a
  // server's config refers to (`${GITHUB_TOKEN}` in a header, a token a local server reads). Without it, the
  // allowlist only, so a server may show Failed here and still work in a job.
  const env: NodeJS.ProcessEnv = login.env
    ? { ...login.env, PATH: login.path, NO_COLOR: '1' }
    : toolEnv(login.path, { ...process.env, ...options.env });
  const worker = workerDrivers(profile.worker?.provider);
  // The fallback reads the config folders the CLI would: CLAUDE_CONFIG_DIR and CODEX_HOME from the same environment.
  const configEnv = options.env ?? login.env ?? process.env;
  const reads = await Promise.all(worker.drivers.map((driver: WorkerDriver) =>
    (driver === 'claude' ? listClaude : listCodex)(profile.project.path, home, { ...options, env: configEnv }, run, env)));
  const servers = reads.flatMap((read) => read.servers);
  return {
    worker,
    servers: servers.map(reported),
    warnings: missingToolWarnings(requiredTools(profile.messageTriggers), servers, worker.drivers),
    files: reads.flatMap((read) => read.files),
    listing: reads.map((read) => read.listing),
  };
};
