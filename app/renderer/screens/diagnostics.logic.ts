// The Diagnostics screen's logic (APP-22): the summary line, when a status change should rerun the checks, and the
// plain-text report the Copy button exports. Main has already scrubbed every detail and log line of token values.
import type { BotStatus, Diagnostic } from '../../../src/contracts.ts';
import type { AppInfo } from '../../main/bridge.ts';

export const LOG_LINE_CHOICES = [100, 200, 500, 1000] as const;
export const DEFAULT_LOG_LINES = 200;

export type SummaryTone = 'up' | 'down';

/** "All 9 checks pass" or "2 of 9 checks fail: Tokens, GitHub CLI". */
export const summarize = (results: Diagnostic[]): { tone: SummaryTone; text: string; failing: Diagnostic[] } => {
  const failing = results.filter((result) => !result.ok);
  const total = `${results.length} check${results.length === 1 ? '' : 's'}`;
  if (!failing.length) return { tone: 'up', text: results.length === 1 ? 'The check passes' : `All ${total} pass`, failing };
  return {
    tone: 'down',
    text: `${failing.length} of ${total} ${failing.length === 1 ? 'fails' : 'fail'}: ${failing.map((result) => result.name).join(', ')}`,
    failing,
  };
};

/**
 * What about the daemon's status should rerun the checks: it starting, stopping, restarting (a new pid) or its Slack
 * connection changing. Job counts change all the time and don't matter here.
 */
export const statusKey = (status: BotStatus | null): string => {
  if (!status) return 'unknown';
  if (status.state === 'stopped') return 'stopped';
  return `up:${status.pid}:${status.slackConnected ? 'slack' : 'no-slack'}`;
};

/** The app's own runtime, labelled so nobody mistakes Electron's bundled Node for the bot's (that one is the Node check). */
export const runtimeLine = (info: Pick<AppInfo, 'version' | 'electron' | 'node'>): string =>
  `App ${info.version} · Electron ${info.electron} · bundled Node ${info.node}`;

/** Failing checks first, so the ones to fix are on the first screen; otherwise the order `diagnose()` gave. */
export const orderChecks = (results: Diagnostic[]): Diagnostic[] => [...results.filter((result) => !result.ok), ...results.filter((result) => result.ok)];

/** Paths under the home folder as `~/…`: shorter, and a pasted report doesn't carry the account name. */
export const tildePaths = (text: string, home: string | undefined): string => {
  const root = home?.replace(/\/+$/, '');
  if (!root || root === '/' || !text.includes(root)) return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${escaped}(?![\\w.-])`, 'g'), '~');
};

/**
 * A passing check's detail as a short value: "24.1.0 · /opt/homebrew/bin/node", "Configured", "Writable". Only the
 * first clause of a "this; that" detail stays; the copied report keeps the whole of it.
 */
export const passValue = (detail: string): string => {
  const node = /^(\S+) \((.+), the Node the bot runs on\)$/.exec(detail);
  if (node) return `${node[1]} · ${node[2]}`;
  if (detail === 'An author identity is configured') return 'Configured';
  if (detail === 'Server reachable; project registered') return 'Connected';
  return detail.split('; ')[0]!;
};

/** Where a failing check is fixed, as a screen to open. */
interface FailureAction { label: string; path: string }

/** A failing check's detail as a short reason to read first, the raw output (if any) on demand, and where to fix it. */
export interface Failure { reason: string; raw: string | null; action?: FailureAction }

/**
 * Raw command errors ("gh api user exited 4: To get started…") read as a reason first. Known shapes get their plain
 * words; any other `<command> exited N: …` becomes "<command> failed (exit N)" with the output kept as the detail.
 * Anything else is already a sentence and stays as it is.
 */
export const explainFailure = (detail: string): Failure => {
  const exited = /^(\S+)(?: [^:]*?)? exited (\d+): ([\s\S]*)$/.exec(detail);
  if (/gh auth login/.test(detail)) return { reason: 'GitHub CLI isn’t signed in.', raw: detail, action: { label: 'Sign in', path: '/settings/tools' } };
  const missing = /cannot change to '([^']+)': No such file or directory/.exec(detail);
  if (missing) return { reason: `Folder not found: ${missing[1]}`, raw: detail, action: { label: 'Fix path', path: '/settings/repositories' } };
  if (/could not be found in the keychain/i.test(detail)) {
    const which = /SLACK_APP_TOKEN/.test(detail) ? 'The app token' : /SLACK_BOT_TOKEN/.test(detail) ? 'The bot token' : 'A token';
    return { reason: `${which} isn’t in the Keychain.`, raw: detail, action: { label: 'Add token', path: '/setup/slack' } };
  }
  if (exited) return { reason: `${exited[1]} failed (exit ${exited[2]})`, raw: detail };
  return { reason: detail, raw: null };
};

/**
 * Failing checks that share one cause (no bot token fails both Tokens and Slack account): the later ones point at the
 * first instead of repeating its error. Keyed by check name, the value is the check that already says it.
 */
export const sharedCauses = (failing: readonly Diagnostic[]): Map<string, string> => {
  const first = new Map<string, string>();
  const shared = new Map<string, string>();
  for (const result of failing) {
    const seen = first.get(result.detail);
    if (seen) shared.set(result.name, seen);
    else first.set(result.detail, result.name);
  }
  return shared;
};

/** A plain-text report for pasting into an issue or a message. */
export const reportText = ({ results, checkedAt, info, log }: {
  results: Diagnostic[];
  checkedAt: Date | null;
  info: Pick<AppInfo, 'version' | 'electron' | 'node' | 'platform' | 'home'> | null;
  log: string[];
}): string => tildePaths([
  `Serra diagnostics${checkedAt ? ` (${checkedAt.toISOString()})` : ''}`,
  ...(info ? [`App: Serra ${info.version}, Electron ${info.electron} (bundled Node ${info.node}), ${info.platform}`] : []),
  '',
  summarize(results).text,
  ...results.map((result) => `${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`),
  ...(log.length ? ['', `Last ${log.length} log line${log.length === 1 ? '' : 's'}:`, ...log] : []),
].join('\n'), info?.home);
