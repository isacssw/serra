// Eval runs that keep T3 tidy. Every thread an eval starts is launched in T3's approval-required mode (its scratch
// profile sits inside the eval project, so the worker reads pages without asking), at most three at a time, and is
// settled as soon as its answer is saved, whatever happened: settling is reversible, nothing is deleted or archived.
// A sweep at the end settles anything left in the project and says how many are still unsettled (the target is 0).
//
// It talks to T3's own MCP endpoint with a session scoped to orchestration, the same way Serra's meeting runs do. That
// session may only act on threads at approval-required or below, which is why the threads run there.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROTOCOL = '2025-06-18';
/** The most eval threads running at once, so evals never crowd the owner's machine. */
export const MAX_RUNNING = 3;

interface Session { call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => void }

const openSession = async (bin: string): Promise<Session> => {
  const runtime = JSON.parse(readFileSync(join(process.env.T3CODE_HOME ?? join(homedir(), '.t3'), 'userdata', 'server-runtime.json'), 'utf8')) as { origin?: string };
  if (!runtime.origin) throw new Error('T3 Code isn\'t running.');
  const raw = execFileSync(bin, ['auth', 'session', 'issue', '--subject', 'mcp-client', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '6h', '--label', 'Serra evals', '--json'], { encoding: 'utf8' });
  const { token, sessionId } = JSON.parse(raw.slice(raw.indexOf('{'))) as { token: string; sessionId: string };
  let mcp: string | null = null;
  let id = 0;
  const post = async (method: string, params: Record<string, unknown>, notify = false): Promise<unknown> => {
    const response = await fetch(new URL('/mcp', runtime.origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(mcp ? { 'mcp-session-id': mcp } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++id }) }),
      signal: AbortSignal.timeout(120_000),
    });
    mcp = response.headers.get('mcp-session-id') ?? mcp;
    const body = await response.text();
    if (!response.ok) throw new Error(`T3 refused (${response.status}): ${body.slice(0, 200)}`);
    if (notify) return null;
    const events = body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
    const answer = (events.at(-1) ?? JSON.parse(body)) as { result?: unknown; error?: { message?: string } };
    if (answer.error) throw new Error(answer.error.message ?? JSON.stringify(answer.error).slice(0, 200));
    return answer.result;
  };
  await post('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'serra-evals', version: '1' } });
  await post('notifications/initialized', {}, true);
  return {
    call: async (tool, args) => {
      const result = (await post('tools/call', { name: tool, arguments: args })) as { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
      const text = (result.content ?? []).map((part) => part.text ?? '').join('');
      if (result.isError) throw new Error(text.slice(0, 300));
      return result.structuredContent ?? (JSON.parse(text || '{}') as Record<string, unknown>);
    },
    close: () => { try { execFileSync(bin, ['auth', 'session', 'revoke', sessionId]); } catch { /* it expires anyway */ } },
  };
};

export interface EvalRun { threadId: string; runId: string; answer: string; ranOn: string; link: string; asked: boolean }

/** Reads what a worker that stopped is asking, before its thread is settled. */
type ReadAsk = (threadId: string) => Promise<string>;

export interface EvalRunner {
  /** One thread: launched, followed to its end, its final answer read, then settled (also on failure). */
  run: (title: string, brief: string, options?: { timeoutMs?: number; readAsk?: ReadAsk }) => Promise<EvalRun>;
  /** Settle every unsettled thread left in the project; how many are still unsettled after. */
  sweep: () => Promise<{ settled: number; left: number }>;
  close: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

export const createEvalRunner = ({ bin, project, provider, model }: { bin: string; project: string; provider?: string; model?: string }): EvalRunner => {
  let session: Promise<Session> | null = null;
  const open = (): Promise<Session> => (session ??= openSession(bin));
  let projectId: string | null = null;
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async (): Promise<void> => {
    while (running >= MAX_RUNNING) await new Promise<void>((done) => { waiting.push(done); });
    running += 1;
  };
  const release = (): void => { running -= 1; waiting.shift()?.(); };

  const findProject = async (s: Session): Promise<string> => {
    if (projectId) return projectId;
    const real = realpathSync(project);
    const out = await s.call('t3_project_list', { cursor: 0, limit: 200 });
    for (const item of Array.isArray(out.projects) ? out.projects : []) {
      const record = item as { deletedAt?: unknown; workspaceRoot?: unknown; id?: unknown };
      if (record.deletedAt == null && (record.workspaceRoot === real || record.workspaceRoot === project) && typeof record.id === 'string') {
        projectId = record.id;
        return record.id;
      }
    }
    throw new Error(`No T3 project for ${project}`);
  };

  const settle = async (threadId: string): Promise<void> => {
    try {
      const s = await open();
      await s.call('t3_thread_organize', { threadId, action: 'settle' }).catch(async () => {
        // Still running or waiting on a question: stop it, then settle.
        await s.call('t3_thread_interrupt', { threadId, stop: true, reason: 'Serra evals: result saved.' }).catch(() => undefined);
        for (let tries = 0; tries < 5; tries += 1) {
          await sleep(3000);
          try { await s.call('t3_thread_organize', { threadId, action: 'settle' }); return; } catch { /* still stopping */ }
        }
        throw new Error('still running');
      });
    } catch (error) {
      process.stderr.write(`could not settle ${threadId}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}\n`);
    }
  };

  const show = (threadId: string, messages: number): { thread: Record<string, unknown>; messages: { role?: string; runId?: string; text?: string }[] } => {
    const raw = execFileSync(bin, ['thread', 'show', '--messages', String(messages), '--json', threadId], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(raw.slice(raw.indexOf('{'))) as { thread: Record<string, unknown>; messages: { role?: string; runId?: string; text?: string }[] };
  };

  const list = (): { threadId: string; settled: boolean }[] => {
    const raw = execFileSync(bin, ['thread', 'list', '--json', '--project', realpathSync(project)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(raw.slice(raw.search(/[[{]/))) as { threadId: string; settled: boolean }[];
  };

  return {
    run: async (title, brief, { timeoutMs = 8 * 60_000, readAsk } = {}) => {
      await slot();
      let threadId = '';
      try {
        const s = await open();
        const out = await s.call('t3_thread_launch', {
          projectId: await findProject(s), title, message: brief, runtimeMode: 'approval-required', interactionMode: 'default',
          ...(model ? { modelSelection: { ...(provider ? { instanceId: provider } : {}), model } } : {}),
        });
        if (typeof out.threadId !== 'string') throw new Error('T3 started no thread');
        threadId = out.threadId;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          await sleep(5000);
          const { thread } = show(threadId, 2);
          const link = typeof thread.link === 'string' ? thread.link : '';
          const ranOn = typeof thread.providerInstanceId === 'string' ? `${thread.providerInstanceId} ${typeof thread.model === 'string' ? thread.model : ''}`.trim() : 'unknown';
          if (thread.status === 'failed') throw new Error(`T3 run failed (provider error): ${link}`);
          // A worker that stops to ask (a question or a permission) gets no answer from an eval: it counts as asking.
          if (typeof thread.pendingRequestCount === 'number' && thread.pendingRequestCount > 0) {
            return { threadId, runId: typeof thread.latestRunId === 'string' ? thread.latestRunId : '', answer: readAsk ? await readAsk(threadId).catch(() => '') : '', ranOn, link, asked: true };
          }
          if (thread.activeRunId === null && typeof thread.latestRunId === 'string') {
            let last = '';
            for (let tries = 0; tries < 6; tries += 1) {
              await sleep(2500);
              const text = show(threadId, 30).messages.findLast((message) => message.role === 'assistant' && message.runId === thread.latestRunId)?.text ?? '';
              if (text && text === last) break;
              last = text;
            }
            return { threadId, runId: thread.latestRunId, answer: last, ranOn, link, asked: false };
          }
          if (Date.now() > deadline) throw new Error(`T3 run timed out: ${link}`);
        }
      } finally {
        if (threadId) await settle(threadId);
        release();
      }
    },
    sweep: async () => {
      const left = list().filter((thread) => !thread.settled);
      for (const thread of left) await settle(thread.threadId);
      return { settled: left.length, left: list().filter((thread) => !thread.settled).length };
    },
    close: () => { void session?.then((s) => s.close(), () => undefined); },
  };
};
