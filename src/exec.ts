// Runs a command and captures what it printed, without a shell and without throwing for a failed command (Tools,
// SERRA-39). Used for read-only checks: `claude mcp list`, `gh --version`, `gh auth status` and the like.
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
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

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Output past this is dropped: these checks print a few lines. */
const MAX_OUTPUT = 512 * 1024;

export const exec: Exec = (command, args, { cwd, env, timeoutMs = 10_000 } = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (result: Omit<ExecResult, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    // stdin is closed, so nothing can wait on a prompt.
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += chunk.toString(); });
    child.once('error', (error: NodeJS.ErrnoException) => done({ code: null, missing: error.code === 'ENOENT' }));
    child.once('close', (code) => done({ code, missing: false }));
  });

/** The first executable called `name` in `path`, or null. Looks only; runs nothing. */
export const findExecutable = (name: string, path: string): string | null => {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
};
