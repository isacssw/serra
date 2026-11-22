// Runs a command and captures what it printed, without a shell and without throwing for a failed command (Tools,
// SERRA-39). Used for read-only checks: `claude mcp list`, `gh --version`, `gh auth status` and the like.
import { spawn } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';

export interface ExecResult {
  /** The exit code, or null when the command didn't run to the end. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command isn't installed (spawn's ENOENT). */
  missing: boolean;
  timedOut: boolean;
}

interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Process groups still running, so the app can end them when it quits (`stopAll`). */
const running = new Set<number>();

const killGroup = (pid: number | undefined) => {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  running.delete(pid);
};

/** Ends every check still running. The app calls it on quit, so a slow `claude mcp list` doesn't outlive Serra. */
export const stopAll = (): void => { for (const pid of [...running]) killGroup(pid); };

/** Output past this is dropped: these checks print a few lines. */
const MAX_OUTPUT = 512 * 1024;

export const exec: Exec = (command, args, { cwd, env, timeoutMs = 10_000 } = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: Omit<ExecResult, 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) running.delete(child.pid);
      resolve({ ...result, stdout, stderr });
    };
    // Its own process group, so a timeout ends anything it started too. stdin is closed: nothing can wait on a prompt.
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid) running.add(child.pid);
    const timer = setTimeout(() => {
      // Settle at the deadline: a grandchild holding the pipes open must not keep the caller waiting.
      killGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      done({ code: null, missing: false, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += chunk.toString(); });
    child.once('error', (error: NodeJS.ErrnoException) => done({ code: null, missing: error.code === 'ENOENT', timedOut: false }));
    child.once('close', (code) => done({ code, missing: false, timedOut: false }));
  });

/** What a checked tool may see of Serra's environment: where home and config live, locale, proxies. No tokens. */
const PASSED_ENV = [
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'GH_HOST', 'GH_CONFIG_DIR', 'AWS_PROFILE', 'AWS_CONFIG_FILE',
  'CLOUDSDK_CONFIG', 'AZURE_CONFIG_DIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'FLY_CONFIG_DIR',
] as const;

/**
 * The environment for a read-only check: only PASSED_ENV from `source` (so a token Serra resolved never reaches a
 * third-party CLI), the given PATH, no colour, and no telemetry, update checks or prompts where a tool has a switch.
 */
export const toolEnv = (path: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSED_ENV) if (source[key] !== undefined) env[key] = source[key];
  return {
    ...env, PATH: path, NO_COLOR: '1', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    VERCEL_TELEMETRY_DISABLED: '1', AZURE_CORE_COLLECT_TELEMETRY: '0', AZURE_CORE_NO_COLOR: '1', FLY_NO_UPDATE_CHECK: '1',
    // No log files written (or old ones pruned) just because Serra asked for a version.
    AZURE_LOGGING_ENABLE_LOG_FILE: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
    DO_NOT_TRACK: '1',
  };
};

/** The first executable called `name` in `path`, or null. Looks only; runs nothing. */
export const findExecutable = (name: string, path: string): string | null => {
  for (const dir of path.split(delimiter)) {
    // A relative entry would resolve against Serra's folder here and the project's when spawned: never trust it.
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
};
