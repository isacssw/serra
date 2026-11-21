// The PATH to look for tools on (Tools, SERRA-39). T3 runs the worker with the owner's login environment, while a
// packaged app opened from Finder gets launchd's short PATH and the daemon gets the PATH it was installed with. So
// Serra asks the login shell for its PATH once, and adds the usual install folders (app/main/tool-path.ts).
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { exec, type Exec } from './exec.ts';

const MARKER = '__SERRA_PATH__';

/** `PATH` as the login shell sets it, or null when the shell can't say within the timeout. */
export const loginShellPath = async (
  { shell = process.env.SHELL || '/bin/zsh', run = exec, timeoutMs = 5_000 }: { shell?: string; run?: Exec; timeoutMs?: number } = {},
): Promise<string | null> => {
  // Interactive and login, so version managers set up in .zshrc (nvm, asdf, mise) are on it too.
  const result = await run(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`], { timeoutMs });
  const match = new RegExp(`${MARKER}(.*?)${MARKER}`, 's').exec(result.stdout);
  return match?.[1]?.trim() || null;
};

/** Joins PATH lists in order, without repeats or empty parts. */
export const mergePaths = (...paths: (string | null | undefined)[]): string => {
  const parts: string[] = [];
  for (const path of paths) for (const part of (path ?? '').split(delimiter)) if (part && !parts.includes(part)) parts.push(part);
  return parts.join(delimiter);
};

const INSTALL_DIRS = (home: string) => ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin')].join(delimiter);

let cached: { path: string; at: number } | null = null;
const CACHE_MS = 5 * 60_000;

/**
 * The login shell's PATH, then this process's, then the usual install folders. Cached for five minutes.
 * `SERRA_TOOLS_PATH` replaces all of it.
 */
export const toolSearchPath = async (options: { run?: Exec; home?: string; fresh?: boolean } = {}): Promise<string> => {
  // An explicit PATH wins: tests use it so they never find the real `claude` or `gh`.
  if (process.env.SERRA_TOOLS_PATH !== undefined) return process.env.SERRA_TOOLS_PATH;
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.path;
  const shell = await loginShellPath({ run: options.run }).catch(() => null);
  const path = mergePaths(shell, process.env.PATH, INSTALL_DIRS(options.home ?? homedir()));
  cached = { path, at: Date.now() };
  return path;
};
