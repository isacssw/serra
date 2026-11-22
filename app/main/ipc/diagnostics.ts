// Diagnostics (APP-22): `diagnose()` for the selected profile and a tail of the daemon's log.
//
// Inside the app `process.versions.node` is Electron's bundled Node, so the Node check runs the Node binary the
// bot's release uses (`findNode`) instead. Every detail and log line is scrubbed of the profile's token values and
// anything shaped like a Slack token before it reaches the window.
import { join } from 'node:path';
import { loadConfig, type Config } from '../../../src/config.ts';
import type { Diagnostic } from '../../../src/contracts.ts';
import { diagnose, type DiagnoseOptions } from '../../../src/doctor.ts';
import { tailLog } from '../../../src/logging.ts';
import { findNode } from '../../../src/releases.ts';
import { scrub } from '../../../src/secrets.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

/** The most log lines one call returns. */
export const MAX_LOG_LINES = 2000;
/** Longer log lines are cut, so one huge JSON line can't flood the window. */
const MAX_LINE_LENGTH = 4000;

/** Tests swap the services for fakes. */
export interface DiagnosticsHandlerOptions {
  loadConfig?: (profileDir: string) => Config;
  diagnose?: (config: Config, options: DiagnoseOptions) => Promise<Diagnostic[]>;
  findNode?: (profileDir: string) => Promise<string>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The profile's token values, to hide wherever they appear. Tokens load lazily and a missing one throws; by now
 * the Tokens check has resolved them once, so this doesn't ask the Keychain or 1Password again.
 */
const tokenValues = (config: Config): (string | undefined)[] => [
  () => config.botToken, () => config.appToken,
].map((read) => { try { return read(); } catch { return undefined; } });

/** The daemon's log, where launchd sends its stdout and stderr (`deploy.ts`). */
const daemonLogPath = (profileDir: string): string => join(profileDir, 'logs', 'bot.log');

export const diagnosticsHandlers = (context: HandlerContext, options: DiagnosticsHandlerOptions = {}): Handlers<'diagnostics'> => {
  const load = options.loadConfig ?? ((profileDir: string) => loadConfig({ profileDir, env: {} }));
  const check = options.diagnose ?? diagnose;
  const locateNode = options.findNode ?? findNode;
  return {
    run: async () => {
      const profileDir = context.profileDir();
      let config: Config;
      // A profile that can't load (an invalid profile.json) is the one failing check.
      try { config = load(profileDir); }
      catch (error) { return [{ name: 'Profile', ok: false, detail: scrub(errorText(error)) }]; }
      let results: Diagnostic[];
      try { results = await check(config, { nodeBinary: () => locateNode(profileDir) }); }
      catch (error) { throw new Error(scrub(errorText(error), tokenValues(config))); }
      const values = tokenValues(config);
      // Copy only the contract's fields, scrubbed.
      return results.map((result) => ({ name: String(result.name), ok: result.ok === true, detail: scrub(String(result.detail), values) }));
    },

    logTail: (lines) => {
      if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
        throw new Error(`Ask for 1 to ${MAX_LOG_LINES} log lines.`);
      }
      return tailLog(daemonLogPath(context.profileDir()), lines)
        .map((line) => scrub(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));
    },
  };
};
