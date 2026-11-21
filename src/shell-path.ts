// The PATH to look for tools on (Tools, SERRA-39). T3 runs the worker with the owner's login environment, while a
// packaged app opened from Finder gets launchd's short PATH and the daemon gets the PATH it was installed with. So
// Serra asks the login shell for its PATH once, and adds the usual install folders (app/main/tool-path.ts).
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { exec, toolEnv, type Exec } from './exec.ts';

const MARKER = '__SERRA_PATH__';

/** `PATH` as the login shell sets it, or null when the shell can't say within the timeout. */
export const loginShellPath = async (
  { shell = process.env.SHELL || '/bin/zsh', run = exec, timeoutMs = 5_000 }: { shell?: string; run?: Exec; timeoutMs?: number } = {},
): Promise<string | null> => {
  // Interactive and login, so version managers set up in .zshrc (nvm, asdf, mise) are on it too.
  // Only the allowlisted environment: the rc files run, but never see a token Serra resolved.
  const result = await run(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`], { timeoutMs, env: toolEnv(process.env.PATH ?? '/usr/bin:/bin') });
  const match = new RegExp(`${MARKER}(.*?)${MARKER}`, 's').exec(result.stdout);
  return match?.[1]?.trim() || null;
};

/** Joins PATH lists in order, without repeats, empty parts or relative entries (they'd depend on the folder). */
export const mergePaths = (...paths: (string | null | undefined)[]): string => {
  const parts: string[] = [];
  for (const path of paths) for (const part of (path ?? '').split(delimiter)) if (isAbsolute(part) && !parts.includes(part)) parts.push(part);
  return parts.join(delimiter);
};

const INSTALL_DIRS = (home: string) => ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin')].join(delimiter);

let cached: { path: Promise<string>; at: number } | null = null;
const CACHE_MS = 5 * 60_000;

/**
 * The login shell's PATH, then this process's, then the usual install folders. Cached for five minutes.
 * `SERRA_TOOLS_PATH` replaces all of it.
 */
export const toolSearchPath = async (options: { run?: Exec; home?: string; fresh?: boolean } = {}): Promise<string> => {
  // An explicit PATH wins: tests use it so they never find the real `claude` or `gh`.
  if (process.env.SERRA_TOOLS_PATH !== undefined) return mergePaths(process.env.SERRA_TOOLS_PATH);
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.path;
  // The promise is cached, so the MCP and CLI checks that start together share one login shell.
  const path = loginShellPath({ run: options.run }).catch(() => null)
    .then((shell) => mergePaths(shell, process.env.PATH, INSTALL_DIRS(options.home ?? homedir())));
  cached = { path, at: Date.now() };
  return path;
};
