// The environment to look for and run tools in (Tools, SERRA-39). T3 runs the worker with the owner's login
// environment, while a packaged app opened from Finder gets launchd's short PATH and the daemon gets the PATH it
// was installed with. So Serra asks the login shell once for its environment, and adds the usual install folders
// (as app/main/tool-path.ts does) to its PATH.
//
// The whole login environment goes only to the provider CLIs (`claude mcp list`, `codex mcp list`): they're the
// programs T3 runs jobs with, and their health checks need the variables a server's config refers to. Third-party
// CLIs get the allowlist in exec.ts (`toolEnv`) instead.
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { exec, toolEnv, type Exec } from './exec.ts';

const MARKER = '__SERRA_ENV__';
const END = '__SERRA_ENV_END__';

export interface LoginEnvironment {
  /** PATH to search: the login shell's, then this process's, then the usual install folders. */
  path: string;
  /** The login shell's environment, or null when it couldn't be read (then only `toolEnv` is used). */
  env: Record<string, string> | null;
}

/** The login shell's environment (from `env -0`), or null when the shell can't say within the timeout. */
export const loginShellEnv = async (
  { shell = process.env.SHELL || '/bin/zsh', run = exec, timeoutMs = 5_000 }: { shell?: string; run?: Exec; timeoutMs?: number } = {},
): Promise<Record<string, string> | null> => {
  // Interactive and login, so version managers set up in .zshrc (nvm, asdf, mise) are on it too. It starts from the
  // allowlisted environment: the rc files run, but never see a token Serra itself resolved.
  const result = await run(shell, ['-ilc', `printf '${MARKER}'; env -0; printf '${END}'`], { timeoutMs, env: toolEnv(process.env.PATH ?? '/usr/bin:/bin') });
  const start = result.stdout.indexOf(MARKER);
  const end = result.stdout.indexOf(END, start);
  // Between the markers only: whatever a logout script prints after `env` isn't part of the last variable.
  if (start < 0 || end < 0 || result.timedOut) return null;
  const env: Record<string, string> = {};
  for (const entry of result.stdout.slice(start + MARKER.length, end).split('\0')) {
    const equals = entry.indexOf('=');
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env.PATH ? env : null;
};

/** `PATH` as the login shell sets it, or null. */
export const loginShellPath = async (options: Parameters<typeof loginShellEnv>[0] = {}): Promise<string | null> =>
  (await loginShellEnv(options))?.PATH ?? null;

/** Joins PATH lists in order, without repeats, empty parts or relative entries (they'd depend on the folder). */
export const mergePaths = (...paths: (string | null | undefined)[]): string => {
  const parts: string[] = [];
  for (const path of paths) for (const part of (path ?? '').split(delimiter)) if (isAbsolute(part) && !parts.includes(part)) parts.push(part);
  return parts.join(delimiter);
};

const INSTALL_DIRS = (home: string) => ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin')].join(delimiter);

let cached: { value: Promise<LoginEnvironment>; at: number } | null = null;
const CACHE_MS = 5 * 60_000;

/**
 * The login environment, cached for five minutes; `fresh` asks the shell again (Check again on the Tools screen).
 * `SERRA_TOOLS_PATH` replaces the search path and skips the shell (for unusual shells, and for tests, so they never
 * find the real `claude` or `gh`).
 */
export const loginEnvironment = (options: { run?: Exec; home?: string; fresh?: boolean } = {}): Promise<LoginEnvironment> => {
  if (process.env.SERRA_TOOLS_PATH !== undefined) return Promise.resolve({ path: mergePaths(process.env.SERRA_TOOLS_PATH), env: null });
  // A fresh request within a couple of seconds of another (the MCP and CLI checks of one Check again) shares it.
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && (options.fresh ? age < 2_000 : age < CACHE_MS)) return cached.value;
  // The promise is cached, so the MCP and CLI checks that start together share one login shell.
  const value = loginShellEnv({ run: options.run }).catch(() => null)
    .then((env) => ({ env, path: mergePaths(env?.PATH, process.env.PATH, INSTALL_DIRS(options.home ?? homedir())) }));
  cached = { value, at: Date.now() };
  return value;
};

/** Just the search path. */
export const toolSearchPath = async (options: { run?: Exec; home?: string; fresh?: boolean } = {}): Promise<string> =>
  (await loginEnvironment(options)).path;
