// Meeting capture routing, the extractor launch and the provider sources (SERRA-62), with fakes for Slack, Claude
// Code and the providers. Nothing here runs a model.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { codeRoot } from '../src/config.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { COPY, createMeetingCapture, meetingsFirst, type MeetingChat } from '../src/meeting-capture.ts';
import { createExtractor, EXTRACTOR_FLAGS, type SpawnClaude } from '../src/meeting-extractor.ts';
import { writeMeetingSettings } from '../src/meeting-settings.ts';
import { createSourceReader, meetingRequest, transcriptFromResult } from '../src/meeting-sources.ts';
import type { IncomingMessage } from '../src/types.ts';

const OWNER = 'UROBIN0001';
const DM = 'D0OWNER01';

const TRANSCRIPT = [
  'Ana: For webhook retries, three attempts and then dead-letter it.',
  "Robin: Yes, let's do that. The staging key is sk-live-abcdefghijklmnopqrstuvwx by the way.",
  'Bo: payments-api never calls the ledger directly. UNIQUE-TRANSCRIPT-PHRASE-42',
  'Ana: Bo, can you update the retry config by Friday?',
].join('\n');

const DIGEST = `<meeting-digest>${JSON.stringify({
  meeting: { title: 'Payments sync', date: '2026-11-20' },
  items: [
    { kind: 'decision', text: 'Webhook retries: 3 attempts, then dead-letter.', quote: 'three attempts and then dead-letter it', turns: [1], assent_turn: 2, who: ['Ana', 'Robin'], links: [], target: 'product/webhooks.md', op: 'add' },
    { kind: 'decision', text: 'Use the staging key.', quote: 'The staging key is [redacted]', turns: [2], target: 'product/webhooks.md', op: 'add' },
  ],
  reply: [{ kind: 'action', text: 'Update the retry config', owner: 'Bo', due: '2026-11-27' }],
  dropped: { 'chit-chat': 1 },
})}</meeting-digest>`;

interface Harness {
  profileDir: string;
  posts: { channel: string; text: string; thread?: string }[];
  prompts: string[];
  fetched: string[];
  capture: ReturnType<typeof createMeetingCapture>;
  state: { paused: boolean; busy: boolean; earlier: number; extract: () => Promise<string> };
}

const harness = (t: TestContext, { enabled = true }: { enabled?: boolean } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profileDir = join(dir, 'profile');
  const knowledgeDir = join(profileDir, 'knowledge');
  cpSync(join(codeRoot, 'evals/fixture/knowledge'), knowledgeDir, { recursive: true });
  createKnowledge(knowledgeDir).seedApproved();
  if (enabled) writeMeetingSettings(profileDir, true);
  const posts: Harness['posts'] = [];
  const prompts: string[] = [];
  const fetched: string[] = [];
  const state: Harness['state'] = { paused: false, busy: false, earlier: 0, extract: async () => DIGEST };
  let ts = 100;
  const chat: MeetingChat = {
    post: async (channel, text, thread) => { posts.push({ channel, text, ...(thread ? { thread } : {}) }); ts += 1; return `${ts}.0`; },
    remove: async () => {},
    earlierInThread: async () => state.earlier,
  };
  const capture = createMeetingCapture({
    profileDir, knowledgeDir, owner: OWNER, chat,
    readFile: async (file) => ({ name: file.name ?? 'x.txt', text: TRANSCRIPT }),
    sources: { fetchTranscript: async (link) => { fetched.push(`${link.provider}:${link.id}`); return { text: TRANSCRIPT, title: 'Payments sync' }; } },
    extractor: { extract: async (prompt) => { prompts.push(prompt); return state.extract(); } },
    paused: () => state.paused, busy: () => state.busy,
    now: () => new Date('2026-11-22T10:00:00Z'),
  });
  return { profileDir, posts, prompts, fetched, capture, state };
};

const message = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channel: DM, threadTs: '1.0', messageTs: '1.0', user: OWNER, text: 'remember this meeting', direct: true, im: true,
  files: [{ id: 'F1', name: 'payments-sync.txt', size: 400 }], ...over,
});

const run = async (h: Harness, msg: IncomingMessage): Promise<boolean> => {
  const result = h.capture.intercept(msg);
  if (result) await result.work;
  return result !== null;
};

test('the owner\'s upload in a DM becomes a digest and review items; the transcript is never stored', async (t) => {
  const h = harness(t);
  assert.equal(await run(h, message()), true);
  assert.equal(h.prompts.length, 1);
  assert.doesNotMatch(h.prompts[0]!, /sk-live/, 'the secret is redacted before the model sees it');
  assert.match(h.prompts[0]!, /UNIQUE-TRANSCRIPT-PHRASE-42/);
  const digest = h.posts.at(-1)!;
  assert.equal(digest.thread, undefined, 'the digest is a new top-level DM message');
  assert.match(digest.text, /1 decision to review/);
  assert.match(digest.text, /Update the retry config \(Bo, by 2026-11-27\)/);
  assert.match(digest.text, /secret redacted/);
  const [meeting] = h.capture.store.listMeetings();
  assert.equal(meeting!.items.length, 1, 'the item quoting the redacted key fails the quote check');
  // Nothing in the profile holds the transcript's other text.
  const files = readdirSync(h.profileDir, { recursive: true }).map(String).filter((path) => statSync(join(h.profileDir, path)).isFile());
  for (const path of files) assert.doesNotMatch(readFileSync(join(h.profileDir, path), 'utf8'), /UNIQUE-TRANSCRIPT-PHRASE-42|sk-live/, path);
});

test('none of these reach the extractor: a teammate, a channel, a mention, an alert trigger, capture off, a pause', async (t) => {
  const cases: [string, Partial<IncomingMessage>, (h: Harness) => void, RegExp][] = [
    ['teammate', { user: 'UPRIYA0001' }, () => {}, /Only <@UROBIN0001> can add meetings/],
    ['channel', { channel: 'C0TEAM001', im: false }, () => {}, /as a new message in our DM, not here/],
    ['mention', { im: false }, () => {}, /as a new message in our DM, not here/],
    ['trigger', { automaticTrigger: true }, () => {}, /Only <@UROBIN0001>/],
    ['pause', {}, (h) => { h.state.paused = true; }, /updating/],
  ];
  for (const [name, over, setup, reply] of cases) {
    const h = harness(t);
    setup(h);
    assert.equal(await run(h, message(over)), true, name);
    assert.equal(h.prompts.length, 0, name);
    assert.match(h.posts.at(-1)!.text, reply, name);
    assert.equal(h.capture.closed(over.channel ?? DM, '1.0'), true, `${name}: the thread is closed anyway`);
  }
  const off = harness(t, { enabled: false });
  await run(off, message());
  assert.equal(off.prompts.length, 0);
  assert.equal(off.posts.at(-1)!.text, COPY.off);
});

test('a trigger inside a running job\'s thread is not closed, not passed on, and not read', async (t) => {
  const h = harness(t);
  h.state.busy = true;
  assert.equal(await run(h, message({ threadTs: '0.5', messageTs: '1.0' })), true);
  assert.equal(h.capture.closed(DM, '0.5'), false);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.posts.at(-1)!.text, COPY.inThread);
});

test('agent view: a DM thread with earlier messages is closed and refused; an empty one captures', async (t) => {
  const h = harness(t);
  h.state.earlier = 2;
  await run(h, message({ threadTs: '0.5', messageTs: '1.0' }));
  assert.equal(h.prompts.length, 0);
  assert.equal(h.posts.at(-1)!.text, COPY.earlier);
  assert.equal(h.capture.closed(DM, '0.5'), true);
  const fresh = harness(t);
  await run(fresh, message({ threadTs: '0.7', messageTs: '1.0' }));
  assert.equal(fresh.prompts.length, 1);
});

test('a closed thread stays closed: replies after a capture, a refusal or a failure never start a job', async (t) => {
  const h = harness(t);
  h.state.extract = async () => { throw new Error('The extractor took too long.'); };
  await run(h, message());
  assert.match(h.posts.at(-1)!.text, /Couldn’t read that meeting: The extractor took too long/);
  assert.equal(h.capture.store.listMeetings().length, 0);
  for (const text of ['actually also note this', 'remember this meeting']) {
    assert.equal(await run(h, message({ threadTs: '1.0', messageTs: '2.0', text, files: [] })), true, 'intercepted, never a job');
    assert.equal(h.posts.at(-1)!.text, COPY.closed);
  }
  // Closed survives a restart: a new capture instance reads it from disk.
  const again = createMeetingCapture({ ...h, knowledgeDir: join(h.profileDir, 'knowledge'), owner: OWNER, chat: { post: async () => undefined, remove: async () => {}, earlierInThread: async () => 0 }, readFile: async () => ({ name: '', text: '' }), sources: { fetchTranscript: async () => ({ text: '', title: null }) }, extractor: { extract: async () => '' }, paused: () => false, busy: () => false });
  assert.equal(again.closed(DM, '1.0'), true);
  assert.equal(again.intercept(message({ text: 'hello', messageTs: '3.0', files: [] })) !== null, true);
});

test('a meeting request held by an older Serra during an update is closed and dropped at start', (t) => {
  const h = harness(t);
  const held = [message({ threadTs: '5.0', messageTs: '5.0' }), message({ threadTs: '6.0', messageTs: '6.0', text: 'fix the build' })];
  const { drop } = h.capture.closeHeld(held);
  assert.deepEqual(drop.map((msg) => msg.threadTs), ['5.0']);
  assert.equal(h.capture.closed(DM, '5.0'), true);
  assert.equal(h.capture.closed(DM, '6.0'), false);
});

test('ordinary messages pass through untouched; only a message that starts with the phrase is a meeting', async (t) => {
  const h = harness(t);
  assert.equal(h.capture.intercept(message({ text: 'fix the flaky test', files: [] })), null);
  assert.equal(h.capture.intercept(message({ text: 'can you remember this meeting later?', files: [] })), null);
  for (const text of ['remember our meeting at 3', 'Remember the meeting with Dana tomorrow', 'remember my meeting notes']) {
    assert.equal(h.capture.intercept(message({ text, files: [] })), null, text);
  }
  assert.equal(h.capture.closed(DM, '1.0'), false, 'nothing above closed the thread');
  assert.equal(meetingRequest('<@U123> Remember this meeting: https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c').link?.provider, 'granola');
  const doc = meetingRequest('remember this meeting <https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit|Payments sync - Transcript>');
  assert.deepEqual([doc.link?.provider, doc.link?.id, doc.pasted], ['google-meet', '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '']);
});

test('a Granola or Meet link is read through the provider, then checked like an upload', async (t) => {
  const h = harness(t);
  await run(h, message({ text: 'remember this meeting https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c', files: [] }));
  assert.deepEqual(h.fetched, ['granola:f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c']);
  assert.match(h.posts.at(-1)!.text, /from Granola/);
});

test('nothing to read, or two files, gets a plain instruction', async (t) => {
  const h = harness(t);
  await run(h, message({ files: [] }));
  assert.equal(h.posts.at(-1)!.text, COPY.nothing);
  const two = harness(t);
  await run(two, message({ files: [{ id: 'A', name: 'a.txt' }, { id: 'B', name: 'b.vtt' }] }));
  assert.equal(two.posts.at(-1)!.text, COPY.oneFile);
  assert.equal(two.prompts.length, 0);
});

test('Forget deletes the digest message through the daemon, and a deleted one counts as gone', async (t) => {
  const h = harness(t);
  await run(h, message());
  const [meeting] = h.capture.store.listMeetings();
  h.capture.store.forget(meeting!.id);
  assert.equal(h.capture.store.digestsToDelete().length, 1);
  await h.capture.upkeep();
  assert.equal(h.capture.store.digestsToDelete().length, 0);
  assert.equal(h.capture.store.readRegistry().meetings[meeting!.id]!.state, 'forgotten');
});

// --- The extractor launch -------------------------------------------------------------------------------------------

/** A fake `claude`: records argv and stdin, answers with `lines` on stdout. */
const fakeClaude = (answer: (args: readonly string[], stdin: string) => string[]) => {
  const calls: { args: readonly string[]; stdin: string; cwd: string }[] = [];
  const spawn: SpawnClaude = (_command, args, { cwd }) => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: () => { stdout.end(); return true; } });
    let input = '';
    stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
    stdin.on('finish', () => {
      calls.push({ args, stdin: input, cwd });
      for (const line of answer(args, input)) if (!stdout.writableEnded) stdout.write(`${line}\n`);
      if (!stdout.writableEnded) stdout.end();
    });
    stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
    return child;
  };
  return { spawn, calls };
};

const binDir = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-bin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\n');
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
};

const init = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], plugins: [{ path: 'builtin' }], claude_code_version: '2.1.330', ...over });
const result = (text: string, turns = 1) => JSON.stringify({ type: 'result', result: text, is_error: false, num_turns: turns });

test('the extractor refuses before any transcript byte when the probe shows tools, MCP servers, plugins or an untested build', async (t) => {
  const path = binDir(t);
  for (const [over, reason] of [
    [{ tools: ['Read'] }, /offered the extractor tools/],
    [{ mcp_servers: [{ name: 'x' }] }, /loaded MCP servers/],
    [{ plugins: [{ path: '/tmp/evil' }] }, /loaded plugins/],
    [{ claude_code_version: '9.9.9' }, /tested with Claude Code 2\.1\.330/],
  ] as const) {
    const fake = fakeClaude((args) => (args.includes('stream-json') ? [init(over)] : [result(DIGEST)]));
    const extractor = createExtractor({ path, spawn: fake.spawn, managedSettingsDir: join(path, 'none') });
    await assert.rejects(extractor.extract('TRANSCRIPT-BYTES'), reason);
    assert.ok(fake.calls.every((call) => !call.stdin.includes('TRANSCRIPT-BYTES')), 'the transcript was never sent');
  }
});

test('managed hooks refuse capture; the prompt goes on stdin from an empty folder with the fixed flags', async (t) => {
  const path = binDir(t);
  const managed = join(path, 'managed');
  mkdirSync(managed);
  writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'tee' }] }] } }));
  const fake = fakeClaude((args) => (args.includes('stream-json') ? [init()] : [result(DIGEST)]));
  await assert.rejects(createExtractor({ path, spawn: fake.spawn, managedSettingsDir: managed }).extract('x'), /managed hooks/);
  assert.equal(fake.calls.length, 0);

  const clean = fakeClaude((args) => (args.includes('stream-json') ? [init()] : [result(DIGEST)]));
  const text = await createExtractor({ path, spawn: clean.spawn, managedSettingsDir: join(path, 'none') }).extract('TRANSCRIPT-BYTES');
  assert.equal(text, DIGEST);
  const launch = clean.calls.at(-1)!;
  assert.equal(launch.stdin, 'TRANSCRIPT-BYTES');
  assert.ok(!launch.args.some((arg) => arg.includes('TRANSCRIPT-BYTES')), 'never in argv');
  for (const flag of EXTRACTOR_FLAGS) assert.ok(launch.args.includes(flag), flag);
  assert.equal(readdirSync(tmpdir()).includes(launch.cwd.split('/').pop()!), false, 'the run folder is removed');
});

test('a self-test that leaks the canary or uses a tool refuses capture', async (t) => {
  const path = binDir(t);
  const leaky = fakeClaude((args, stdin) => {
    if (args.includes('stream-json')) return [init()];
    // The fake can't read the file: model a leak by answering with the canary the self-test planted in the folder.
    const folder = leakyFolder.value;
    return stdin.includes('canary.txt') && folder ? [result(readFileSync(join(folder, 'canary.txt'), 'utf8'))] : [result(DIGEST)];
  });
  const leakyFolder: { value: string | null } = { value: null };
  const wrapped: SpawnClaude = (command, args, options) => { leakyFolder.value = options.cwd; return leaky.spawn(command, args, options); };
  const extractor = createExtractor({ path, spawn: wrapped, managedSettingsDir: join(path, 'none') });
  const checked = await extractor.preflight();
  assert.equal((await extractor.selfTest(checked)).reason, 'The extractor read a file it must not be able to read.');
  await assert.rejects(extractor.extract('x'), /read a file/);
  const planted = fakeClaude((args, stdin) => {
    if (args.includes('stream-json')) return [init()];
    if (!stdin.includes('canary.txt')) return [result(DIGEST)];
    return [result('<meeting-digest>{"items":[]}</meeting-digest>', 3)];
  });
  assert.equal((await createExtractor({ path, spawn: planted.spawn, managedSettingsDir: join(path, 'none') }).selfTest(checked)).reason, 'The extractor used a tool.');
});

// --- Provider sources -----------------------------------------------------------------------------------------------

test('a provider fetch allows one tool, stops at its result, and refuses any other tool', async (t) => {
  const path = binDir(t);
  const server = { name: 'claude.ai Granola', status: 'connected' };
  const tool = 'mcp__claude_ai_Granola__get_meeting_transcript';
  const fake = fakeClaude((args) => {
    if (!args.includes('--allowedTools')) return [init({ mcp_servers: [server], tools: [tool] })];
    return [
      init({ mcp_servers: [server], tools: [tool] }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: { meeting_id: 'abc' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Ana: three attempts.\nBo: ok.' }] }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SHOULD NOT BE READ' }] } }),
    ];
  });
  const reader = createSourceReader({ path, spawn: fake.spawn });
  const fetched = await reader.fetchTranscript({ provider: 'granola', id: 'abc', url: 'x' });
  assert.equal(fetched.text, 'Ana: three attempts.\nBo: ok.');
  const launch = fake.calls.at(-1)!;
  assert.deepEqual(launch.args.slice(launch.args.indexOf('--allowedTools'), launch.args.indexOf('--allowedTools') + 2), ['--allowedTools', tool]);
  assert.ok(launch.args.includes('--restricted') && launch.args.includes('dontAsk'));
  assert.deepEqual(launch.args.slice(launch.args.indexOf('--max-turns'), launch.args.indexOf('--max-turns') + 2), ['--max-turns', '1'], 'one turn: no model sees the result');
  assert.doesNotMatch(launch.stdin, /three attempts/);

  const rogue = fakeClaude((args) => (!args.includes('--allowedTools') ? [init({ mcp_servers: [server], tools: [tool] })] : [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'mcp__claude_ai_Gmail__send', input: {} }] } }),
  ]));
  await assert.rejects(createSourceReader({ path, spawn: rogue.spawn }).fetchTranscript({ provider: 'granola', id: 'abc', url: 'x' }), /one call Serra asked for/);
});

test('provider status says what the owner must do: connect, sign in again, or nothing', async (t) => {
  const path = binDir(t);
  const fake = fakeClaude(() => [init({ mcp_servers: [{ name: 'claude.ai Google Drive', status: 'needs-auth' }], tools: [] })]);
  const status = await createSourceReader({ path, spawn: fake.spawn }).status();
  assert.equal(status.find((entry) => entry.provider === 'granola')!.state, 'missing');
  assert.match(status.find((entry) => entry.provider === 'granola')!.detail, /claude mcp add granola/);
  assert.equal(status.find((entry) => entry.provider === 'google-meet')!.state, 'needs-sign-in');
});

test('JSON transcripts from a provider are unwrapped into speaker lines', () => {
  assert.equal(transcriptFromResult(JSON.stringify({ title: 'Sync', transcript: [{ speaker: { name: 'Ana' }, text: 'Hi' }, { speaker: 'Bo', text: 'Yo' }] })).text, 'Ana: Hi\nBo: Yo');
  assert.equal(transcriptFromResult('Ana: plain').text, 'Ana: plain');
});

test('a provider fetch refuses other arguments, an untested build, and managed hooks; errors never quote the result', async (t) => {
  const path = binDir(t);
  const server = { name: 'claude.ai Granola', status: 'connected' };
  const tool = 'mcp__claude_ai_Granola__get_meeting_transcript';
  const answer = (input: Record<string, unknown>, over: Record<string, unknown> = {}, result: Record<string, unknown> = {}) => fakeClaude((args) => (!args.includes('--allowedTools')
    ? [init({ mcp_servers: [server], tools: [tool], ...over })]
    : [
      init({ mcp_servers: [server], tools: [tool], ...over }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: tool, input }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Ana: permission denied is what the customer saw. SECRET-TRANSCRIPT', ...result }] } }),
    ]));
  const link = { provider: 'granola' as const, id: 'abc', url: 'x' };
  await assert.rejects(createSourceReader({ path, spawn: answer({ meeting_id: 'other' }).spawn, managedSettingsDir: join(path, 'none') }).fetchTranscript(link), /one call Serra asked for/);
  await assert.rejects(createSourceReader({ path, spawn: answer({ meeting_id: 'abc' }, { claude_code_version: '9.9.9' }).spawn, managedSettingsDir: join(path, 'none') }).fetchTranscript(link), /tested with Claude Code/);
  const managed = join(path, 'managed');
  mkdirSync(managed);
  writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ hooks: { PostToolUse: [{}] } }));
  await assert.rejects(createSourceReader({ path, spawn: answer({ meeting_id: 'abc' }).spawn, managedSettingsDir: managed }).fetchTranscript(link), /managed hooks/);
  // A transcript that happens to start like an error is read as a transcript, not echoed as one.
  const ok = await createSourceReader({ path, spawn: answer({ meeting_id: 'abc' }).spawn, managedSettingsDir: join(path, 'none') }).fetchTranscript(link);
  assert.match(ok.text, /SECRET-TRANSCRIPT/);
  const failed = createSourceReader({ path, spawn: answer({ meeting_id: 'abc' }, {}, { is_error: true }).spawn, managedSettingsDir: join(path, 'none') }).fetchTranscript(link);
  await assert.rejects(failed, (error: Error) => !error.message.includes('SECRET-TRANSCRIPT') && /couldn.t give Serra that meeting/.test(error.message));
});

test('meetings come first: a meeting message never reaches the hold or a job; anything else does, unchanged', async () => {
  const seen: string[] = [];
  const route = meetingsFirst(
    (msg) => (msg.text.startsWith('remember this meeting') ? { work: Promise.resolve().then(() => { seen.push(`meeting:${msg.text}`); }) } : null),
    async (work) => { seen.push('tracked'); await work; },
    async (msg) => { seen.push(`next:${msg.text}`); },
  );
  await route(message({ text: 'remember this meeting', files: [] }));
  await route(message({ text: 'fix the build', files: [] }));
  assert.deepEqual(seen, ['tracked', 'meeting:remember this meeting', 'next:fix the build']);
});

test('the digest escapes Slack markup from model text, so an injected line is never a link or a mention', async (t) => {
  const h = harness(t);
  h.state.extract = async () => `<meeting-digest>${JSON.stringify({ items: [], reply: [{ kind: 'action', text: 'Click <https://evil.example|the doc> and ping <!channel>', owner: 'Bo' }] })}</meeting-digest>`;
  await run(h, message());
  const digest = h.posts.at(-1)!.text;
  assert.doesNotMatch(digest, /<https|<!channel>/);
  assert.match(digest, /&lt;`https:\/\/evil\.example\|the` doc&gt;/, 'escaped, and the URL in code so it never links');
});

test('bare domains in digest lines become code, and ordinary dotted words stay whole', async (t) => {
  const h = harness(t);
  h.state.extract = async () => `<meeting-digest>${JSON.stringify({ items: [], reply: [{ kind: 'action', text: 'Check evil.ru/login and bit.ly/x, then set config.common and app.config' }] })}</meeting-digest>`;
  await run(h, message());
  const digest = h.posts.at(-1)!.text;
  assert.match(digest, /`evil\.ru\/login`/);
  assert.match(digest, /`bit\.ly\/x`/);
  assert.match(digest, /`config\.common`/);
  assert.doesNotMatch(digest, /`config\.com`mon|`app\.co`nfig/);
});

test('a meeting that kept nothing can still be forgotten: its digest is deleted and its record keeps no names', async (t) => {
  const h = harness(t);
  h.state.extract = async () => `<meeting-digest>${JSON.stringify({ items: [], reply: [{ kind: 'action', text: 'Ana sends the notes' }] })}</meeting-digest>`;
  await run(h, message());
  const [listed] = h.capture.store.history();
  assert.ok(listed, 'listed for Forget because its digest is in the DM');
  h.capture.store.forget(listed.id);
  await h.capture.upkeep();
  const record = h.capture.store.readRegistry().meetings[listed.id]!;
  assert.equal(record.state, 'forgotten');
  assert.deepEqual([record.title, record.speakers, record.dropped], ['Forgotten meeting', [], {}]);
});

test('with capture off, a teammate or a channel message that starts with the phrase is an ordinary request', (t) => {
  const h = harness(t, { enabled: false });
  assert.equal(h.capture.intercept(message({ user: 'UPRIYA0001' })), null);
  assert.equal(h.capture.intercept(message({ user: 'UPRIYA0001', channel: 'C0TEAM001', im: false, text: '<@UBOT> remember this meeting is at 3, fix the build' })), null);
  assert.equal(h.capture.closed('C0TEAM001', '1.0'), false);
});

test('a damaged meeting registry never stops a brief', (t) => {
  const h = harness(t);
  writeFileSync(join(h.profileDir, 'meeting-registry.json'), '{ not json');
  const knowledge = createKnowledge(join(h.profileDir, 'knowledge'));
  assert.ok(knowledge.briefKnowledge('team').index.length > 0);
});

test('a link inside a pasted transcript is part of the meeting, not its source; "this meeting\'s notes" is no trigger', () => {
  const pasted = meetingRequest('remember this meeting\nAna: the spec is at https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit\nBo: agreed');
  assert.equal(pasted.link, null);
  assert.match(pasted.pasted, /docs\.google\.com/);
  assert.equal(meetingRequest("remember this meeting's notes please").trigger, false);
  assert.equal(meetingRequest('remember this meeting — https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c').link?.provider, 'granola');
  assert.equal(meetingRequest('remember this meeting, here it is: https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c').link?.provider, 'granola');
  assert.equal(meetingRequest('remember this meeting\nAna: see https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c').link, null, 'a link on a transcript line is part of the transcript');
  assert.equal(meetingRequest('remember this meeting: decided per https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 that retries stop at 3').link, null);
});

test('the digest thread is closed: a reply there never starts a job with unreviewed meeting text', async (t) => {
  const h = harness(t);
  await run(h, message());
  const posted = h.posts.at(-1)!;
  assert.equal(posted.thread, undefined);
  const [record] = Object.values(h.capture.store.readRegistry().meetings);
  assert.equal(h.capture.closed(DM, record!.digest!.ts), true);
  assert.notEqual(h.capture.intercept(message({ threadTs: record!.digest!.ts, messageTs: '200.0', text: 'file tickets for these', files: [] })), null);
});

test('with capture off, the owner\'s channel message about a meeting is still turned away, not sent to a job', (t) => {
  const h = harness(t, { enabled: false });
  const result = h.capture.intercept(message({ channel: 'C0TEAM001', im: false, text: 'remember this meeting: Ana: TRANSCRIPT' }));
  assert.notEqual(result, null);
});

test('a provider fetch refuses a cut-off result and a binary replaced between the probe and the run', async (t) => {
  const path = binDir(t);
  const server = { name: 'claude.ai Granola', status: 'connected' };
  const tool = 'mcp__claude_ai_Granola__get_meeting_transcript';
  const lines = (content: string) => [
    init({ mcp_servers: [server], tools: [tool] }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: { meeting_id: 'abc' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content }] } }),
  ];
  const cut = fakeClaude((args) => (args.includes('--allowedTools') ? lines('Output too large (180KB). Full output saved to: /x/tool-results/y.txt') : [init({ mcp_servers: [server], tools: [tool] })]));
  await assert.rejects(createSourceReader({ path, spawn: cut.spawn, managedSettingsDir: join(path, 'none') }).fetchTranscript({ provider: 'granola', id: 'abc', url: 'x' }), /too long to read through Claude Code/);
  // The binary is rewritten while the probe runs.
  const swapped = fakeClaude((args) => {
    if (!args.includes('--allowedTools')) writeFileSync(join(path, 'claude'), '#!/bin/sh\necho replaced\n');
    return args.includes('--allowedTools') ? lines('Ana: hi') : [init({ mcp_servers: [server], tools: [tool] })];
  });
  await assert.rejects(createSourceReader({ path, spawn: swapped.spawn, managedSettingsDir: join(path, 'none') }).fetchTranscript({ provider: 'granola', id: 'abc', url: 'x' }), /changed while Serra was checking/);
});
