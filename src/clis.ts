// Command-line tools on this Mac (SERRA-39): installed or not, version, and signed in where the tool has a cheap
// read-only check (`gh auth status`, `az account show`). Also the signals that make a recommended service relevant
// (a Sentry SDK in the repo, vercel.json, Jira links in the knowledge). Read-only: nothing is installed, signed in
// or changed. Only a version, an account name and yes/no leave this module, never a command's raw output.
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Profile } from './config.ts';
import { exec, findExecutable, toolEnv, type Exec } from './exec.ts';
import { requiredTools } from './mcp.ts';
import { toolSearchPath } from './shell-path.ts';
import { CLI_CATALOG, type CliSpec, type Recommendation } from './tool-catalog.ts';

export type CliCheckState = 'yes' | 'no' | 'unknown';

export interface CliStatus {
  id: string;
  /** Where it was found, with the home folder as `~`. Null when it isn't installed. */
  path: string | null;
  version: string | null;
  /** The read-only check, when the tool has one and is installed. */
  check: { kind: 'signed-in' | 'running'; state: CliCheckState; account: string | null } | null;
}

export interface CliOverview {
  clis: CliStatus[];
  /** Why each recommendation is relevant to this profile, by recommendation id. Empty when nothing points at it. */
  signals: Partial<Record<Recommendation['id'], string>>;
}

const VERSION = /(\d+\.\d+(?:\.\d+)?)/;
/** An account name worth showing: a login or an email, never a line of arbitrary output. */
const ACCOUNT = /^[\w.@+-]{1,80}$/;

const shortPath = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

const account = (spec: CliSpec, output: string): string | null => {
  if (spec.check?.account === 'gh') {
    const login = /account\s+([\w-]+)/.exec(output)?.[1] ?? /Logged in to \S+ as ([\w-]+)/.exec(output)?.[1];
    return login ?? null;
  }
  if (spec.check?.account === 'first-line') {
    const line = output.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) ?? '';
    return ACCOUNT.test(line) ? line : null;
  }
  return null;
};

/** One tool's status. Version and check run with a timeout and no stdin, so a prompt can't hang them. */
export const detectCli = async (spec: CliSpec, { path, run = exec, home = homedir() }: { path: string; run?: Exec; home?: string }): Promise<CliStatus> => {
  const bin = spec.bins.map((name) => findExecutable(name, path)).find(Boolean) ?? null;
  if (!bin) return { id: spec.id, path: null, version: null, check: null };
  const env = toolEnv(path);
  /** The check's arguments; 'skip' when the help probe failed, so whether the flag exists is unknown. */
  const checkArgs = async (): Promise<readonly string[] | 'skip' | null> => {
    if (!spec.check) return null;
    const flag = spec.check.ifSupported;
    if (!flag) return spec.check.args;
    // Only a flag the installed version knows: older gh has no --no-refresh and would fail on it.
    const help = await run(bin, [...spec.check.args.slice(0, 2), '--help'], { env, timeoutMs: 5_000 });
    if (help.code !== 0 || help.timedOut) return 'skip';
    return `${help.stdout}${help.stderr}`.includes(flag) ? [...spec.check.args, flag] : spec.check.args;
  };
  const [version, args] = await Promise.all([run(bin, spec.versionArgs, { env, timeoutMs: 8_000 }), checkArgs()]);
  const check = args && args !== 'skip' ? await run(bin, args, { env, timeoutMs: 10_000 }) : null;
  const versionText = `${version.stdout}\n${version.stderr}`.slice(0, 2_000);
  let checkStatus: CliStatus['check'] = null;
  if (spec.check && args === 'skip') checkStatus = { kind: spec.check.kind, state: 'unknown', account: null };
  if (spec.check && check) {
    const ok = check.code === 0 && (!spec.check.needsOutput || check.stdout.trim().length > 0);
    const state: CliCheckState = check.timedOut || check.missing ? 'unknown' : ok ? 'yes' : 'no';
    checkStatus = { kind: spec.check.kind, state, account: ok ? account(spec, `${check.stdout}\n${check.stderr}`) : null };
  }
  return { id: spec.id, path: shortPath(bin, home), version: VERSION.exec(versionText)?.[1] ?? null, check: checkStatus };
};

// ---------------------------------------------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------------------------------------------

/**
 * A small text file, or ''. Opened without blocking and checked on the open descriptor, so a FIFO or device in the
 * repo (or a symlink to one) can't stall the main process; at most `max` bytes are read whatever it claims.
 */
const readSmall = (path: string, max = 256 * 1024): string => {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return '';
    const buffer = Buffer.alloc(max);
    const read = readSync(fd, buffer, 0, max, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch { return ''; } finally { if (fd !== null) closeSync(fd); }
};

/** Markdown under a folder, at most `limit` files. */
const markdownUnder = (dir: string, limit = 200): string[] => {
  const files: string[] = [];
  const walk = (folder: string, depth: number) => {
    if (depth > 4 || files.length >= limit) return;
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  };
  walk(dir, 0);
  return files;
};

const SENTRY_SDK: readonly [string, RegExp][] = [
  ['package.json', /"@sentry\//],
  ['requirements.txt', /^sentry-sdk\b/m],
  ['pyproject.toml', /sentry-sdk/],
  ['go.mod', /getsentry\/sentry-go/],
  ['Gemfile', /sentry-ruby/],
  ['Cargo.toml', /^sentry\s*=/m],
];

/**
 * Why each recommendation fits this profile, from the repository (the main checkout, read only), the alert rules
 * and the knowledge. A bare issue key like ABC-123 doesn't count: it can't tell Jira from Linear.
 */
export const recommendationSignals = (
  profile: Pick<Profile, 'project' | 'messageTriggers'>,
  profileDir: string | null,
): CliOverview['signals'] => {
  const signals: CliOverview['signals'] = {};
  const repo = profile.project.path;
  const triggers = (profile.messageTriggers ?? []).map((trigger) => trigger.instructions).join('\n');
  const knowledge = profileDir
    ? [readSmall(join(profileDir, 'brief.md')), ...markdownUnder(join(profileDir, 'knowledge')).map((file) => readSmall(file))].join('\n')
    : '';
  const notes = `${triggers}\n${knowledge}`;

  if (requiredTools(profile.messageTriggers).has('sentry')) signals.sentry = 'An alert rule mentions Sentry';
  else if (SENTRY_SDK.some(([file, pattern]) => pattern.test(readSmall(join(repo, file))))) signals.sentry = 'The repo uses a Sentry SDK';
  if (existsSync(join(repo, 'vercel.json')) || existsSync(join(repo, '.vercel'))) signals.vercel = 'vercel.json in the repo';
  if (/atlassian\.net|\bjira\b|\bconfluence\b/i.test(notes)) signals.atlassian = 'Your notes mention Jira or Confluence';
  if (/linear\.app/i.test(notes)) signals.linear = 'Your notes link to Linear';
  return signals;
};

/** Every catalogued CLI's status, checked in parallel, and the recommendation signals. */
export const cliOverview = async (
  profile: Pick<Profile, 'project' | 'messageTriggers'>,
  profileDir: string | null,
  options: { run?: Exec; path?: string; home?: string; catalog?: readonly CliSpec[]; fresh?: boolean } = {},
): Promise<CliOverview> => {
  const path = options.path ?? await toolSearchPath({ home: options.home, fresh: options.fresh });
  const clis = await Promise.all((options.catalog ?? CLI_CATALOG).map((spec) => detectCli(spec, { path, run: options.run, home: options.home })));
  return { clis, signals: recommendationSignals(profile, profileDir) };
};

/** Plain text for `pnpm bot tools`. */
export const formatCliOverview = ({ clis }: CliOverview, catalog: readonly CliSpec[] = CLI_CATALOG): string => {
  const lines = ['Command-line tools:'];
  for (const status of clis) {
    const spec = catalog.find((entry) => entry.id === status.id);
    if (!spec) continue;
    if (!status.path) { lines.push(`  ${spec.label}  not installed  (${spec.install})`); continue; }
    const check = status.check
      ? status.check.kind === 'running'
        ? { yes: 'running', no: 'not running', unknown: 'unknown' }[status.check.state]
        : { yes: `signed in${status.check.account ? ` as ${status.check.account}` : ''}`, no: 'not signed in', unknown: 'sign-in unknown' }[status.check.state]
      : 'sign-in not checked';
    lines.push(`  ${spec.label}  ${status.version ?? 'installed'}  ${check}  ${status.path}`);
  }
  return lines.join('\n');
};
