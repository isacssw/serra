// New task (APP-25) and the knowledge interview (APP-26), on src/tasks.ts. Handlers only check what the window sent and call the service, which starts the
// T3 thread exactly as the daemon does for a Slack request. The profile's tokens are never read here: a task needs no
// Slack, and nothing from the config but the thread's details goes back to the window.
import { readAgentBackend } from '../../../src/agent/acp-agents.ts';
import { requestRun } from '../../../src/status-socket.ts';
import { previewInterview, previewTask, startInterview, startTask, taskRequest, type StartedTask, type TaskDeps } from '../../../src/tasks.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

/** Tests swap the daemon. */
export interface TasksDaemon { run: typeof requestRun }

/** What the daemon started, as the window shows it. */
const startedFrom = (value: unknown): StartedTask => {
  const text = (field: unknown): string | undefined => (typeof field === 'string' ? field : undefined);
  const record = typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
  const [threadId, title, branch, requester, createdAt] = ['threadId', 'title', 'branch', 'requester', 'createdAt'].map((key) => text(record[key]));
  if (!threadId || title === undefined || branch === undefined || requester === undefined || createdAt === undefined) throw new Error('The bot didn’t start the task. Try again.');
  const backend = text(record.backend);
  return { threadId, title, branch, requester, createdAt, ...(backend ? { backend } : {}) };
};

export const tasksHandlers = (context: HandlerContext, deps: TaskDeps = {}, daemon: TasksDaemon = { run: requestRun }): Handlers<'tasks'> => {
  /** On an ACP agent the bot starts it: the agent lives in the bot's process, which follows it to the end. */
  const onAcp = (): boolean => readAgentBackend(context.profileDir()).backend === 'acp';
  // One start at a time, task or interview: a double click must not start two threads.
  let starting = false;
  const once = async <T>(start: () => Promise<T>): Promise<T> => {
    if (starting) throw new Error('A task is already starting.');
    starting = true;
    try {
      return await start();
    } finally {
      starting = false;
    }
  };
  return {
    preview: (request) => previewTask(context.profileDir(), request),
    start: async (request) => {
      const text = taskRequest(request);
      return once(async () => (onAcp() ? startedFrom(await daemon.run(context.profileDir(), { op: 'task', request: text })) : startTask(context.profileDir(), text, deps)));
    },
    previewInterview: () => previewInterview(context.profileDir(), deps.now?.()),
    startInterview: () => once(async () => (onAcp() ? startedFrom(await daemon.run(context.profileDir(), { op: 'interview' })) : startInterview(context.profileDir(), deps))),
  };
};
