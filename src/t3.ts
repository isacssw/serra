import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { branchName } from './branch.ts';
import type { Config } from './config.ts';
import { CommandError } from './lib/errors.ts';
import type { FolderThreadInput, StartThreadInput, T3Message, T3Thread, T3ThreadDetail } from './types.ts';

const T3_BIN = process.env.T3_BIN ?? `${homedir()}/.t3/bin/t3`;

interface RunOptions {
  input?: string;
  timeoutMs?: number;
}

/**
 * Runs a command, piping `input` to stdin. Rejects with a `CommandError` on a non-zero exit, carrying what the command
 * printed: stderr, else stdout (T3 prints its errors, like `ProjectAlreadyExistsError`, to stdout).
 */
export const run = (cmd: string, args: string[], { input, timeoutMs = 60_000 }: RunOptions = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const command = [basename(cmd), ...args.slice(0, 2)].join(' ');
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CommandError(`${command} timed out after ${timeoutMs}ms`, command, '', 'timeout'));
    }, timeoutMs);
    child.once('close', () => clearTimeout(timer));
    child.once('error', () => clearTimeout(timer));
    child.stdin.on('error', reject);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(new CommandError(`${command} could not start: ${error.message}`, command, error.message, error.code === 'ENOENT' ? 'missing' : 'spawn'));
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      const detail = (stderr.trim() || stdout.trim()).slice(-2000);
      reject(new CommandError(`${command} exited ${code}: ${detail || '(no output)'}`, command, detail, 'exit'));
    });
    child.stdin.end(input);
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isThread = (value: unknown): value is T3Thread =>
  isRecord(value) &&
  typeof value.threadId === 'string' &&
  typeof value.link === 'string' &&
  typeof value.status === 'string' &&
  isStringOrNull(value.latestRunId) &&
  isStringOrNull(value.activeRunId);

const isMessage = (value: unknown): value is T3Message =>
  isRecord(value) &&
  typeof value.role === 'string' &&
  (value.runId === undefined || typeof value.runId === 'string') &&
  (value.text === undefined || typeof value.text === 'string');

const isThreadDetail = (value: unknown): value is T3ThreadDetail =>
  isRecord(value) && isThread(value.thread) && Array.isArray(value.messages) && value.messages.every(isMessage);

const parseJson = (raw: string, what: string): unknown => {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error(`No JSON in t3 ${what} output: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start));
};

/**
 * The thread a job starts, for a brief already filled: a branch from the profile's `branchPattern`, the title
 * `<bot name>: <summary>` and the profile's worker. The daemon (a Slack request) and the app (a task, src/tasks.ts)
 * both start their threads from this, so a job looks the same in T3 whichever way it began.
 */
export const jobThreadInput = (
  config: Pick<Config, 'id' | 'name' | 'project' | 'baseRef' | 'branchPattern' | 'workerProvider' | 'workerModel'>,
  { summary, brief, now }: { summary: string; brief: string; now: Date },
): StartThreadInput => ({
  project: config.project,
  baseRef: config.baseRef,
  branch: branchName(config.branchPattern, { id: config.id, request: summary, now }),
  title: `${config.name}: ${summary.replace(/\s+/g, ' ').slice(0, 60)}`,
  brief,
  ...(config.workerProvider ? { provider: config.workerProvider } : {}),
  ...(config.workerModel ? { model: config.workerModel } : {}),
});

const start = async ({ project, baseRef, branch, title, brief, provider, model }: StartThreadInput | FolderThreadInput, bin: string): Promise<string> => {
  const worker = [...(provider ? ['--provider', provider] : []), ...(model ? ['--model', model] : [])];
  const worktree = baseRef && branch ? ['--worktree', baseRef, '--branch', branch] : [];
  const raw = await run(
    bin,
    ['thread', 'start', ...worktree, '--title', title, ...worker, '--json', project, '-'],
    { input: brief },
  );
  const out = parseJson(raw, 'thread start');
  if (!isRecord(out) || typeof out.threadId !== 'string') {
    throw new Error(`t3 thread start returned no thread id: ${raw.slice(0, 300)}`);
  }
  return out.threadId;
};

/** Starts a thread in a new worktree with the brief on stdin, and returns its id. */
export const startThread = (input: StartThreadInput, bin = T3_BIN): Promise<string> => start(input, bin);

/**
 * Starts a thread in the project's own folder, with no worktree, and returns its id: a meeting run, in Serra's empty
 * meetings folder (src/meeting-runs.ts). Same CLI, provider and model choice as a job.
 */
export const startFolderThread = (input: FolderThreadInput, bin = T3_BIN): Promise<string> => start(input, bin);

/**
 * The threads in `project` titled `title` and created at or after `since`, newest first. A start cut off by a crash may
 * still have made its thread: the bot confirms which one is its own before carrying on there. Throws on output that
 * isn't T3's list, so a change in T3 shows up in the log instead of passing for "none".
 */
export const findThreads = async (project: string, title: string, since: string, bin = T3_BIN): Promise<string[]> => {
  const raw = await run(bin, ['thread', 'list', '--json', '--project', project]);
  const start = raw.search(/[[{]/);
  const parsed: unknown = start === -1 ? null : JSON.parse(raw.slice(start));
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.threads) ? parsed.threads : null;
  if (!list) throw new Error(`Unexpected t3 thread list output: ${raw.slice(0, 200)}`);
  const from = Date.parse(since);
  return list
    .filter((thread): thread is Record<string, unknown> & { threadId: string; createdAt: string } => isRecord(thread)
      && thread.title === title && typeof thread.threadId === 'string' && typeof thread.createdAt === 'string' && Date.parse(thread.createdAt) >= from)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((thread) => thread.threadId);
};

/**
 * Makes `path` a T3 project of its own, if it isn't one yet, and reuses it when it is. T3 resolves a path to the deepest project containing it,
 * so a thread started at `path` then runs there, never in a project that happens to contain the folder.
 */
export const ensureProject = async (path: string, title: string, bin = T3_BIN): Promise<void> => {
  try {
    await run(bin, ['project', 'add', '--title', title, path]);
  } catch (error) {
    // Real T3 prints `ProjectAlreadyExistsError: An active project already exists…` to stdout, which `run` keeps.
    if (!/ProjectAlreadyExists|already exists/i.test(error instanceof CommandError ? error.detail : String(error))) throw error;
  }
};

/** Queues a message on a thread. A busy thread gets it as its next turn. */
export const sendToThread = async (threadId: string, message: string, bin = T3_BIN): Promise<void> => {
  await run(bin, ['thread', 'send', '--json', threadId, '-'], { input: message });
};

/** Reads a thread's state and its latest `messages` messages, oldest first. Throws if T3's JSON no longer has the fields the bot needs. */
export const showThread = async (threadId: string, bin = T3_BIN, messages = 1): Promise<T3ThreadDetail> => {
  const raw = await run(bin, ['thread', 'show', '--messages', String(messages), '--json', threadId]);
  const detail = parseJson(raw, 'thread show');
  if (!isThreadDetail(detail)) {
    throw new Error(`Unexpected t3 thread show output for ${threadId}: ${raw.slice(0, 300)}`);
  }
  return detail;
};

/** A GitHub pull request URL, `https://github.com/<owner>/<repo>/pull/<n>`, and nothing after it. */
export const GITHUB_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/**
 * The PR a T3 thread is about, from `t3 thread show --json`: the one linked to the thread, else the newest open one
 * it opened or found, else the newest of any state. Only github.com PR links count. A draft PR the bot never asked
 * a review for (so `reviewRequestedPrs` is empty) is found here.
 */
export const threadPullRequest = (thread: Record<string, unknown>): string | undefined => {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const prs = (Array.isArray(thread.pullRequests) ? thread.pullRequests : [])
    .map(record)
    .filter((pr) => typeof pr.url === 'string' && GITHUB_PR_URL.test(pr.url));
  const linked = thread.linkedPullRequest;
  const linkedUrl = typeof linked === 'string' ? linked : record(linked).url;
  if (typeof linkedUrl === 'string' && GITHUB_PR_URL.test(linkedUrl)) return linkedUrl;
  // T3 lists them oldest first.
  return (prs.filter((pr) => pr.state === 'open').at(-1) ?? prs.at(-1))?.url as string | undefined;
};
