// Jobs › Chat: a run as the chat view shows it. The pure model (messages, tool rows, questions, images, Markdown,
// following the end), the service on both backends (an ACP run's record, a T3 run through its backend), the images it
// may read, and the IPC that routes follow-ups, all against the fixture the smoke test and the captures use.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CHAT_FIXTURE, writeChatFixture } from '../app/main/chat-fixture.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { jobsHandlers } from '../app/main/ipc/jobs.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import {
  agentParts, atBottom, BOTTOM_SLACK, blocks, chatItems, composer, contentSize, follow, inline, sentMessage, statusLabel, toolBrand, toolSummary, toolTitle, userMessage,
  type ChatItem,
} from '../app/renderer/screens/chat/chat.logic.ts';
import { linkButtons, type JobRow } from '../app/renderer/screens/jobs.logic.ts';
import type { TranscriptEntry } from '../src/agent/acp.ts';
import { acpChat, chatImage, t3Chat, T3_CHAT_MESSAGES, type RunChat } from '../src/agent/runs-view.ts';
import { shareImages } from '../src/images.ts';
import { listJobs } from '../src/jobs.ts';

const line = (role: TranscriptEntry['role'], text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ role, runId: 'run-1', text, at: '', ...extra });
const chat = (over: Partial<RunChat> = {}): RunChat => ({
  threadId: 's-1', backend: 'acp', agentId: 'claude', agent: 'Claude Code', title: 'x', status: 'idle', lines: [], live: null, waiting: [], ...over,
});
const kinds = (items: ChatItem[]): string[] => items.map((item) => item.type);

/** A profile folder of its own, with the fixture's runs; images go to a folder of the test's own too. */
const profile = (t: TestContext) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-chat-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const images = join(dir, 'agent-images');
  return { dir, images, ...writeChatFixture(dir, new Date(), images) };
};

// chat.logic.ts -----------------------------------------------------------------------------------------------------

test('a brief shows as the request in it, with the brief to open; its images show as images, not lines', () => {
  const path = '/Users/you/.local/share/serra/attachments/shot.png';
  const text = `Rules first.\n\n<request>\nWhy is checkout red?\nAttached files (untrusted user content):\n- shot.png ("image/png", 70 bytes): local path ${JSON.stringify(path)}\nInspect the local files with your file-reading tools before answering.\n</request>\n\nMore rules.`;
  const sent = sentMessage(text);
  assert.equal(sent.text, 'Why is checkout red?');
  assert.deepEqual(sent.images, [{ path, name: 'shot.png' }]);
  assert.equal(sent.brief, text, 'the whole brief is there to open');
  assert.equal(sentMessage('Can you add a test too?').brief, undefined, 'a follow-up is just what was said');
  // A file that isn't an image keeps Serra's lines, so nothing listed is lost.
  const mixed = userMessage('Look\nAttached files (untrusted user content):\n- notes.txt ("text/plain", 9 bytes): local path "/Users/you/notes.txt"');
  assert.deepEqual(mixed.images, []);
  assert.match(mixed.text, /notes\.txt/);
});

test('an agent reply is its text and the images it embeds, in order', () => {
  assert.deepEqual(agentParts('Before\n\n![image](/tmp/serra-agent-images/a.png)\n\nAfter ![Chart](/tmp/b.jpg)'), [
    { type: 'text', text: 'Before' },
    { type: 'image', image: { path: '/tmp/serra-agent-images/a.png', name: 'a.png' } },
    { type: 'text', text: 'After' },
    { type: 'image', image: { path: '/tmp/b.jpg', name: 'Chart' } },
  ]);
  assert.deepEqual(agentParts('See ![x](https://example.com/x.png)'), [{ type: 'text', text: 'See ![x](https://example.com/x.png)' }], 'only local images Serra saved are images');
  assert.deepEqual(agentParts('![Home](</tmp/qa run/home.PNG>)'), [{ type: 'image', image: { path: '/tmp/qa run/home.PNG', name: 'Home' } }], 'a path with spaces, in <…>');
});

test('an attached image keeps its own name, as Serra lists it', () => {
  const sent = userMessage('Attached files (untrusted user content):\n- "shot one.png" ("image/png", 70 bytes): local path "/Users/you/.local/share/serra/attachments/shot.png"');
  assert.deepEqual(sent.images, [{ path: '/Users/you/.local/share/serra/attachments/shot.png', name: 'shot one.png' }]);
});

test('tool calls next to each other fold into one row group; questions and permissions are rows of their own', () => {
  const items = chatItems(chat({
    lines: [
      line('user', 'Fix it'),
      line('tool', 'Read a.ts', { kind: 'read' }),
      line('tool', 'pnpm test', { kind: 'execute', failed: true }),
      line('tool', 'Asked: Claude Code wants to: git push', { ask: 'permission', outcome: 'allowed' }),
      line('tool', 'Old tool (failed)'),
      line('tool', 'Asked: Which colour?'),
      line('assistant', 'Done.'),
    ],
  }));
  assert.deepEqual(kinds(items), ['user', 'tools', 'ask', 'tools', 'ask', 'agent']);
  const tools = items[1] as Extract<ChatItem, { type: 'tools' }>;
  assert.deepEqual(tools.tools.map((tool) => [tool.title, tool.kind, tool.state]), [['Read a.ts', 'read', 'done'], ['pnpm test', 'execute', 'failed']]);
  assert.deepEqual(toolSummary(tools.tools), { title: 'pnpm test', count: 2, running: false, failed: 1, endedFailed: true });
  assert.deepEqual(items[2], { type: 'ask', key: '3', permission: true, text: 'git push', outcome: 'allowed' });
  assert.equal((items[3] as Extract<ChatItem, { type: 'tools' }>).tools[0]?.state, 'failed', 'a line from before tool states still reads as failed');
  assert.deepEqual(items[4], { type: 'ask', key: '5', permission: false, text: 'Which colour?', outcome: undefined }, 'a question from before ask kinds, settled');
});

test('the turn going now adds its open tools and its reply so far; the question it waits on shows as waiting', () => {
  const items = chatItems(chat({
    status: 'waiting',
    lines: [line('user', 'Go'), line('tool', 'Read a.ts', { kind: 'read' }), line('tool', 'Asked: X wants to: rm -r old', { ask: 'permission' })],
    waiting: [{ requestId: 'r', questions: [{ id: 'permission', header: 'Permission', question: 'X wants to: rm -r old', options: [], allowCustomAnswer: false }] }],
    live: { runId: 'run-1', reply: 'Half a', tools: [{ id: 't', title: 'pnpm test', kind: 'execute' }] },
  }));
  assert.deepEqual(kinds(items), ['user', 'tools', 'ask', 'tools', 'agent']);
  assert.equal((items[2] as Extract<ChatItem, { type: 'ask' }>).outcome, 'waiting');
  assert.deepEqual((items[3] as Extract<ChatItem, { type: 'tools' }>).tools.map((tool) => tool.state), ['running']);
  assert.deepEqual(items[4], { type: 'agent', key: 'live-run-1', parts: [{ type: 'text', text: 'Half a' }], streaming: true });
  // An open tool right after finished ones joins their group.
  const joined = chatItems(chat({ lines: [line('tool', 'Read a.ts')], live: { runId: 'run-1', reply: '', tools: [{ id: 't', title: '', kind: 'read' }] } }));
  assert.deepEqual(kinds(joined), ['tools', 'agent']);
  assert.deepEqual((joined[0] as Extract<ChatItem, { type: 'tools' }>).tools.map((tool) => [tool.title, tool.state]), [['Read a.ts', 'done'], ['read', 'running']]);
});

test('Markdown: paragraphs, headings, lists, quotes and code; inline code, bold, em and only https links', () => {
  assert.deepEqual(blocks('# Done\n\nFirst line\nsecond line\n\n- one\n- two\n  more\n1. a\n\n> quoted\n\n```ts\nconst x = 1;\n```'), [
    { type: 'h', text: 'Done' },
    { type: 'p', text: 'First line\nsecond line' },
    { type: 'list', ordered: false, items: ['one', 'two more'] },
    { type: 'list', ordered: true, items: ['a'] },
    { type: 'quote', text: 'quoted' },
    { type: 'code', lang: 'ts', text: 'const x = 1;' },
  ]);
  assert.deepEqual(inline('Run `pnpm test`, **now**, _please_: [PR](https://github.com/acme/project/pull/1) or https://example.com/a.'), [
    { type: 'text', text: 'Run ' }, { type: 'code', text: 'pnpm test' }, { type: 'text', text: ', ' }, { type: 'strong', text: 'now' },
    { type: 'text', text: ', ' }, { type: 'em', text: 'please' }, { type: 'text', text: ': ' },
    { type: 'link', text: 'PR', url: 'https://github.com/acme/project/pull/1' }, { type: 'text', text: ' or ' },
    { type: 'link', text: 'https://example.com/a', url: 'https://example.com/a' }, { type: 'text', text: '.' },
  ]);
  assert.deepEqual(inline('[x](javascript:alert(1)) and file_name_here'), [{ type: 'text', text: '[x](javascript:alert(1)) and file_name_here' }], 'no other link kinds, and snake_case stays text');
});

test('a tool names its service by a word in its title; the header says the state in a word or two', () => {
  const brands = ['github', 'linear', 'slack'] as const;
  assert.equal(toolBrand('mcp__github__create_pull_request', brands), 'github');
  assert.equal(toolBrand('Search Linear issues', brands), 'linear');
  assert.equal(toolBrand('Read src/github-ish.ts', ['git'] as const), null, 'a whole word only');
  assert.equal(toolTitle('mcp__github__create_pull_request'), 'Create pull request', 'an MCP tool reads as words, its service as its mark');
  assert.equal(toolTitle('Read src/a.ts'), 'Read src/a.ts');
  assert.equal(toolSummary([{ key: 'a', title: 'x', kind: null, state: 'failed' }, { key: 'b', title: 'y', kind: null, state: 'done' }]).endedFailed, false, 'a retry that passed is no alarm');
  assert.deepEqual((['running', 'waiting', 'idle', 'failed'] as const).map(statusLabel), ['Working', 'Needs you', 'Done', 'Failed']);
});

test('the composer answers what the run waits on, follows up otherwise, and says in a few words why it can\'t', () => {
  const question = { requestId: 'r', questions: [{ id: 'q', header: '', question: 'Which?', options: [], allowCustomAnswer: true }] };
  assert.deepEqual(composer(chat(), true), { mode: 'reply', placeholder: 'Follow up', note: null });
  assert.deepEqual(composer(chat({ status: 'running' }), true), { mode: 'reply', placeholder: 'Follow up', note: 'Sends after this turn' }, 'ACP queues behind a turn');
  assert.deepEqual(composer(chat({ backend: 't3', status: 'running' }), true), { mode: 'reply', placeholder: 'Follow up', note: null }, 'T3 takes it into the turn');
  assert.deepEqual(composer(chat({ status: 'waiting', waiting: [question] }), true), { mode: 'answer', placeholder: 'Or type an answer', note: null });
  assert.deepEqual(composer(chat({ replyBlocked: 'Read-only run' }), true), { mode: 'blocked', reason: 'Read-only run' });
  assert.deepEqual(composer(chat(), false), { mode: 'blocked', reason: 'Start Serra to reply' });
  for (const result of [composer(chat({ replyBlocked: 'Answer in T3' }), true), composer(chat(), false)]) {
    assert.ok(result.mode === 'blocked' && result.reason.split(' ').length <= 4, 'a reason is a few words');
  }
});

test('following the end: stuck while at the bottom, let go on a scroll up, counting what arrives, until a jump', () => {
  const box = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 600 });
  assert.equal(atBottom(box(1400)), true);
  assert.equal(atBottom(box(1400 - BOTTOM_SLACK)), true, 'near the end counts');
  assert.equal(atBottom(box(1000)), false);
  let state = { stuck: true, unseen: 0 };
  state = follow(state, { type: 'grew', added: 2 });
  assert.deepEqual(state, { stuck: true, unseen: 0 }, 'while stuck, new items are seen');
  state = follow(state, { type: 'scrolled', box: box(200) });
  assert.deepEqual(state, { stuck: false, unseen: 0 });
  state = follow(follow(state, { type: 'grew', added: 1 }), { type: 'grew', added: 2 });
  assert.deepEqual(state, { stuck: false, unseen: 3 });
  assert.deepEqual(follow(state, { type: 'scrolled', box: box(1400) }), { stuck: true, unseen: 0 }, 'scrolling back down sticks again');
  assert.deepEqual(follow(state, { type: 'jumped' }), { stuck: true, unseen: 0 });
  // Streamed text grows what's on screen without a new item, so the view follows it too.
  const before = contentSize(chatItems(chat({ live: { runId: 'run-1', reply: 'Hal', tools: [] } })));
  assert.ok(contentSize(chatItems(chat({ live: { runId: 'run-1', reply: 'Half a line', tools: [] } }))) > before);
});

// The service ------------------------------------------------------------------------------------------------------

test('an ACP run\'s chat comes from its record: state, agent name, the turn streaming, and why a read-only run takes no reply', (t) => {
  const { dir } = profile(t);
  const finished = acpChat(dir, CHAT_FIXTURE.finished)!;
  assert.equal(finished.agent, 'Claude Code');
  assert.equal(finished.status, 'idle');
  assert.equal(finished.live, null);
  assert.equal(finished.replyBlocked, undefined);
  assert.deepEqual(kinds(chatItems(finished)), ['user', 'tools', 'ask', 'tools', 'agent', 'user', 'tools', 'agent']);
  const streaming = acpChat(dir, CHAT_FIXTURE.streaming)!;
  assert.equal(streaming.agent, 'Codex');
  assert.equal(streaming.status, 'running');
  assert.match(streaming.live?.reply ?? '', /Highlights/);
  const waiting = acpChat(dir, CHAT_FIXTURE.waiting)!;
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(composer(waiting, true), { mode: 'reply', placeholder: 'Follow up', note: 'Sends after you answer' }, 'a permission is Allow or Deny; typed words are the next message');
  assert.equal(acpChat(dir, 'no-such-run'), null);

  // A meeting run or a check is read-only: nobody carries it on.
  const runs = join(dir, 'agent-runs');
  writeFileSync(join(runs, 'readonly.json'), JSON.stringify({ version: 1, agent: 'gemini', sessionId: 'readonly', title: 't', cwd: dir, access: 'read-only', createdAt: '', runs: 1, active: 'run-1', entries: [], live: { runId: 'run-1', reply: 'x', tools: [{ id: 1 }] } }));
  const guarded = acpChat(dir, 'readonly')!;
  assert.equal(guarded.replyBlocked, 'Read-only run');
  assert.equal(guarded.agent, 'Gemini CLI');
  assert.deepEqual(guarded.live, { runId: 'run-1', reply: 'x', tools: [] }, 'a malformed tool in the record is dropped');
});

test('a T3 run\'s chat is read through its backend: its messages, state and link; a question in T3 is answered there', async () => {
  const asked: number[] = [];
  const backend = {
    read: async (threadId: string, count = 1) => {
      asked.push(count);
      return {
        thread: { threadId, link: 'https://t3.test/t-1', status: 'running', latestRunId: 'run-2', activeRunId: 'run-2', pendingRequestCount: 0 },
        messages: [{ role: 'user', runId: 'run-1', text: 'Go' }, { role: 'system', text: 'hidden' }, { role: 'assistant', runId: 'run-1', text: 'Done.' }, { role: 'assistant', runId: 'run-2' }],
      };
    },
  };
  const found = await t3Chat(backend, 't-1', 'Fix it');
  assert.deepEqual(asked, [T3_CHAT_MESSAGES]);
  assert.equal(found.link, 'https://t3.test/t-1');
  assert.equal(found.status, 'running');
  assert.equal(found.title, 'Fix it');
  assert.deepEqual(found.lines.map((entry) => [entry.role, entry.text]), [['user', 'Go'], ['assistant', 'Done.']]);
  assert.equal(composer(found, true).mode, 'reply');
  const waiting = await t3Chat({ read: async (id) => ({ ...(await backend.read(id)), thread: { threadId: id, link: '', status: 'idle', latestRunId: null, activeRunId: null, pendingRequestCount: 1 } }) }, 't-1');
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(composer(waiting, true), { mode: 'blocked', reason: 'Answer in T3' });
});

test('chat images come only from Serra\'s attachments and agent images, as data URLs', (t) => {
  const { dir, images, imageIn, imageOut } = profile(t);
  const roots = [join(dir, 'attachments'), images];
  assert.match(chatImage(dir, imageIn, roots) ?? '', /^data:image\/png;base64,iVBORw0KGgo/);
  assert.match(chatImage(dir, imageOut, roots) ?? '', /^data:image\/png;base64,/);
  const outside = join(dir, 'secret.png');
  writeFileSync(outside, 'not for the chat');
  assert.equal(chatImage(dir, outside, roots), null, 'a file outside Serra\'s folders');
  const link = join(dir, 'attachments', 'link.png');
  symlinkSync(outside, link);
  assert.equal(chatImage(dir, link, roots), null, 'a link out of them');
  writeFileSync(join(dir, 'attachments', 'notes.txt'), 'text');
  assert.equal(chatImage(dir, join(dir, 'attachments', 'notes.txt'), roots), null, 'not an image');
  assert.equal(chatImage(dir, 'attachments/fixture-ci-runs.png', roots), null, 'a relative path');
  assert.equal(chatImage(dir, join(dir, 'attachments', 'missing.png'), roots), null);
});

test('the chat shows an image a worker shares from its worktree or temp files, as Slack gets it', async (t) => {
  const { dir } = profile(t);
  const qa = realpathSync(mkdtempSync(join(tmpdir(), 'serra-qa-run-')));
  t.after(() => rmSync(qa, { recursive: true, force: true }));
  const shot = join(qa, 'home page.png');
  writeFileSync(shot, readFileSync(join(dir, 'attachments', 'fixture-ci-runs.png')));
  const uploaded: string[] = [];
  await shareImages(`Done.\n\n![Home](<${shot}>)`, async (file) => { uploaded.push(file.path); return null; });
  assert.deepEqual(uploaded, [shot], 'Slack gets it');
  const [image] = agentParts(`Done.\n\n![Home](<${shot}>)`).filter((part) => part.type === 'image');
  assert.equal(image?.type === 'image' && image.image.path, shot);
  assert.match(chatImage(dir, shot) ?? '', /^data:image\/png;base64,/, 'and the chat shows it');
});

// Jobs and IPC -------------------------------------------------------------------------------------------------------

const context = (profileDir: string): HandlerContext => ({
  profileDirOrNull: () => profileDir,
  profileDir: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

test('Jobs rows open the chat on both backends; an ACP run has no T3 button', async (t) => {
  const { dir } = profile(t);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'C0123456789:1.1': { t3ThreadId: 'thread-t3', channel: 'C0123456789', threadTs: '1.1', requester: 'U0123456789', createdAt: new Date().toISOString() } }));
  const { jobs } = await listJobs(dir, { now: new Date() });
  const chats = Object.fromEntries(jobs.map((job) => [job.title || job.key, job.chat]));
  assert.deepEqual(chats['Fix the flaky checkout test'], { threadId: CHAT_FIXTURE.finished, backend: 'acp' });
  assert.deepEqual(chats['C0123456789:1.1'], { threadId: 'thread-t3', backend: 't3' });
  const row = (chat: JobRow['chat']): JobRow => ({ key: 'k', group: 'done', requester: 'U0123456789', channel: 'app', title: 'x', createdAt: '', lastActivityAt: '', links: {}, ...(chat ? { chat } : {}) });
  assert.deepEqual(linkButtons(row({ threadId: 's', backend: 'acp' })).map((button) => button.kind), ['slack', 'chat', 'pr']);
  assert.deepEqual(linkButtons(row({ threadId: 't', backend: 't3' })).map((button) => button.kind), ['slack', 'chat', 't3', 'pr']);
  assert.deepEqual(linkButtons(row({ threadId: 't', backend: 't3' }))[1]?.chat, { threadId: 't', backend: 't3' });
});

test('just after midnight the fixture\'s finished run still shows under today in Jobs', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-chat-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date(2026, 10, 28, 0, 1);
  writeChatFixture(dir, now, join(dir, 'agent-images'));
  const { jobs } = await listJobs(dir, { now });
  assert.deepEqual(jobs.find((job) => job.title === 'Fix the flaky checkout test')?.chat, { threadId: CHAT_FIXTURE.finished, backend: 'acp' });
});

test('jobs.chat, image and reply: ACP from its record, T3 through `t3 thread show`, follow-ups to the right backend', async (t) => {
  const { dir, images } = profile(t);
  mkdirSync(images, { recursive: true });
  const t3Bin = join(dir, 'bin', 't3');
  const example = JSON.parse(readFileSync(new URL('../examples/profile.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...example, t3Bin }));
  const ran: string[][] = [];
  const sent: unknown[] = [];
  const handlers = jobsHandlers(context(dir), {
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      return JSON.stringify({ thread: { threadId: 't-1', link: 'https://t3.test/t-1', status: 'idle', latestRunId: 'run-1', activeRunId: null }, messages: [{ role: 'assistant', runId: 'run-1', text: 'Hi' }] });
    },
    daemon: async (_profile, request) => { sent.push(request); return {} as never; },
  });
  assert.equal((await handlers.chat({ threadId: CHAT_FIXTURE.finished, backend: 'acp' }))?.agent, 'Claude Code');
  const t3 = await handlers.chat({ threadId: 't-1', backend: 't3', title: 'Hello' });
  assert.deepEqual([t3?.link, t3?.title, t3?.lines.length], ['https://t3.test/t-1', 'Hello', 1]);
  assert.deepEqual(ran, [[t3Bin, 'thread', 'show', '--messages', String(T3_CHAT_MESSAGES), '--json', 't-1']]);
  await assert.rejects(async () => handlers.chat({ threadId: 't-1', backend: 'other' } as never), /That run is missing/);

  await handlers.reply({ threadId: CHAT_FIXTURE.finished, backend: 'acp' }, '  Thanks  ');
  await handlers.reply({ threadId: 't-1', backend: 't3' }, 'More, please');
  assert.deepEqual(sent, [
    { op: 'send', backend: 'acp:claude', threadId: CHAT_FIXTURE.finished, message: 'Thanks' },
    { op: 'send', backend: 't3', threadId: 't-1', message: 'More, please' },
  ]);
  await assert.rejects(async () => handlers.reply({ threadId: 't-1', backend: 't3' }, '   '), /Write a reply/);
  await assert.rejects(async () => handlers.reply({ threadId: 'no-such-run', backend: 'acp' }, 'hi'), /no record/);

  assert.match(await handlers.image(join(dir, 'attachments', 'fixture-ci-runs.png')) ?? '', /^data:image\/png/);
  assert.equal(await handlers.image(join(dir, 'profile.json')), null);
  assert.equal(await handlers.image(42 as never), null);
});
