// The MCP servers a bot's worker will have in T3 (APP-23), read-only.
//
// T3 runs each job through a provider (Claude, Codex, Cursor, …: the list is T3's, src/t3-providers.ts), and that
// provider loads MCP servers from its own config. Serra reads Claude's and Codex's; the others show as not supported yet.
// Serra never configures them: this module only reads those files to show what a job will get, and warns when the
// profile clearly needs a server that isn't there (an alert trigger that investigates Sentry alerts, with no Sentry
// server). MCP configs hold tokens in `env`, `headers` and command arguments, so a server is reported only by its
// name, scope, transport and host: never its command, arguments, environment, headers or full URL. A parse error
// is reported as a fixed sentence, because a parser's message can quote the text around the error.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MessageTrigger, Profile } from './config.ts';
import { providerFor, readT3Providers, type McpReader, type T3Provider, type T3Providers } from './t3-providers.ts';

/** A provider kind whose MCP config Serra can read. T3's other providers are listed as "not supported yet". */
export type WorkerDriver = McpReader;

export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Whether a T3 job will get the server: `loads`, `disabled` (turned off in the config), or `unsure` (it depends on
 * something Serra can't see from the files, such as a project approval or which folder the job runs in).
 */
type McpLoad = 'loads' | 'disabled' | 'unsure';

/**
 * Where a server comes from: for every folder (`user`), the project's checkout (`project`), one folder (`local`),
 * a claude.ai connector (`connector`), a plugin (`plugin`), or the provider itself, outside the files Serra reads
 * (`provider`: Codex's bundled servers, for example). The last three are only known from the provider's CLI.
 */
export type McpScope = 'user' | 'project' | 'local' | 'connector' | 'plugin' | 'provider';

/**
 * What the provider's own CLI said about a server: `connected` (it answered a health check), `needs-auth` (it
 * needs a sign-in), `failed` (it didn't connect), `pending` (Claude waits for the project's approval). Null when
 * there was no check: Codex lists servers without connecting, and the config files say nothing about health.
 */
export type McpHealth = 'connected' | 'needs-auth' | 'failed' | 'pending';

export interface McpServer {
  name: string;
  driver: WorkerDriver;
  scope: McpScope;
  /** The config file, with the home folder shown as `~`. */
  source: string;
  transport: McpTransport | null;
  /** A remote server's host, like `mcp.example.com`. Never its path, query or credentials. */
  host: string | null;
  load: McpLoad;
  /** Why `load` is what it is, when that isn't obvious. */
  note: string | null;
  health: McpHealth | null;
}

/** A tool the profile needs, by name, and the trigger channels that need it. */
export interface McpWarning {
  /** A known tool's label, like `Sentry`. */
  tool: string;
  driver: WorkerDriver;
  /** The channels of the message triggers whose instructions mention the tool. */
  channels: string[];
  text: string;
}

export interface McpConfigFile {
  driver: WorkerDriver;
  scope: McpScope | 'settings';
  /** With `~` for the home folder. */
  path: string;
  /** `missing`, `read`, or `unreadable` (not valid JSON/TOML, or no permission). */
  state: 'missing' | 'read' | 'unreadable';
}

/** A provider T3 can run the worker with, from T3's settings, and whether Serra can read its MCP setup. */
interface WorkerProvider {
  instanceId: string;
  label: string;
  /** Serra's reader for its MCP servers, or null: "not supported yet". */
  driver: WorkerDriver | null;
}

export interface McpOverview {
  worker: {
    /** `worker.provider` from the profile, or null when T3 uses the project's default. */
    provider: string | null;
    /** The provider kinds whose servers are listed. */
    drivers: WorkerDriver[];
    /**
     * The providers the worker may run on, from T3's settings: the profile's one, else every one turned on in T3.
     * Empty when Serra couldn't read T3's settings (then `drivers` is a guess and `note` says so).
     */
    providers: WorkerProvider[];
    /** Why the list is what it is, when that isn't obvious. */
    note: string | null;
  };
  servers: McpServer[];
  warnings: McpWarning[];
  /** Every config file looked at, so the owner can see where to make a change. */
  files: McpConfigFile[];
  /** How each provider's servers were found: its CLI (`claude mcp list`), or only its config files, and why. */
  listing: McpListing[];
}

export interface McpListing {
  driver: WorkerDriver;
  method: 'cli' | 'files';
  /** Why the files were used instead of the CLI, in one short sentence. Null for the CLI. */
  note: string | null;
}

/**
 * Tools a message trigger's instructions can name, and how to recognise their MCP server. A tool counts as needed
 * only when a trigger's instructions name it, so the words here are product names, not ordinary English.
 */
const KNOWN_TOOLS: readonly { id: string; label: string; mentioned: RegExp; server: RegExp }[] = [
  { id: 'sentry', label: 'Sentry', mentioned: /\bsentry\b/i, server: /sentry/i },
  { id: 'datadog', label: 'Datadog', mentioned: /\bdatadog\b/i, server: /datadog/i },
  { id: 'pagerduty', label: 'PagerDuty', mentioned: /\bpager\s?duty\b/i, server: /pager-?duty/i },
  { id: 'grafana', label: 'Grafana', mentioned: /\bgrafana\b/i, server: /grafana/i },
];

/** Where the provider configs live. Tests point these at a temp folder. */
export interface McpOptions {
  /** The user's home folder. */
  home?: string;
  /** Only `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `T3CODE_HOME` are read. */
  env?: Record<string, string | undefined>;
}

const DRIVER_LABELS: Record<WorkerDriver, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * Which providers a profile's worker can run on, and so whose MCP servers to list. The list comes from T3's own
 * settings (src/t3-providers.ts): the profile's `worker.provider` instance, else every provider turned on in T3.
 * Without T3's settings, Serra falls back to guessing from the instance name, and says so.
 */
export const workerDrivers = (provider: string | undefined, t3: T3Providers | null = null): McpOverview['worker'] => {
  if (t3) {
    const view = (entry: T3Provider): WorkerProvider => ({ instanceId: entry.instanceId, label: entry.label, driver: entry.mcp });
    const chosen = provider ? providerFor(t3, provider) : null;
    if (provider && !chosen) {
      return { provider, drivers: [], providers: [], note: `T3 has no provider "${provider}". Pick one that exists in the profile's worker settings.` };
    }
    const on = chosen ? [chosen] : t3.providers.filter((entry) => entry.enabled);
    const drivers = [...new Set(on.flatMap((entry) => (entry.mcp ? [entry.mcp] : [])))];
    const note = chosen && !chosen.enabled ? `${chosen.label} is turned off in T3, so jobs can't start until it's on.`
      : !chosen && !on.length ? 'No provider is turned on in T3.' : null;
    return { provider: provider ?? null, drivers, providers: on.map(view), note };
  }
  const guess = (drivers: WorkerDriver[], note: string | null): McpOverview['worker'] => ({ provider: provider ?? null, drivers, providers: [], note });
  const unread = "Serra couldn't read T3's provider settings";
  if (!provider) return guess(['claude', 'codex'], `${unread}, so servers for both Claude and Codex are listed.`);
  if (/claude/i.test(provider)) return guess(['claude'], null);
  if (/codex/i.test(provider)) return guess(['codex'], null);
  return guess(['claude', 'codex'], `${unread}, and can't tell whether "${provider}" is Claude or Codex, so servers for both are listed.`);
};

// ---------------------------------------------------------------------------------------------------------------
// Reading configs
// ---------------------------------------------------------------------------------------------------------------

/** A server as read, with the text used to recognise a known tool. That text stays in the main process. */
export interface ReadServer extends McpServer { fingerprint: string }

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const hostOf = (url: string): string | null => {
  try { return new URL(url).host || null; } catch { return null; }
};

const shortPath = (path: string, home: string): string =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

type ReadResult<T> = { state: 'missing' } | { state: 'unreadable' } | { state: 'read'; value: T };

const readJson = (path: string): ReadResult<Record<string, unknown>> => {
  if (!existsSync(path)) return { state: 'missing' };
  try {
    const value = record(JSON.parse(readFileSync(path, 'utf8')));
    return value ? { state: 'read', value } : { state: 'unreadable' };
  } catch { return { state: 'unreadable' }; }
};

const readText = (path: string): ReadResult<string> => {
  if (!existsSync(path)) return { state: 'missing' };
  try { return { state: 'read', value: readFileSync(path, 'utf8') }; } catch { return { state: 'unreadable' }; }
};

/** One server entry from a Claude `mcpServers` object. */
const claudeServer = (name: string, entry: unknown, base: Omit<McpServer, 'name' | 'transport' | 'host' | 'health'>): ReadServer => {
  const fields = record(entry) ?? {};
  const url = text(fields.url);
  const type = text(fields.type);
  const transport: McpTransport | null = type === 'stdio' || type === 'http' || type === 'sse'
    ? type
    : url ? 'http' : text(fields.command) ? 'stdio' : null;
  return {
    name, ...base, transport, host: url ? hostOf(url) : null, health: null,
    fingerprint: [name, url, text(fields.command), ...strings(fields.args)].join(' '),
  };
};

const claudeServers = (servers: unknown, base: Omit<McpServer, 'name' | 'transport' | 'host' | 'health'>): ReadServer[] =>
  Object.entries(record(servers) ?? {}).map(([name, entry]) => claudeServer(name, entry, base));

/**
 * Claude Code's MCP servers for jobs in `projectPath`:
 * - user scope: `mcpServers` in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set), loaded everywhere;
 * - local scope: `projects[<path>].mcpServers` in the same file, which belongs to that exact folder, while T3 runs
 *   each job in its own worktree;
 * - project scope: `.mcp.json` in the checkout, which Claude loads once the project's servers are approved
 *   (`enableAllProjectMcpServers` in a settings file, or per server for the folder in `~/.claude.json`).
 */
export const readClaude = (projectPath: string, home: string, env: McpOptions['env']): { servers: ReadServer[]; files: McpConfigFile[] } => {
  const configDir = env?.CLAUDE_CONFIG_DIR || null;
  const userFile = join(configDir ?? home, '.claude.json');
  const settingsFiles = [
    { path: join(configDir ?? join(home, '.claude'), 'settings.json'), scope: 'settings' as const },
    { path: join(projectPath, '.claude', 'settings.json'), scope: 'settings' as const },
    { path: join(projectPath, '.claude', 'settings.local.json'), scope: 'settings' as const },
  ];
  const projectFile = join(projectPath, '.mcp.json');
  const files: McpConfigFile[] = [];
  const servers: ReadServer[] = [];
  const show = (path: string) => shortPath(path, home);

  const user = readJson(userFile);
  files.push({ driver: 'claude', scope: 'user', path: show(userFile), state: user.state });
  const config = user.state === 'read' ? user.value : {};
  servers.push(...claudeServers(config.mcpServers, { driver: 'claude', scope: 'user', source: show(userFile), load: 'loads', note: null }));

  const folder = record(record(config.projects)?.[projectPath]) ?? {};
  servers.push(...claudeServers(folder.mcpServers, {
    driver: 'claude', scope: 'local', source: show(userFile), load: 'unsure',
    note: `Added for ${show(projectPath)} only. T3 runs each job in its own worktree, which may not get it. Add it with user scope to be sure.`,
  }));

  let approveAll = false;
  for (const settings of settingsFiles) {
    const read = readJson(settings.path);
    files.push({ driver: 'claude', scope: settings.scope, path: show(settings.path), state: read.state });
    if (read.state === 'read' && read.value.enableAllProjectMcpServers === true) approveAll = true;
  }
  const enabled = new Set(strings(folder.enabledMcpjsonServers));
  const disabled = new Set(strings(folder.disabledMcpjsonServers));

  const project = readJson(projectFile);
  files.push({ driver: 'claude', scope: 'project', path: show(projectFile), state: project.state });
  if (project.state === 'read') {
    for (const server of claudeServers(project.value.mcpServers, { driver: 'claude', scope: 'project', source: show(projectFile), load: 'unsure', note: null })) {
      if (disabled.has(server.name)) {
        servers.push({ ...server, load: 'disabled', note: 'Turned off for this project in Claude.' });
      } else if (approveAll) {
        servers.push({ ...server, load: 'loads', note: null });
      } else if (enabled.has(server.name)) {
        servers.push({ ...server, note: `Approved for ${show(projectPath)} in Claude. A job's worktree may ask again; set enableAllProjectMcpServers to be sure.` });
      } else {
        servers.push({ ...server, note: "Claude asks before it loads a project's servers, and a T3 job can't answer. Approve it in Claude or set enableAllProjectMcpServers." });
      }
    }
  }
  return { servers, files };
};

/** A TOML key path like `mcp_servers."my server".enabled`, split on dots outside quotes. */
const tomlKeys = (path: string): string[] => {
  const keys: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of path.trim()) {
    if (quote) { if (char === quote) quote = null; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '.') { keys.push(current.trim()); current = ''; }
    else current += char;
  }
  keys.push(current.trim());
  return keys;
};

/**
 * A TOML scalar: a basic or literal string, or a boolean. Anything else is kept as its raw text. A comment after a
 * bare value (`enabled = false # off for now`) isn't part of it.
 */
export const tomlScalar = (raw: string): string | boolean => {
  const value = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value);
  if (quoted) return quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, '$1') : quoted[2]!;
  const bare = value.replace(/\s*#.*$/, '').trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  return bare;
};

/** The `key = value` pairs of an inline table `{ a = "x", b = false }`, scalars only. */
const inlineTable = (raw: string): Record<string, string | boolean> => {
  const fields: Record<string, string | boolean> = {};
  const pair = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false)/g;
  for (const match of raw.matchAll(pair)) fields[match[1]!] = tomlScalar(match[2]!);
  return fields;
};

/**
 * The `[mcp_servers.<name>]` tables of a Codex `config.toml`: each name with its `command`, `url`, `args` text and
 * `enabled`. Not a full TOML parser, only enough for these tables: table headers, dotted keys, inline tables and
 * scalar values. Values of other tables are never kept.
 */
export const parseCodexServers = (toml: string): Map<string, { command: string; url: string; args: string; enabled: boolean }> => {
  const servers = new Map<string, { command: string; url: string; args: string; enabled: boolean }>();
  const entry = (name: string) => {
    let server = servers.get(name);
    if (!server) { server = { command: '', url: '', args: '', enabled: true }; servers.set(name, server); }
    return server;
  };
  const set = (name: string, key: string, value: string | boolean) => {
    const server = entry(name);
    if (key === 'enabled') server.enabled = value !== false;
    else if (key === 'command' && typeof value === 'string') server.command = value;
    else if (key === 'url' && typeof value === 'string') server.url = value;
    else if (key === 'args' && typeof value === 'string') server.args = value;
  };
  let table: string[] = [];
  let openArray: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const trimmed = line.trim();
    // A multi-line `args = [` array: keep its text (to recognise a tool) until it closes.
    if (openArray !== null) {
      if (table[0] === 'mcp_servers' && table.length === 2) entry(table[1]!).args += ` ${trimmed}`;
      if (trimmed.startsWith(']')) openArray = null;
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Keys under an array of tables belong to that array, never to `mcp_servers`.
    if (trimmed.startsWith('[[')) { table = ['[[array]]']; continue; }
    const header = /^\[([^\]]+)\]\s*(#.*)?$/.exec(trimmed);
    if (header) {
      table = tomlKeys(header[1]!);
      if (table[0] === 'mcp_servers' && table.length === 2) entry(table[1]!);
      continue;
    }
    const assignment = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment) continue;
    const keys = [...table, ...tomlKeys(assignment[1]!)];
    const value = assignment[2]!;
    if (keys[0] !== 'mcp_servers' || keys.length < 2) continue;
    const name = keys[1]!;
    if (keys.length === 2) {
      // `name = { command = "…", … }` under `[mcp_servers]`.
      entry(name);
      if (value.startsWith('{')) for (const [key, field] of Object.entries(inlineTable(value))) set(name, key, field);
      if (/\bargs\s*=\s*\[/.test(value)) entry(name).args += ` ${value}`;
    } else if (keys.length === 3) {
      if (keys[2] === 'args' && value.startsWith('[')) {
        entry(name).args += ` ${value}`;
        if (!value.includes(']')) openArray = name;
      } else set(name, keys[2]!, tomlScalar(value));
    }
  }
  return servers;
};

/**
 * Codex's MCP servers: `[mcp_servers.*]` in `$CODEX_HOME/config.toml` (default `~/.codex`), loaded everywhere unless
 * `enabled = false`, and in the checkout's `.codex/config.toml`, which Codex reads only for a trusted project.
 */
export const readCodex = (projectPath: string, home: string, env: McpOptions['env']): { servers: ReadServer[]; files: McpConfigFile[] } => {
  const codexHome = env?.CODEX_HOME || join(home, '.codex');
  const show = (path: string) => shortPath(path, home);
  const sources = [
    { path: join(codexHome, 'config.toml'), scope: 'user' as const },
    { path: join(projectPath, '.codex', 'config.toml'), scope: 'project' as const },
  ];
  const files: McpConfigFile[] = [];
  const servers: ReadServer[] = [];
  for (const source of sources) {
    const read = readText(source.path);
    files.push({ driver: 'codex', scope: source.scope, path: show(source.path), state: read.state });
    if (read.state !== 'read') continue;
    for (const [name, server] of parseCodexServers(read.value)) {
      const load: McpLoad = !server.enabled ? 'disabled' : source.scope === 'project' ? 'unsure' : 'loads';
      servers.push({
        name, driver: 'codex', scope: source.scope, source: show(source.path),
        transport: server.url ? 'http' : server.command ? 'stdio' : null,
        host: server.url ? hostOf(server.url) : null,
        load, health: null,
        note: load === 'disabled' ? 'Turned off with enabled = false.'
          : load === 'unsure' ? "Codex reads a project's config only when the project is trusted, and a T3 job runs in its own worktree." : null,
        fingerprint: [name, server.url, server.command, server.args].join(' '),
      });
    }
  }
  return { servers, files };
};

// ---------------------------------------------------------------------------------------------------------------
// What the profile needs
// ---------------------------------------------------------------------------------------------------------------

/** The known tools each message trigger's instructions name, keyed by tool id, with the channels that name it. */
export const requiredTools = (triggers: readonly MessageTrigger[] | undefined): Map<string, string[]> => {
  const needed = new Map<string, string[]>();
  for (const trigger of triggers ?? []) {
    for (const tool of KNOWN_TOOLS) {
      if (!tool.mentioned.test(trigger.instructions)) continue;
      const channels = needed.get(tool.id) ?? [];
      if (!channels.includes(trigger.channel)) channels.push(trigger.channel);
      needed.set(tool.id, channels);
    }
  }
  return needed;
};

const channelList = (channels: string[]): string => {
  if (channels.length === 1) return `The alert trigger for channel ${channels[0]}`;
  return `The alert triggers for channels ${channels.slice(0, -1).join(', ')} and ${channels.at(-1)}`;
};

/** A warning for each needed tool that the worker won't surely have, per provider kind. */
export const missingToolWarnings = (
  needed: Map<string, string[]>,
  servers: readonly (McpServer & { fingerprint?: string })[],
  drivers: readonly WorkerDriver[],
): McpWarning[] => {
  const warnings: McpWarning[] = [];
  for (const [id, channels] of needed) {
    const tool = KNOWN_TOOLS.find((known) => known.id === id)!;
    for (const driver of drivers) {
      const matches = servers.filter((server) => server.driver === driver && tool.server.test(server.fingerprint ?? `${server.name} ${server.host ?? ''}`));
      if (matches.some((server) => server.load === 'loads')) continue;
      const provider = DRIVER_LABELS[driver];
      const subject = `${channelList(channels)} ${channels.length === 1 ? 'mentions' : 'mention'} ${tool.label}`;
      const why = matches.some((server) => server.load === 'unsure')
        ? `the only ${tool.label} MCP server for ${provider} (${matches.filter((server) => server.load === 'unsure').map((server) => server.name).join(', ')}) may not load in a T3 job`
        : matches.length
          ? `the ${tool.label} MCP server for ${provider} (${matches.map((server) => server.name).join(', ')}) is turned off`
          : `${provider} has no ${tool.label} MCP server`;
      warnings.push({
        tool: tool.label, driver, channels: [...channels],
        text: `${subject}, but ${why}. Investigations can't read ${tool.label} without it. Add it in ${provider}'s MCP settings.`,
      });
    }
  }
  return warnings;
};

/**
 * The MCP servers the profile's worker will load in T3, and what it is missing. Reads the provider configs and
 * the profile; writes nothing and starts nothing.
 */
export const mcpOverview = (profile: Pick<Profile, 'project' | 'worker' | 'messageTriggers'>, options: McpOptions = {}): McpOverview => {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const worker = workerDrivers(profile.worker?.provider, readT3Providers({ home, env }));
  const read = worker.drivers.map((driver) => (driver === 'claude' ? readClaude : readCodex)(profile.project.path, home, env));
  const servers = read.flatMap((result) => result.servers);
  const warnings = missingToolWarnings(requiredTools(profile.messageTriggers), servers, worker.drivers);
  return {
    worker,
    servers: servers.map(reported),
    warnings,
    files: read.flatMap((result) => result.files),
    listing: worker.drivers.map((driver) => ({ driver, method: 'files', note: null })),
  };
};

/** Only the reported fields of a server: the fingerprint holds commands and arguments, which can carry tokens. */
export const reported = ({ name, driver, scope, source, transport, host, load, note, health }: McpServer): McpServer =>
  ({ name, driver, scope, source, transport, host, load, note, health });

/** Plain text for `pnpm bot tools`. */
export const formatMcpOverview = (overview: McpOverview): string => {
  const lines: string[] = [];
  lines.push(overview.worker.provider ? `Worker provider: ${overview.worker.provider}` : "Worker provider: T3's project default");
  if (overview.worker.note) lines.push(overview.worker.note);
  for (const provider of overview.worker.providers) {
    if (!provider.driver) lines.push(`${provider.label}: not supported yet. Serra can't read its MCP servers; check them in ${provider.label}.`);
  }
  for (const listing of overview.listing) if (listing.note) lines.push(`${DRIVER_LABELS[listing.driver]}: ${listing.note}`);
  for (const warning of overview.warnings) lines.push(`! ${warning.text}`);
  for (const driver of overview.worker.drivers) {
    lines.push('', `${DRIVER_LABELS[driver]}:`);
    const servers = overview.servers.filter((server) => server.driver === driver);
    if (!servers.length) lines.push('  No MCP servers.');
    for (const server of servers) {
      const where = server.host ? `${server.transport ?? 'remote'} ${server.host}` : server.transport ?? 'unknown transport';
      const state = server.load === 'disabled' ? 'off' : server.health ?? server.load;
      lines.push(`  ${server.name}  ${state}  ${server.scope}, ${where}, ${server.source}${server.note ? `\n    ${server.note}` : ''}`);
    }
    for (const file of overview.files.filter((entry) => entry.driver === driver && entry.state === 'unreadable')) {
      lines.push(`  Couldn't read ${file.path}.`);
    }
  }
  return lines.join('\n');
};
