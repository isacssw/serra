/**
 * `pnpm bot server doctor`: whether this computer can run Serra in the background, before any bot exists. The
 * profile doctor (`doctor.ts`) checks one bot; this checks the host: Node, git, GitHub, T3 Code, the coding agents,
 * disk space and the service manager (launchd, or systemd with lingering so the bot outlives a logout).
 * Read-only: it installs, enables and signs in to nothing. Every command runs with a timeout and no stdin.
 */
import { statfsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { nodeProblem } from './doctor.ts';
import { exec, findExecutable, toolEnv, type Exec } from './exec.ts';
import { mergePaths } from './shell-path.ts';

/** `warn`: works, with a limit worth knowing. Only `fail` makes the command exit non-zero. */
export interface HostCheck { name: string; state: 'ok' | 'warn' | 'fail'; detail: string }

export interface HostOptions {
  run?: Exec;
  platform?: NodeJS.Platform;
  home?: string;
  /** Where to look for tools. Default: PATH, then `~/.local/bin` and `~/.t3/bin`. */
  path?: string;
  nodeVersion?: string;
  uid?: number;
  user?: string;
  /** Free bytes in the home folder's file system. */
  freeBytes?: (folder: string) => number;
  /** The T3 CLI. Default: `T3_BIN`, then `~/.t3/bin/t3`, then `t3` on the path. */
  t3Bin?: string;
}

const GB = 1024 ** 3;
/** Releases, worktrees and job logs need room; under this the bot may fail mid-job. */
const MIN_FREE = 2 * GB;

const freeSpace = (folder: string): number => {
  const stats = statfsSync(folder);
  return stats.bavail * stats.bsize;
};

export const diagnoseHost = async (options: HostOptions = {}): Promise<HostCheck[]> => {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const path = options.path ?? mergePaths(process.env.PATH, join(home, '.local/bin'), join(home, '.t3/bin'));
  const env = toolEnv(path);
  const run = options.run ?? exec;
  const call = (bin: string, args: string[], timeoutMs = 10_000) => run(bin, args, { env, timeoutMs });
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const user = options.user ?? userInfo().username;
  const checks: HostCheck[] = [];
  const add = (name: string, state: HostCheck['state'], detail: string): void => { checks.push({ name, state, detail }); };

  if (uid === 0) add('User', 'fail', 'Running as root. Run Serra as your own user.');
  else add('User', 'ok', user);

  const node = options.nodeVersion ?? process.versions.node;
  const problem = nodeProblem(node);
  add('Node', problem ? 'fail' : 'ok', problem ? `${node}. ${problem}` : node);

  const git = await call('git', ['--version']);
  add('Git', git.code === 0 ? 'ok' : 'fail', git.code === 0 ? git.stdout.trim().replace(/^git version /, '') : 'Not installed');

  const gh = findExecutable('gh', path);
  if (!gh) add('GitHub CLI', 'fail', 'Not installed. See cli.github.com, then run gh auth login');
  else {
    const status = await call(gh, ['auth', 'status'], 15_000);
    add('GitHub CLI', status.code === 0 ? 'ok' : 'fail', status.code === 0 ? 'Signed in' : 'Not signed in. Run gh auth login');
  }

  const t3 = options.t3Bin ?? process.env.T3_BIN ?? findExecutable('t3', join(home, '.t3/bin')) ?? findExecutable('t3', path);
  if (!t3) add('T3 Code', 'fail', 'Not found at ~/.t3/bin/t3 or on PATH. Install T3 Code first');
  else {
    const help = await call(t3, ['thread', 'start', '--help']);
    add('T3 Code', help.code === 0 ? 'ok' : 'fail', help.code === 0 ? t3 : `${t3} doesn’t support "t3 thread". Update T3 Code`);
  }

  const agents = [['claude', 'Claude Code'], ['codex', 'Codex']].filter(([bin]) => findExecutable(bin!, path)).map(([, name]) => name!);
  add('Coding agents', agents.length ? 'ok' : 'warn', agents.length ? `${agents.join(', ')}. Sign in to each on this computer` : 'Neither Claude Code nor Codex is installed');

  try {
    const free = (options.freeBytes ?? freeSpace)(home);
    add('Disk', free >= MIN_FREE ? 'ok' : 'fail', `${(free / GB).toFixed(1)} GB free${free >= MIN_FREE ? '' : '. Free at least 2 GB'}`);
  } catch { add('Disk', 'warn', 'Couldn’t read free space'); }

  if (platform === 'darwin') add('Background service', 'ok', 'launchd');
  else if (platform === 'linux') {
    const manager = await call('systemctl', ['--user', 'show-environment']);
    if (manager.code !== 0) add('Background service', 'warn', 'No systemd user manager. The bot runs in the foreground only');
    else {
      const linger = await call('loginctl', ['show-user', user, '--property=Linger', '--value']);
      if (linger.stdout.trim() === 'yes') add('Background service', 'ok', 'systemd, starts at boot');
      else add('Background service', 'warn', `systemd, stops when you log out. To keep it running: sudo loginctl enable-linger ${user}`);
    }
  } else add('Background service', 'warn', 'None on this system. The bot runs in the foreground only');

  return checks;
};

const LABEL: Record<HostCheck['state'], string> = { ok: 'PASS', warn: 'NOTE', fail: 'FAIL' };

/** One line per check, as the CLI prints them. */
export const formatHostChecks = (checks: readonly HostCheck[]): string =>
  checks.map((check) => `${LABEL[check.state]} ${check.name}: ${check.detail}`).join('\n');
