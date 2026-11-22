/**
 * Tasks the owner starts from the app, without Slack (APP-25). A task is a job like one from Slack: its T3 thread gets
 * the same brief, filled by the same `fillBrief` with the bot's knowledge index, and is started by the same
 * `startThread` with the same branch, title and worker (`jobThreadInput`). Only what a Slack message would add is
 * different: there is no Slack link and no earlier thread, and the requester is the owner.
 *
 * The daemon owns `state.json` and the app never writes it, so tasks are recorded in the profile's own `tasks.json`,
 * written only here. `listJobs` reads both, so a task shows in Jobs, and its group comes from T3, since the daemon
 * doesn't follow it: its replies are read in T3.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fillBrief, renderBrief, type BriefInput } from './brief.ts';
import { codeRoot, loadConfig, writeFileAtomic, type Config } from './config.ts';
import { createKnowledge } from './knowledge.ts';
import { parseJson } from './lib/guards.ts';
import { APP_PROPOSALS_FOLDER, stampProposalsFolder } from './proposals.ts';
import { jobThreadInput, run, showThread, startThread, threadPullRequest } from './t3.ts';
import type { StartThreadInput } from './types.ts';

/** The channel a task's Jobs row shows, where a Slack job shows its channel ID. Slack IDs are upper case, so it can't clash. */
export const APP_TASK_CHANNEL = 'app';

/**
 * What the brief's `{{PERMALINK}}` gets for a task: nothing, since there is no Slack message to link to.
 * `renderBrief` then leaves the brief's ` ({{PERMALINK}})` out, so the request reads "Alex asked:".
 */
export const APP_TASK_PERMALINK = '';

/** What the brief's `{{THREAD_CONTEXT}}` says for a task, so the worker knows there is no Slack thread to read. */
export const appTaskThread = (ownerName: string): string =>
  `(None. ${ownerName} started this task in the Serra app, not in Slack, so there is no Slack thread.)`;

/** The longest request the app sends, so a pasted log can't make a brief T3 refuses. */
export const MAX_TASK_REQUEST = 20_000;

const TASKS_FILE = 'tasks.json';

/** One task in `tasks.json`. The request itself isn't kept: it is in the T3 thread. */
export interface AppTask {
  t3ThreadId: string;
  /** The thread's title without the bot name, from the request's first words. */
  title: string;
  branch: string;
  /** The owner's name when the task started. */
  requester: string;
  createdAt: string;
}

/** What `startTask` returns to the app. Never anything from the config's tokens. */
export interface StartedTask extends AppTask {
  /** The T3 thread's link, when T3 answered with one right after starting it. */
  link?: string;
}

export const tasksPath = (profileDir: string): string => join(resolve(profileDir), TASKS_FILE);

const isTask = (value: unknown): value is AppTask => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return ['t3ThreadId', 'title', 'branch', 'requester', 'createdAt'].every((key) => typeof task[key] === 'string')
    && (task.t3ThreadId as string) !== '';
};

/** The profile's tasks, oldest first. A missing file is no tasks; entries that don't parse are skipped. */
export const readTasks = (profileDir: string): AppTask[] => {
  let raw: string;
  try {
    raw = readFileSync(tasksPath(profileDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // A broken file is reported, not read as no tasks: adding a task would otherwise write over the ones in it.
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) throw new Error(`${TASKS_FILE} is not a JSON list. Fix or remove ${tasksPath(profileDir)}.`);
  return parsed.filter(isTask);
};

const addTask = (profileDir: string, task: AppTask): void => {
  const tasks = readTasks(profileDir);
  writeFileAtomic(tasksPath(profileDir), JSON.stringify([...tasks, task], null, 2) + '\n');
};

/** The request as the app sends it: trimmed, and refused when empty or too long. */
export const taskRequest = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Write what the bot should do.');
  const request = value.trim();
  if (request.length > MAX_TASK_REQUEST) throw new Error(`The request is ${request.length} characters. Keep it under ${MAX_TASK_REQUEST}.`);
  return request;
};

/** What `fillBrief` gets for a task: the owner asked, outside Slack, in no earlier thread. */
export const taskBriefInput = (config: Pick<Config, 'ownerName'>, request: string): BriefInput =>
  ({ request, requester: `${config.ownerName} (your owner)`, permalink: APP_TASK_PERMALINK, thread: appTaskThread(config.ownerName), proposalsFolder: APP_PROPOSALS_FOLDER });

/** The brief a task's worker gets: the daemon's `fillBrief` with the profile's brief and knowledge index. */
export const taskBrief = (config: Config, request: string): string =>
  fillBrief(config, createKnowledge(config.knowledgeDir).briefKnowledge('owner'), taskBriefInput(config, request));

/** The thread `startTask` would start, without starting it. */
export const taskThreadInput = (config: Config, request: string, now: Date = new Date()): StartThreadInput =>
  jobThreadInput(config, { summary: request, brief: taskBrief(config, request), now });

export interface TaskDeps {
  startThread?: typeof startThread;
  showThread?: typeof showThread;
  /** Brings the base branch up to date first, as the daemon does before every job. */
  fetchBase?: (config: Config) => Promise<unknown>;
  now?: () => Date;
}

const fetchBase = (config: Config): Promise<unknown> => run('git', ['-C', config.project, 'fetch', config.remote, '--quiet']);

/** The profile's config without its tokens: a task never needs Slack, so they are never read. */
const taskConfig = (profileDir: string): Config => loadConfig({ profileDir, env: {} });

/** The brief `startTask` would send for this request, for the app's preview. */
export const previewTask = (profileDir: string, request: unknown): string => taskBrief(taskConfig(profileDir), taskRequest(request));

/**
 * Starts a task: fetches the base, starts the T3 thread exactly as the daemon starts a job, then records it in
 * `tasks.json` so it shows in Jobs. A thread that started but couldn't be recorded is still reported, by its id.
 */
export const startTask = async (profileDir: string, request: unknown, deps: TaskDeps = {}): Promise<StartedTask> => {
  const text = taskRequest(request);
  const config = taskConfig(profileDir);
  // A task is the owner's own: its proposals folder says so, as a Slack thread's says who started it.
  stampProposalsFolder(config.knowledgeDir, APP_PROPOSALS_FOLDER, { who: config.ownerName, owner: true, via: 'app' });
  return startRecorded(profileDir, config, taskThreadInput(config, text, (deps.now ?? (() => new Date()))()), deps);
};

/** Starts `input`'s thread and records it in `tasks.json`: what a task and the knowledge interview share. */
const startRecorded = async (profileDir: string, config: Config, input: StartThreadInput, {
  startThread: start = startThread, showThread: show = showThread, fetchBase: fetch = fetchBase, now = () => new Date(),
}: TaskDeps): Promise<StartedTask> => {
  await fetch(config);
  const t3ThreadId = await start(input, config.t3Bin);
  const task: AppTask = {
    t3ThreadId,
    title: input.title.slice(config.name.length + 2),
    branch: input.branch,
    requester: config.ownerName,
    createdAt: now().toISOString(),
  };
  try {
    addTask(profileDir, task);
  } catch (error) {
    throw new Error(`Started T3 thread ${t3ThreadId}, but couldn't record it for Jobs: ${error instanceof Error ? error.message : String(error)}`);
  }
  const link = await show(t3ThreadId, config.t3Bin).then((detail) => detail.thread.link, () => undefined);
  return { ...task, ...(link ? { link } : {}) };
};

/** What T3 says about a task's thread, for its Jobs row. */
export interface TaskState {
  /** A run is going now. */
  running: boolean;
  /** The run waits on a question, approval or secret in T3. */
  waiting: boolean;
  link?: string;
  /** The thread's PR, once it opened one (`threadPullRequest` in t3.ts). */
  pr?: string;
  /** When T3 last saw the thread change. */
  updatedAt?: string;
  /** The thread's newest run, going or finished. Absent before its first run. */
  latestRunId?: string;
}

/** Reads a task's thread. Resolves null when it can't, so one unreadable thread never fails the list. */
export type TaskStateLookup = (t3ThreadId: string) => Promise<TaskState | null>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A `TaskStateLookup` through `t3 thread show --json`. Never cached: a task's state changes as it runs. */
export const t3TaskState = (
  t3Bin: string,
  runner: (cmd: string, args: string[]) => Promise<string> = (cmd, args) => run(cmd, args),
): TaskStateLookup => async (threadId) => {
  try {
    const raw = await runner(t3Bin, ['thread', 'show', '--messages', '1', '--json', threadId]);
    const thread = record(record(JSON.parse(raw.slice(Math.max(0, raw.indexOf('{'))))).thread);
    const link = typeof thread.link === 'string' && thread.link ? thread.link : undefined;
    const pr = threadPullRequest(thread);
    const updatedAt = typeof thread.updatedAt === 'string' && thread.updatedAt ? thread.updatedAt : undefined;
    const latestRunId = typeof thread.latestRunId === 'string' && thread.latestRunId ? thread.latestRunId : undefined;
    return {
      running: typeof thread.activeRunId === 'string' && thread.activeRunId !== '',
      waiting: typeof thread.pendingRequestCount === 'number' && thread.pendingRequestCount > 0,
      ...(link ? { link } : {}),
      ...(pr ? { pr } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(latestRunId ? { latestRunId } : {}),
    };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// The knowledge interview (APP-26)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The guided knowledge interview (docs/knowledge-interview.md), started as a T3 thread from the Proposals screen.
 * It is a task with its own brief, `templates/interview.md`, instead of the bot's: the worker asks the owner
 * questions in T3 and writes what they confirm to `knowledge/proposals/`, where the Proposals queue picks it up.
 * Like a task, it starts in a worktree of the project (it reads the project but changes nothing there) and is
 * recorded in `tasks.json`, so it shows in Jobs.
 */
export const INTERVIEW_TITLE = 'Knowledge interview';

/** The interview's brief template. It ships with the app (templates/ is packaged), unlike docs/. */
export const INTERVIEW_TEMPLATE = join(codeRoot, 'templates/interview.md');

/** The progress notes an earlier interview left, relative to the profile's `knowledge/`. */
export const INTERVIEW_PROGRESS = 'proposals/onboarding-progress.md';

export interface InterviewPreview {
  /** The brief the interview's thread gets. */
  brief: string;
  /** An earlier interview left progress notes, so this one carries on from them. */
  resumes: boolean;
}

/** `YYYY-MM-DD` in the machine's time zone: the date the owner would write on a page today. */
const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const interviewResumes = (config: Pick<Config, 'knowledgeDir'>): boolean => existsSync(join(config.knowledgeDir, INTERVIEW_PROGRESS));

/** The interview's brief for a profile: `templates/interview.md` with the profile's names, folders and today's date. */
export const interviewBrief = (
  config: Pick<Config, 'name' | 'ownerName' | 'profileDir' | 'knowledgeDir' | 'project'>, now: Date = new Date(),
  template: string = readFileSync(INTERVIEW_TEMPLATE, 'utf8'),
): string => {
  const progress = join(config.knowledgeDir, INTERVIEW_PROGRESS);
  return renderBrief(template, {
    BOT_NAME: config.name,
    OWNER_NAME: config.ownerName,
    PROFILE_DIR: config.profileDir,
    KNOWLEDGE_DIR: config.knowledgeDir,
    PROJECT_PATH: config.project,
    TODAY: localDate(now),
    PROGRESS: interviewResumes(config)
      ? `An earlier interview left notes in ${progress}. Read them and the proposals already waiting in ${join(config.knowledgeDir, 'proposals')}, tell ${config.ownerName} where you are picking up, and carry on from the next question instead of starting again.`
      : `This is the first interview for this profile. Create ${progress} once the first topic is done.`,
  });
};

/** The thread `startInterview` would start: a task's thread with the interview's title and brief. */
export const interviewThreadInput = (config: Config, now: Date = new Date()): StartThreadInput =>
  jobThreadInput(config, { summary: INTERVIEW_TITLE, brief: interviewBrief(config, now), now });

/** The brief `startInterview` would send, and whether it carries on from an earlier interview. */
export const previewInterview = (profileDir: string, now: Date = new Date()): InterviewPreview => {
  const config = taskConfig(profileDir);
  return { brief: interviewBrief(config, now), resumes: interviewResumes(config) };
};

/** Starts the knowledge interview as a T3 thread, the way `startTask` starts a task, and records it for Jobs. */
export const startInterview = async (profileDir: string, deps: TaskDeps = {}): Promise<StartedTask> => {
  const config = taskConfig(profileDir);
  return startRecorded(profileDir, config, interviewThreadInput(config, (deps.now ?? (() => new Date()))()), deps);
};
