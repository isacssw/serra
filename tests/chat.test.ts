// The chat port's boundary: `deliver` is the only way worker words reach a chat, and it asks who can see the target
// right before each write. These run the real Slack adapter over the recording Slack in tests/fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliver } from '../src/chat/deliver.ts';
import type { Audience, Target } from '../src/chat/port.ts';
import { createSlackChat } from '../src/slack/chat.ts';
import { fakeClock } from './fakes/clock.ts';
import { createFakeSlack, slackError } from './fakes/slack.ts';

const OWNER = 'U0123456789';
const thread: Target = { conversation: 'C1', thread: '1700000000.000100' };
const reply = { kind: 'reply', markdown: 'PR is up.', link: 'https://t3.test/t', notify: 'none', runId: 'run-1' } as const;
const quiet = (): void => {};

const fixture = (options: Parameters<typeof createFakeSlack>[0] = {}) => {
  const clock = fakeClock('2026-11-18T10:00:00Z');
  const slack = createFakeSlack({ botUserId: 'UBOT', now: () => clock.now(), ...options });
  const { chat, writer } = createSlackChat({ client: slack.client, owner: OWNER, botUserId: () => 'UBOT', botToken: 'xoxb-1111-2222-fixturevalue',
    profileDir: '/tmp', logger: { info: quiet, warn: quiet, error: quiet, debug: quiet }, clock });
  return { slack, chat, writer, clock, deliver: createDeliver(writer) };
};

test('[KB-002] deliver writes worker words only after the chat says who can see the target, and the page check allows them', async () => {
  const f = fixture({ external: ['CEXT'] });
  const heard: Audience[] = [];
  const may = (audience: Audience): boolean => { heard.push(audience); return audience !== 'external'; };

  const sent = await f.deliver({ target: thread, requester: OWNER, may }, { op: 'send', out: reply });
  assert.equal(sent.ok, true);
  assert.deepEqual(heard, ['team']);
  // Asked of Slack right before the post, not taken from a cache.
  assert.deepEqual(f.slack.calls.map((call) => call.method), ['conversations.info', 'chat.postMessage']);

  const refused = await f.deliver({ target: { conversation: 'CEXT', thread: '1.0' }, requester: OWNER, may }, { op: 'send', out: reply });
  assert.deepEqual(refused, { ok: false, why: 'withheld' });
  assert.equal(f.slack.callsTo('chat.postMessage').length, 1, 'nothing posted in the shared channel');
});

test('[KB-003] when Slack can\'t say who sees a thread, deliver writes nothing and says whether asking again can help', async () => {
  const f = fixture();
  f.slack.fail('conversations.info', new Error('ratelimited'), 2);
  const blip = await f.deliver({ target: thread, requester: OWNER, may: () => true }, { op: 'send', out: reply });
  assert.deepEqual(blip, { ok: false, why: 'unconfirmed', error: { kind: 'retry' } });
  assert.equal(f.slack.callsTo('conversations.info').length, 2, 'asked twice before giving up');

  f.slack.fail('conversations.info', slackError('missing_scope'), 2);
  const setup = await f.deliver({ target: thread, requester: OWNER, may: () => true }, { op: 'send', out: reply });
  assert.deepEqual(setup, { ok: false, why: 'unconfirmed', error: { kind: 'setup', problem: 'missing_scope' } });
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
  const sent = await f.deliver({ target: thread, requester: OWNER, may: () => true }, { op: 'send', out: { kind: 'progress', text: 'Still on it.' } });
  assert.ok(sent.ok);
  f.slack.deleted.push(sent.value);
  await assert.rejects(f.deliver({ target: thread, requester: OWNER, may: () => true }, { op: 'revise', ref: { conversation: 'C1', id: sent.value }, out: { kind: 'progress', text: 'Nearly.' } }),
    { name: 'MessageGone' });
});

test('[REPLY-009] a reply carries its run, and a notice in its place does too, so a restart finds either', async () => {
  const f = fixture();
  await f.deliver({ target: thread, requester: OWNER, may: () => true }, { op: 'send', out: reply });
  assert.equal(await f.chat.findReply(thread, { runId: 'run-1', at: '2026-11-18T10:00:00.000Z' }), f.slack.posted[0]!.ts);
  await f.chat.notice(thread, { kind: 'withheld' }, { runId: 'run-2', frame: 'reply', link: 'https://t3.test/t', notify: 'none' });
  assert.equal(await f.chat.findReply(thread, { runId: 'run-2', at: '2026-11-18T10:00:00.000Z' }), f.slack.posted[1]!.ts);
  assert.match(String(f.slack.posted[1]!.text), /made private, so I won't post it/);
});
