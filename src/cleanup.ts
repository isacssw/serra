import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { readProfileFile } from './config.ts';
import { readEnv } from './lib/env.ts';
import { readState } from './state.ts';
import { readTasks } from './tasks.ts';

/** Runs a command and resolves with its stdout. Rejects when it exits non-zero. Injected so tests never call git, gh or t3. */
export type Runner = (cmd: string, args: string[], options?: { cwd?: string }) => Promise<string>;

export const runCommand: Runner = (cmd, args, { cwd } = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} ${args.join(' ')} failed: ${String(stderr).trim() || error.message}`));
      else resolve(String(stdout));
    });
  });

export interface CleanupOptions {
  statePath: string;
  t3Bin: string;
  /** A job must be quiet this many days before its worktree goes. */
  days?: number;
  /** Remove the worktrees. Without it, only report. */
  apply?: boolean;
  now?: Date;
  /** Only worktrees inside this folder are ever removed. */
  worktreesRoot?: string;
  run?: Runner;
}

export interface Verdict {
  threadId: string;
  path: string | null;
  branch: string | null;
  removable: boolean;
  /** Why the worktree is kept, or why it may go. */
  reason: string;
  /** Set with --apply: the removal succeeded, or the error it hit. */
  removed?: boolean;
  error?: string;
}

/** The fields of `t3 thread show --json` cleanup reads, parsed without trusting their shape. */
interface ThreadFacts {
  worktreePath: string | null;
  branch: string | null;
  activeRunId: string | null;
  openPullRequestCount: number | null;
  /** When T3 last saw the thread change. The owner may carry on in T3 without anything in Slack. */
  updatedAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const parseThread = (raw: string): ThreadFacts => {
  const thread = record(record(JSON.parse(raw)).thread);
  const text = (key: string): string | null => (typeof thread[key] === 'string' && thread[key] ? (thread[key] as string) : null);
  const count = thread.openPullRequestCount;
  return {
    worktreePath: text('worktreePath'),
    branch: text('branch'),
    activeRunId: text('activeRunId'),
    openPullRequestCount: typeof count === 'number' ? count : null,
    updatedAt: text('updatedAt'),
  };
};

/**
 * Each job's T3 thread and the time it last saw activity, then each task the app started (`tasks.json` next to
 * state.json, APP-25), whose activity T3's own date covers. state.json is only read, never written.
 */
const readJobs = (statePath: string): { threadId: string; lastActivity: string }[] => {
  const jobs = Object.values(readState(statePath).jobs).map((job) => ({ threadId: job.threadId, lastActivity: job.lastActivityAt ?? job.createdAt }));
  const tasks = readTasks(dirname(statePath)).map((task) => ({ threadId: task.threadId, lastActivity: task.createdAt }));
  return [...jobs, ...tasks];
};

const realPath = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Decides, for every job in state.json, whether its T3 worktree can go: quiet for `days`, no running turn,
 * no open PR, nothing uncommitted and nothing unpushed. Anything it can't confirm keeps the worktree.
 * With `apply`, removes the removable ones with `git worktree remove` (never forced).
 */
export const cleanupWorktrees = async ({
  statePath, t3Bin, days = 3, apply = false, now = new Date(),
  worktreesRoot = `${homedir()}/.t3/worktrees`, run = runCommand,
}: CleanupOptions): Promise<Verdict[]> => {
  const root = realPath(worktreesRoot);
  const verdicts: Verdict[] = [];

  for (const { threadId, lastActivity } of readJobs(statePath)) {
    const verdict = (removable: boolean, reason: string, facts?: ThreadFacts): Verdict => ({
      threadId, path: facts?.worktreePath ?? null, branch: facts?.branch ?? null, removable, reason,
    });
    // The thread is read even for a recent job, so a worktree it shares with an older job is known to be in use.
    let facts: ThreadFacts;
    try {
      facts = parseThread(await run(t3Bin, ['thread', 'show', '--messages', '1', '--json', threadId]));
    } catch (error) {
      verdicts.push(verdict(false, `couldn't read the T3 thread: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }
    // A clock a little ahead of this one (T3's, or a write a moment ago) would read as "-0.0 days ago".
    const idleDays = Math.max(0, (now.getTime() - Date.parse(lastActivity)) / DAY_MS);
    if (!Number.isFinite(idleDays)) { verdicts.push(verdict(false, 'no readable activity date', facts)); continue; }
    if (idleDays < days) { verdicts.push(verdict(false, `active ${idleDays.toFixed(1)} days ago, under ${days}`, facts)); continue; }
    const t3IdleDays = Math.max(0, (now.getTime() - Date.parse(facts.updatedAt ?? '')) / DAY_MS);
    if (!Number.isFinite(t3IdleDays)) { verdicts.push(verdict(false, "T3 didn't report when the thread last changed", facts)); continue; }
    if (t3IdleDays < days) { verdicts.push(verdict(false, `changed in T3 ${t3IdleDays.toFixed(1)} days ago, under ${days}`, facts)); continue; }
    verdicts.push(await judge(facts, idleDays, root, run, verdict));
  }

  // Two jobs can share a worktree. It goes only when every job using it lets it go, and only once.
  const kept = new Set(verdicts.filter((v) => !v.removable && v.path).map((v) => v.path));
  const seen = new Set<string>();
  for (const v of verdicts) {
    if (!v.removable || !v.path) continue;
    if (kept.has(v.path)) Object.assign(v, { removable: false, reason: 'another job still uses this worktree' });
    else if (seen.has(v.path)) Object.assign(v, { removable: false, reason: 'listed above' });
    seen.add(v.path);
  }

  if (apply) {
    for (const v of verdicts) {
      if (!v.removable || !v.path) continue;
      try {
        await run('git', ['-C', v.path, 'worktree', 'remove', v.path]);
        v.removed = true;
      } catch (error) {
        v.removed = false;
        v.error = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return verdicts;
};

/** The checks that need the thread's worktree, cheapest first. */
const judge = async (
  facts: ThreadFacts,
  idleDays: number,
  root: string | null,
  run: Runner,
  verdict: (removable: boolean, reason: string, facts?: ThreadFacts) => Verdict,
): Promise<Verdict> => {
  const keep = (reason: string): Verdict => verdict(false, reason, facts);
  const { worktreePath: path, branch } = facts;
  if (facts.activeRunId) return keep('a run is in progress');
  if (facts.openPullRequestCount === null) return keep("T3 didn't report open PRs");
  if (facts.openPullRequestCount > 0) return keep(`${facts.openPullRequestCount} open PR(s) in T3`);
  if (!path) return keep('the thread has no worktree');
  if (!existsSync(path)) return keep('worktree already gone');
  const real = realPath(path);
  if (!root || !real || !real.startsWith(`${root}${sep}`)) return keep('not inside the T3 worktrees folder');
  if (!branch) return keep('the thread has no branch');

  try {
    if ((await run('git', ['-C', path, 'status', '--porcelain'])).trim()) return keep('uncommitted changes');
    const unpushed = (await run('git', ['-C', path, 'log', '--oneline', `refs/heads/${branch}`, '--not', '--remotes'])).trim();
    if (unpushed) return keep(`${unpushed.split('\n').length} unpushed commit(s) on ${branch}`);
    // The worker may have moved to another branch or a detached HEAD in the worktree. Commits there would be lost.
    const unpushedHead = (await run('git', ['-C', path, 'log', '--oneline', 'HEAD', '--not', '--remotes'])).trim();
    if (unpushedHead) return keep(`${unpushedHead.split('\n').length} unpushed commit(s) on the worktree's HEAD`);
  } catch (error) {
    return keep(`git check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The branch checked out now can differ from the one T3 created (a `git branch -m`, or a PR's branch).
  const current = await run('git', ['-C', path, 'symbolic-ref', '-q', '--short', 'HEAD']).then((out) => out.trim(), () => '');
  for (const head of [...new Set([branch, current].filter(Boolean))]) {
    try {
      const prs: unknown = JSON.parse(await run('gh', ['pr', 'list', '--head', head, '--state', 'open', '--json', 'number'], { cwd: path }));
      if (!Array.isArray(prs)) return keep('gh returned something unexpected');
      if (prs.length > 0) return keep(`${prs.length} open PR(s) on GitHub for ${head}`);
    } catch (error) {
      return keep(`couldn't check GitHub PRs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return verdict(true, `quiet ${Math.floor(idleDays)} days, clean, pushed, no open PR`, facts);
};

/** The dry-run or apply report, one line per job and a total. */
export const formatCleanup = (verdicts: Verdict[], apply: boolean): string => {
  const lines = verdicts.map((v) => {
    const where = v.path ?? v.threadId;
    if (!v.removable) return `keep    ${where}: ${v.reason}`;
    if (!apply) return `remove  ${where}: ${v.reason}`;
    return v.removed ? `removed ${where}` : `failed  ${where}: ${v.error ?? 'unknown error'}`;
  });
  const removable = verdicts.filter((v) => v.removable).length;
  const total = apply
    ? `${verdicts.filter((v) => v.removed).length} of ${removable} removable worktree(s) removed, ${verdicts.length - removable} job(s) kept.`
    : `${removable} worktree(s) would be removed, ${verdicts.length - removable} job(s) kept. Run again with --apply to remove them.`;
  return [...lines, '', total].join('\n');
};

export interface CleanupReport {
  /** False for a dry run: nothing was removed. */
  applied: boolean;
  days: number;
  verdicts: Verdict[];
  /** Worktrees that may go (dry run) or were tried (apply). */
  removable: number;
  /** Worktrees actually removed. Always 0 on a dry run. */
  removed: number;
  /** Jobs whose worktree stays. */
  kept: number;
}

export interface CleanupServiceOptions {
  days?: number;
  now?: Date;
  worktreesRoot?: string;
  run?: Runner;
}

/**
 * The t3 binary a profile uses, resolved like `loadConfig` but without the Slack tokens, which reading jobs and
 * cleaning worktrees don't need: `t3Bin` in profile.json, then `T3_BIN` in the profile's .env, then `~/.t3/bin/t3`.
 */
export const profileT3Bin = (profileDir: string): string => {
  const directory = resolve(profileDir);
  return readProfileFile(directory).t3Bin ?? readEnv(join(directory, '.env')).T3_BIN?.trim() ?? join(homedir(), '.t3/bin/t3');
};

const profilePaths = (profileDir: string): { statePath: string; t3Bin: string } =>
  ({ statePath: join(resolve(profileDir), 'state.json'), t3Bin: profileT3Bin(profileDir) });

const report = (verdicts: Verdict[], applied: boolean, days: number): CleanupReport => {
  const removable = verdicts.filter((v) => v.removable).length;
  return { applied, days, verdicts, removable, removed: verdicts.filter((v) => v.removed).length, kept: verdicts.length - removable };
};

const checkDays = (days: number): number => {
  if (!Number.isFinite(days) || days < 0) throw new Error('days needs a number of days, like 3');
  return days;
};

/** Worktree cleanup for a profile, as a dry run: lists what would go and why the rest stays. Removes nothing. */
export const planWorktreeCleanup = async (profileDir: string, { days = 3, ...rest }: CleanupServiceOptions = {}): Promise<CleanupReport> => {
  const verdicts = await cleanupWorktrees({ ...profilePaths(profileDir), ...rest, days: checkDays(days), apply: false });
  return report(verdicts, false, days);
};

/**
 * Removes the worktrees cleanup allows for a profile. Every check runs again first, so a worktree that changed since
 * the dry run the owner saw is kept.
 */
export const applyWorktreeCleanup = async (profileDir: string, { days = 3, ...rest }: CleanupServiceOptions = {}): Promise<CleanupReport> => {
  const verdicts = await cleanupWorktrees({ ...profilePaths(profileDir), ...rest, days: checkDays(days), apply: true });
  return report(verdicts, true, days);
};
