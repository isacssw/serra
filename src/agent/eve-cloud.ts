// A profile's agent on Vercel (SB-17): an eve agent deployed at a URL. Serra reaches it through eve's own ACP bridge,
// `npx eve@<pinned> acp --url <url> [--scope <team>]`, as one more ACP agent behind the agent layer
// (src/agent/acp.ts), so jobs, approvals and questions work as on any ACP agent. eve signs in with the owner's own
// `vercel` login (it mints short-lived tokens itself; Serra never sees them).
//
// What leaves the Mac, said once in the app before anything is sent: each job's brief (the request and the profile's
// knowledge index), follow-ups, and answers to the agent's approvals and questions. The agent gets no file system or
// terminal on this Mac, no worktree is made for it, and its sessions open in a neutral folder name, never a local path.
//
// Rules this module keeps:
// - Consent is recorded per host (`notice`): no eve process starts, and Check sends nothing, unless the owner accepted
//   the notice for the URL's host at the current notice version. A new host asks again.
// - The Protection Bypass secret lives in the Keychain (or is a 1Password reference). `agent-backend.json` holds only
//   where it is. It is read right before each start and goes only into eve's environment, never its arguments.
// - eve's own text (stderr, error messages) is matched in memory and replaced by a fixed sentence, never shown or logged.
import type { SecretSource } from '../contracts.ts';
import { isRecord } from '../json-guards.ts';
import type { AcpAgent } from './acp-agents.ts';

/** The one cloud agent a profile can have, as its id in `agent-backend.json` and job keys (`acp:eve-cloud`). */
export const EVE_AGENT_ID = 'eve-cloud';
/** The eve release Serra runs, exactly: never a range, so what runs is what was checked. */
const EVE_PACKAGE = 'eve@1.5.0';
/** Bumped when what leaves the Mac changes, so the owner is asked again. */
export const EVE_NOTICE_VERSION = 1;
/** The folder name a cloud session is opened with: eve's URL mode ignores it, and it says nothing about this Mac. */
export const REMOTE_CWD = '/workspace';
/** Where eve reads the Protection Bypass for Automation secret. */
export const BYPASS_ENV = 'VERCEL_AUTOMATION_BYPASS_SECRET';
/** The Keychain account of a profile's bypass secret; the service is the profile's (`dev.serra.<bot-id>`). */
export const BYPASS_ACCOUNT = 'eve-bypass';

export type EveSecret = Exclude<SecretSource, { kind: 'env' }>;
export type EveProblem = 'login' | 'protected' | 'offline' | 'consent' | 'error';
export interface EveCheck { at: string; result: 'ok' | EveProblem; version: string | null }

/** The cloud agent as `agent-backend.json` keeps it (`eve`). Never a secret's value. */
export interface EveCloud {
  /** `https://<host>`, normalised. */
  url: string;
  host: string;
  /** The Vercel team slug (`--scope`), when the owner is in several. */
  team: string | null;
  /** Where the bypass secret is, or null when the deployment has none (Trusted Sources, or no protection). */
  bypass: EveSecret | null;
  /** When the secret was last saved: a new value starts a new eve process for the next job. */
  secretSavedAt: string | null;
  /** The owner's yes to the data notice, for this host and notice version. */
  notice: { host: string; version: number; acceptedAt: string } | null;
  /** The last Check. */
  check: EveCheck | null;
}

const TEAM = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The URL as Serra keeps it (`https://<host>`), or a plain sentence saying what's wrong. */
export const normalizeEveUrl = (input: string): { url: string; host: string } => {
  const text = input.trim();
  if (!text) throw new Error('Enter the agent’s URL.');
  let parsed: URL;
  try { parsed = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { throw new Error('That isn’t a URL.'); }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw new Error('Use an https:// URL.');
  if (parsed.username || parsed.password) throw new Error('Leave the sign-in out of the URL.');
  if (parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) throw new Error('Use the agent’s address only, like https://researcher.vercel.app.');
  return { url: `${parsed.protocol}//${parsed.host}`, host: parsed.host };
};

/** A team slug, or null when blank; throws a plain sentence when it can't be one. */
export const normalizeTeam = (input: string | null | undefined): string | null => {
  const text = (input ?? '').trim();
  if (!text) return null;
  if (!TEAM.test(text)) throw new Error('A Vercel team is its short name, like acme.');
  return text;
};

const isSecret = (value: unknown): value is EveSecret => isRecord(value) && (
  (value.kind === 'keychain' && typeof value.service === 'string' && typeof value.account === 'string')
  || (value.kind === '1password' && typeof value.reference === 'string' && value.reference.startsWith('op://')));

const isCheck = (value: unknown): value is EveCheck => isRecord(value) && typeof value.at === 'string'
  && ['ok', 'login', 'protected', 'offline', 'consent', 'error'].includes(String(value.result));

/** The `eve` entry of `agent-backend.json`, or null when there is none or it doesn't hold together. */
export const parseEveCloud = (value: unknown): EveCloud | null => {
  if (!isRecord(value) || typeof value.url !== 'string') return null;
  let address: { url: string; host: string };
  let team: string | null;
  try { address = normalizeEveUrl(value.url); team = normalizeTeam(typeof value.team === 'string' ? value.team : null); } catch { return null; }
  const notice = isRecord(value.notice) && typeof value.notice.host === 'string' && typeof value.notice.version === 'number' && typeof value.notice.acceptedAt === 'string'
    ? { host: value.notice.host, version: value.notice.version, acceptedAt: value.notice.acceptedAt } : null;
  return {
    ...address, team,
    bypass: isSecret(value.bypass) ? value.bypass : null,
    secretSavedAt: typeof value.secretSavedAt === 'string' ? value.secretSavedAt : null,
    notice,
    check: isCheck(value.check) ? { at: value.check.at, result: value.check.result, version: typeof value.check.version === 'string' ? value.check.version : null } : null,
  };
};

/** Whether the owner accepted the notice for this host, at the current version. */
export const consented = (cloud: Pick<EveCloud, 'host' | 'notice'>): boolean =>
  cloud.notice !== null && cloud.notice.host === cloud.host && cloud.notice.version === EVE_NOTICE_VERSION;

/** The cloud agent as an ACP agent: eve's bridge, pinned, with the URL and team as arguments and no secret in them. */
export const eveCloudAgent = (cloud: EveCloud): AcpAgent => ({
  id: EVE_AGENT_ID,
  name: 'eve',
  command: 'npx',
  args: ['--yes', EVE_PACKAGE, 'acp', '--url', cloud.url, ...(cloud.team ? ['--scope', cloud.team] : [])],
  env: { EVE_TELEMETRY_DISABLED: '1', VERCEL_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
  remote: { host: cloud.host, consented: consented(cloud), bypass: cloud.bypass, secretSavedAt: cloud.secretSavedAt },
});

/** The fixed sentence for an outcome: what the Check line, a job's failure and the eve card say. Never eve's own text. */
export const eveSentence = (outcome: 'ok' | EveProblem, host: string, version?: string | null): string => {
  switch (outcome) {
    case 'ok': return version ? `Connected · eve ${version}` : 'Connected';
    case 'login': return 'Sign in to Vercel: run vercel login, then Check.';
    case 'protected': return 'This deployment is protected. Add a bypass secret or allow this Mac in Vercel.';
    case 'offline': return `Can’t reach ${host}.`;
    case 'consent': return `Accept what leaves this Mac for ${host} first, in Settings › Worker.`;
    case 'error': return `eve at ${host} stopped with an error.`;
  }
};

/** Which fixed sentence a message is, so a Check that failed records its outcome. */
export const eveOutcomeOf = (message: string, host: string): EveProblem => {
  for (const problem of ['login', 'protected', 'offline', 'consent'] as const) if (message === eveSentence(problem, host)) return problem;
  return 'error';
};

/**
 * What went wrong, from eve's stderr or an ACP error, matched in memory and then dropped. eve reports a Vercel
 * failure as `-32002` with `httpStatus` (or its own `code`); a start that fails prints why and exits.
 */
export const eveProblemOf = (text: string, error?: unknown): EveProblem => {
  const record = isRecord(error) ? error : {};
  const data = isRecord(record.data) ? record.data : {};
  const status = typeof data.httpStatus === 'number' ? data.httpStatus : null;
  const code = typeof data.code === 'string' ? data.code : '';
  if (record.code === -32000 || status === 401 || /UNAUTH|LOGIN|TOKEN_EXPIRED/i.test(code)) return 'login';
  if (status === 403 || /PROTECT/i.test(code)) return 'protected';
  if (/not logged in|vercel login|no existing credentials|token (?:is )?(?:expired|invalid)|invalid token|re-?authenticate|unauthori[sz]ed/i.test(text)) return 'login';
  if (/deployment protection|protection[- ]bypass|vercel_auth|\b403\b|forbidden/i.test(text)) return 'protected';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed|getaddrinfo|network|offline|socket hang up|could not resolve/i.test(text)) return 'offline';
  return 'error';
};

/**
 * The environment a cloud eve starts in: the owner's login environment without a bypass secret or eve setting their
 * shell exported for another project, then this profile's secret, read now (a rotated one is used at the next start).
 * Refuses, before anything starts, when the notice isn't accepted for this host.
 */
export const remoteAgentEnv = async (
  agent: AcpAgent,
  base: () => Promise<NodeJS.ProcessEnv>,
  readSecret: (source: EveSecret) => Promise<string>,
): Promise<NodeJS.ProcessEnv> => {
  const remote = agent.remote;
  if (!remote) return base();
  if (!remote.consented) throw new Error(eveSentence('consent', remote.host));
  const env = { ...await base() };
  for (const key of Object.keys(env)) if (key === BYPASS_ENV || key.startsWith('EVE_')) delete env[key];
  if (remote.bypass) {
    let value: string;
    try { value = await readSecret(remote.bypass); } catch { throw new Error(`Serra can’t read the bypass secret for ${remote.host}. Check it in Settings › Worker.`); }
    if (!value) throw new Error(`The bypass secret for ${remote.host} is empty. Add it again in Settings › Worker.`);
    env[BYPASS_ENV] = value;
  }
  return env;
};

/** A bypass secret as typed: a 1Password reference kept as one, else the value itself (letters and digits only). */
export const parseBypassInput = (input: string | null | undefined): { reference: string } | { value: string } | null => {
  const text = (input ?? '').trim();
  if (!text) return null;
  if (text.startsWith('op://')) return { reference: text };
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(text)) throw new Error('A bypass secret is 16 or more letters and digits.');
  return { value: text };
};
