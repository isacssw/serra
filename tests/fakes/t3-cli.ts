/**
 * A fake T3 that behaves like the real one from outside: a `t3` script that prints its errors to stdout, and T3's
 * tool endpoint (`/mcp`) on 127.0.0.1, found through `userdata/server-runtime.json` in a T3 home folder.
 * - `project add` of a folder it already has exits 1 with ProjectAlreadyExistsError on stdout.
 * - `thread start` and `thread show` give one thread, `run-thread`, whose final answer is the `answer` file.
 * - `auth session issue` prints a session (after Electron's noise on stderr), or, when the `refuse` file exists, its
 *   text on stdout and exits 1. `auth session revoke` records the session ID.
 * - `/mcp` takes only that session's token. `t3_thread_interrupt` is refused like T3 refuses a full-access thread.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

const TOKEN = 'fixture-session-token';

export const fakeT3Cli = async (t: TestContext, answerText = '') => {
  const root = mkdtempSync(join(tmpdir(), 'serra-meeting-t3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(join(home, 'userdata'), { recursive: true });
  const workspace = join(root, 'runs');
  mkdirSync(workspace);
  const bin = join(root, 't3');
  const projects = join(root, 'projects.txt');
  const answer = join(root, 'answer.txt');
  const revoked = join(root, 'revoked.txt');
  const refuse = join(root, 'refuse.txt');
  writeFileSync(answer, answerText);
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const args = process.argv.slice(2); let input = '';
process.stdin.on('data', (x) => { input += x; });
process.stdin.on('end', () => {
  const is = (...words) => words.every((word, n) => args[n] === word);
  if (is('project', 'add')) {
    const known = fs.existsSync(${JSON.stringify(projects)}) ? fs.readFileSync(${JSON.stringify(projects)}, 'utf8').split('\\n') : [];
    if (known.includes(args.at(-1))) { console.log('ProjectAlreadyExistsError: An active project already exists for ' + args.at(-1)); process.exit(1); }
    fs.appendFileSync(${JSON.stringify(projects)}, args.at(-1) + '\\n'); console.log('Added project'); return;
  }
  if (is('thread', 'start')) { console.log(JSON.stringify({ threadId: 'run-thread' })); return; }
  if (is('thread', 'show')) {
    console.log(JSON.stringify({ thread: { threadId: 'run-thread', link: 'https://app.t3.codes/threads/run-thread', status: 'idle', latestRunId: 'run-1', activeRunId: null, pendingRequestCount: 0 },
      messages: [{ role: 'assistant', runId: 'run-1', text: fs.readFileSync(${JSON.stringify(answer)}, 'utf8') }] }));
    return;
  }
  if (is('auth', 'session', 'issue')) {
    if (fs.existsSync(${JSON.stringify(refuse)})) { console.log(fs.readFileSync(${JSON.stringify(refuse)}, 'utf8')); process.exit(1); }
    if (!args.includes('--subject') || args[args.indexOf('--subject') + 1] !== 'mcp-client') { console.log('Unrecognized session'); process.exit(1); }
    console.error('[1122/144251.491731:ERROR:electron/shell/common/node_util.cc:78] CompileAndCall failed');
    console.log(JSON.stringify({ sessionId: 'session-1', token: ${JSON.stringify(TOKEN)}, method: 'bearer-access-token', scopes: ['orchestration:read', 'orchestration:operate'] }, null, 2));
    return;
  }
  if (is('auth', 'session', 'revoke')) { fs.appendFileSync(${JSON.stringify(revoked)}, args[3] + '\\n'); console.log('Revoked'); return; }
  console.log('Unknown command'); process.exit(2);
});`, { mode: 0o700 });

  const requests: { authorization: string | undefined }[] = [];
  const launched: Record<string, unknown>[] = [];
  const result = (value: Record<string, unknown>, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? {} : { structuredContent: value }), isError });
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization });
      if (request.url !== '/mcp' || request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_mcp_credential' }));
        return;
      }
      const rpc = JSON.parse(body) as { id?: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } };
      if (rpc.id === undefined) { response.writeHead(202).end(); return; }
      const reply = (value: unknown, stream = false) => {
        const json = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: value });
        // T3 may answer as an event stream; Serra reads both.
        if (stream) response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'mcp-1' }).end(`event: message\ndata: ${json}\n\n`);
        else response.writeHead(200, { 'content-type': 'application/json' }).end(json);
      };
      if (rpc.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'T3 Code' } }, true);
      const { name, arguments: args = {} } = rpc.params;
      if (name === 't3_project_list') return reply(result({ projects: [{ id: 'project-1', workspaceRoot: realpathSync(workspace), deletedAt: null }], nextCursor: null }));
      if (name === 't3_thread_launch') { launched.push(args); return reply(result({ threadId: 'run-thread', link: 'https://app.t3.codes/threads/run-thread' })); }
      if (name === 't3_thread_interrupt') {
        return reply(result({ _tag: 'OrchestratorMcpFailure', code: 'runtime_mode_escalation_denied', message: `Thread "${String(args.threadId)}" runs in full-access/default, above this caller's approval-required/default limit.` }, true));
      }
      return reply(result({ _tag: 'OrchestratorMcpFailure', message: `Unknown tool ${String(name)}` }, true));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.close(); });
  const { port } = server.address() as AddressInfo;
  writeFileSync(join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, port, origin: `http://127.0.0.1:${port}` }));
  return { bin, home, workspace, projects, answer, revoked, refuse, requests, launched };
};
