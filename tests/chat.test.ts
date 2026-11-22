// The chat port's boundary: `deliver` is the only way worker words reach a chat, and it asks who can see the target
// right before each write. Most run the real Slack adapter over the recording Slack in tests/fakes; the last runs the
// bot against an in-memory chat, with no Slack at all.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createBot } from '../src/bot.ts';
import { createDeliver } from '../src/chat/deliver.ts';
import { t3LinkOf, type Target } from '../src/chat/port.ts';
import { createSlackChat } from '../src/slack/chat.ts';
import { createStore } from '../src/state.ts';
import { createFakeChat, onePage } from './fakes/chat.ts';
import { fakeClock } from './fakes/clock.ts';
import { OWNER as PROFILE_OWNER, testProfile } from './fakes/profile.ts';
import { createFakeSlack, slackError } from './fakes/slack.ts';
import { createFakeT3 } from './fakes/t3.ts';

const OWNER = 'U0123456789';
const thread: Target = { conversation: 'C1', thread: '1700000000.000100' };
const reply = { kind: 'reply', markdown: 'PR is up.', link: 'https://t3.test/t', notify: 'none', runId: 'run-1' } as const;
const quiet = (): void => {};
/** The worker was told one page only the team may hear. */
const { heard: told, loadKnowledge } = onePage();

const fixture = (options: Parameters<typeof createFakeSlack>[0] = {}) => {
  const clock = fakeClock('2026-11-18T10:00:00Z');
  const slack = createFakeSlack({ botUserId: 'UBOT', now: () => clock.now(), ...options });
  const { chat, writer, sawDm } = createSlackChat({ client: slack.client, owner: OWNER, botUserId: () => 'UBOT', botToken: 'xoxb-1111-2222-fixturevalue',
    profileDir: '/tmp', logger: { info: quiet, warn: quiet, error: quiet, debug: quiet }, clock });
  return { slack, chat, writer, sawDm, clock, deliver: createDeliver(writer, loadKnowledge) };
};

test('[KB-002] deliver writes worker words only after the chat says who can see the target, and only if they may hear them', async () => {
  const f = fixture({ external: ['CEXT'] });
  const sent = await f.deliver({ target: thread, requester: OWNER, hearing: { kind: 'thread', heard: told } }, { op: 'send', out: reply });
  assert.equal(sent.ok, true);
  // Asked of Slack right before the post, not taken from a cache.
  assert.deepEqual(f.slack.calls.map((call) => call.method), ['conversations.info', 'chat.postMessage']);

  const refused = await f.deliver({ target: { conversation: 'CEXT', thread: '1.0' }, requester: OWNER, hearing: { kind: 'thread', heard: told } }, { op: 'send', out: reply });
  assert.deepEqual(refused, { ok: false, why: 'withheld' });
  assert.equal(f.slack.callsTo('chat.postMessage').length, 1, 'nothing posted in the shared channel');
});

test('[KB-002] text only the owner may see goes only to the owner\'s own DM', async () => {
  const f = fixture();
  const detail = { op: 'send', out: { kind: 'failure-detail', line: 'exited 1: /Users/you/project' } } as const;
  assert.deepEqual(await f.deliver({ target: thread, requester: OWNER, hearing: { kind: 'owner-only' } }, detail), { ok: false, why: 'withheld' });
  assert.equal((await f.deliver({ target: { conversation: 'D1', thread: '1.0' }, requester: OWNER, hearing: { kind: 'owner-only' } }, detail)).ok, true);
  assert.equal(f.slack.callsTo('chat.postMessage').length, 1);
});

test('[REPLY-005] an error\'s detail goes out only under the owner-only rule, and only to a DM no one else has written in', async () => {
  const f = fixture();
  const detail = { op: 'send', out: { kind: 'failure-detail', line: 'exited 1' } } as const;
  await assert.rejects(f.deliver({ target: { conversation: 'D1', thread: '1.0' }, requester: OWNER, hearing: { kind: 'thread', heard: told } }, detail), /only under the owner-only rule/);
  // The owner's own DM needs no lookup: describing a DM would need a scope the app doesn't have.
  assert.equal((await f.deliver({ target: { conversation: 'D1', thread: '1.0' }, requester: OWNER, hearing: { kind: 'owner-only' } }, detail)).ok, true);
  assert.equal(f.slack.callsTo('conversations.info').length, 0);
  // Passed off as the owner's, a DM a teammate wrote in is still theirs.
  f.sawDm('D2', 'USAM');
  assert.deepEqual(await f.deliver({ target: { conversation: 'D2', thread: '1.0' }, requester: OWNER, hearing: { kind: 'owner-only' } }, detail), { ok: false, why: 'withheld' });
  assert.equal(f.slack.callsTo('chat.postMessage').length, 1);
});

test('[REPLY-008] a review request goes elsewhere only when its channel and the thread it came from may both hear it', async () => {
  const outside = new Set<string>();
  const f = fixture({ external: outside });
  const review = { op: 'send', out: { kind: 'review', markdown: 'Review https://github.com/acme/project/pull/12', from: 'Friday', link: 'https://t3.test/t' } } as const;
  const to = (target: Target) => ({ target, requester: OWNER, hearing: { kind: 'elsewhere', heard: told, source: { target: thread, requester: 'USAM' } } } as const);
  assert.equal((await f.deliver(to({ conversation: 'CREVIEW', thread: null }), review)).ok, true);
  outside.add('C1');
  assert.deepEqual(await f.deliver(to({ conversation: 'CREVIEW', thread: null }), review), { ok: false, why: 'withheld' }, 'the source thread was shared outside since');
  outside.clear(); outside.add('CREVIEW');
  assert.deepEqual(await f.deliver(to({ conversation: 'CREVIEW', thread: null }), review), { ok: false, why: 'withheld' }, 'the review channel is shared outside');
  assert.equal(f.slack.callsTo('chat.postMessage').length, 1);
});

test('[KB-003] when Slack can\'t say who sees a thread, deliver writes nothing and says whether asking again can help', async () => {
  const f = fixture();
  const to = { target: thread, requester: OWNER, hearing: { kind: 'thread', heard: told } } as const;
  f.slack.fail('conversations.info', new Error('ratelimited'), 2);
  assert.deepEqual(await f.deliver(to, { op: 'send', out: reply }), { ok: false, why: 'unconfirmed', error: { kind: 'retry' } });
  assert.equal(f.slack.callsTo('conversations.info').length, 2, 'asked twice before giving up');

  f.slack.fail('conversations.info', slackError('missing_scope'), 2);
  assert.deepEqual(await f.deliver(to, { op: 'send', out: reply }), { ok: false, why: 'unconfirmed', error: { kind: 'setup', problem: 'missing-permission', code: 'missing_scope' } });
  assert.equal(f.slack.callsTo('conversations.info').length, 3, 'a setup error isn\'t asked again');
  assert.equal(f.slack.callsTo('chat.postMessage').length, 0);
});

test('[KB-004] a DM is the owner\'s own, a teammate\'s is team, and someone from another workspace is outside', async () => {
  const f = fixture({ teams: { UOUT: 'TOTHER' } });
  const audience = async (conversation: string, requester: string) => {
    const looked = await f.chat.audience({ conversation, thread: '1.0' }, requester, { fresh: true });
    return looked.ok ? looked.value : looked.error;
  };
  assert.equal(await audience('D1', OWNER), 'owner');
  assert.equal(await audience('D2', 'USAM'), 'team');
  assert.equal(await audience('D3', 'UOUT'), 'external');
});

test('a writer refuses a proof for another conversation, or one too old to post on', async () => {
  const f = fixture();
  const cleared = await f.writer.clear(thread, OWNER);
  assert.ok(cleared.ok);
  await assert.rejects(f.writer.revise(cleared.value, { conversation: 'C2', id: '1.0' }, { kind: 'progress', text: 'x' }), /Cleared for C1, not C2/);
  await f.clock.advance(61_000);
  await assert.rejects(f.writer.send(cleared.value, reply), /checked too long ago/);
  assert.equal(f.slack.callsTo('chat.postMessage').length + f.slack.callsTo('chat.update').length, 0);
});

test('an edit of a deleted message says so, so the caller can post a new one', async () => {
  const f = fixture();
  const to = { target: thread, requester: OWNER, hearing: { kind: 'thread', heard: told } } as const;
  const sent = await f.deliver(to, { op: 'send', out: { kind: 'progress', text: 'Still on it.' } });
  assert.ok(sent.ok);
  f.slack.deleted.push(sent.value);
  await assert.rejects(f.deliver(to, { op: 'revise', ref: { conversation: 'C1', id: sent.value }, out: { kind: 'progress', text: 'Nearly.' } }), { name: 'MessageGone' });
});

test('[REPLY-009] a reply carries its run, and a notice in its place does too, so a restart finds either', async () => {
  const f = fixture();
  await f.deliver({ target: thread, requester: OWNER, hearing: { kind: 'thread', heard: told } }, { op: 'send', out: reply });
  assert.equal(await f.chat.findReply(thread, { runId: 'run-1', at: '2026-11-18T10:00:00.000Z' }), f.slack.posted[0]!.ts);
  await f.chat.notice(thread, { kind: 'withheld' }, { runId: 'run-2', frame: 'reply', link: t3LinkOf('https://t3.test/t'), notify: 'none' });
  assert.equal(await f.chat.findReply(thread, { runId: 'run-2', at: '2026-11-18T10:00:00.000Z' }), f.slack.posted[1]!.ts);
  assert.match(String(f.slack.posted[1]!.text), /made private, so I won't post it/);
});

test('a T3 link is only a plain URL: text that would read as markup can\'t pass for one', () => {
  assert.equal(t3LinkOf('https://t3.test/thread/abc'), 'https://t3.test/thread/abc');
  for (const bad of ['https://x|click here', 'see <https://x>', 'https://x y', 'javascript:alert(1)', 'Done.']) assert.equal(t3LinkOf(bad), null, bad);
});

const coreOnFakeChat = (t: TestContext) => {
  const { config } = testProfile(t);
  const clock = fakeClock('2026-11-18T10:00:00Z');
  const fake = createFakeChat();
  const worker = createFakeT3();
  const bot = createBot({
    config, chat: fake.chat, deliver: createDeliver(fake.writer, undefined), store: createStore(config.statePath), loadIndex: () => 'index',
    logger: { info: quiet, warn: quiet, error: (message) => assert.fail(message), debug: quiet }, t3: worker.t3, questions: worker.questions,
    fetchBase: async () => {}, share: async (text) => text, reviewRequest: async (text) => ({ reply: text, postedFor: null }), clock,
    timing: { quietMs: 15, retryMs: 5 },
  });
  clock.settleWith(() => bot.idle());
  return { fake, worker, bot };
};

test('[INTAKE-001] the core runs against the port alone: a request becomes a T3 thread, and its reply goes out through deliver', async (t) => {
  const { fake, worker, bot } = coreOnFakeChat(t);
  await bot.handle({ channel: 'G1', threadTs: '1', messageTs: '1', user: PROFILE_OWNER, text: '@BOT rename the pricing page', direct: true });
  assert.equal(worker.started.length, 1);
  assert.deepEqual(fake.acknowledged, [{ ref: { conversation: 'G1', id: '1' }, on: true }]);
  worker.reply('Renamed it. PR is up.');
  await bot.poll();
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0]!.out.kind, 'reply');
  assert.match(JSON.stringify(fake.sent[0]!.out), /Renamed it\. PR is up\./);
  assert.deepEqual(fake.acknowledged.at(-1), { ref: { conversation: 'G1', id: '1' }, on: false }, 'the acknowledgement goes with the reply');
});

test('[KB-003] the core\'s reply turns into a notice when the chat can\'t confirm who sees the thread at the moment of writing', async (t) => {
  const { fake, worker, bot } = coreOnFakeChat(t);
  await bot.handle({ channel: 'G1', threadTs: '1', messageTs: '1', user: PROFILE_OWNER, text: '@BOT rename the pricing page', direct: true });
  worker.reply('Renamed it.');
  fake.writer.clear = async () => ({ ok: false, error: { kind: 'retry' } });
  await bot.poll();
  assert.equal(fake.sent.length, 0, 'no worker words went out');
  assert.deepEqual(fake.notices.map(({ notice, inPlaceOf }) => [notice.kind, inPlaceOf?.runId]), [['unconfirmed', 'run-1']]);
  await bot.poll();
  assert.equal(fake.notices.length, 1, 'the notice stands in for the run: it isn\'t posted again');
});
