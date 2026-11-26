// A fake Granola for evals/flows.live.test.ts: a minimal stdio MCP server with one read tool, get_meeting_transcript.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fakegranola', version: '1' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'get_meeting_transcript', description: 'Returns a meeting transcript by id', inputSchema: { type: 'object', properties: { meeting_id: { type: 'string' } }, required: ['meeting_id'] }, annotations: { readOnlyHint: true } }] } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Ana: We ship Thursday.\nBo: Agreed.' }] } });
  else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
