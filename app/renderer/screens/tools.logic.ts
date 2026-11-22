// The Tools screen's logic (APP-23, SERRA-39): server groups per provider, one status per server and per CLI, and
// which services to recommend. Pure functions, tested with `node --test`.
import type { CliOverview, CliStatus } from '../../../src/clis.ts';
import type { McpOverview, McpScope, McpServer, WorkerDriver } from '../../../src/mcp.ts';
import { CLI_CATALOG, PROVIDER_MCP, RECOMMENDATIONS, type CliSpec, type Recommendation, type ToolIcon } from '../../../src/tool-catalog.ts';
import type { BrandId } from '../ui/brand-icons.ts';

const DRIVER_NAMES: Record<WorkerDriver, string> = { claude: 'Claude', codex: 'Codex' };

/** A status pill's colour. `off` is a quiet grey dot. */
type StatusTone = 'up' | 'warn' | 'down' | 'neutral' | 'off';
export interface Status { tone: StatusTone; text: string }

const SCOPE_LABELS: Record<McpScope, string> = {
  user: 'User config', project: 'Project', local: 'This folder only', connector: 'claude.ai connector', plugin: 'Plugin', provider: 'Built in',
};

const SCOPE_ORDER: Record<McpScope, number> = { user: 0, connector: 1, plugin: 2, provider: 3, project: 4, local: 5 };

/** One status for a server: what its provider's health check said, else whether it loads. */
export const serverStatus = (server: Pick<McpServer, 'load' | 'health'>): Status => {
  if (server.load === 'disabled') return { tone: 'off', text: 'Off' };
  // Before health: a server that connects from the checkout may still not reach a job's worktree.
  if (server.load === 'unsure') return { tone: 'warn', text: 'May not load' };
  if (server.health === 'connected') return { tone: 'up', text: 'Connected' };
  if (server.health === 'needs-auth') return { tone: 'warn', text: 'Needs sign-in' };
  if (server.health === 'failed') return { tone: 'down', text: 'Failed' };
  if (server.health === 'pending') return { tone: 'warn', text: 'Needs approval' };
  // Turned on, but nobody checked it answers (Codex lists servers without connecting).
  return { tone: 'neutral', text: 'Enabled' };
};

const STATUS_ORDER: Record<StatusTone, number> = { down: 0, warn: 1, up: 2, neutral: 3, off: 4 };

/** "HTTP · mcp.example.com", "Local command" or "Unknown transport". */
export const transportLabel = (server: Pick<McpServer, 'transport' | 'host'>): string => {
  if (server.transport === 'stdio') return 'Local command';
  const kind = server.transport === 'sse' ? 'SSE' : server.transport === 'http' ? 'HTTP' : null;
  if (!kind) return server.host ?? 'Unknown transport';
  return server.host ? `${kind} · ${server.host}` : kind;
};

/** A claude.ai connector's name without its prefix: "claude.ai Gmail" → "Gmail". */
export const serverLabel = (server: Pick<McpServer, 'name' | 'scope'>): string =>
  server.scope === 'connector' ? server.name.replace(/^claude\.ai\s+/, '') : server.name;

export interface DriverGroup {
  driver: WorkerDriver;
  title: string;
  servers: McpServer[];
  /** "3 servers" or "No servers". */
  summary: string;
  /** Why the list came from config files instead of the provider's CLI, when it did. */
  listingNote: string | null;
  /** Config files that exist but couldn't be read. */
  unreadable: string[];
  /** The provider's command to add a server, and its docs, for the hint line. Serra never runs it. */
  hint: { command: string; docs: string };
}

/** One group per provider the worker may use: problems first, then by where the server comes from, then by name. */
export const driverGroups = (overview: McpOverview): DriverGroup[] => overview.worker.drivers.map((driver) => {
  const servers = overview.servers
    .filter((server) => server.driver === driver)
    .sort((a, b) => STATUS_ORDER[serverStatus(a).tone] - STATUS_ORDER[serverStatus(b).tone]
      || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.name.localeCompare(b.name));
  return {
    driver,
    title: DRIVER_NAMES[driver],
    servers,
    summary: servers.length ? `${servers.length} ${servers.length === 1 ? 'server' : 'servers'}` : 'No servers',
    listingNote: overview.listing.find((listing) => listing.driver === driver)?.note ?? null,
    unreadable: overview.files.filter((file) => file.driver === driver && file.state === 'unreadable').map((file) => file.path),
    hint: { command: PROVIDER_MCP[driver].add('<name>', '<url>'), docs: PROVIDER_MCP[driver].docs },
  };
});

/** A few words beside the MCP heading: which provider the worker runs on, or why both are listed. */
export const providerLine = (worker: McpOverview['worker']): string => {
  if (!worker.provider) return 'No worker provider set, so both are listed';
  if (worker.drivers.length > 1) return `"${worker.provider}" isn't Claude or Codex, so both are listed`;
  return `Worker: ${worker.provider}`;
};

/** Where a server comes from, in a few words: "User config · ~/.claude.json", "claude.ai connector", "Added by Codex". */
export const serverOrigin = (server: Pick<McpServer, 'scope' | 'source' | 'driver'>): string => {
  if (server.scope === 'provider') return `Added by ${DRIVER_NAMES[server.driver]}`;
  if (server.scope === 'user' || server.scope === 'project' || server.scope === 'local') return `${SCOPE_LABELS[server.scope]} · ${server.source}`;
  return SCOPE_LABELS[server.scope];
};

// ---------------------------------------------------------------------------------------------------------------
// Command-line tools
// ---------------------------------------------------------------------------------------------------------------

/** One status for a CLI. */
export const cliStatus = (status: CliStatus | undefined): Status => {
  if (!status?.path) return { tone: 'off', text: 'Not installed' };
  const check = status.check;
  // Installed, but nothing checked it's signed in: a hollow dot, not a green one.
  if (!check) return { tone: 'neutral', text: 'Installed' };
  if (check.kind === 'running') {
    return check.state === 'yes' ? { tone: 'up', text: 'Running' } : check.state === 'no' ? { tone: 'warn', text: 'Not running' } : { tone: 'neutral', text: 'Unknown' };
  }
  if (check.state === 'yes') return { tone: 'up', text: 'Signed in' };
  return check.state === 'no' ? { tone: 'warn', text: 'Not signed in' } : { tone: 'neutral', text: 'Unknown' };
};

export interface CliRow { spec: CliSpec; status: CliStatus | undefined; state: Status; recommended: boolean; command: string | null }

/** The catalogue's CLIs, installed ones first, each with the one command to copy when it needs something. */
export const cliRows = (overview: CliOverview, recommended: ReadonlySet<string>, catalog: readonly CliSpec[] = CLI_CATALOG): CliRow[] =>
  catalog
    .map((spec) => {
      const status = overview.clis.find((entry) => entry.id === spec.id);
      const state = cliStatus(status);
      const command = !status?.path ? spec.install : state.text === 'Not signed in' ? spec.login ?? null : null;
      return { spec, status, state, recommended: recommended.has(spec.id), command };
    })
    .sort((a, b) => Number(!a.status?.path) - Number(!b.status?.path) || Number(b.recommended) - Number(a.recommended));

// ---------------------------------------------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------------------------------------------

export interface RecommendationRow {
  rec: Recommendation;
  /** Why it's recommended, in a few words. */
  reason: string;
  state: Status;
  /** Commands to copy to set it up, labelled. Empty when it's ready. */
  setup: { label: string; command: string }[];
}

/**
 * GitHub always; Sentry, Atlassian, Linear and Vercel when a signal points at them or a server for them is already
 * there. Ready means its CLI is signed in or an MCP server for it answered.
 */
export const recommendationRows = (
  mcp: McpOverview | null,
  clis: CliOverview | null,
  catalog: readonly CliSpec[] = CLI_CATALOG,
  recommendations: readonly Recommendation[] = RECOMMENDATIONS,
  /** True while the MCP list is still loading: an MCP-backed row waits instead of saying "Not set up". */
  mcpPending = false,
): RecommendationRow[] => {
  const rows: RecommendationRow[] = [];
  for (const rec of recommendations) {
    // Every server for it, including turned-off ones (an `add` would replace those), and the ones that are on.
    const matching = (mcp?.servers ?? []).filter((server) => rec.server.test(`${server.name} ${server.host ?? ''}`));
    const servers = matching.filter((server) => server.load !== 'disabled');
    const signal = clis?.signals[rec.id];
    if (!rec.always && !signal && !matching.length) continue;
    const spec = rec.cli ? catalog.find((entry) => entry.id === rec.cli) : undefined;
    const cli = spec ? clis?.clis.find((entry) => entry.id === spec.id) : undefined;
    const cliState = spec && clis ? cliStatus(cli) : null;
    // Ready means checked: a CLI that's signed in (or has no sign-in check), or an MCP server that answered Claude's
    // health check. A server nobody checked (Codex lists without connecting) is only Configured.
    // Only a check that passed counts: an installed CLI nobody could check (sentry-cli, vercel) isn't Ready.
    const cliReady = cli?.check?.state === 'yes';
    const cliUnchecked = Boolean(cli?.path) && !cliReady && cli?.check?.state !== 'no';
    const connected = !rec.needsCli && servers.some((server) => server.health === 'connected' && server.load === 'loads');
    const configured = !rec.needsCli && servers.some((server) => server.health === null && server.load === 'loads');
    let state: Status;
    if (cliReady || connected) state = { tone: 'up', text: 'Ready' };
    else if (mcpPending && !rec.needsCli) state = { tone: 'neutral', text: 'Checking…' };
    else if (!rec.needsCli && servers.some((server) => server.health === 'needs-auth')) state = { tone: 'warn', text: 'Needs sign-in' };
    else if (cliState?.text === 'Not signed in') state = { tone: 'warn', text: 'Not signed in' };
    else if (configured) state = { tone: 'neutral', text: 'Configured' };
    // A server that's on but failed, may not load or waits for approval: say so, as the MCP list below does.
    else if (!rec.needsCli && servers.length) state = servers.map(serverStatus).sort((a, b) => STATUS_ORDER[a.tone] - STATUS_ORDER[b.tone])[0]!;
    else if (cliUnchecked) state = { tone: 'neutral', text: 'Installed' };
    else if (!rec.needsCli && matching.length) state = { tone: 'off', text: 'Turned off' };
    else state = { tone: 'off', text: 'Not set up' };
    const setup: RecommendationRow['setup'] = [];
    if (state.text !== 'Ready' && state.text !== 'Checking…') {
      if (spec && !cli?.path) setup.push({ label: `Install ${spec.label}`, command: spec.install });
      else if (spec?.login && (cliState?.text === 'Not signed in' || cliUnchecked)) setup.push({ label: 'Sign in', command: spec.login });
      // Per provider: sign in to a server it already has (never re-add it, even turned off: that would replace its
      // settings), or add the vendor's server where it has none. Without an MCP list, no MCP commands at all.
      for (const driver of mcp?.worker.drivers ?? []) {
        const existing = matching.filter((server) => server.driver === driver);
        const signIn = existing.find((server) => server.health === 'needs-auth');
        if (signIn) setup.push({ label: `Sign in (${DRIVER_NAMES[driver]})`, command: PROVIDER_MCP[driver].login(signIn.name) });
        else if (!existing.length && rec.mcp) setup.push({ label: `Add to ${DRIVER_NAMES[driver]}`, command: PROVIDER_MCP[driver].add(rec.mcp.name, rec.mcp.url) });
      }
    }
    rows.push({ rec, reason: rec.reason ?? signal ?? 'An MCP server for it is set up', state, setup });
  }
  return rows;
};

/** The CLI ids the recommendations name, for the CLI list's badges. */
export const recommendedCliIds = (rows: readonly RecommendationRow[]): Set<string> =>
  new Set(rows.flatMap((row) => (row.rec.cli ? [row.rec.cli] : [])));

// ---------------------------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------------------------

/** A catalogue icon as a brand mark, or null for the generic ones (`cloud`, `terminal`). */
export const brandFor = (icon: ToolIcon): BrandId | null => (icon === 'cloud' || icon === 'terminal' ? null : icon);

const SERVER_BRANDS: readonly [RegExp, BrandId][] = [
  [/github/i, 'github'], [/vercel/i, 'vercel'], [/jira/i, 'jira'], [/confluence/i, 'confluence'], [/atlassian/i, 'atlassian'],
  [/linear/i, 'linear'], [/sentry/i, 'sentry'], [/docker/i, 'docker'], [/notion/i, 'notion'], [/stripe/i, 'stripe'],
  [/supabase/i, 'supabase'], [/cloudflare/i, 'cloudflare'], [/datadog/i, 'datadog'], [/grafana/i, 'grafana'],
  [/pager-?duty/i, 'pagerduty'], [/figma/i, 'figma'], [/miro/i, 'miro'], [/excalidraw/i, 'excalidraw'], [/gmail/i, 'gmail'],
  [/google drive|drivemcp/i, 'googledrive'], [/google calendar|calendarmcp/i, 'googlecalendar'], [/postgres/i, 'postgresql'],
  [/fly\.io|flyctl/i, 'flydotio'], [/google cloud|gcloud/i, 'googlecloud'], [/claude docs/i, 'claude'],
];

/** The brand mark for an MCP server, by its name or host, or null for the generic plug. */
export const serverBrand = (server: Pick<McpServer, 'name' | 'host'>): BrandId | null =>
  SERVER_BRANDS.find(([pattern]) => pattern.test(`${server.name} ${server.host ?? ''}`))?.[1] ?? null;
