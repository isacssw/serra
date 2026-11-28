/**
 * Discord as a chat beside Slack and Telegram (SB-6): the adapter on its own (markup, routing, pairing, the Gateway's
 * ups and downs) and the real daemon serving Slack and Discord at once. Discord's REST API is played by an in-memory
 * fake behind `@discordjs/rest`'s `makeRequest`, its Gateway by a fake that hands over events. Nothing reaches the
 * network or a real bot.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GatewayIntentBits } from '@discordjs/core/http-only';
import type { RESTOptions } from '@discordjs/rest';
import type { Config } from '../src/config.ts';
import { createThreadStore } from '../src/chat/threads.ts';
import { chatPairingCode } from '../src/chat/pairing.ts';
import { createDiscordApi, createDiscordRest } from '../src/discord/api.ts';
import { DISCORD, questionData, SEEN } from '../src/discord/chat.ts';
import { createDiscordConnection } from '../src/discord/connection.ts';
import { isDiscordCdn, receiveDiscordFiles } from '../src/discord/files.ts';
import { INTENTS } from '../src/discord/gateway.ts';
import { CONTINUE_MS, threadName, translateInteraction, translateMessage } from '../src/discord/incoming.ts';
import { MESSAGE_LIMIT, messageText } from '../src/discord/markup.ts';
import { channelsHandlers, channelsView, DISCORD_PERMISSIONS, discordInvite } from '../src/handlers/channels.ts';
import { readSecretsFile, scrub } from '../src/secrets.ts';
import { createProfile } from '../src/setup.ts';
import { stoppedStatusSource } from '../src/status-source.ts';
import type { T3QuestionRequest } from '../src/t3-questions.ts';
import { createTelegramConnection } from '../src/telegram/connection.ts';
import { discordRow, discordTokenProblem, spacedCode } from '../app/renderer/screens/settings/channels.logic.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { engineContext } from './fakes/app-context.ts';
import { startTestDaemon } from './fakes/daemon.ts';
import { createFakeDiscord, DISCORD_BOT, DISCORD_TOKEN, OTHER_DISCORD_TOKEN } from './fakes/discord.ts';
import { OWNER } from './fakes/profile.ts';
import { createFakeTelegram, TELEGRAM_BOT, TELEGRAM_TOKEN } from './fakes/telegram.ts';

/** The owner's Discord user ID, someone else's, a DM, a server and a channel in it. Made-up snowflakes. */
const ME = '3333333333333333333';
const STRANGER = '4444444444444444444';
const DM = '5555555555555555555';
const STRANGER_DM = '5555555555555555556';
const GUILD = '6666666666666666666';
const CHANNEL = '7777777777777777777';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const tempDir = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-discord-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const apiOver = (discord: ReturnType<typeof createFakeDiscord>, token = DISCORD_TOKEN) =>
  createDiscordApi(createDiscordRest(() => token, { makeRequest: discord.makeRequest as unknown as RESTOptions['makeRequest'] }));

// --- markup ----------------------------------------------------------------------------------------------------------

test('a reply too long for one Discord message is cut at a line, closes a code block, and says the rest is in T3', () => {
  const text = messageText(`\`\`\`\n${'x\n'.repeat(1500)}\`\`\``, '-# T3 thread');
  assert.ok(text.length <= MESSAGE_LIMIT, `${text.length} characters`);
  assert.match(text, /```\n\n\*…cut short, the full reply is in T3\*\n\n-# T3 thread$/);
  assert.equal(messageText('**Done.** See [the PR](https://github.com/acme/project/pull/1).'), '**Done.** See [the PR](https://github.com/acme/project/pull/1).');
  assert.equal(messageText('[x](javascript:alert(1))'), 'x', 'a link Discord could open as something else is left as text');
});

test('a Discord token never survives scrubbing, and the API never puts it in an error', async () => {
  assert.equal(scrub(`failed with ${DISCORD_TOKEN} in it`), 'failed with [hidden] in it');
  const api = createDiscordApi(createDiscordRest(() => DISCORD_TOKEN, {
    makeRequest: async () => { throw new TypeError(`fetch failed, Authorization: Bot ${DISCORD_TOKEN}`); },
  }));
  await assert.rejects(api.me(), (error: Error) => !error.message.includes(DISCORD_TOKEN) && /Couldn't reach Discord/.test(error.message));
  const refused = createFakeDiscord({ token: OTHER_DISCORD_TOKEN });
  await assert.rejects(apiOver(refused).me(), (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes(DISCORD_TOKEN));
});

test('the Gateway asks for messages, DMs and their content, and never for members or presences', () => {
  assert.ok((INTENTS & GatewayIntentBits.MessageContent) !== 0);
  assert.ok((INTENTS & GatewayIntentBits.DirectMessages) !== 0);
  assert.equal(INTENTS & (GatewayIntentBits.GuildMembers | GatewayIntentBits.GuildPresences), 0);
  // View channels, send (and in threads), start public threads, attach files, read history, add reactions: no Administrator.
  assert.equal(BigInt(DISCORD_PERMISSIONS) & 8n, 0n);
  assert.equal(BigInt(DISCORD_PERMISSIONS), (1n << 10n) | (1n << 11n) | (1n << 38n) | (1n << 35n) | (1n << 15n) | (1n << 16n) | (1n << 6n));
  assert.equal(discordInvite('1111111111111111111'), `https://discord.com/oauth2/authorize?client_id=1111111111111111111&scope=bot&permissions=${DISCORD_PERMISSIONS}`);
});

// --- routing: DMs, channels, threads ---------------------------------------------------------------------------------

const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id, channel_id: DM, author: { id: ME, username: 'alex', global_name: 'Alex' }, content: text, type: 0, mentions: [], attachments: [], ...extra,
}) as unknown as Parameters<typeof translateMessage>[0];

const routing = (t: TestContext, overrides: Partial<Parameters<typeof translateMessage>[1]> = {}) => {
  const store = createThreadStore(tempDir(t), DISCORD);
  const started: string[] = [];
  const context: Parameters<typeof translateMessage>[1] = {
    botId: DISCORD_BOT.id, owner: ME, store, owns: () => true, now: 1_000_000,
    channel: async (id) => (id === '8888888888888888888' ? { id, type: 11, parentId: CHANNEL, recipient: null } : { id, type: 0, parentId: null, recipient: null }),
    startThread: async (_channel, id) => { started.push(id); return { id }; },
    ...overrides,
  };
  return { store, started, context };
};

test('in a DM, a message carries on the last job for a while; a reply or "new" picks the job', async (t) => {
  const { store, context } = routing(t);
  const first = await translateMessage(message('100', 'check the build'), context);
  assert.equal(first?.kind === 'message' && first.msg.threadTs, '100');
  assert.equal(first?.kind === 'message' && first.msg.channel, `discord:${DM}`);
  assert.equal(first?.kind === 'message' && first.msg.user, `discord:${ME}`);
  assert.equal(first?.kind === 'message' && first.msg.im, true);
  store.add(DM, '100', { id: '100', from: ME, text: 'check the build' }, 1_000_000);
  store.add(DM, '100', { id: '101', from: 'self', text: 'Build is green.' }, 1_000_000);
  const next = await translateMessage(message('102', 'and the docs?'), { ...context, now: 1_000_000 + 60_000 });
  assert.equal(next?.kind === 'message' && next.msg.threadTs, '100', 'soon after, it carries on');
  const later = await translateMessage(message('103', 'new topic'), { ...context, now: 1_000_000 + CONTINUE_MS + 1 });
  assert.equal(later?.kind === 'message' && later.msg.threadTs, '103', 'after a while, a new job');
  const fresh = await translateMessage(message('104', 'new: rename the pricing page'), context);
  assert.equal(fresh?.kind === 'message' && fresh.msg.threadTs, '104');
  assert.equal(fresh?.kind === 'message' && fresh.msg.text, 'rename the pricing page');
  const replied = await translateMessage(message('105', 'why?', { type: 19, message_reference: { message_id: '101' } }), { ...context, now: 1_000_000 + CONTINUE_MS * 3 });
  assert.equal(replied?.kind === 'message' && replied.msg.threadTs, '100', 'a reply goes to the job of the message it answers');
  assert.equal(await translateMessage(message('106', 'hi', { author: { id: STRANGER, username: 'bot', bot: true } }), context), null, 'bots are never for Serra');
  assert.equal(await translateMessage(message('107', 'hi', { webhook_id: '1' }), context), null, 'nor webhooks');
  assert.equal(await translateMessage(message('108', 'pinned a message', { type: 6 }), context), null, 'nor system messages');
  const unpaired = await translateMessage(message('109', 'abcd2345'), { ...context, owner: null });
  assert.deepEqual(unpaired, { kind: 'unpaired', channel: DM, from: ME, code: 'ABCD2345' });
});

test('in a server, only a mention starts a job: the owner\'s in a new thread, anyone else\'s answered in place', async (t) => {
  const { store, started, context } = routing(t);
  const inServer = (id: string, text: string, extra: Record<string, unknown> = {}) => message(id, text, { channel_id: CHANNEL, guild_id: GUILD, ...extra });
  const me = { id: DISCORD_BOT.id, username: DISCORD_BOT.username };
  assert.equal(await translateMessage(inServer('200', 'lunch?'), context), null);
  const mine = await translateMessage(inServer('201', `<@${DISCORD_BOT.id}> what changed?`, { mentions: [me] }), context);
  assert.deepEqual(started, ['201'], 'a thread is started from the request');
  assert.equal(mine?.kind === 'message' && mine.msg.channel, `discord:${CHANNEL}`);
  assert.equal(mine?.kind === 'message' && mine.msg.threadTs, '201');
  assert.equal(store.homeOf('201'), CHANNEL);
  // A follow-up in that thread needs no mention.
  const followUp = await translateMessage(inServer('202', 'and why?', { channel_id: '201' }), context);
  assert.equal(followUp?.kind === 'message' && followUp.msg.channel, `discord:${CHANNEL}`);
  assert.equal(followUp?.kind === 'message' && followUp.msg.direct, false);
  // Someone else's mention: answered in place, no thread opened for a refusal.
  const theirs = await translateMessage(inServer('203', `<@${DISCORD_BOT.id}> drop the table`, { mentions: [me], author: { id: STRANGER, username: 'sam' } }), context);
  assert.deepEqual(started, ['201']);
  assert.equal(theirs?.kind === 'message' && theirs.msg.threadTs, '203');
  assert.equal(store.homeOf('203'), undefined);
  // A mention inside a thread someone else started: the job lives in that thread.
  const inThread = await translateMessage(inServer('204', `<@${DISCORD_BOT.id}> summarise`, { mentions: [me], channel_id: '8888888888888888888' }), context);
  assert.equal(inThread?.kind === 'message' && inThread.msg.channel, `discord:${CHANNEL}`);
  assert.equal(inThread?.kind === 'message' && inThread.msg.threadTs, '8888888888888888888');
  // No permission to start threads: the owner is answered in place.
  const { started: none, context: noThreads } = routing(t, { startThread: async () => { throw new Error('Missing Permissions'); } });
  const inPlace = await translateMessage(inServer('205', `<@${DISCORD_BOT.id}> hello`, { mentions: [me] }), noThreads);
  assert.equal(inPlace?.kind === 'message' && inPlace.msg.threadTs, '205');
  assert.deepEqual(none, []);
  assert.equal(threadName(`<@${DISCORD_BOT.id}>  Fix the login page\nmore`), 'Fix the login page');
});

test('a button press is a card answer from whoever pressed it, in the conversation the thread belongs to', (t) => {
  const store = createThreadStore(tempDir(t), DISCORD);
  store.recordHome('201', CHANNEL);
  const nonce = 'a'.repeat(32);
  const click = translateInteraction({
    id: '1', token: 'tok', type: 3, channel: { id: '201' }, member: { user: { id: STRANGER } }, data: { custom_id: questionData(nonce, 1), component_type: 2 }, message: { id: '300' },
  } as unknown as Parameters<typeof translateInteraction>[0], store);
  assert.deepEqual(click, { kind: 'answer', ack: { id: '1', token: 'tok' }, interaction: { channel: `discord:${CHANNEL}`, messageTs: '300', user: `discord:${STRANGER}`, nonce, indices: [1] } });
  assert.ok(questionData(nonce, 9).length <= 100);
});

// --- attachments -----------------------------------------------------------------------------------------------------

test('attachments come only from Discord\'s CDN over https, with no token, up to 20 MB', async (t) => {
  assert.equal(isDiscordCdn('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1'), true);
  assert.equal(isDiscordCdn('http://cdn.discordapp.com/a.png'), false);
  assert.equal(isDiscordCdn('https://cdn.discordapp.com.evil.example/a.png'), false);
  assert.equal(isDiscordCdn('https://user:pw@cdn.discordapp.com/a.png'), false);
  const fetched: { url: string; init?: RequestInit }[] = [];
  const fetchApi = (async (url: string, init?: RequestInit) => {
    fetched.push({ url, ...(init ? { init } : {}) });
    return new Response(url.includes('big') ? 'x'.repeat(100) : 'png bytes', { headers: url.includes('big') ? { 'content-length': String(30 * 1024 * 1024) } : {} });
  }) as typeof fetch;
  const text = await receiveDiscordFiles([
    { id: '1', name: 'screen.png', mimetype: 'image/png', url_private: 'https://cdn.discordapp.com/attachments/1/2/screen.png?ex=1' },
    { id: '2', name: 'evil.png', url_private: 'https://example.com/evil.png' },
    { id: '3', name: 'big.bin', url_private: 'https://cdn.discordapp.com/attachments/1/2/big.bin' },
  ], tempDir(t), 5, fetchApi);
  assert.match(text, /"screen\.png" \("image\/png", 9 bytes\): local path/);
  assert.match(text, /"evil\.png": unavailable — no file to download/);
  assert.match(text, /"big\.bin": unavailable — file exceeds the 20 MB download limit/);
  assert.deepEqual(fetched.map((call) => new URL(call.url).hostname), ['cdn.discordapp.com', 'cdn.discordapp.com']);
  for (const call of fetched) {
    assert.equal(new Headers(call.init?.headers).get('authorization'), null, 'the CDN gets no token');
    assert.equal(call.init?.redirect, 'error', 'and no redirect elsewhere');
  }
  assert.ok(!text.includes('https://'), 'the worker gets paths, not links');
});

// --- the connection on its own ---------------------------------------------------------------------------------------

const connectionOver = (t: TestContext, discord: ReturnType<typeof createFakeDiscord>, warnings: string[] = []) => createDiscordConnection({
  token: () => DISCORD_TOKEN, profileDir: tempDir(t), ownerId: ME, logger: { ...quiet, warn: (line: string) => warnings.push(line) },
  clock: { now: () => Date.now() }, api: apiOver(discord), gateway: discord.gateway, retryMs: 5,
});

test('the connection retries a first connection that fails, reports drops and returns, and stop closes the Gateway', async (t) => {
  const discord = createFakeDiscord();
  const adapter = connectionOver(t, discord);
  const states: string[] = [];
  adapter.connection.watch((state) => states.push(state));
  assert.deepEqual(await adapter.connection.identify(), { self: `discord:${DISCORD_BOT.id}`, lock: `discord-${DISCORD_BOT.id}`, describe: `${DISCORD_BOT.username} on Discord` });
  discord.refuseNextConnects(2);
  await adapter.connection.listen({ owns: () => false, message: async () => {}, answer: async () => {} });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(discord.connects(), 3, 'tried again until it connected');
  assert.deepEqual(states, ['disconnected', 'connected']);
  await discord.drop(1006);
  assert.deepEqual(states.slice(-2), ['disconnected', 'connected'], 'a drop is reported, and the resume');
  await adapter.connection.stop();
  assert.equal(states.at(-1), 'disconnected');
  assert.ok(discord.destroyed() >= 1);
  assert.ok(discord.requests.every((request) => request.url.startsWith('https://discord.com/api/v10/')), 'only Discord\'s API is called');
});

test('a refused token or Message Content left off stops Discord for good, with the fix, and nothing reconnects', async (t) => {
  for (const [code, fix] of [[4004, /Connect Discord again in Settings › Channels/], [4014, /Turn it on under Bot in the Discord Developer Portal/]] as const) {
    const discord = createFakeDiscord();
    const warnings: string[] = [];
    const adapter = connectionOver(t, discord, warnings);
    const states: string[] = [];
    adapter.connection.watch((state) => states.push(state));
    await adapter.connection.identify();
    await adapter.connection.listen({ owns: () => false, message: async () => {}, answer: async () => {} });
    await discord.idle();
    await discord.drop(code, { stayDown: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(discord.connects(), 1, 'no reconnect');
    assert.equal(states.at(-1), 'disconnected');
    assert.ok(warnings.some((line) => fix.test(line)), warnings.join('\n'));
    assert.ok(warnings.every((line) => !line.includes(DISCORD_TOKEN)));
    await adapter.connection.stop();
  }
});

test('a token Discord refuses before the Gateway opens is not retried', async (t) => {
  const warnings: string[] = [];
  let connects = 0;
  const { DiscordAPIError } = await import('@discordjs/rest');
  const adapter = createDiscordConnection({
    token: () => DISCORD_TOKEN, profileDir: tempDir(t), ownerId: ME, logger: { ...quiet, warn: (line: string) => warnings.push(line) },
    clock: { now: () => Date.now() }, api: apiOver(createFakeDiscord()), retryMs: 5,
    gateway: {
      connect: async () => { connects += 1; throw new DiscordAPIError({ code: 0, message: '401: Unauthorized' }, 0, 401, 'GET', 'https://discord.com/api/v10/gateway/bot', {}); },
      destroy: async () => {},
    },
  });
  await adapter.connection.identify();
  await adapter.connection.listen({ owns: () => false, message: async () => {}, answer: async () => {} });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(connects, 1);
  assert.ok(warnings.some((line) => /refused the bot token/.test(line)));
  await adapter.connection.stop();
});

// --- the daemon serving Slack and Discord ----------------------------------------------------------------------------

const discordProfile = (ownerId?: string) => ({ channels: { discord: { bot: { id: DISCORD_BOT.id, username: DISCORD_BOT.username, applicationId: DISCORD_BOT.id }, ...(ownerId ? { ownerId } : {}) } } });

const withDiscord = async (t: TestContext, { paired = true }: { paired?: boolean } = {}) => {
  const discord = createFakeDiscord();
  discord.addChannel(CHANNEL, { type: 0, guild: GUILD });
  discord.addChannel(DM, { type: 1, recipient: ME });
  discord.addChannel(STRANGER_DM, { type: 1, recipient: STRANGER });
  const fetched: string[] = [];
  const chats = (config: Config) => [createDiscordConnection({
    token: () => DISCORD_TOKEN, profileDir: config.profileDir, bot: config.discord?.bot ?? DISCORD_BOT, ...(config.discord?.ownerId ? { ownerId: config.discord.ownerId } : {}),
    logger: quiet, clock: { now: () => Date.now() }, api: apiOver(discord), gateway: discord.gateway,
    fetch: (async (url: string) => { fetched.push(url); return new Response('png bytes'); }) as typeof fetch,
  })];
  const h = await startTestDaemon(t, { profile: discordProfile(paired ? ME : undefined), chats });
  await h.clock.settle();
  return { h, discord, fetched };
};

test('the owner pairs by DMing the bot the app\'s code; until then, and for anyone else, the bot does nothing', async (t) => {
  const { h, discord } = await withDiscord(t, { paired: false });
  assert.ok(h.logs.some((line) => /is up as @serra in Acme, friday-serra on Discord\./.test(line)), h.logs.join('\n'));
  await discord.say({ from: STRANGER, channel: STRANGER_DM, text: 'delete the staging database' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 0);
  assert.match(discord.sent.at(-1)?.content ?? '', /not connected to anyone yet/);

  const code = chatPairingCode(h.config.profileDir, 'discord');
  await discord.say({ from: ME, channel: DM, text: code.toLowerCase() });
  await h.clock.settle();
  assert.match(discord.sent.at(-1)?.content ?? '', /You're connected/);
  const profile = JSON.parse(readFileSync(join(h.config.profileDir, 'profile.json'), 'utf8')) as { channels: { discord: { ownerId: string } } };
  assert.equal(profile.channels.discord.ownerId, ME, 'the owner\'s Discord ID is saved');
  // The same code from someone else does nothing: it was used.
  await discord.say({ from: STRANGER, channel: STRANGER_DM, text: code });
  await h.clock.settle();
  assert.match(discord.sent.at(-1)?.content ?? '', /only take requests from my owner/);
  assert.equal(h.t3.started.length, 0);

  await discord.say({ from: ME, channel: DM, text: 'which plans exist?' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 1, 'the owner\'s message starts a job at once, without a restart');
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0);
});

test('a DM on Discord runs a job there: 👀, the reply as a reply, follow-ups in the same job, nothing on Slack', async (t) => {
  const { h, discord } = await withDiscord(t);
  const asked = await discord.say({ from: ME, channel: DM, text: 'which plans exist?' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 1);
  assert.match(h.t3.brief(), /which plans exist\?/);
  assert.deepEqual(discord.reactions, [{ channel: DM, id: asked, emoji: SEEN, on: true }]);
  const job = h.state()[`${DISCORD}:${DM}:${asked}`];
  assert.equal(job?.requester, `${DISCORD}:${ME}`);
  assert.equal(job?.visibility, 'owner', 'the owner\'s DM with the bot is theirs alone');

  h.t3.reply('**Starter** is the only plan. @everyone look');
  await h.advance(15_000);
  await discord.idle();
  const reply = discord.sent.at(-1);
  assert.equal(reply?.channel, DM);
  assert.equal(reply?.replyTo, asked, 'the reply answers the request');
  assert.match(reply?.content ?? '', /^\*\*Starter\*\* is the only plan\./);
  assert.match(reply?.content ?? '', /T3 thread/);
  assert.deepEqual(reply?.mentions, { parse: [] }, 'nobody is pinged, @everyone included');
  assert.deepEqual(discord.reactions.at(-1), { channel: DM, id: asked, emoji: SEEN, on: false }, '👀 cleared with the reply');

  await discord.say({ from: ME, channel: DM, text: 'and the yearly ones?' });
  await h.advance(5_000);
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1);
  assert.equal(h.t3.sends.length, 1);
  assert.match(JSON.stringify(h.t3.sends[0]), /and the yearly ones\?/);
  assert.equal(h.slack.callsTo('chat.postMessage').length + h.slack.callsTo('reactions.add').length, 0, 'nothing went to Slack');
});

test('a mention in a server channel works in a new thread: replies there, follow-ups without a mention, counted as outside', async (t) => {
  const { h, discord } = await withDiscord(t);
  const asked = await discord.say({ from: ME, channel: CHANNEL, guild: GUILD, mention: true, text: 'Fix the flaky login test' });
  await h.clock.settle();
  assert.deepEqual(discord.threads, [{ channel: CHANNEL, message: asked, name: 'Fix the flaky login test' }]);
  assert.equal(h.t3.started.length, 1);
  assert.match(h.t3.brief(), /Fix the flaky login test/);
  assert.doesNotMatch(h.t3.brief(), new RegExp(DISCORD_BOT.id), 'the bot\'s own mention is taken out');
  assert.deepEqual(discord.reactions[0], { channel: CHANNEL, id: asked, emoji: SEEN, on: true }, '👀 on the request, in the channel');
  const job = h.state()[`${DISCORD}:${CHANNEL}:${asked}`];
  assert.equal(job?.visibility, 'external', 'a server counts as outside until marked otherwise');

  h.t3.reply('Fixed the race.');
  await h.advance(15_000);
  await discord.idle();
  const reply = discord.sent.at(-1);
  assert.equal(reply?.channel, asked, 'the reply goes in the thread');
  assert.equal(reply?.replyTo, undefined);

  await discord.say({ from: ME, channel: asked, guild: GUILD, text: 'also check signup' });
  await h.advance(5_000);
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1, 'a follow-up in the thread goes to the same job');
  assert.match(JSON.stringify(h.t3.sends), /also check signup/);
  // Chatter in a channel without a mention never reaches the core.
  await discord.say({ from: ME, channel: CHANNEL, guild: GUILD, text: 'lunch?' });
  await h.clock.settle();
  assert.equal(h.t3.started.length, 1);
});

const approval: T3QuestionRequest = {
  requestId: 'req-1',
  questions: [{ id: 'permission', header: 'Allow', question: 'Run `rm -rf build`?', multiSelect: false, options: [{ label: 'Allow', description: '' }, { label: 'Deny', description: '' }] }],
};

test('a tool approval in a thread shows buttons; only the owner\'s press answers T3, and every press is answered', async (t) => {
  const { h, discord } = await withDiscord(t);
  const asked = await discord.say({ from: ME, channel: CHANNEL, guild: GUILD, mention: true, text: 'clean the build folder' });
  await h.clock.settle();
  h.t3.ask(approval);
  await h.advance(15_000);
  await discord.idle();
  const card = discord.sent.find((sent) => sent.components);
  assert.ok(card?.components, 'the card has buttons');
  assert.equal(card.channel, asked);
  assert.deepEqual(card.components.flatMap((row) => row.components.map((button) => button.label)), ['Allow', 'Deny']);
  const allow = card.components[0]?.components[0]?.custom_id ?? '';

  await discord.click({ from: STRANGER, message: card, customId: allow, guild: GUILD });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 0, 'someone else can\'t allow a tool');
  await discord.click({ from: ME, message: card, customId: allow, guild: GUILD });
  await h.clock.settle();
  await discord.idle();
  assert.equal(h.t3.answered.length, 1, 'the owner allows it');
  assert.ok(discord.edits.some((edit) => edit.id === card.id && /Answer sent/.test(edit.content) && JSON.stringify(edit.components) === '[]'), 'the card shows the answer, without buttons');
  assert.equal(discord.acks.length, 2, 'every press is answered, so Discord doesn\'t show it as failed');
  assert.ok(discord.requests.filter((request) => request.url.includes('/interactions/')).every((request) => request.auth === null), 'a press is answered without the bot token');
  assert.equal(h.slack.callsTo('chat.postMessage').length, 0);
});

test('a file sent to the bot reaches the worker as a local file, fetched from the CDN without the token', async (t) => {
  const { h, fetched } = await withDiscord(t).then(async (made) => {
    await made.discord.say({ from: ME, channel: DM, text: 'what is on this screen?', attachment: { url: 'https://cdn.discordapp.com/attachments/1/2/screen.png?ex=1', filename: 'screen.png' } });
    await made.h.clock.settle();
    return made;
  });
  const brief = h.t3.brief();
  assert.match(brief, /screen\.png/);
  assert.match(brief, /local path/);
  assert.ok(!brief.includes(DISCORD_TOKEN) && !brief.includes('cdn.discordapp.com'));
  assert.deepEqual(fetched, ['https://cdn.discordapp.com/attachments/1/2/screen.png?ex=1']);
});

test('a request held for an update gets ⏳ on Discord, not on Slack, and stopping the daemon closes the Gateway', async (t) => {
  const { h, discord } = await withDiscord(t);
  const { pauseIntake, resumeIntake } = await import('../src/intake.ts');
  pauseIntake(h.config.profileDir, 'app-update', { now: h.clock.now() });
  const asked = await discord.say({ from: ME, channel: DM, text: 'rename the pricing page' });
  await h.clock.settle();
  await discord.idle();
  assert.equal(h.t3.started.length, 0);
  assert.deepEqual(discord.reactions, [{ channel: DM, id: asked, emoji: '⏳', on: true }]);
  assert.equal(h.slack.callsTo('reactions.add').length, 0);
  resumeIntake(h.config.profileDir);
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1);
  await h.stop();
  assert.equal(discord.connected(), false);
});

test('Slack, Telegram and Discord run jobs side by side, each answered only in its own chat, each owner only there', async (t) => {
  const discord = createFakeDiscord();
  discord.addChannel(DM, { type: 1, recipient: ME });
  const tg = createFakeTelegram();
  const chats = (config: Config) => [
    createTelegramConnection({ token: () => TELEGRAM_TOKEN, profileDir: config.profileDir, ownerId: '4242', logger: quiet, clock: { now: () => Date.now() }, fetch: tg.fetch }),
    createDiscordConnection({ token: () => DISCORD_TOKEN, profileDir: config.profileDir, ownerId: ME, logger: quiet, clock: { now: () => Date.now() }, api: apiOver(discord), gateway: discord.gateway }),
  ];
  const h = await startTestDaemon(t, {
    profile: { channels: { telegram: { bot: { id: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username }, ownerId: '4242' }, ...discordProfile(ME).channels } },
    chats,
  });
  await h.clock.settle();
  await discord.say({ from: ME, channel: DM, text: 'check the build' });
  await tg.say({ from: 4242, text: 'check the tests' });
  await h.deliver({
    type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: 'Ev1', event_time: 1,
    authorizations: [{ team_id: 'THOME', user_id: 'UBOT', is_bot: true }],
    event: { type: 'app_mention', user: OWNER, text: '<@UBOT> check the docs', ts: '1700000100.000100', channel: 'C1', event_ts: '1700000100.000100', team: 'THOME' },
  });
  const [discordThread, telegramThread, slackThread] = h.t3.threadIds();
  assert.ok(discordThread && telegramThread && slackThread);
  h.t3.reply('Build is green.', discordThread);
  h.t3.reply('Tests pass.', telegramThread);
  h.t3.reply('Docs are current.', slackThread);
  await h.advance(15_000);
  await discord.idle();
  assert.deepEqual(discord.sent.map((sent) => sent.content.split('\n')[0]), ['Build is green.']);
  assert.deepEqual(tg.sent.map((sent) => sent.text.split('\n')[0]), ['Tests pass.']);
  assert.deepEqual(h.slack.callsTo('chat.postMessage').map((args) => [args.channel, args.text]), [['C1', 'Docs are current.']]);
  // The Telegram owner's number and the Slack owner's ID mean nothing on Discord.
  discord.addChannel(STRANGER_DM, { type: 1, recipient: '4242' });
  await discord.say({ from: '4242', channel: STRANGER_DM, text: 'drop the users table' });
  await h.clock.settle();
  await discord.idle();
  assert.equal(h.t3.started.length, 3);
  assert.match(discord.sent.at(-1)?.content ?? '', /only take requests from my owner/);
});

test('approvals follow the owner across Slack, Telegram and Discord: one answer anywhere, every copy done, a chat that was down catches up', async (t) => {
  const discord = createFakeDiscord();
  discord.addChannel(CHANNEL, { type: 0, guild: GUILD });
  const tg = createFakeTelegram();
  const chats = (config: Config) => [
    createTelegramConnection({ token: () => TELEGRAM_TOKEN, profileDir: config.profileDir, ownerId: '4242', logger: quiet, clock: { now: () => Date.now() }, fetch: tg.fetch, retryMs: 5 }),
    createDiscordConnection({ token: () => DISCORD_TOKEN, profileDir: config.profileDir, ownerId: ME, logger: quiet, clock: { now: () => Date.now() }, api: apiOver(discord), gateway: discord.gateway }),
  ];
  const h = await startTestDaemon(t, {
    profile: { channels: { telegram: { bot: { id: String(TELEGRAM_BOT.id), username: TELEGRAM_BOT.username }, ownerId: '4242' }, ...discordProfile(ME).channels } },
    chats,
  });
  await h.clock.settle();
  const slackEvent = (event: Record<string, unknown>) => ({
    type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: `Ev${String(event.ts)}`, event_time: 1,
    authorizations: [{ team_id: 'THOME', user_id: 'UBOT', is_bot: true }], event: { team: 'THOME', event_ts: event.ts, ...event },
  });
  // The owner has written to the Slack bot in a DM, so Slack knows which DM is theirs.
  await h.deliver(slackEvent({ type: 'message', channel_type: 'im', user: OWNER, text: 'hi', ts: '1700000050.000100', channel: 'D0OWNER1' }));
  await h.clock.settle();

  // A job in a Discord server channel asks to run a tool.
  const asked = await discord.say({ from: ME, channel: CHANNEL, guild: GUILD, mention: true, text: 'clean the build folder' });
  await h.clock.settle();
  const discordThread = h.t3.threadIds().at(-1);
  h.t3.ask(approval, discordThread);
  await h.advance(15_000);
  await discord.idle();
  const card = discord.sent.find((sent) => sent.components && sent.channel === asked);
  assert.ok(card, 'the card is in the job\'s thread');
  assert.deepEqual(discord.dmsOpened, [], 'no copy in the job\'s own chat');
  const tgCopy = tg.sent.find((sent) => sent.keyboard);
  assert.ok(tgCopy?.keyboard, 'a copy with buttons in the owner\'s Telegram chat');
  assert.equal(tgCopy.chat, '4242');
  assert.match(tgCopy.text, /From Discord · <a href="https:\/\/discord\.com\/channels\/[^"]+">Open thread<\/a>/);
  assert.doesNotMatch(tgCopy.text, /Tap an answer|reply/i, 'a copy is answered by its buttons only');
  const slackCopy = h.slack.callsTo('chat.postMessage').find((args) => args.channel === 'D0OWNER1' && String(JSON.stringify(args.blocks)).includes('serra_question_choice'));
  assert.ok(slackCopy, 'and one in the owner\'s Slack DM');

  // Someone else pressing a copy (a forged press: only the owner sees it) answers nothing; the owner's press does.
  await tg.click({ from: 9999, message: tgCopy, data: tgCopy.keyboard[0]?.[0]?.callback_data ?? '' });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 0);
  await tg.click({ from: 4242, message: tgCopy, data: tgCopy.keyboard[0]?.[0]?.callback_data ?? '' });
  await h.clock.settle();
  await discord.idle();
  assert.deepEqual(h.t3.answered.map(({ answers }) => answers), [{ permission: 'Allow' }], 'one decision');
  assert.ok(discord.edits.some((edit) => edit.id === card.id && /^Answered in Telegram\./.test(edit.content) && JSON.stringify(edit.components) === '[]'), 'the Discord card says where it was answered, without buttons');
  assert.ok(tg.edits.some((edit) => edit.id === tgCopy.id && /Answer sent/.test(edit.text)), 'the Telegram copy shows the answer');
  assert.ok(h.slack.callsTo('chat.update').some((args) => args.channel === 'D0OWNER1' && /Answered in Telegram/.test(String(args.text))), 'the Slack copy too');
  // The Discord card pressed later answers nothing more.
  await discord.click({ from: ME, message: card, customId: card.components?.[0]?.components[1]?.custom_id ?? '', guild: GUILD });
  await h.clock.settle();
  assert.equal(h.t3.answered.length, 1);

  // A job in Slack: the copy goes to the owner's Discord DM, opened for it. Telegram is down when it's answered there.
  await h.deliver(slackEvent({ type: 'app_mention', user: OWNER, text: '<@UBOT> tidy the docs', ts: '1700000100.000100', channel: 'C1' }));
  await h.clock.settle();
  h.t3.ask({ ...approval, requestId: 'req-2' }, h.t3.threadIds().at(-1));
  await h.advance(15_000);
  await discord.idle();
  assert.deepEqual(discord.dmsOpened, [ME]);
  const discordCopy = discord.sent.findLast((sent) => sent.components);
  assert.ok(discordCopy && discordCopy.channel !== CHANNEL && discordCopy.channel !== asked, 'in the owner\'s DM');
  assert.match(discordCopy.content, /-# From Slack/);
  const tgCopy2 = tg.sent.findLast((sent) => sent.keyboard);
  assert.ok(tgCopy2 && tgCopy2.id !== tgCopy.id);
  tg.setUnreachable(true);
  await discord.click({ from: ME, message: discordCopy, customId: discordCopy.components?.[0]?.components[1]?.custom_id ?? '' });
  await h.clock.settle();
  await discord.idle();
  assert.deepEqual(h.t3.answered.map(({ requestId, answers }) => [requestId, answers.permission]), [['req-1', 'Allow'], ['req-2', 'Deny']]);
  assert.ok(h.slack.callsTo('chat.update').some((args) => args.channel === 'C1' && /Answered in Discord/.test(String(args.text))));
  assert.ok(!tg.edits.some((edit) => edit.id === tgCopy2.id), 'Telegram is down');
  tg.setUnreachable(false);
  await h.advance(2 * 60_000);
  assert.ok(tg.edits.some((edit) => edit.id === tgCopy2.id && /Answer sent/.test(edit.text)), 'back up, the Telegram copy shows it was answered');
});

test('a Discord token that can\'t be checked at start leaves Discord down, and Slack starts and answers anyway', async (t) => {
  const discord = createFakeDiscord({ token: OTHER_DISCORD_TOKEN });
  const warnings: string[] = [];
  const chats = (config: Config) => [createDiscordConnection({
    token: () => DISCORD_TOKEN, profileDir: config.profileDir, bot: DISCORD_BOT, ownerId: ME,
    logger: { ...quiet, warn: (line: string) => warnings.push(line) }, clock: { now: () => Date.now() }, api: apiOver(discord),
    gateway: { connect: async () => { throw Object.assign(new Error('refused'), {}); }, destroy: async () => {} }, retryMs: 5,
  })];
  const h = await startTestDaemon(t, { profile: discordProfile(ME), chats });
  assert.ok(warnings.some((line) => /Discord isn't reachable yet/.test(line)), warnings.join('\n'));
  assert.ok(warnings.every((line) => !line.includes(DISCORD_TOKEN)), 'no warning carries the token');
  await h.deliver({
    type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: 'Ev9', event_time: 1,
    authorizations: [{ team_id: 'THOME', user_id: 'UBOT', is_bot: true }],
    event: { type: 'app_mention', user: OWNER, text: '<@UBOT> check the docs', ts: '1700000300.000100', channel: 'C1', event_ts: '1700000300.000100', team: 'THOME' },
  });
  assert.equal(h.t3.started.length, 1, 'Slack works');
});

// --- Settings › Channels ---------------------------------------------------------------------------------------------

const appContext = (dir: string) => engineContext({
  profileDir: () => dir, profileDirOrNull: () => dir, prefs: memoryPrefs(), status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' }, openExternal: async () => {}, openPath: async () => {},
});

test('connecting Discord checks the token and Message Content, keeps the token out of the profile and the window, and gives an invite and a code', async (t) => {
  const root = tempDir(t);
  const dir = join(root, 'profile');
  createProfile(dir, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  let messageContent = false;
  const bot = () => ({ id: DISCORD_BOT.id, username: DISCORD_BOT.username, applicationId: DISCORD_BOT.id, messageContent, publicBot: false });
  const { writeFileSync, chmodSync } = await import('node:fs');
  const opBin = join(root, 'op');
  writeFileSync(opBin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(DISCORD_TOKEN)});\n`);
  chmodSync(opBin, 0o755);
  const handlers = channelsHandlers(appContext(dir), {
    whoAmI: async (token) => {
      if (token !== DISCORD_TOKEN) throw Object.assign(new Error('401: Unauthorized'), { data: { error: '401: Unauthorized' } });
      return bot();
    },
    tools: { security: join(root, 'no-security'), op: opBin, timeoutMs: 5_000 },
  });
  assert.deepEqual((await handlers.status()).discord, { state: 'off' });
  await assert.rejects(async () => handlers.connectDiscord('xoxb-not-discord'), (error: Error) => /isn't a real Discord bot token/.test(error.message));
  const wrong = OTHER_DISCORD_TOKEN;
  await assert.rejects(async () => handlers.connectDiscord(wrong), (error: Error) => /didn’t accept that token/.test(error.message) && !error.message.includes(wrong));
  await assert.rejects(async () => handlers.connectDiscord('op://Private/Discord bot/token'), (error: Error) => /Turn on Message Content Intent/.test(error.message));
  assert.equal(readSecretsFile(dir).sources.DISCORD_BOT_TOKEN?.kind ?? 'env', 'env', 'a refused token points at nothing');

  messageContent = true;
  const view = await handlers.connectDiscord('op://Private/Discord bot/token');
  assert.equal(view.discord.state, 'pairing');
  assert.equal(view.telegram.state, 'off', 'Telegram is untouched');
  assert.equal(view.discord.state === 'pairing' && view.discord.invite, discordInvite(DISCORD_BOT.id));
  assert.match(view.discord.state === 'pairing' ? view.discord.code : '', /^[A-Z2-9]{8}$/);
  const profileText = readFileSync(join(dir, 'profile.json'), 'utf8');
  assert.ok(!profileText.includes(DISCORD_TOKEN) && !JSON.stringify(view).includes(DISCORD_TOKEN), 'the token is in neither the profile nor the answer');
  assert.deepEqual(readSecretsFile(dir).sources.DISCORD_BOT_TOKEN, { kind: '1password', reference: 'op://Private/Discord bot/token' });
  assert.ok(readSecretsFile(dir).checks.DISCORD_BOT_TOKEN?.verifiedAt, 'recorded as checked');
  assert.deepEqual(channelsView(dir), view, 'the same code until it is used');

  assert.deepEqual((await handlers.disconnectDiscord()).discord, { state: 'off' });
  assert.equal(readSecretsFile(dir).sources.DISCORD_BOT_TOKEN, undefined);
  assert.ok(!readFileSync(join(dir, 'profile.json'), 'utf8').includes('discord'));
});

test('the Discord row says one thing, and the screen checks a pasted token before Discord is asked', () => {
  const up = { state: 'up', pid: 1, startedAt: '', slackConnected: true, counts: { needsYou: 0, running: 0 } } as const;
  assert.deepEqual(discordRow({ state: 'off' }, up), { tone: 'neutral', label: 'Not connected' });
  assert.deepEqual(discordRow({ state: 'pairing', username: 'b', invite: '', code: 'ABCD2345' }, up), { tone: 'warn', label: 'Waiting for you' });
  assert.deepEqual(discordRow({ state: 'paired', username: 'b', invite: '' }, up), { tone: 'warn', label: 'Restart to start' });
  assert.deepEqual(discordRow({ state: 'paired', username: 'b', invite: '' }, { ...up, chats: [{ kind: 'discord', connected: true }] }), { tone: 'up', label: 'Connected' });
  assert.deepEqual(discordRow({ state: 'paired', username: 'b', invite: '' }, { ...up, chats: [{ kind: 'discord', connected: false }] }), { tone: 'down', label: 'Not reachable' });
  assert.equal(discordTokenProblem(DISCORD_TOKEN), null);
  assert.equal(discordTokenProblem('op://Private/Discord bot/token'), null);
  assert.match(discordTokenProblem('123456:ABC') ?? '', /doesn’t look like a Discord bot token/);
  assert.equal(spacedCode('ABCD2345'), 'ABCD 2345');
});

test('a Discord job shows as Discord in Jobs, with no Slack link', async () => {
  const { channelTag } = await import('../app/renderer/screens/jobs.logic.ts');
  const { slackThreadLink } = await import('../src/jobs.ts');
  assert.equal(channelTag({ channel: `${DISCORD}:${DM}` } as Parameters<typeof channelTag>[0]), 'Discord');
  assert.equal(slackThreadLink('https://acme.slack.com', `${DISCORD}:${DM}`, '105'), undefined);
});
