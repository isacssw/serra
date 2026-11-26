// T3 Code behind Serra's agent interface (src/agent/backend.ts): the default backend. It wraps Serra's T3 layer, the
// `t3` CLI (src/t3.ts) and T3's own tool endpoint (src/t3-session.ts), without changing what either does:
// - a worktree run is `t3 thread start --worktree`; a folder run makes the folder a T3 project of its own first;
// - a read-only run is launched on T3's tool endpoint in `approval-required` mode, which Serra's session can stop;
// - follow-ups go through the CLI, except to a read-only run, which stays on the session it was launched from;
// - a run's state is `t3 thread show --json`, and its tool results are read from T3's record of the run.
// The tool endpoint's session is opened only when a call needs it, and revoked on `close()`.
import { realpathSync } from 'node:fs';
import { isRecord, parseJson } from '../json-guards.ts';
import { ensureProject, findThreads, sendToThread, showThread, startFolderThread, startThread } from '../t3.ts';
import { answerQuestion, listQuestions } from '../t3-questions.ts';
import { openT3Session, type T3Session } from '../t3-session.ts';
import { pollUntilSettled, type AgentBackend, type BackendCapabilities, type RunToolCall, type StartRun } from './backend.ts';

/** How much of one item T3 gives per read. */
const ITEM_PAGE_CHARS = 20_000;
/** A tool result is read in at most this many pages (about 1 MB). Past that it's too long. */
const ITEM_MAX_PAGES = 50;
/** Item types T3 records a tool call and its result as. */
const TOOL_ITEMS = new Set(['dynamic_tool', 'mcp_tool_call', 'dynamic_tool_call']);

const T3_CAPABILITIES: BackendCapabilities = {
  steer: true, worktrees: true, persistentRuns: true, transcriptLink: true, readOnly: true, toolResults: true,
};

/** The `t3` CLI calls the backend makes. Tests pass fakes; a missing one is a call that backend never makes. */
interface T3Cli {
  startThread?: typeof startThread;
  startFolderThread?: typeof startFolderThread;
  showThread: typeof showThread;
  sendToThread?: typeof sendToThread;
  findThreads?: typeof findThreads;
  ensureProject?: typeof ensureProject;
}

export interface T3BackendOptions {
  bin: string;
  /** The CLI calls; the real `t3` CLI when absent. */
  cli?: T3Cli;
  /** Opens a session on T3's tool endpoint; a real one, revoked on `close()`, when absent. */
  session?: () => Promise<T3Session>;
  /** T3's question bridge (Slack question cards); the real one when absent. */
  questions?: { listQuestions: typeof listQuestions; answerQuestion: typeof answerQuestion };
}

const missing = (what: string): Error => new Error(`Serra's T3 layer can't ${what} here.`);

export const createT3Backend = ({
  bin,
  cli = { startThread, startFolderThread, showThread, sendToThread, findThreads, ensureProject },
  session: openSession = () => openT3Session({ bin }),
  questions = { listQuestions, answerQuestion },
}: T3BackendOptions): AgentBackend => {
  let opened: Promise<T3Session> | null = null;
  const session = (): Promise<T3Session> => (opened ??= openSession());
  /** Threads launched read-only on the session: their follow-ups stay on it. */
  const guarded = new Set<string>();

  /** The folder's T3 project, by its path. */
  const projectId = async (open: T3Session, path: string, name: string): Promise<string> => {
    const real = realpathSync(path);
    let cursor: number | null = 0;
    for (let page = 0; cursor !== null && page < 20; page += 1) {
      const out = await open.call('t3_project_list', { cursor, limit: 100 });
      const projects = Array.isArray(out.projects) ? out.projects.filter(isRecord) : [];
      const found = projects.find((project) => project.deletedAt == null && (project.workspaceRoot === real || project.workspaceRoot === path));
      if (found && typeof found.id === 'string') return found.id;
      cursor = typeof out.nextCursor === 'number' ? out.nextCursor : null;
    }
    throw new Error(`T3 Code has no "${name}" project. Try again.`);
  };

  /** Starts a thread in `approval-required` mode, which Serra's session can stop. */
  const launchGuarded = async (path: string, name: string, { title, brief, provider, model }: StartRun): Promise<string> => {
    if (provider && !model) throw new Error(`Pick a model for ${provider} in Serra › Settings › Worker, or leave both empty to use T3's default.`);
    const open = await session();
    const out = await open.call('t3_thread_launch', {
      projectId: await projectId(open, path, name), title, message: brief, runtimeMode: 'approval-required', interactionMode: 'default',
      ...(model ? { modelSelection: { ...(provider ? { instanceId: provider } : {}), model } } : {}),
    });
    if (typeof out.threadId !== 'string') throw new Error('T3 Code didn’t start the run. Try again.');
    guarded.add(out.threadId);
    return out.threadId;
  };

  const start = async (input: StartRun): Promise<string> => {
    const { workspace, title, brief, provider, model } = input;
    const worker = { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
    if (workspace.kind === 'worktree') {
      if (input.readOnly) throw new Error('A worktree run in T3 is never read-only.');
      if (!cli.startThread) throw missing('start a worktree thread');
      return cli.startThread({ project: workspace.project, baseRef: workspace.baseRef, branch: workspace.branch, title, brief, ...worker }, bin);
    }
    if (!cli.ensureProject) throw missing('add a project');
    await cli.ensureProject(workspace.path, workspace.name, bin);
    if (input.readOnly) return launchGuarded(workspace.path, workspace.name, input);
    if (!cli.startFolderThread) throw missing('start a folder thread');
    return cli.startFolderThread({ project: workspace.path, title, brief, ...worker }, bin);
  };

  const read: AgentBackend['read'] = (threadId, messages = 1) => cli.showThread(threadId, bin, messages);

  /** The full text of one item, read page by page. Null when it's longer than Serra reads. */
  const itemText = async (open: T3Session, threadId: string, item: Record<string, unknown>): Promise<string | null> => {
    let text = typeof item.text === 'string' ? item.text : '';
    let offset = item.textTruncated === true && typeof item.nextTextOffset === 'number' ? item.nextTextOffset : null;
    for (let page = 1; offset !== null; page += 1) {
      if (page >= ITEM_MAX_PAGES) return null;
      const out = await open.call('t3_thread_read', { threadId, itemId: item.itemId, textOffset: offset, maxCharsPerItem: ITEM_PAGE_CHARS });
      const next = Array.isArray(out.items) ? out.items.find((entry) => isRecord(entry) && entry.itemId === item.itemId) : undefined;
      if (!isRecord(next) || typeof next.text !== 'string') return null;
      text += next.text;
      offset = next.textTruncated === true && typeof next.nextTextOffset === 'number' ? next.nextTextOffset : null;
    }
    return text;
  };

  /** The run's last tool call that names `match`, from T3's record of the run. A record Serra can't read whole is `unreadable`. */
  const toolCall = async (threadId: string, runId: string, match: string): Promise<RunToolCall | null> => {
    const open = await session();
    const calls: Record<string, unknown>[] = [];
    let after = -1;
    for (let page = 0; page < 50; page += 1) {
      const out = await open.call('t3_thread_read', { threadId, view: 'activity', afterPosition: after, limit: 100, maxCharsPerItem: ITEM_PAGE_CHARS });
      const items = Array.isArray(out.items) ? out.items.filter(isRecord) : [];
      // A call's input comes before its output, so the first page of its text shows what it was asked for.
      calls.push(...items.filter((item) => item.runId === runId && TOOL_ITEMS.has(String(item.type)) && typeof item.text === 'string' && item.text.includes(match)));
      if (out.hasMore !== true || typeof out.nextPosition !== 'number' || out.nextPosition <= after) break;
      after = out.nextPosition;
    }
    const last = calls.at(-1);
    if (!last) return null;
    const text = await itemText(open, threadId, last);
    const value = text === null ? undefined : parseJson(text);
    if (!isRecord(value)) return { input: undefined, output: undefined, failed: false, unreadable: true };
    return { input: value.input, output: value.output, failed: last.status === 'failed' };
  };

  return {
    id: 't3',
    key: 't3',
    label: 'T3',
    questions: {
      list: (threadId) => questions.listQuestions(threadId, bin),
      answer: (threadId, requestId, answers) => questions.answerQuestion(threadId, requestId, answers, bin),
    },
    capabilities: T3_CAPABILITIES,
    start,
    send: async (threadId, message, { mode = 'queue' } = {}) => {
      if (guarded.has(threadId) || mode === 'steer' || !cli.sendToThread) {
        await (await session()).call('t3_thread_send', { threadId, message, mode });
        return;
      }
      await cli.sendToThread(threadId, message, bin);
    },
    interrupt: async (threadId, reason) => {
      await (await session()).call('t3_thread_interrupt', { threadId, stop: true, reason });
    },
    read,
    wait: (threadId, options) => pollUntilSettled(read, threadId, options),
    list: async ({ project, title, since }) => (cli.findThreads ? cli.findThreads(project, title, since, bin) : []),
    settle: async (threadId) => {
      await (await session()).call('t3_thread_organize', { threadId, action: 'settle' });
    },
    toolCall,
    close: async () => {
      if (!opened) return;
      const open = opened;
      opened = null;
      await open.then((value) => value.close(), () => {});
    },
  };
};
