/**
 * Telegram as a second chat (SB-5): the adapter on its own (markup, threads, pairing, polling) and the real daemon
 * serving Slack and Telegram at once, with Telegram's Bot API played by an in-memory fake behind `fetch`. Nothing
 * reaches the network or a real bot.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Config } from '../src/config.ts';
import { channelsHandlers } from '../src/handlers/channels.ts';
import { readSecretsFile, scrub } from '../src/secrets.ts';
import { createTelegramApi } from '../src/telegram/api.ts';
import { questionData, SEEN, TELEGRAM } from '../src/telegram/chat.ts';
import { createTelegramConnection } from '../src/telegram/connection.ts';
import { CONTINUE_MS, translateUpdate } from '../src/telegram/incoming.ts';
import { markdownToHtml, messageHtml } from '../src/telegram/markup.ts';
import { pairingCode, takePairingCode } from '../src/telegram/pairing.ts';
import { createThreadStore } from '../src/telegram/threads.ts';
import type { T3QuestionRequest } from '../src/t3-questions.ts';
import { channelsView } from '../src/handlers/channels.ts';
import { slackRow, telegramRow, tokenProblem } from '../app/renderer/screens/settings/channels.logic.ts';
import { engineContext } from './fakes/app-context.ts';
import { startTestDaemon } from './fakes/daemon.ts';
import { OWNER } from './fakes/profile.ts';
import { createFakeTelegram, TELEGRAM_BOT, TELEGRAM_TOKEN } from './fakes/telegram.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../src/status-source.ts';
import { createProfile } from '../src/setup.ts';

/** The owner's Telegram user ID, and someone else's. */
const ME = 4242;
const STRANGER = 9999;
const GROUP = -1001234567890;

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// --- markup -----------------------------------------------------------------------------------------------------------

test('the worker\'s Markdown becomes Telegram HTML, with everything else escaped', () => {
  assert.equal(markdownToHtml('**Done.** See `a<b>` and [the PR](https://github.com/acme/project/pull/1).'),
    '<b>Done.</b> See <code>a&lt;b&gt;</code> and <a href="https://github.com/acme/project/pull/1">the PR</a>.');
  assert.equal(markdownToHtml('# Plan\n- one\n- two'), '<b>Plan</b>\n• one\n• two');
  assert.equal(markdownToHtml('```\nif (a < b) {}\n```'), '<pre>if (a &lt; b) {}</pre>');
  // A link Telegram could open as something else is left as text.
  assert.equal(markdownToHtml('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(markdownToHtml('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
  assert.equal(markdownToHtml('<script>&'), '&lt;script&gt;&amp;');
});

test('a reply too long for one message is cut at the Markdown, never inside a tag, and says the rest is in T3', () => {
  const long = `\`\`\`\n${'x'.repeat(5000)}\n\`\`\``;
  const html = messageHtml(long, '<i>T3 thread</i>');
  assert.ok(html.length <= 4096);
  assert.match(html, /^<pre>x+<\/pre>/);
  assert.match(html, /cut short, the full reply is in T3/);
  assert.ok(html.endsWith('<i>T3 thread</i>'));
});

test('a Telegram token never survives scrubbing, and the API never puts it in an error', async () => {
  assert.equal(scrub(`failed for https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`), 'failed for https://api.telegram.org/bot[hidden]/getMe');
  const api = createTelegramApi(() => TELEGRAM_TOKEN, async () => { throw new TypeError(`fetch failed for https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`); });
  await assert.rejects(api.getMe(), (error: Error) => !error.message.includes(TELEGRAM_TOKEN) && /Couldn't reach Telegram/.test(error.message));
});

// --- threads and inbound ------------------------------------------------------------------------------------------------

const store = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-telegram-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, threads: createThreadStore(dir) };
};
const dm = (id: number, text: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: id, message: { message_id: id, date: 0, from: { id: ME, first_name: 'Alex' }, chat: { id: ME, type: 'private' as const }, text, ...extra } });

test('in a private chat, a new message carries on the last thread for a while; a reply or /new picks the thread', (t) => {
  const { threads } = store(t);
  const context = { botId: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username, store: threads, owns: () => true, now: 1_000_000 };
  const first = translateUpdate(dm(10, 'check the build'), context);
  assert.equal(first?.kind, 'message');
  assert.equal(first?.kind === 'message' && first.msg.threadTs, '10', 'a first message starts its own thread');
  assert.equal(first?.kind === 'message' && first.msg.channel, `${TELEGRAM}:${ME}`);
  assert.equal(first?.kind === 'message' && first.msg.user, `${TELEGRAM}:${ME}`);
  threads.add(String(ME), '10', { id: '10', from: String(ME), text: 'check the build' }, 1_000_000);
  threads.add(String(ME), '10', { id: '11', from: 'self', text: 'Build is green.' }, 1_000_000);

  const next = translateUpdate(dm(12, 'and the docs?'), { ...context, now: 1_000_000 + 60_000 });
  assert.equal(next?.kind === 'message' && next.msg.threadTs, '10', 'soon after, it carries on');
  const later = translateUpdate(dm(13, 'new topic'), { ...context, now: 1_000_000 + CONTINUE_MS + 1 });
  assert.equal(later?.kind === 'message' && later.msg.threadTs, '13', 'after a while, a new thread');
  const fresh = translateUpdate(dm(14, '/new rename the pricing page'), context);
  assert.equal(fresh?.kind === 'message' && fresh.msg.threadTs, '14');
  assert.equal(fresh?.kind === 'message' && fresh.msg.text, 'rename the pricing page');
  const replied = translateUpdate(dm(15, 'why?', { reply_to_message: { message_id: 11, date: 0, chat: { id: ME, type: 'private' } } }), { ...context, now: 1_000_000 + CONTINUE_MS * 3 });
  assert.equal(replied?.kind === 'message' && replied.msg.threadTs, '10', 'a reply goes to the thread of the message it answers');
  assert.deepEqual(threads.lines(String(ME), '10', '12').map((line) => line.text), ['check the build', 'Build is green.']);
  const notOwned = translateUpdate(dm(16, 'hello'), { ...context, owns: () => false, now: 1_000_000 });
  assert.equal(notOwned?.kind === 'message' && notOwned.msg.threadTs, '16', 'a thread the bot no longer owns is not carried on');
});

test('in a group, only a mention or a reply in the bot\'s thread is for Serra; /start pairs; a button press is a card answer', (t) => {
  const { threads } = store(t);
  const context = { botId: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username, store: threads, owns: () => true, now: 0 };
  const group = (id: number, text: string, extra: Record<string, unknown> = {}) =>
    ({ update_id: id, message: { message_id: id, date: 0, from: { id: STRANGER, first_name: 'Sam' }, chat: { id: GROUP, type: 'supergroup' as const }, text, ...extra } });
  assert.equal(translateUpdate(group(1, 'lunch?'), context), null);
  const mentioned = translateUpdate(group(2, `@${TELEGRAM_BOT.username} what changed?`), context);
  assert.equal(mentioned?.kind === 'message' && mentioned.msg.direct, true);
  threads.add(String(GROUP), '2', { id: '3', from: 'self', text: 'Two fixes.' }, 0);
  const reply = translateUpdate(group(4, 'which ones?', { reply_to_message: { message_id: 3, date: 0, chat: { id: GROUP, type: 'supergroup' } } }), context);
  assert.equal(reply?.kind === 'message' && reply.msg.threadTs, '2');
  assert.equal(reply?.kind === 'message' && reply.msg.direct, false, 'a reply without a mention reaches the core as chatter in the thread');
  assert.deepEqual(translateUpdate(dm(5, '/start ABCDEFGH'), context), { kind: 'start', chat: String(ME), from: String(ME), code: 'ABCDEFGH' });
  const nonce = 'a'.repeat(32);
  const click = translateUpdate({ update_id: 6, callback_query: { id: 'cb', from: { id: ME }, data: questionData(nonce, 1), message: { message_id: 3, date: 0, chat: { id: GROUP, type: 'supergroup' } } } }, context);
  assert.deepEqual(click, { kind: 'answer', callback: 'cb', interaction: { channel: `${TELEGRAM}:${GROUP}`, messageTs: '3', user: `${TELEGRAM}:${ME}`, nonce, indices: [1] } });
  assert.ok(Buffer.byteLength(questionData(nonce, 19)) <= 64, 'callback data fits Telegram\'s 64 bytes');
});

test('a pairing code works once, and not after it expires', (t) => {
  const { dir } = store(t);
  const code = pairingCode(dir, 0);
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(pairingCode(dir, 1000), code, 'the same code until it is used or expires');
  assert.equal(takePairingCode(dir, 'WRONGONE', 1000), false);
  assert.equal(takePairingCode(dir, code.toLowerCase(), 1000), true);
  assert.equal(takePairingCode(dir, code, 1000), false, 'used once');
  const old = pairingCode(dir, 0);
  assert.equal(takePairingCode(dir, old, 25 * 60 * 60 * 1000), false, 'expired after a day');
});

// --- the connection on its own ----------------------------------------------------------------------------------------

test('the connection reports a drop when Telegram can\'t be reached and comes back on its own; stop ends polling', async (t) => {
  const { dir } = store(t);
  const tg = createFakeTelegram();
  const adapter = createTelegramConnection({ token: () => TELEGRAM_TOKEN, profileDir: dir, ownerId: String(ME), logger: quiet, clock: { now: () => 0 }, fetch: tg.fetch, retryMs: 5 });
  const states: string[] = [];
  adapter.connection.watch((state) => states.push(state));
  assert.equal((await adapter.connection.identify()).describe, `@${TELEGRAM_BOT.username} on Telegram`);
  await adapter.connection.listen({ owns: () => false, message: async () => {}, answer: async () => {} });
  tg.setDown(true);
  // Wake the waiting poll so the next one fails.
  await tg.say({ from: ME, text: 'hello' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(states.includes('disconnected'), `states: ${states.join(', ')}`);
  tg.setDown(false);
  // Back once a poll answers: here, with the next message.
  await tg.say({ from: ME, text: 'are you there?' });
  assert.equal(states.at(-1), 'connected');
  await adapter.connection.stop();
  const polls = tg.polls();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tg.polls(), polls, 'no poll after stop');
  assert.ok(tg.urls.every((url) => url.startsWith('https://api.telegram.org/')), 'only Telegram\'s API is called');
});

// --- the daemon serving Slack and Telegram -----------------------------------------------------------------------------

const telegramProfile = (ownerId?: string) => ({ channels: { telegram: { bot: { id: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username }, ...(ownerId ? { ownerId } : {}) } } });

const withTelegram = async (t: TestContext, { paired = true }: { paired?: boolean } = {}) => {
  const tg = createFakeTelegram();
  const chats = (config: Config) => [createTelegramConnection({
    token: () => TELEGRAM_TOKEN, profileDir: config.profileDir, ...(config.telegram?.ownerId ? { ownerId: config.telegram.ownerId } : {}),
    logger: quiet, clock: { now: () => Date.now() }, fetch: tg.fetch,
  })];
  const h = await startTestDaemon(t, { profile: telegramProfile(paired ? String(ME) : undefined), chats });
  await h.clock.settle();
  return { h, tg };
};

test('the owner pairs from the app\'s link; until then, and for anyone else, the bot does nothing', async (t) => {
  const { h, tg } = await withTelegram(t, { paired: false });
  assert.ok(h.logs.some((line) => /is up as @serra in Acme, @friday_serra_bot on Telegram\./.test(line)), 'both chats are up');
  await tg.say({ from: STRANGER, text: '/start' });
  await tg.say({ from: STRANGER, text: 'delete the staging database' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 0);
  assert.match(tg.sent[0]?.text ?? '', /not connected to anyone yet/);

  const code = pairingCode(h.config.profileDir);
  await tg.say({ from: ME, text: `/start ${code}` });
  await h.clock.settle();
  assert.match(tg.sent.at(-1)?.text ?? '', /You're connected/);
  const profile = JSON.parse(readFileSync(join(h.config.profileDir, 'profile.json'), 'utf8')) as { channels: { telegram: { ownerId: string } } };
  assert.equal(profile.channels.telegram.ownerId, String(ME), 'the owner\'s Telegram ID is saved');
  // A second /start with the same code from someone else changes nothing.
  await tg.say({ from: STRANGER, text: `/start ${code}` });
  await h.clock.settle();
  assert.match(tg.sent.at(-1)?.text ?? '', /only take requests from my owner/);

  await tg.say({ from: ME, text: 'which plans exist?' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 1, 'the owner\'s message starts a job at once, without a restart');
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0);
});

test('a DM on Telegram runs a job there: 👀, the reply in that chat as a reply, follow-ups in the same job, nothing on Slack', async (t) => {
  const { h, tg } = await withTelegram(t);
  const asked = await tg.say({ from: ME, text: 'which plans exist?' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 1);
  assert.match(h.t3.brief(), /which plans exist\?/);
  assert.deepEqual(tg.reactions, [{ chat: String(ME), id: asked, emoji: SEEN }]);
  const job = h.state()[`${TELEGRAM}:${ME}:${asked}`];
  assert.equal(job?.requester, `${TELEGRAM}:${ME}`);
  assert.equal(job?.visibility, 'owner', 'the owner\'s private chat with the bot is theirs alone');

  h.t3.reply('**Starter** is the only plan.');
  await h.advance(15_000);
  const reply = tg.sent.at(-1);
  assert.equal(reply?.chat, String(ME));
  assert.equal(reply?.replyTo, asked, 'the reply answers the request');
  assert.match(reply?.text ?? '', /^<b>Starter<\/b> is the only plan\./);
  assert.match(reply?.text ?? '', /T3 thread/);
  assert.deepEqual(tg.reactions.at(-1), { chat: String(ME), id: asked, emoji: null }, '👀 cleared with the reply');

  // A plain message soon after carries on the same job; so does a reply to the bot's message.
  await tg.say({ from: ME, text: 'and the yearly ones?' });
  await h.advance(5_000);
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1);
  assert.equal(h.t3.sends.length, 1);
  assert.match(JSON.stringify(h.t3.sends[0]), /and the yearly ones\?/);
  assert.equal(h.slack.callsTo('chat.postMessage').length + h.slack.callsTo('reactions.add').length, 0, 'nothing went to Slack');
});

test('Slack and Telegram run jobs side by side, each answered only in its own chat', async (t) => {
  const { h, tg } = await withTelegram(t);
  await tg.say({ from: ME, text: 'check the build' });
  await h.deliver({
    type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: 'Ev1', event_time: 1,
    authorizations: [{ team_id: 'THOME', user_id: 'UBOT', is_bot: true }],
    event: { type: 'app_mention', user: OWNER, text: '<@UBOT> check the docs', ts: '1700000100.000100', channel: 'C1', event_ts: '1700000100.000100', team: 'THOME' },
  });
  const [telegramThread, slackThread] = h.t3.threadIds();
  assert.ok(telegramThread && slackThread);
  h.t3.reply('Build is green.', telegramThread);
  h.t3.reply('Docs are current.', slackThread);
  await h.advance(15_000);
  assert.deepEqual(tg.sent.map((message) => message.text.split('\n')[0]), ['Build is green.']);
  assert.deepEqual(h.slack.callsTo('chat.postMessage').map((args) => [args.channel, args.text]), [['C1', 'Docs are current.']]);
  // The Slack owner's ID means nothing on Telegram, and the reverse.
  await tg.say({ from: 4243, text: 'drop the users table' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 2);
  assert.match(tg.sent.at(-1)?.text ?? '', /only take requests from my owner/);
});

const approval: T3QuestionRequest = {
  requestId: 'req-1',
  questions: [{ id: 'permission', header: 'Allow', question: 'Run `rm -rf build`?', multiSelect: false, options: [{ label: 'Allow', description: '' }, { label: 'Deny', description: '' }] }],
};

test('a tool approval in a group shows buttons; only the owner\'s press answers T3, and the card shows the answer', async (t) => {
  const { h, tg } = await withTelegram(t);
  const asked = await tg.say({ from: ME, chat: GROUP, text: `@${TELEGRAM_BOT.username} clean the build folder` });
  await h.clock.settle();
  assert.equal(h.state()[`${TELEGRAM}:${GROUP}:${asked}`]?.visibility, 'external', 'a group counts as outside');
  h.t3.ask(approval);
  await h.advance(15_000);
  const card = tg.sent.find((message) => message.keyboard);
  assert.ok(card?.keyboard, 'the card has buttons');
  assert.deepEqual(card.keyboard.map((row) => row[0]?.text), ['Allow', 'Deny']);
  assert.equal(card.replyTo, asked);

  await tg.click({ from: STRANGER, message: card, data: card.keyboard[0]?.[0]?.callback_data ?? '' });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 0, 'someone else can\'t allow a tool');
  await tg.click({ from: ME, message: card, data: card.keyboard[0]?.[0]?.callback_data ?? '' });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 1, 'the owner allows it');
  assert.ok(tg.edits.some((edit) => edit.id === card.id && /Answer sent/.test(edit.text)), 'the card shows the answer');
  assert.equal(tg.answered.length, 2, 'every press is answered, so Telegram stops its spinner');
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0);
});

test('a photo sent to the bot reaches the worker as a local file, without the token in the brief', async (t) => {
  const { h, tg } = await withTelegram(t);
  await tg.say({ from: ME, text: 'what is on this screen?', photo: true });
  await h.clock.settle();
  const brief = h.t3.brief();
  assert.match(brief, /photo-\d+\.jpg/);
  assert.match(brief, /local path/);
  assert.ok(!brief.includes(TELEGRAM_TOKEN));
  assert.ok(tg.calls.some((call) => call.method === 'getFile' && /^large-/.test(String(call.body.file_id))), 'the largest size is downloaded');
});

test('stopping the daemon stops Telegram too, and a request held for an update gets 😴 there, not on Slack', async (t) => {
  const { h, tg } = await withTelegram(t);
  const { pauseIntake, resumeIntake } = await import('../src/intake.ts');
  pauseIntake(h.config.profileDir, 'app-update', { now: h.clock.now() });
  const asked = await tg.say({ from: ME, text: 'rename the pricing page' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 0);
  assert.deepEqual(tg.reactions, [{ chat: String(ME), id: asked, emoji: '😴' }]);
  assert.equal(h.slack.callsTo('reactions.add').length, 0);
  resumeIntake(h.config.profileDir);
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1);
  await h.stop();
  const polls = tg.polls();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tg.polls(), polls);
});

// --- Settings › Channels -----------------------------------------------------------------------------------------------

const appContext = (dir: string) => engineContext({
  profileDir: () => dir, profileDirOrNull: () => dir, prefs: memoryPrefs(), status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' }, openExternal: async () => {}, openPath: async () => {},
});

test('connecting Telegram checks the token, keeps it out of the profile and the window, and gives a pairing link; disconnect undoes it', async (t) => {
  const { dir: root } = store(t);
  const dir = join(root, 'profile');
  createProfile(dir, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  const handlers = channelsHandlers(appContext(dir), {
    getMe: async (token) => {
      if (token !== TELEGRAM_TOKEN) throw Object.assign(new Error('Unauthorized'), { data: { error: 'Unauthorized' } });
      return { id: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username, name: 'Friday' };
    },
    // No `security` or `op` here unless a test makes one.
    tools: { security: join(root, 'no-security'), op: join(root, 'no-op'), timeoutMs: 1_000 },
  });
  assert.deepEqual(await handlers.status(), { telegram: { state: 'off' } });
  await assert.rejects(async () => handlers.connectTelegram('not a token'), (error: Error) => /isn't a real Telegram bot token/.test(error.message));
  const wrong = '2222222:fixturevalue-telegram-1111111111111';
  await assert.rejects(async () => handlers.connectTelegram(wrong), (error: Error) => /didn’t accept that token/.test(error.message) && !error.message.includes(wrong));
  // No Keychain here (a fake path): the error says so, without the value, and nothing is connected.
  await assert.rejects(async () => handlers.connectTelegram(TELEGRAM_TOKEN), (error: Error) => !error.message.includes(TELEGRAM_TOKEN));
  assert.deepEqual(await handlers.status(), { telegram: { state: 'off' } });

  // A 1Password reference: Serra points at it and reads it once to ask Telegram.
  const opBin = join(root, 'op');
  const { writeFileSync, chmodSync } = await import('node:fs');
  writeFileSync(opBin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(TELEGRAM_TOKEN)});\n`);
  chmodSync(opBin, 0o755);
  const viaOp = channelsHandlers(appContext(dir), {
    getMe: async () => ({ id: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username, name: 'Friday' }),
    tools: { security: join(root, 'no-security'), op: opBin, timeoutMs: 5_000 },
  });
  const view = await viaOp.connectTelegram('op://Private/Telegram bot/token');
  assert.equal(view.telegram.state, 'pairing');
  assert.match(view.telegram.state === 'pairing' ? view.telegram.link : '', /^https:\/\/t\.me\/friday_serra_bot\?start=[A-Z2-9]{8}$/);
  const profileText = readFileSync(join(dir, 'profile.json'), 'utf8');
  assert.ok(!profileText.includes(TELEGRAM_TOKEN) && !JSON.stringify(view).includes(TELEGRAM_TOKEN), 'the token is in neither the profile nor the answer');
  assert.deepEqual(readSecretsFile(dir).sources.TELEGRAM_BOT_TOKEN, { kind: '1password', reference: 'op://Private/Telegram bot/token' });
  assert.ok(readSecretsFile(dir).checks.TELEGRAM_BOT_TOKEN?.verifiedAt, 'recorded as checked');
  assert.deepEqual(channelsView(dir), view, 'the same link until it is used');

  assert.deepEqual(await viaOp.disconnectTelegram(), { telegram: { state: 'off' } });
  assert.equal(readSecretsFile(dir).sources.TELEGRAM_BOT_TOKEN, undefined);
  assert.ok(!readFileSync(join(dir, 'profile.json'), 'utf8').includes('telegram'));
});

test('the Channels rows say one thing each, from the profile and the running bot', () => {
  const up = { state: 'up', pid: 1, startedAt: '', slackConnected: true, counts: { needsYou: 0, running: 0 } } as const;
  assert.deepEqual(slackRow(up), { tone: 'up', label: 'Connected' });
  assert.deepEqual(slackRow({ state: 'stopped' }), { tone: 'neutral', label: 'Bot stopped' });
  assert.deepEqual(telegramRow({ state: 'off' }, up), { tone: 'neutral', label: 'Not connected' });
  assert.deepEqual(telegramRow({ state: 'pairing', username: 'b', link: '' }, up), { tone: 'warn', label: 'Waiting for you' });
  assert.deepEqual(telegramRow({ state: 'paired', username: 'b' }, up), { tone: 'warn', label: 'Restart to start' });
  assert.deepEqual(telegramRow({ state: 'paired', username: 'b' }, { ...up, chats: [{ kind: 'telegram', connected: true }] }), { tone: 'up', label: 'Connected' });
  assert.deepEqual(telegramRow({ state: 'paired', username: 'b' }, { ...up, chats: [{ kind: 'telegram', connected: false }] }), { tone: 'down', label: 'Not reachable' });
  assert.equal(tokenProblem(TELEGRAM_TOKEN), null);
  assert.equal(tokenProblem('op://Private/Telegram bot/token'), null);
  assert.match(tokenProblem('xoxb-nope') ?? '', /doesn’t look like a bot token/);
});

test('a Telegram job shows as Telegram in Jobs, with no Slack link', async () => {
  const { channelTag } = await import('../app/renderer/screens/jobs.logic.ts');
  const { slackThreadLink } = await import('../src/jobs.ts');
  assert.equal(channelTag({ channel: `${TELEGRAM}:${ME}` } as Parameters<typeof channelTag>[0]), 'Telegram');
  assert.equal(slackThreadLink('https://acme.slack.com', `${TELEGRAM}:${ME}`, '105'), undefined);
});

test('a Telegram token that is refused at start leaves Telegram down and retrying, and Slack starts and answers anyway', async (t) => {
  const tg = createFakeTelegram({ token: '3333333:fixturevalue-telegram-2222222222222' });
  const warnings: string[] = [];
  const chats = (config: Config) => [createTelegramConnection({
    token: () => TELEGRAM_TOKEN, profileDir: config.profileDir, bot: { id: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username },
    logger: { ...quiet, warn: (line: string) => warnings.push(line) }, clock: { now: () => Date.now() }, fetch: tg.fetch, retryMs: 5,
  })];
  const h = await startTestDaemon(t, { profile: telegramProfile(String(ME)), chats });
  assert.ok(warnings.some((line) => /Telegram isn't reachable yet/.test(line)));
  assert.ok(warnings.every((line) => !line.includes(TELEGRAM_TOKEN)), 'no warning carries the token');
  await h.deliver({
    type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: 'Ev9', event_time: 1,
    authorizations: [{ team_id: 'THOME', user_id: 'UBOT', is_bot: true }],
    event: { type: 'app_mention', user: OWNER, text: '<@UBOT> check the docs', ts: '1700000300.000100', channel: 'C1', event_ts: '1700000300.000100', team: 'THOME' },
  });
  assert.equal(h.t3.started.length, 1, 'Slack works');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(warnings.some((line) => /refused the bot token/.test(line)), 'the poll says the token is refused');
});
