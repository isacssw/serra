import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJson } from './lib/guards.ts';
import { run } from './t3.ts';

export interface T3Question {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value?: string; preview?: string }[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  initialAnswer?: string;
  required?: boolean;
}

export interface T3QuestionRequest { requestId: string; questions: T3Question[] }
export type T3Answers = Record<string, unknown>;

const T3_BIN = process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3');
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
class QuestionBridgeError extends Error {}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** The CLI and MCP endpoint use the same local T3 installation and credential store. */
const localOrigin = async (): Promise<string> => {
  const home = process.env.T3CODE_HOME ?? join(homedir(), '.t3');
  const state = parseJson(await readFile(join(home, 'userdata/server-runtime.json'), 'utf8'));
  if (!record(state) || typeof state.origin !== 'string') throw new QuestionBridgeError('T3 server address is unavailable');
  return state.origin;
};

const endpointFor = (origin: string): string => {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new QuestionBridgeError('T3 questions require a local loopback server');
  }
  return new URL('/mcp', url).href;
};

const question = (value: unknown): value is T3Question => {
  if (!record(value) || !nonempty(value.id) || typeof value.header !== 'string' || !nonempty(value.question)
    || !Array.isArray(value.options) || value.isSecret === true || value.is_secret === true) return false;
  if (!value.options.every((option) => record(option) && nonempty(option.label) && typeof option.description === 'string'
    && (option.value === undefined || typeof option.value === 'string') && (option.preview === undefined || typeof option.preview === 'string'))) return false;
  return ['multiSelect', 'allowCustomAnswer', 'required'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
    && (value.initialAnswer === undefined || typeof value.initialAnswer === 'string');
};

const parse = (text: string): unknown => {
  try { return JSON.parse(text); }
  catch { throw new QuestionBridgeError('T3 returned an invalid question response'); }
};

/** Read a bounded JSON response or stop the SSE stream as soon as this call's result arrives. */
const rpcResult = async (response: Response, id: number): Promise<unknown> => {
  if (!response.ok) {
    await response.body?.cancel();
    throw new QuestionBridgeError(`T3 question request returned HTTP ${response.status}`);
  }
  if (!response.body) throw new QuestionBridgeError('T3 returned an empty question response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = response.headers.get('content-type')?.includes('text/event-stream') === true;
  let bytes = 0;
  let buffer = '';
  const unwrap = (value: unknown): unknown => {
    if (!record(value) || value.jsonrpc !== '2.0' || value.id !== id) throw new QuestionBridgeError('T3 returned an unexpected question response');
    if ('error' in value) throw new QuestionBridgeError('T3 rejected the question request');
    if (!('result' in value)) throw new QuestionBridgeError('T3 returned no question result');
    return value.result;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new QuestionBridgeError('T3 question response exceeds the size limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (!sse) continue;
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const value = parse(data);
        if (record(value) && value.id === id) return unwrap(value);
      }
    }
    if (sse) throw new QuestionBridgeError('T3 question stream ended without a result');
    buffer += decoder.decode();
    return unwrap(parse(buffer));
  } finally {
    await reader.cancel().catch(() => {});
  }
};

interface TransportDeps {
  execute?: typeof run;
  fetch?: typeof fetch;
  origin?: () => Promise<string>;
  connect?: (url: string) => WebSocket;
}

/** Ordinary questions are verified with the read-only native tool before any answer is dispatched. */
export const createQuestionTransport = ({ execute = run, fetch: fetchRequest = fetch, origin = localOrigin, connect = (url) => new WebSocket(url) }: TransportDeps = {}) => {
  const withSession = async <T>(bin: string, work: (call: (args: Record<string, unknown>) => Promise<unknown>, endpoint: string) => Promise<T>): Promise<T> => {
    let endpoint: string;
    try { endpoint = endpointFor(await origin()); }
    catch { throw new QuestionBridgeError('T3 questions require an available local loopback server'); }
    let issued: unknown;
    try {
      issued = parse(await execute(bin, ['auth', 'session', 'issue', '--subject', 'mcp-client', '--scope', 'orchestration:read',
        '--ttl', '1m', '--label', 'Slack question bridge', '--json'], { timeoutMs: REQUEST_TIMEOUT_MS }));
    } catch { throw new QuestionBridgeError('Could not authenticate the T3 question bridge'); }
    if (!record(issued) || !nonempty(issued.sessionId) || !nonempty(issued.token)) {
      if (record(issued) && nonempty(issued.sessionId)) await execute(bin, ['auth', 'session', 'revoke', issued.sessionId], { timeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {});
      throw new QuestionBridgeError('T3 returned invalid question credentials');
    }
    const session = { id: issued.sessionId, token: issued.token };
    let mcpSession: string | null = null;
    let protocol = '2025-06-18';
    let nextId = 0;
    const headers = (): Record<string, string> => ({
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocol,
      ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}),
    });
    const post = async (body: Record<string, unknown>): Promise<Response> => {
      try {
        return await fetchRequest(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch { throw new QuestionBridgeError('Could not reach the T3 question bridge'); }
    };
    const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = ++nextId;
      const response = await post({ jsonrpc: '2.0', id, method, params });
      if (method === 'initialize') mcpSession = response.headers.get('mcp-session-id');
      try { return await rpcResult(response, id); }
      catch (error) {
        // Transport/body errors can contain credentials or answer text; expose only our own fixed diagnostics.
        if (error instanceof QuestionBridgeError) throw error;
        throw new QuestionBridgeError('Could not read the T3 question response');
      }
    };
    try {
      const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'slack-question-bridge', version: '1' } });
      if (!record(initialized) || typeof initialized.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(initialized.protocolVersion)) throw new QuestionBridgeError('T3 returned an invalid question protocol');
      protocol = initialized.protocolVersion;
      const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await notification.body?.cancel();
      if (!notification.ok) throw new QuestionBridgeError(`T3 question initialization returned HTTP ${notification.status}`);
      return await work(async (args) => {
        const result = await rpc('tools/call', { name: 't3_pending_request', arguments: args });
        if (!record(result) || result.isError === true) throw new QuestionBridgeError('T3 could not complete the pending question request');
        if (!record(result.structuredContent)) throw new QuestionBridgeError('T3 returned an invalid pending question result');
        return result.structuredContent;
      }, endpoint);
    } finally {
      if (mcpSession) await fetchRequest(endpoint, { method: 'DELETE', headers: headers(), redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then((response) => response.body?.cancel(), () => {}).catch(() => {});
      // The short TTL also expires credentials if the CLI cannot revoke during shutdown.
      await execute(bin, ['auth', 'session', 'revoke', session.id], { timeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {});
    }
  };

  const readRequest = async (call: (args: Record<string, unknown>) => Promise<unknown>, threadId: string, requestId: string): Promise<T3QuestionRequest> => {
    const result = await call({ action: 'read', threadId, requestId });
    if (!record(result) || result.requestId !== requestId || !Array.isArray(result.questions) || !result.questions.length || !result.questions.every(question)
      || new Set(result.questions.map((item) => item.id)).size !== result.questions.length) throw new QuestionBridgeError('T3 returned invalid pending questions');
    return { requestId, questions: result.questions };
  };

  const pendingIds = async (call: (args: Record<string, unknown>) => Promise<unknown>, threadId: string): Promise<string[]> => {
    const listed = await call({ action: 'list', threadId });
    if (!record(listed) || !Array.isArray(listed.requestIds) || listed.requestIds.length > 100 || !listed.requestIds.every(nonempty)) throw new QuestionBridgeError('T3 returned invalid pending question identifiers');
    return [...new Set(listed.requestIds)];
  };

  /** The owner UI RPC can answer a question on a thread regardless of its worker runtime mode. */
  const respond = async (endpoint: string, bin: string, threadId: string, requestId: string, answers: T3Answers): Promise<void> => {
    let issued: unknown;
    try {
      issued = parse(await execute(bin, ['auth', 'session', 'issue', '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
        '--ttl', '1m', '--label', 'Slack question answer', '--json'], { timeoutMs: REQUEST_TIMEOUT_MS }));
    } catch { throw new QuestionBridgeError('Could not authenticate the T3 question answer'); }
    if (!record(issued) || !nonempty(issued.sessionId) || !nonempty(issued.token)) {
      if (record(issued) && nonempty(issued.sessionId)) await execute(bin, ['auth', 'session', 'revoke', issued.sessionId], { timeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {});
      throw new QuestionBridgeError('T3 returned invalid question credentials');
    }
    const session = { id: issued.sessionId, token: issued.token };
    try {
      let response: Response;
      try {
        response = await fetchRequest(new URL('/api/auth/websocket-ticket/rpc', endpoint), {
          method: 'POST', headers: { authorization: `Bearer ${session.token}` }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch { throw new QuestionBridgeError('Could not reach the T3 question answer service'); }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new QuestionBridgeError(`T3 question ticket returned HTTP ${response.status}`);
      }
      let ticket: unknown;
      const reader = response.body.getReader();
      try {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new QuestionBridgeError('T3 question ticket exceeds the size limit');
          chunks.push(chunk.value);
        }
        ticket = parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        if (error instanceof QuestionBridgeError) throw error;
        throw new QuestionBridgeError('Could not read the T3 question ticket');
      } finally { await reader.cancel().catch(() => {}); }
      if (!record(ticket) || !nonempty(ticket.ticket)) throw new QuestionBridgeError('T3 returned an invalid question ticket');
      const url = new URL('/ws', endpoint);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('orchestrationProtocol', '2');
      url.searchParams.set('wsTicket', ticket.ticket);
      const result = await new Promise<unknown>((resolve, reject) => {
        let socket: WebSocket;
        try { socket = connect(url.href); }
        catch { reject(new QuestionBridgeError('Could not connect the T3 question answer socket')); return; }
        let settled = false;
        const finish = (error?: Error, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('error', onError);
          socket.removeEventListener('close', onClose);
          try { socket.close(); } catch { /* Revoke the short-lived credential below even if closing fails. */ }
          if (error) reject(error); else resolve(value);
        };
        const onError = (): void => finish(new QuestionBridgeError('T3 question answer socket failed'));
        const onClose = (): void => finish(new QuestionBridgeError('T3 question answer socket closed before confirmation'));
        const onOpen = (): void => {
          try {
            socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'orchestration.dispatchCommand', headers: [], payload: {
              type: 'runtime-request.respond', commandId: `slack-question:${randomUUID()}`, threadId, requestId, answers,
            } }));
          } catch { onError(); }
        };
        const onMessage = (event: MessageEvent): void => {
          try {
            if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_RESPONSE_BYTES) throw new QuestionBridgeError('T3 returned an invalid question answer frame');
            const decoded = parse(event.data);
            for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
              if (!record(item)) throw new QuestionBridgeError('T3 returned an invalid question answer frame');
              if (item._tag === 'Defect') throw new QuestionBridgeError('T3 could not dispatch the question answer');
              if (item._tag !== 'Exit') continue;
              if (item.requestId !== '1' || !record(item.exit)) throw new QuestionBridgeError('T3 returned an unexpected question answer confirmation');
              if (item.exit._tag !== 'Success') throw new QuestionBridgeError('T3 could not dispatch the question answer');
              finish(undefined, item.exit.value);
              return;
            }
          } catch (error) { finish(error instanceof QuestionBridgeError ? error : new QuestionBridgeError('Could not read the T3 question answer confirmation')); }
        };
        const timer = setTimeout(() => finish(new QuestionBridgeError('T3 question answer timed out')), REQUEST_TIMEOUT_MS);
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      });
      if (!record(result) || typeof result.sequence !== 'number' || !Number.isSafeInteger(result.sequence) || result.sequence < 0) throw new QuestionBridgeError('T3 did not confirm the question answer');
    } finally {
      await execute(bin, ['auth', 'session', 'revoke', session.id], { timeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {});
    }
  };

  return {
    listQuestions: (threadId: string, bin = T3_BIN): Promise<T3QuestionRequest[]> => withSession(bin, async (call) => {
      const requests: T3QuestionRequest[] = [];
      for (const requestId of await pendingIds(call, threadId)) requests.push(await readRequest(call, threadId, requestId));
      return requests;
    }),
    answerQuestion: async (threadId: string, requestId: string, answers: T3Answers, bin = T3_BIN): Promise<void> => {
      if (!record(answers) || !Object.values(answers).every((answer) => typeof answer === 'string' || Array.isArray(answer) && answer.every((value) => typeof value === 'string')
        || record(answer) && Array.isArray(answer.answers) && answer.answers.every((value) => typeof value === 'string'))) throw new QuestionBridgeError('T3 question answers must be text or text selections');
      await withSession(bin, async (call, endpoint) => {
        if (!(await pendingIds(call, threadId)).includes(requestId)) throw new QuestionBridgeError('T3 question is no longer pending');
        const current = await readRequest(call, threadId, requestId);
        const ids = new Set(current.questions.map((item) => item.id));
        if (Object.keys(answers).some((id) => !ids.has(id))) throw new QuestionBridgeError('T3 question answers refer to an unknown question');
        if (current.questions.some((item) => item.required !== false && !Object.hasOwn(answers, item.id))) throw new QuestionBridgeError('Answer each T3 question before sending');
        for (const item of current.questions) {
          if (!Object.hasOwn(answers, item.id)) continue;
          const answer = answers[item.id];
          const values = typeof answer === 'string' ? [answer] : Array.isArray(answer) ? answer as string[] : (answer as { answers: string[] }).answers;
          const choices = new Set(item.options.map((option) => option.value ?? option.label));
          if (!values.length || values.some((value) => !value.trim()) || new Set(values).size !== values.length || !item.multiSelect && values.length !== 1
            || item.options.length > 0 && item.allowCustomAnswer === false && values.some((value) => !choices.has(value))) {
            throw new QuestionBridgeError('T3 question answer does not match the current choices');
          }
        }
        await respond(endpoint, bin, threadId, requestId, answers);
      });
    },
  };
};

const transport = createQuestionTransport();
export const listQuestions = transport.listQuestions;
export const answerQuestion = transport.answerQuestion;
