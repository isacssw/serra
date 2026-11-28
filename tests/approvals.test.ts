/**
 * Approvals follow the owner (`src/chat/mirrors.ts`): an approval card for the owner's own request also goes to the
 * owner's own conversation in every other connected chat. The first answer anywhere wins, every copy then shows it's
 * done, a chat that was down catches up, and only the owner, as each chat knows them, can answer a copy. Slack is the
 * real daemon's; the other chat is the in-memory one every new chat plugs into (`fakes/second-chat.ts`).
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { chatName } from '../src/chat/connection.ts';
import { mayFollowOwner, refuseCopyPress, STALE_COPY_RETRY_MS } from '../src/chat/mirrors.ts';
import type { QuestionCard } from '../src/questions.ts';
import { readOwnerDm, SLACK_OWNER_DM_FILE } from '../src/slack/owner-dm.ts';
import type { T3QuestionRequest } from '../src/t3-questions.ts';
import { startTestDaemon, type DaemonHarness } from './fakes/daemon.ts';
import { BOT, OWNER, SAM } from './fakes/profile.ts';
import { createSecondChat, fake, FAKE } from './fakes/second-chat.ts';

const approval: T3QuestionRequest = {
  requestId: 'req-1',
  questions: [{ id: 'permission', header: 'Allow', question: 'Run `rm -rf build`?', multiSelect: false, options: [{ label: 'Allow', description: '' }, { label: 'Deny', description: '' }] }],
};
const question: T3QuestionRequest = {
  requestId: 'req-q',
  questions: [{ id: 'colour', header: 'Colour', question: 'Which colour?', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }],
};

const TS = '1700000100.000100';
const mention = (user: string, text: string, ts = TS, channel = 'C1'): Record<string, unknown> => ({
  type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: `Ev${ts}`, event_time: 1,
  authorizations: [{ team_id: 'THOME', user_id: BOT, is_bot: true }],
  event: { type: 'app_mention', user, text: `<@${BOT}> ${text}`, ts, channel, event_ts: ts, team: 'THOME' },
});
const slackDm = (user: string, text: string, ts: string, channel = 'D0OWNER1'): Record<string, unknown> => ({
  type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: `Ev${ts}`, event_time: 1,
  authorizations: [{ team_id: 'THOME', user_id: BOT, is_bot: true }],
  event: { type: 'message', channel_type: 'im', user, text, ts, channel, event_ts: ts, team: 'THOME' },
});

/** A Slack press on the button labelled `label` of the newest card posted in `channel`, as `user`. */
const slackPress = (h: DaemonHarness, label: string, user: string, channel = 'C1'): Record<string, unknown> => {
  for (const call of h.slack.calls.toReversed()) {
    if (call.method !== 'chat.postMessage' || call.args.channel !== channel) continue;
    const blocks = Array.isArray(call.args.blocks) ? call.args.blocks as Record<string, unknown>[] : [];
    for (const block of blocks) {
      const elements = Array.isArray(block.elements) ? block.elements as Record<string, unknown>[] : [];
      const button = elements.find((element) => element.type === 'button' && (element.text as { text?: string } | undefined)?.text === label);
      if (!button) continue;
      const ts = h.slack.posted.findLast((posted) => posted.channel === channel && JSON.stringify(posted.blocks) === JSON.stringify(call.args.blocks))?.ts;
      return {
        type: 'block_actions', team: { id: 'THOME' }, user: { id: user, team_id: 'THOME' }, api_app_id: 'A1', token: 'x', trigger_id: 't',
        channel: { id: channel }, container: { type: 'message', message_ts: ts, channel_id: channel },
        message: { ts, type: 'message' }, actions: [{ type: 'button', action_id: button.action_id, block_id: block.block_id, value: button.value, action_ts: '1' }],
      };
    }
  }
  throw new Error(`No button labelled ${label} in ${channel}`);
};
const slackText = (args: Record<string, unknown>): string => JSON.stringify(args.blocks ?? args.text);

/** Slack and a second chat whose owner's own conversation is `dm`; the owner asks in Slack and the agent asks to run a tool. */
const askedInSlack = async (t: test.TestContext, { by = OWNER, request = approval }: { by?: string; request?: T3QuestionRequest } = {}) => {
  const second = createSecondChat({ ownerSpace: 'dm', audiences: { dm: 'owner' } });
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  await h.deliver(mention(by, 'clean the build folder'));
  await h.clock.settle();
  h.t3.ask(request);
  await h.advance(15_000);
  const copy = second.sent.find(({ out }) => out.kind === 'question');
  return { h, second, copy };
};
type Copy = NonNullable<Awaited<ReturnType<typeof askedInSlack>>['copy']>;
const nonceOf = (copy: Copy): string => (copy.out.kind === 'question' ? copy.out.card.nonce : '');

// --- the rules ------------------------------------------------------------------------------------------------------

test('only a one-step tool approval with a few answers follows the owner', () => {
  assert.equal(mayFollowOwner(approval), true);
  assert.equal(mayFollowOwner(question), false, 'an ordinary question stays in its thread: it may be the requester\'s');
  assert.equal(mayFollowOwner({ questions: [...approval.questions, ...question.questions] }), false, 'a form with several steps stays');
  const many = { ...approval.questions[0]!, options: Array.from({ length: 6 }, (_, index) => ({ label: `Option ${index}`, description: '' })) };
  assert.equal(mayFollowOwner({ questions: [many] }), false, 'more answers than every chat shows as buttons stay');
  assert.equal(mayFollowOwner({ questions: [{ ...approval.questions[0]!, multiSelect: true }] }), false);
});

test('a press on a copy counts only on this card\'s copy, with its nonce, from the owner as that chat knows them', () => {
  const card: QuestionCard = { ...approval, ts: '1', nonce: 'a'.repeat(32), index: 0, answers: {}, runId: null, mirrors: [{ conversation: fake('dm'), id: '7' }] };
  const owner = (person: string, conversation: string): boolean => person === fake('1') && conversation.startsWith(`${FAKE}:`);
  const press = { channel: fake('dm'), messageTs: '7', nonce: card.nonce, user: fake('1') };
  assert.equal(refuseCopyPress(card, press, owner), null);
  assert.equal(refuseCopyPress(card, { ...press, messageTs: '6' }, owner), 'not-a-copy');
  assert.equal(refuseCopyPress(card, { ...press, channel: fake('room') }, owner), 'not-a-copy');
  assert.equal(refuseCopyPress(card, { ...press, nonce: 'b'.repeat(32) }, owner), 'not-open', 'an earlier card\'s nonce answers nothing');
  assert.equal(refuseCopyPress(card, { ...press, user: fake('9') }, owner), 'not-owner');
  assert.equal(refuseCopyPress({ ...card, index: 1 }, press, owner), 'not-open');
  assert.equal(chatName('telegram'), 'Telegram');
  assert.equal(chatName('fake'), 'Fake');
});

// --- one answer, every copy ------------------------------------------------------------------------------------------

test('an approval asked in Slack is copied to the owner\'s own conversation in the other chat; answering there answers once and every copy shows it', async (t) => {
  const { h, second, copy } = await askedInSlack(t);
  assert.ok(copy && copy.out.kind === 'question', 'a copy went to the other chat');
  assert.deepEqual(copy.target, { conversation: fake('dm'), thread: null }, 'only in the owner\'s own conversation');
  assert.equal(copy.out.to, fake('1'), 'for the owner, by their ID there');
  assert.equal(copy.out.copyOf?.chat, 'slack');
  assert.equal(second.sent.length, 1, 'one copy, nothing else');
  assert.equal(h.slack.callsTo('chat.postMessage').filter((args) => Array.isArray(args.blocks) && JSON.stringify(args.blocks).includes('serra_question_choice')).length, 1, 'the card in Slack is still there');

  await second.click({ conversation: 'dm', from: '1', messageTs: copy.id, nonce: nonceOf(copy), indices: [0] });
  await h.clock.settle();
  assert.deepEqual(h.t3.answered.map(({ answers }) => answers), [{ permission: 'Allow' }], 'answered once');
  const slackCard = h.slack.callsTo('chat.update').at(-1);
  assert.ok(slackCard, 'the Slack card changed');
  assert.match(slackText(slackCard), /Answered in Fake\./, 'the Slack card says where it was answered');
  assert.match(slackText(slackCard), /Allow/);
  assert.doesNotMatch(slackText(slackCard), /fake:1/, 'no ID from the other chat shows in Slack');
  const done = second.revised.find(({ ref }) => ref.id === copy.id);
  assert.ok(done && done.out.kind === 'answered', 'the copy shows the answer');
  assert.equal(done.out.by, fake('1'));
  assert.equal(done.out.via, undefined, 'answered right there');
  assert.deepEqual(h.state()[`C1:${TS}`]?.phase, { state: 'following' });
});

test('the owner answering in Slack closes the copy, and a later press on the copy answers nothing', async (t) => {
  const { h, second, copy } = await askedInSlack(t);
  assert.ok(copy);
  await h.deliver(slackPress(h, 'Deny', OWNER));
  await h.clock.settle();
  assert.deepEqual(h.t3.answered.map(({ answers }) => answers), [{ permission: 'Deny' }]);
  const done = second.revised.find(({ ref }) => ref.id === copy.id);
  assert.ok(done && done.out.kind === 'answered');
  assert.equal(done.out.via, 'slack', 'the copy says it was answered in Slack');
  assert.equal(done.out.by, fake('1'), 'by the owner as this chat knows them');

  await second.click({ conversation: 'dm', from: '1', messageTs: copy.id, nonce: nonceOf(copy), indices: [0] });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 1, 'no second decision');
});

test('two presses at once, in Slack and on the copy, make exactly one decision', async (t) => {
  const { h, second, copy } = await askedInSlack(t);
  assert.ok(copy);
  await Promise.all([
    h.deliver(slackPress(h, 'Allow', OWNER)),
    second.click({ conversation: 'dm', from: '1', messageTs: copy.id, nonce: nonceOf(copy), indices: [1] }),
  ]);
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 1, 'one decision reaches the agent');
  assert.equal(second.revised.filter(({ ref, out }) => ref.id === copy.id && out.kind === 'answered').length, 1, 'the copy is closed once');
});

test('a copy answers nothing for anyone but the owner there, nor with an old nonce or after a newer card', async (t) => {
  const { h, second, copy } = await askedInSlack(t);
  assert.ok(copy);
  const press = { conversation: 'dm', messageTs: copy.id, nonce: nonceOf(copy), indices: [0] };
  await second.click({ ...press, from: '9' });
  await second.click({ ...press, from: OWNER });
  await second.click({ ...press, from: '1', nonce: 'b'.repeat(32) });
  await second.click({ ...press, from: '1', conversation: 'room' });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 0, 'a stranger, the Slack owner\'s ID in another chat, a wrong nonce or another conversation answers nothing');
  assert.equal(second.notices.length, 0, 'and nothing is posted about it');
  assert.ok(h.logs.some((line) => /press on a copy of the question .* was refused \(not-owner\)/.test(line)), 'the refusal is logged');

  // T3 replaces the approval with a new one: the old copy closes, and pressing it answers neither.
  h.t3.questionsOf().splice(0, 1, { ...approval, requestId: 'req-2' });
  await h.advance(15_000);
  const second2 = second.sent.filter(({ out }) => out.kind === 'question');
  assert.equal(second2.length, 2, 'the new approval has its own copy');
  assert.ok(second.revised.some(({ ref, out }) => ref.id === copy.id && out.kind === 'answered' && out.by === undefined), 'the old copy shows it no longer waits');
  await second.click({ ...press, from: '1' });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 0);
});

test('answered in T3 or the app, every copy shows it no longer waits', async (t) => {
  const { h, second, copy } = await askedInSlack(t);
  assert.ok(copy);
  h.t3.questionsOf().splice(0);
  h.t3.reply('Cleaned.');
  await h.advance(15_000);
  const done = second.revised.find(({ ref }) => ref.id === copy.id);
  assert.ok(done && done.out.kind === 'answered' && done.out.by === undefined && done.out.via === undefined);
});

test('a chat that was down when the card closed catches up when it is back', async (t) => {
  const { h, second, copy } = await askedInSlack(t);
  assert.ok(copy);
  second.setOffline(true);
  await h.deliver(slackPress(h, 'Allow', OWNER));
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 1);
  const stale = h.state()[`C1:${TS}`]?.staleCopies as { id: string; shows: string }[] | undefined;
  assert.deepEqual(stale?.map(({ id, shows }) => [id, shows]), [[copy.id, 'answered']], 'the copy waits to be fixed');
  await h.advance(STALE_COPY_RETRY_MS + 1_000);
  assert.equal(second.replaced.length, 0, 'still down');
  second.setOffline(false);
  await h.advance(STALE_COPY_RETRY_MS + 1_000);
  assert.deepEqual(second.replaced, [{ ref: { conversation: fake('dm'), id: copy.id }, notice: { kind: 'question-over', answered: true } }], 'back: it shows it was answered');
  assert.equal(h.state()[`C1:${TS}`]?.staleCopies, undefined);
});

// --- who gets copies -------------------------------------------------------------------------------------------------

test('nothing is copied for a teammate\'s request, for an ordinary question, or to a chat with no owner conversation', async (t) => {
  const teammate = await askedInSlack(t, { by: SAM });
  assert.equal(teammate.copy, undefined, 'a teammate\'s job keeps its approval in its own thread');
  const asked = await askedInSlack(t, { request: question });
  assert.equal(asked.copy, undefined, 'an ordinary question is not copied');
});

test('a Slack-only owner sees no change: one card in the thread, nothing else', async (t) => {
  const plain = createSecondChat();
  const h = await startTestDaemon(t, { chats: [plain.adapter] });
  await h.deliver(mention(OWNER, 'clean the build folder'));
  await h.clock.settle();
  h.t3.ask(approval);
  await h.advance(15_000);
  assert.equal(plain.sent.length, 0);
  const posts = h.slack.callsTo('chat.postMessage');
  assert.deepEqual(posts.map((args) => args.channel), ['C1']);
  await h.deliver(slackPress(h, 'Allow', OWNER));
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 1);
  assert.doesNotMatch(slackText(h.slack.callsTo('chat.update').at(-1) ?? {}), /Answered in/, 'the card reads as before');
});

test('a copy that the target chat says isn\'t the owner\'s alone is never posted', async (t) => {
  const second = createSecondChat({ ownerSpace: 'dm', audiences: { dm: 'team' } });
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  await h.deliver(mention(OWNER, 'clean the build folder'));
  await h.clock.settle();
  h.t3.ask(approval);
  await h.advance(15_000);
  assert.equal(second.sent.length, 0, 'owner-only, checked right before the write');
});

// --- Slack as the owner's other chat ----------------------------------------------------------------------------------

test('Slack takes copies in the owner\'s DM once the owner wrote there, and a press there answers the other chat\'s card', async (t) => {
  const second = createSecondChat({ audiences: { room: 'team' } });
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  // Before the owner wrote to the Slack bot, Slack has no DM it knows is theirs.
  await second.say({ from: '1', text: '@bot clean the build folder', conversation: 'room', ts: '400' });
  await h.clock.settle();
  h.t3.ask(approval);
  await h.advance(15_000);
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0, 'no guess at a DM');

  // A teammate's DM is never the owner's.
  await h.deliver(slackDm(SAM, 'hello', '1700000300.000100', 'D0SAM0001'));
  await h.deliver(slackDm(OWNER, 'hi', '1700000301.000100'));
  await h.clock.settle();
  assert.equal(readOwnerDm(h.config.profileDir, OWNER), 'D0OWNER1', 'the owner\'s DM is kept, with whose it is');
  assert.equal(readOwnerDm(h.config.profileDir, SAM), null);

  h.t3.questionsOf(h.t3.threadIds()[0]).splice(0, 1, { ...approval, requestId: 'req-2' });
  await h.advance(15_000);
  const copies = h.slack.callsTo('chat.postMessage').filter((args) => args.channel === 'D0OWNER1' && String(JSON.stringify(args.blocks)).includes('serra_question_choice'));
  assert.equal(copies.length, 1, 'a copy in the owner\'s Slack DM');
  assert.match(slackText(copies[0]!), /From Fake · <https:\/\/chat\.example\/room\/\d+\|Open thread>/);
  assert.doesNotMatch(slackText(copies[0]!), /reply in this thread/, 'a copy is answered by its buttons only');

  await h.deliver(slackPress(h, 'Allow', OWNER, 'D0OWNER1'));
  await h.clock.settle();
  assert.deepEqual(h.t3.answered.map(({ requestId }) => requestId), ['req-2']);
  const card = second.revised.at(-1);
  assert.ok(card && card.out.kind === 'answered');
  assert.equal(card.out.via, 'slack');
  assert.equal(card.out.by, fake('1'), 'the other chat names its own owner, not a Slack ID');
});

test('a saved Slack DM is the owner\'s only while they are the owner', async (t) => {
  const h = await startTestDaemon(t);
  writeFileSync(join(h.config.profileDir, SLACK_OWNER_DM_FILE), `${JSON.stringify({ owner: 'UFORMER01', conversation: 'D0FORMER1' })}\n`);
  assert.equal(readOwnerDm(h.config.profileDir, OWNER), null);
  assert.equal(readOwnerDm(h.config.profileDir, 'UFORMER01'), 'D0FORMER1');
  writeFileSync(join(h.config.profileDir, SLACK_OWNER_DM_FILE), `${JSON.stringify({ owner: OWNER, conversation: 'C0NOTADM1' })}\n`);
  assert.equal(readOwnerDm(h.config.profileDir, OWNER), null, 'only a DM');
  await h.deliver(slackDm(OWNER, 'hi', '1700000301.000100'));
  await h.clock.settle();
  assert.deepEqual(JSON.parse(readFileSync(join(h.config.profileDir, SLACK_OWNER_DM_FILE), 'utf8')), { owner: OWNER, conversation: 'D0OWNER1' });
});
