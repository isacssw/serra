// Serra's T3 layer, for what the `t3` CLI doesn't do (SERRA-72): reading a run's tool results and stopping a run.
// T3 serves the same tools its CLI uses (`t3_thread_read`, `t3_thread_interrupt`, …) on its own MCP endpoint. Serra
// asks the `t3` CLI for a short-lived MCP session (`t3 auth session issue --subject mcp-client`), calls the tools it
// needs over HTTP on this Mac, and revokes the session when it's done. Nothing here talks to a provider: T3 does.
//
// A session the CLI issues is capped at T3's `approval-required` mode: it can read any thread and start or stop
// threads in that mode, but T3 refuses to let it stop a full-access thread.
//
// The session's token stays in memory, is sent only to T3's own server on this Mac, and never goes in an error or a log.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord, parseJson } from './json-guards.ts';
import { run } from './t3.ts';

/** How long a session lasts. A meeting run is given up on after 10 minutes, so this outlives every run. */
const SESSION_TTL = '30m';
const PROTOCOL = '2025-06-18';
const REQUEST_TIMEOUT_MS = 30_000;

export interface T3Session {
  /** Calls one of T3's tools and returns its result. Throws with T3's own message when the tool fails. */
  call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Revokes the session. Never throws. */
  close: () => Promise<void>;
}

export interface T3SessionOptions {
  bin: string;
  /** T3's data folder: `T3CODE_HOME`, else `~/.t3`. Its `userdata/server-runtime.json` says where T3 is listening. */
  home?: string;
  fetch?: typeof fetch;
}

/** The running T3 server's address, from the file T3 writes while it runs. */
const serverOrigin = (home: string): string => {
  let state: unknown;
  try { state = parseJson(readFileSync(join(home, 'userdata', 'server-runtime.json'), 'utf8')); } catch { state = undefined; }
  const origin = isRecord(state) && typeof state.origin === 'string' ? state.origin : null;
  if (!origin || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)) throw new Error('T3 Code isn’t running. Open it, then try again.');
  return origin;
};

/** The JSON-RPC answer in a response: plain JSON, or the last `data:` event of a stream. */
const rpcAnswer = (body: string, type: string | null): unknown => {
  if (type?.includes('text/event-stream')) {
    const events = body.split('\n').filter((line) => line.startsWith('data:')).map((line) => parseJson(line.slice(5).trim()));
    return events.findLast((event) => isRecord(event) && ('result' in event || 'error' in event));
  }
  return parseJson(body);
};

/** Opens an MCP session on the running T3 server. Throws a plain sentence when T3 isn't running or refuses. */
export const openT3Session = async ({ bin, home = process.env.T3CODE_HOME ?? join(homedir(), '.t3'), fetch: send = fetch }: T3SessionOptions): Promise<T3Session> => {
  const origin = serverOrigin(home);
  const issued = parseJson((await run(bin, [
    'auth', 'session', 'issue', '--subject', 'mcp-client', '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
    '--ttl', SESSION_TTL, '--label', 'Serra meetings', '--json',
  ])).replace(/^[^{]*/, ''));
  if (!isRecord(issued) || typeof issued.token !== 'string' || typeof issued.sessionId !== 'string') throw new Error('T3 Code didn’t give Serra a session. Check that T3 Code is up to date.');
  const { token, sessionId } = issued;
  let mcpSession: string | null = null;
  let id = 0;

  const post = async (method: string, params: Record<string, unknown>, notify = false): Promise<unknown> => {
    const response = await send(new URL('/mcp', origin), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL, ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++id }) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    mcpSession = response.headers.get('mcp-session-id') ?? mcpSession;
    const body = await response.text();
    if (!response.ok) throw new Error(`T3 Code refused Serra’s request (${response.status}).`);
    if (notify) return null;
    const answer = rpcAnswer(body, response.headers.get('content-type'));
    if (!isRecord(answer)) throw new Error('T3 Code gave Serra an answer it couldn’t read.');
    if (isRecord(answer.error)) throw new Error(`T3 Code: ${typeof answer.error.message === 'string' ? answer.error.message.slice(0, 300) : 'error'}`);
    return answer.result;
  };

  const close = async (): Promise<void> => {
    await run(bin, ['auth', 'session', 'revoke', sessionId]).catch(() => {});
  };

  try {
    await post('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'serra', version: '1' } });
    await post('notifications/initialized', {}, true);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    call: async (tool, args) => {
      const result = await post('tools/call', { name: tool, arguments: args });
      if (!isRecord(result)) throw new Error(`T3 Code’s ${tool} gave no result.`);
      const text = Array.isArray(result.content) ? result.content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('') : '';
      const value = isRecord(result.structuredContent) ? result.structuredContent : parseJson(text);
      if (result.isError === true) {
        const message = isRecord(value) && typeof value.message === 'string' ? value.message : text;
        throw new Error(`T3 Code’s ${tool} failed: ${message.slice(0, 300)}`);
      }
      if (!isRecord(value)) throw new Error(`T3 Code’s ${tool} gave a result Serra couldn’t read.`);
      return value;
    },
    close,
  };
};
