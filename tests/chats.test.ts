/**
 * Several chats at once (the multi-chat seam): the real daemon serves Slack and a second, in-memory chat side by side.
 * Each test drives the second chat the way a Telegram or Discord adapter would and checks that the core answers there,
 * by that chat's rules, and never on Slack.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chatId, kindOf, rawId } from '../src/chat/connection.ts';
import { createDeliver } from '../src/chat/deliver.ts';
import { routeChats } from '../src/chat/router.ts';
import type { WorkerWriter } from '../src/chat/writer.ts';
import { pauseIntake, readHeld, resumeIntake } from '../src/intake.ts';
import type { T3QuestionRequest } from '../src/t3-questions.ts';
import { createFakeChat, onePage } from './fakes/chat.ts';
import { startTestDaemon } from './fakes/daemon.ts';
import { createSecondChat, fake, FAKE, type SecondChatOptions } from './fakes/second-chat.ts';
import { OWNER } from './fakes/profile.ts';

// --- IDs and routing ------------------------------------------------------------------------------------------------

test('an ID names its chat; Slack\'s stay bare, so keys written before other chats read as they did', () => {
  assert.equal(kindOf('C0123456789'), 'slack');
  assert.equal(kindOf('U0123456789'), 'slack');
  assert.equal(kindOf('1700000100.000100'), 'slack');
  assert.equal(chatId('slack', 'C0123456789'), 'C0123456789');
  assert.equal(chatId('telegram', '42'), 'telegram:42');
  assert.equal(kindOf('telegram:42'), 'telegram');
  assert.equal(rawId('telegram', 'telegram:-100:7'), '-100:7');
  assert.equal(rawId('slack', 'C0123456789'), 'C0123456789');
});

test('the core\'s port sends each call to the chat its ID names, and never guesses at a chat that isn\'t connected', async () => {
  const slack = createFakeChat({ self: 'UBOT', owner: OWNER });
  const second = createSecondChat();
  const slackConnection = { ...second.adapter.connection, kind: 'slack', chat: slack.chat };
  const { chat, connectionOf } = routeChats([slackConnection, second.adapter.connection]);
  assert.equal(chat.self('C1'), 'UBOT');
  assert.equal(chat.self(fake('dm')), fake('bot'));
  assert.equal(chat.owner('C1'), OWNER);
  assert.equal(chat.owner(fake('dm')), fake('1'), 'the owner has another ID in the other chat');
  await chat.notice({ conversation: fake('dm'), thread: '1' }, { kind: 'here' });
  await chat.notice({ conversation: 'C1', thread: '1' }, { kind: 'here' });
  assert.equal(second.notices.length, 1);
  assert.equal(slack.notices.length, 1);
  assert.equal(connectionOf('telegram:1'), undefined);
  // A call for a chat that isn't connected fails as the call: it rejects, so `.catch` on it still works.
  await assert.rejects(chat.notice({ conversation: 'telegram:1', thread: null }, { kind: 'here' }), /No telegram connection/);
  await assert.rejects(chat.acknowledge({ conversation: 'telegram:1', id: '1' }, true), /No telegram connection/);
  assert.throws(() => chat.owner('telegram:1'), /No telegram connection/);
  assert.throws(() => routeChats([second.adapter.connection, second.adapter.connection]), /Two fake connections/);
});

// --- deliver across chats -------------------------------------------------------------------------------------------

/** `deliver` holding Slack's writer and the second chat's, with one team page the worker read. */
const twoChats = (audiences: SecondChatOptions['audiences'] = {}) => {
  const slack = createFakeChat({ self: 'UBOT', owner: OWNER, audiences: { CTEAM: 'team', CREVIEW: 'team' } });
  const second = createSecondChat({ audiences });
  const knowledge = onePage();
  const deliver = createDeliver(new Map<string, WorkerWriter>([['slack', slack.writer], [FAKE, second.adapter.writer]]), knowledge.loadKnowledge);
  return { slack, second, deliver, heard: knowledge.heard };
};
const reply = { kind: 'reply', markdown: 'The release is on Tuesday.', link: 'https://t3.example/t/1', notify: 'none', runId: 'run-1' } as const;

test('deliver writes with the target\'s own chat, after that chat says who can see it', async () => {
  const { slack, second, deliver, heard } = twoChats({ room: 'team', shared: 'external' });
  const toRoom = await deliver({ target: { conversation: fake('room'), thread: '5' }, requester: fake('7'), hearing: { kind: 'thread', heard } }, { op: 'send', out: reply });
  assert.equal(toRoom.ok, true);
  assert.deepEqual(second.sent.map(({ target }) => target), [{ conversation: fake('room'), thread: '5' }]);
  assert.equal(slack.sent.length, 0, 'nothing reaches Slack');
  // A team page the worker read is withheld where people outside can see, in this chat as in Slack.
  const toShared = await deliver({ target: { conversation: fake('shared'), thread: '5' }, requester: fake('7'), hearing: { kind: 'thread', heard } }, { op: 'send', out: reply });
  assert.deepEqual(toShared, { ok: false, why: 'withheld' });
  assert.equal(second.sent.length, 1);
});

test('deliver keeps raw errors to the owner\'s own conversation, and says unconfirmed when the chat won\'t say who sees it', async () => {
  const { second, deliver } = twoChats({ dm: 'owner', room: 'team', unsure: null });
  const detail = { kind: 'failure-detail', line: 'git: not a repository' } as const;
  assert.equal((await deliver({ target: { conversation: fake('dm'), thread: '1' }, requester: fake('1'), hearing: { kind: 'owner-only' } }, { op: 'send', out: detail })).ok, true);
  assert.deepEqual(await deliver({ target: { conversation: fake('room'), thread: '1' }, requester: fake('1'), hearing: { kind: 'owner-only' } }, { op: 'send', out: detail }), { ok: false, why: 'withheld' });
  const unsure = await deliver({ target: { conversation: fake('unsure'), thread: '1' }, requester: fake('1'), hearing: { kind: 'thread', heard: {} } }, { op: 'send', out: reply });
  assert.equal(unsure.ok, false);
  assert.equal(unsure.ok ? '' : unsure.why, 'unconfirmed');
  assert.equal(second.sent.length, 1);
});

test('a review request from a job in another chat is checked against who sees that job\'s thread now', async () => {
  const { slack, deliver, heard } = twoChats({ shared: 'external', room: 'team' });
  const review = { kind: 'review', markdown: 'Please review', from: 'Sam', link: 'https://chat.example/room/5' } as const;
  const from = (conversation: string) => ({ target: { conversation: fake(conversation), thread: '5' }, requester: fake('7') });
  // The job's thread in the other chat is shared outside: its team page can't go to Slack's review channel either.
  assert.deepEqual(await deliver({ target: { conversation: 'CREVIEW', thread: null }, requester: OWNER, hearing: { kind: 'elsewhere', heard, source: from('shared') } }, { op: 'send', out: review }),
    { ok: false, why: 'withheld' });
  assert.equal(slack.sent.length, 0);
  assert.equal((await deliver({ target: { conversation: 'CREVIEW', thread: null }, requester: OWNER, hearing: { kind: 'elsewhere', heard, source: from('room') } }, { op: 'send', out: review })).ok, true);
  assert.equal(slack.sent.length, 1);
});

test('deliver never writes to a chat it has no writer for', async () => {
  const { slack, second, deliver } = twoChats();
  await assert.rejects(deliver({ target: { conversation: 'telegram:1', thread: null }, requester: 'telegram:1', hearing: { kind: 'thread', heard: {} } }, { op: 'send', out: reply }), /No telegram chat/);
  assert.equal(slack.sent.length + second.sent.length, 0);
});

// --- the daemon serving Slack and a second chat ---------------------------------------------------------------------

test('a DM in the second chat starts a job there: 👀, a T3 thread, the reply in that DM, and nothing on Slack', async (t) => {
  const second = createSecondChat({ audiences: { dm: 'owner' } });
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  assert.ok(h.logs.some((line) => /is up as @serra in Acme, @bot in the fake chat\./.test(line)), 'both chats are up');
  await second.say({ from: '1', text: 'which plans exist?', ts: '100', dm: true });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 1);
  assert.match(h.t3.brief(), /which plans exist\?/);
  assert.deepEqual(second.acknowledged, [{ ref: { conversation: fake('dm'), id: '100' }, on: true }]);
  assert.deepEqual(second.seen, [fake('1')], 'the chat learns from each message handled');
  const job = h.state()[`${fake('dm')}:100`];
  assert.equal(job?.requester, fake('1'));
  assert.equal(job?.visibility, 'owner', 'the owner\'s DM in the second chat is theirs alone');

  h.t3.reply('Starter is the only plan in the seed data.');
  await h.advance(15_000);
  assert.deepEqual(second.sent.map(({ target, out }) => [target, out.kind, out.kind === 'reply' ? out.markdown : '']),
    [[{ conversation: fake('dm'), thread: '100' }, 'reply', 'Starter is the only plan in the seed data.']]);
  assert.deepEqual(second.acknowledged.at(-1), { ref: { conversation: fake('dm'), id: '100' }, on: false }, '👀 cleared with the reply');
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0, 'nothing went to Slack');
  assert.equal(h.slack.callsTo('reactions.add').length, 0);

  // A reply in the job's thread reaches the worker with no mention, as in a Slack thread.
  assert.equal(await second.say({ from: '1', text: 'and the yearly ones?', ts: '101', thread: '100', conversation: 'dm' }), true);
  await h.advance(5_000);
  await h.advance(15_000);
  assert.equal(h.t3.sends.length, 1);
  assert.match(JSON.stringify(h.t3.sends[0]), /and the yearly ones\?/);

  await h.stop();
  assert.equal(second.stopped(), true, 'stopping the daemon stops every chat');
});

test('Slack and the second chat run jobs side by side, each answered in its own chat', async (t) => {
  const second = createSecondChat();
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  await second.say({ from: '1', text: '@bot check the build', conversation: 'room', ts: '200' });
  await h.deliver({
    type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: 'Ev1', event_time: 1,
    authorizations: [{ team_id: 'THOME', user_id: 'UBOT', is_bot: true }],
    event: { type: 'app_mention', user: OWNER, text: '<@UBOT> check the docs', ts: '1700000100.000100', channel: 'C1', event_ts: '1700000100.000100', team: 'THOME' },
  });
  const [chatThread, slackThread] = h.t3.threadIds();
  assert.ok(chatThread && slackThread);
  assert.deepEqual(Object.keys(h.state()).sort(), ['C1:1700000100.000100', `${fake('room')}:200`].sort());
  h.t3.reply('Build is green.', chatThread);
  h.t3.reply('Docs are current.', slackThread);
  await h.advance(15_000);
  assert.deepEqual(second.sent.map(({ out }) => (out.kind === 'reply' ? out.markdown : out.kind)), ['Build is green.']);
  assert.deepEqual(h.slack.callsTo('chat.postMessage').map((args) => [args.channel, args.text]), [['C1', 'Docs are current.']]);
});

test('only the people the owner added may ask, by their ID in that chat: the Slack owner\'s number elsewhere is a stranger', async (t) => {
  const second = createSecondChat();
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  await second.say({ from: '9', text: '@bot delete the staging database', conversation: 'room', ts: '300' });
  await second.say({ from: OWNER, text: '@bot drop the users table', conversation: 'room', ts: '301' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 0);
  assert.deepEqual(second.notices.map(({ notice }) => notice.kind), ['refused', 'refused']);
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0);
  // Someone the owner added, by their ID in this chat, is heard.
  h.config.allowed.add(fake('7'));
  await second.say({ from: '7', text: '@bot rename the pricing page', conversation: 'room', ts: '302' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 1);
});

const approval: T3QuestionRequest = {
  requestId: 'req-1',
  questions: [{ id: 'permission', header: 'Allow', question: 'Run `rm -rf build`?', multiSelect: false, options: [{ label: 'Allow', description: '' }, { label: 'Deny', description: '' }] }],
};

test('a tool approval in the second chat goes to the owner there: the requester\'s press is refused with a hint, the owner\'s answers T3', async (t) => {
  const second = createSecondChat();
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  h.config.allowed.add(fake('7'));
  await second.say({ from: '7', text: '@bot clean the build folder', conversation: 'room', ts: '400' });
  await h.clock.settle();
  h.t3.ask(approval);
  await h.advance(15_000);
  const card = second.sent.find(({ out }) => out.kind === 'question');
  assert.ok(card && card.out.kind === 'question');
  assert.equal(card.out.to, fake('1'), 'the card is for the owner, by their ID in this chat');
  assert.deepEqual(card.target, { conversation: fake('room'), thread: '400' });

  await second.click({ conversation: 'room', from: '7', messageTs: card.id, nonce: card.out.card.nonce, indices: [0] });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 0, 'the requester can\'t allow a tool');
  assert.deepEqual(second.notices.map(({ notice }) => notice), [{ kind: 'question-hint', hint: 'owner-only' }]);
  // The Slack owner's ID pressed in this chat is nobody's: it answers nothing either.
  await second.click({ conversation: 'room', from: OWNER, messageTs: card.id, nonce: card.out.card.nonce, indices: [0] });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 0);

  await second.click({ conversation: 'room', from: '1', messageTs: card.id, nonce: card.out.card.nonce, indices: [0] });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 1, 'the owner allows it');
  assert.ok(second.revised.some(({ ref, out }) => ref.id === card.id && out.kind === 'answered'), 'the card shows the answer');
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0);
});

test('a conversation the second chat says is shared outside gets an outside brief, and its reply goes out only there', async (t) => {
  const second = createSecondChat({ audiences: { shared: 'external' } });
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  await second.say({ from: '1', text: '@bot what changed this week?', conversation: 'shared', ts: '500' });
  await h.clock.settle();
  assert.equal(h.state()[`${fake('shared')}:500`]?.visibility, 'external');
  h.t3.reply('Two fixes shipped.');
  await h.advance(15_000);
  assert.deepEqual(second.sent.map(({ target }) => target.conversation), [fake('shared')]);
});

test('during an update a new request in the second chat is held with that chat\'s mark, and starts after', async (t) => {
  const second = createSecondChat();
  const h = await startTestDaemon(t, { chats: [second.adapter] });
  pauseIntake(h.config.profileDir, 'app-update', { now: h.clock.now() });
  await second.say({ from: '1', text: '@bot rename the pricing page', conversation: 'room', ts: '600' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 0);
  assert.deepEqual(readHeld(h.config.profileDir).map(({ channel }) => channel), [fake('room')]);
  assert.deepEqual(second.held, [{ ref: { conversation: fake('room'), id: '600' }, on: true }]);
  assert.equal(h.slack.callsTo('reactions.add').length, 0, 'no ⏳ on Slack');
  resumeIntake(h.config.profileDir);
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1);
  assert.deepEqual(second.held.at(-1), { ref: { conversation: fake('room'), id: '600' }, on: false });
  assert.equal(readHeld(h.config.profileDir).length, 0);
});

test('a request held in a chat the restarted daemon doesn\'t serve waits on disk, and doesn\'t block Slack\'s', async (t) => {
  const second = createSecondChat();
  const chats = [second.adapter];
  const h = await startTestDaemon(t, { chats });
  pauseIntake(h.config.profileDir, 'app-update', { now: h.clock.now() });
  await second.say({ from: '1', text: '@bot rename the pricing page', conversation: 'room', ts: '700' });
  await h.deliver({
    type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: 'Ev2', event_time: 1,
    authorizations: [{ team_id: 'THOME', user_id: 'UBOT', is_bot: true }],
    event: { type: 'app_mention', user: OWNER, text: '<@UBOT> check the docs', ts: '1700000200.000100', channel: 'C1', event_ts: '1700000200.000100', team: 'THOME' },
  });
  assert.deepEqual(readHeld(h.config.profileDir).map(({ channel }) => channel), [fake('room'), 'C1']);
  // After the update the second chat isn't set up any more: Slack's request starts, the other one waits for its chat.
  chats.length = 0;
  resumeIntake(h.config.profileDir);
  await h.restart();
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1);
  assert.deepEqual(Object.keys(h.state()), ['C1:1700000200.000100']);
  assert.deepEqual(readHeld(h.config.profileDir).map(({ channel }) => channel), [fake('room')]);
});

test('a second chat that can\'t start fails the daemon\'s start, as Slack would', async (t) => {
  const second = createSecondChat();
  second.adapter.connection.listen = async () => { throw new Error('the fake chat refused the token'); };
  await assert.rejects(startTestDaemon(t, { chats: [second.adapter] }), /refused the token/);
});
