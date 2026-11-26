// The Codex ACP adapter Serra ships (@agentclientprotocol/codex-acp), against the owner's own `codex`: it starts
// through Serra's launcher, answers ACP `initialize` and `session/new`, and offers the modes Serra relies on. No prompt
// is sent, so no model is called and nothing is spent. Not part of `pnpm test`: it needs `codex` installed.
//
//   node --test evals/codex-acp.contract.test.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { KNOWN_ACP_AGENTS, launchFor } from '../src/agent/acp-agents.ts';
import { agentEnv } from '../src/agent/pool.ts';

test('Codex over ACP: the bundled adapter starts on the owner\'s codex and offers read-only and full-access modes', { timeout: 120_000 }, async (t) => {
  const env = await agentEnv();
  const launch = launchFor(KNOWN_ACP_AGENTS.find((agent) => agent.id === 'codex')!, env.PATH ?? '');
  if ('missing' in launch) { t.skip(launch.missing); return; }
  assert.equal(launch.command, process.execPath, 'run by Serra\'s own Node, not from PATH');
  assert.match(launch.args[0]!, /node_modules\/@agentclientprotocol\/codex-acp\/dist\/index\.js$/);
  const cwd = mkdtempSync(join(tmpdir(), 'serra-codex-contract-'));
  const child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, ...launch.env }, detached: true });
  t.after(() => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ } rmSync(cwd, { recursive: true, force: true }); });
  const connection = acp.client({ name: 'serra-contract' }).connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  const hello = await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } });
  assert.equal(hello.protocolVersion, acp.PROTOCOL_VERSION);
  assert.equal(hello.agentCapabilities?.loadSession, true, 'a run can be reopened after a restart');
  const session = await connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  const modes = session.modes?.availableModes.map((mode) => mode.id) ?? [];
  assert.ok(modes.includes('read-only'), `read-only mode: ${modes.join(', ')}`);
  assert.ok(modes.includes('agent-full-access'), `full-access mode: ${modes.join(', ')}`);
  assert.ok(session.configOptions?.some((option) => option.category === 'model' || option.id === 'model'), 'a model choice');
  connection.close();
});
