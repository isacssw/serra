// Meeting capture routing, and the T3 runs that read links and pick out decisions (SERRA-62, SERRA-69), with fakes
// for Slack and T3. Nothing here runs a model.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { codeRoot } from '../src/config.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { COPY, createMeetingCapture, meetingsFirst, type MeetingChat } from '../src/meeting-capture.ts';
import { createMeetingRuns, meetingRunner, type MeetingRunOptions } from '../src/meeting-runs.ts';
import { writeMeetingSettings } from '../src/meeting-settings.ts';
import { meetingRequest, transcriptFromResult } from '../src/meeting-sources.ts';
import { t3Providers } from '../src/t3-providers.ts';
import type { FolderThreadInput, IncomingMessage, T3ThreadDetail } from '../src/types.ts';

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

// --- Meeting runs on T3 ---------------------------------------------------------------------------------------------

/** A fake T3: records each project added and thread started, and answers each thread with `answer(brief)`. */
const fakeT3 = (t: TestContext, answer: (brief: string) => string, { pending = false, write = false, running = 0 } = {}) => {
  const workspace = mkdtempSync(join(tmpdir(), 'serra-meeting-runs-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const projects: string[] = [];
  const started: { input: FolderThreadInput; bin: string }[] = [];
  const shows: Record<string, number> = {};
  const t3 = {
    ensureProject: async (path: string) => { projects.push(path); },
    startFolderThread: async (input: FolderThreadInput, bin = '') => {
      started.push({ input, bin });
      if (write) writeFileSync(join(workspace, 'notes.md'), 'written by the run');
      return `thread-${started.length}`;
    },
    showThread: async (threadId: string): Promise<T3ThreadDetail> => {
      shows[threadId] = (shows[threadId] ?? 0) + 1;
      const busy = shows[threadId]! <= running;
      const brief = started[Number(threadId.split('-')[1]) - 1]!.input.brief;
      return {
        thread: { threadId, link: `https://app.t3.codes/threads/${threadId}`, status: busy ? 'running' : 'idle', latestRunId: 'run-1', activeRunId: busy ? 'run-1' : null, pendingRequestCount: pending ? 1 : 0 },
        messages: [{ role: 'user', runId: 'run-1', text: brief }, { role: 'assistant', runId: 'run-1', text: 'working on it' }, { role: 'assistant', runId: 'run-1', text: answer(brief) }],
      };
    },
  };
  const runs = (over: Partial<MeetingRunOptions> = {}) => createMeetingRuns({ t3Bin: '/Users/you/.t3/bin/t3', workspace, t3, pollMs: 0, sleep: async () => {}, ...over });
  return { workspace, projects, started, runs };
};

test('extraction is one read-only T3 thread in Serra\'s empty meetings folder, on the provider and model the owner picked', async (t) => {
  const f = fakeT3(t, () => DIGEST);
  const text = await f.runs({ provider: 'cursor', model: 'composer-2' }).extract('TRANSCRIPT-BYTES');
  assert.equal(text, DIGEST, 'the run\'s final answer, not its progress lines');
  assert.deepEqual(f.projects, [f.workspace], 'the folder is a T3 project of its own');
  const { input, bin } = f.started[0]!;
  assert.equal(bin, '/Users/you/.t3/bin/t3');
  assert.equal(input.project, f.workspace);
  assert.equal(input.baseRef, undefined, 'never a worktree of the team\'s repository');
  assert.equal(input.provider, 'cursor');
  assert.equal(input.model, 'composer-2');
  assert.doesNotMatch(input.title, /TRANSCRIPT/, 'the title never holds meeting text');
  assert.match(input.brief, /read-only task/);
  assert.match(input.brief, /Do not create, edit, move or delete any file/);
  assert.match(input.brief, /Use no tools at all/);
  assert.match(input.brief, /TRANSCRIPT-BYTES/);
  // Without a choice, T3's own default runs it.
  const plain = fakeT3(t, () => DIGEST);
  await plain.runs().extract('x');
  assert.equal('provider' in plain.started[0]!.input, false);
  assert.equal('model' in plain.started[0]!.input, false);
});

test('a link is read by a T3 run allowed one read tool; the answer is unwrapped, and its errors never quote it', async (t) => {
  const f = fakeT3(t, () => '<meeting-title>Payments sync</meeting-title>\n<meeting-transcript>\nAna: three attempts.\nBo: ok.\n</meeting-transcript>');
  const fetched = await f.runs().fetchTranscript({ provider: 'granola', id: 'abc-123', url: 'https://notes.granola.ai/d/abc-123' });
  assert.deepEqual(fetched, { text: 'Ana: three attempts.\nBo: ok.', title: 'Payments sync' });
  const brief = f.started[0]!.input.brief;
  assert.match(brief, /meeting with ID "abc-123"/);
  assert.match(brief, /one call of one read tool/);
  assert.match(brief, /Do not change anything anywhere/);

  const meet = fakeT3(t, () => `<meeting-transcript>${JSON.stringify({ title: 'Sync', transcript: [{ speaker: { name: 'Ana' }, text: 'Hi' }] })}</meeting-transcript>`);
  assert.deepEqual(await meet.runs().fetchTranscript({ provider: 'google-meet', id: 'doc1', url: 'x' }), { text: 'Ana: Hi', title: 'Sync' });
  assert.match(meet.started[0]!.input.brief, /Google Doc with file ID "doc1"/);

  for (const [answer, reason] of [
    ['<meeting-error>not-connected</meeting-error>', /no Granola connection\. Connect Granola/],
    ['<meeting-error>sign-in</meeting-error>', /sign in again/],
    ['<meeting-error>too-long</meeting-error>', /too long/],
    ['<meeting-error>SECRET-TRANSCRIPT says hi</meeting-error>', /couldn.t give Serra that meeting/],
    ['Here is a summary: SECRET-TRANSCRIPT', /didn.t give back the Granola transcript/],
    ['<meeting-transcript>  </meeting-transcript>', /empty transcript/],
  ] as const) {
    const failing = fakeT3(t, () => answer);
    await assert.rejects(failing.runs().fetchTranscript({ provider: 'granola', id: 'abc', url: 'x' }), (error: Error) => reason.test(error.message) && !error.message.includes('SECRET-TRANSCRIPT'));
  }
});

test('a run that writes in the meetings folder is thrown away, and a folder with files in it gets no run', async (t) => {
  const writer = fakeT3(t, () => DIGEST, { write: true });
  await assert.rejects(writer.runs().extract('x'), /wrote files .* thrown away/);
  // The file it left stops the next run before it starts.
  await assert.rejects(writer.runs().extract('x'), /has files in it/);
  assert.equal(writer.started.length, 1);
});

test('a run that asks for approval or a question is not waited on; a run that never ends times out', async (t) => {
  const asking = fakeT3(t, () => DIGEST, { pending: true });
  await assert.rejects(asking.runs().extract('x'), /stopped to ask .* Stop it in T3: https:\/\/app\.t3\.codes\/threads\/thread-1/);
  let clock = 0;
  const slow = fakeT3(t, () => DIGEST, { running: 1000 });
  await assert.rejects(slow.runs({ timeoutMs: 10, now: () => (clock += 5) }).extract('x'), /took too long/);
  const steady = fakeT3(t, () => DIGEST, { running: 2 });
  assert.equal(await steady.runs().extract('x'), DIGEST, 'a run that is still going is followed until it ends');
});

test('Test asks one T3 run about a source without calling a tool; its answer becomes a status with what to do', async (t) => {
  for (const [answer, state, detail] of [
    ['<meeting-source>ready</meeting-source>', 'ready', /Business and Enterprise/],
    ['<meeting-source>missing</meeting-source>', 'missing', /Connect Granola in the AI provider you use in T3/],
    ['<meeting-source>sign-in</meeting-source>', 'needs-sign-in', /sign in again/],
    ['I am not sure', 'unknown', /didn't say/],
  ] as const) {
    const f = fakeT3(t, () => answer);
    const status = await f.runs().checkSource('granola');
    assert.equal(status.state, state);
    assert.match(status.detail, detail);
    assert.match(f.started[0]!.input.brief, /Do not call any tool/);
  }
});

test('who runs meetings is read from the profile and T3\'s settings, never from a model call', () => {
  const t3 = t3Providers({
    defaultModelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' },
    providerInstances: { cursor: { driver: 'cursor', enabled: true }, grok: { driver: 'grok' } },
  });
  assert.deepEqual(meetingRunner(undefined, t3, true), { label: 'Codex', model: 'gpt-6.1-sol', ready: true, detail: 'Runs on Codex in T3 (T3’s default), in Serra’s own empty folder.' });
  assert.equal(meetingRunner({ provider: 'cursor', model: 'composer-2' }, t3, true).label, 'Cursor');
  assert.equal(meetingRunner({ provider: 'cursor', model: 'composer-2' }, t3, true).model, 'composer-2');
  assert.match(meetingRunner({ provider: 'grok' }, t3, true).detail, /Grok is turned off in T3/);
  assert.equal(meetingRunner({ provider: 'grok' }, t3, true).ready, false);
  assert.match(meetingRunner({ provider: 'nope' }, t3, true).detail, /T3 has no provider "nope"/);
  assert.match(meetingRunner(undefined, t3, false).detail, /can't find T3 Code/);
  assert.equal(meetingRunner(undefined, null, true).ready, true, 'without T3\'s settings, T3 decides');
});

test('JSON transcripts from a provider are unwrapped into speaker lines', () => {
  assert.equal(transcriptFromResult(JSON.stringify({ title: 'Sync', transcript: [{ speaker: { name: 'Ana' }, text: 'Hi' }, { speaker: 'Bo', text: 'Yo' }] })).text, 'Ana: Hi\nBo: Yo');
  assert.equal(transcriptFromResult('Ana: plain').text, 'Ana: plain');
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
