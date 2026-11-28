/**
 * Discord as a `ChatConnection` (`src/chat/connection.ts`): a bot from the Discord Developer Portal, reached over the
 * Gateway (`gateway.ts`), an outbound WebSocket like Slack's Socket Mode, so nothing listens on this machine and no
 * server is needed. It signs in over REST (`/users/@me`), hands the daemon each message and button press
 * (`incoming.ts`), pairs the owner with the app's one-time code (sent to the bot in a DM), and puts ⏳ on a request held
 * for an update.
 *
 * Events for one channel are handled in order; different channels don't wait for each other. The library resumes the
 * session after a drop or sleep; Serra retries a first connection that fails, with a growing pause. A token Discord
 * refuses, or a Message Content intent left off, stops it for good (Discord bans tokens that keep trying) until the
 * owner fixes it and the bot restarts. Either way the rest of the bot, Slack and Telegram included, keeps working.
 */
import { GatewayDispatchEvents, type GatewayDispatchPayload } from '@discordjs/core/http-only';
import type { REST } from '@discordjs/rest';
import type { ChatConnection, ConnectionState, Inbound } from '../chat/connection.ts';
import type { ChatAdapter } from '../chat/deliver.ts';
import { pairChatOwner, takeChatPairingCode } from '../chat/pairing.ts';
import { createThreadStore, type ThreadStore } from '../chat/threads.ts';
import type { Clock } from '../clock.ts';
import { errorMessage } from '../lib/errors.ts';
import { createDiscordApi, createDiscordRest, isBadToken, type DiscordApi } from './api.ts';
import { createDiscordChat, discordId, DISCORD, HELD } from './chat.ts';
import { BAD_TOKEN, createDiscordGateway, DISALLOWED_INTENTS, FATAL_CLOSES, type DiscordGateway } from './gateway.ts';
import { nameOf, translateInteraction, translateMessage } from './incoming.ts';

type Logger = { info(message: string): void; warn(message: string): void; error(message: string): void; debug(message: string): void };

export interface DiscordConnectionOptions {
  /** The bot token, read on first use. */
  token: () => string;
  profileDir: string;
  /** The owner's Discord user ID, when already paired. */
  ownerId?: string;
  /**
   * The bot as the profile names it. With it, a token that can't be checked at start leaves Discord down and retrying,
   * and the rest of the bot starts anyway.
   */
  bot?: { id: string; username: string };
  logger: Logger;
  clock: Pick<Clock, 'now'>;
  /** Discord's REST API and Gateway. Tests pass fakes. */
  api?: DiscordApi;
  gateway?: DiscordGateway;
  /** For attachment downloads. Tests pass one. */
  fetch?: typeof fetch;
  /** The pause after a failed first connection, doubling up to a minute. */
  retryMs?: number;
  store?: ThreadStore;
}

const PAIRED = 'You\'re connected. Send me anything here, or mention me in a server, and I\'ll take it from there.';
const NOT_PAIRED = 'I\'m not connected to anyone yet. Send me the code from the Serra app (Settings › Channels) to connect.';
const REFUSED = 'Sorry, I only take requests from my owner.';

export const createDiscordConnection = (options: DiscordConnectionOptions): ChatAdapter => {
  const { profileDir, logger, clock, retryMs = 5_000 } = options;
  // One REST client (and one rate-limit queue) for the API and the Gateway's own lookups.
  let shared: REST | null = null;
  const rest = (): REST => (shared ??= createDiscordRest(options.token));
  const api = options.api ?? createDiscordApi(rest());
  const gateway = options.gateway ?? createDiscordGateway(options.token, rest());
  const store = options.store ?? createThreadStore(profileDir, DISCORD, (message) => logger.warn(message));
  let botId = options.bot?.id ?? '';
  let owner: string | null = options.ownerId ?? null;
  const names = new Map<string, string>();
  const channels = { dms: new Map<string, string>(), guilds: new Map<string, string>() };
  /** The paired owner's DM channel, once opened for a copy of an approval. */
  let ownerDm: { owner: string; channel: string } | null = null;
  const { chat, writer } = createDiscordChat({
    api, store, botId: () => botId, owner: () => owner, names, channels, profileDir, logger, clock, ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const listeners: ((state: ConnectionState) => void)[] = [];
  let state: ConnectionState | null = null;
  const report = (next: ConnectionState): void => {
    if (state === next) return;
    state = next;
    for (const listener of listeners) listener(next);
  };

  let stopped = false;
  /** Set once Discord refused for good: nothing reconnects until the owner fixes it and the bot restarts. */
  let refused = false;
  let wake: (() => void) | null = null;
  let loop: Promise<void> = Promise.resolve();
  /** Each channel's events, in order. */
  const queues = new Map<string, Promise<void>>();
  const inOrder = (key: string, work: () => Promise<void>): void => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => logger.error(`Discord event failed: ${errorMessage(error)}`));
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  };

  /** A fixed line from Serra (pairing), never the worker's words. */
  const say = async (channel: string, text: string): Promise<void> => {
    await api.post(channel, text).then(() => {}, (error: unknown) => logger.warn(`Couldn't answer on Discord: ${errorMessage(error)}`));
  };

  const pair = async (channel: string, from: string, code: string | null): Promise<void> => {
    if (owner !== null) return say(channel, from === owner ? 'I\'m here. What do you need?' : REFUSED);
    if (code && takeChatPairingCode(profileDir, DISCORD, code, clock.now())) {
      try { pairChatOwner(profileDir, DISCORD, from); } catch (error) {
        logger.error(`Couldn't save the Discord owner: ${errorMessage(error)}`);
        return say(channel, 'Something went wrong on my side. Send me the code from the Serra app again.');
      }
      owner = from;
      logger.info('Discord: paired with the owner.');
      return say(channel, PAIRED);
    }
    return say(channel, NOT_PAIRED);
  };

  const dispatch = (payload: GatewayDispatchPayload, inbound: Inbound): void => {
    if (payload.t === GatewayDispatchEvents.MessageCreate) {
      const message = payload.d;
      names.set(discordId(message.author.id), nameOf(message.author));
      if (message.guild_id) channels.guilds.set(message.channel_id, message.guild_id);
      else if (!message.author.bot) channels.dms.set(message.channel_id, message.author.id);
      inOrder(message.channel_id, async () => {
        const translated = await translateMessage(message, {
          botId, owner, store, owns: inbound.owns, now: clock.now(),
          channel: (id) => api.channel(id), startThread: (channel, id, name) => api.startThread(channel, id, name),
        });
        if (!translated) return;
        if (translated.kind === 'unpaired') return pair(translated.channel, translated.from, translated.code);
        const { msg, conversation, thread } = translated;
        if (message.guild_id) channels.guilds.set(conversation, message.guild_id);
        // Recorded first, so a reply to this message finds its job even while the core is still on it.
        store.add(conversation, thread, { id: msg.messageTs, from: translated.from, text: translated.text }, clock.now());
        await inbound.message(msg);
      });
      return;
    }
    if (payload.t === GatewayDispatchEvents.InteractionCreate) {
      const clicked = translateInteraction(payload.d, store);
      if (!clicked) return;
      // Discord shows the press as failed unless it is answered within three seconds.
      void api.acknowledge(clicked.ack.id, clicked.ack.token).catch((error: unknown) => logger.debug(`Answering a Discord click failed: ${errorMessage(error)}`));
      if (clicked.kind === 'answer') {
        const { interaction } = clicked;
        if (payload.d.user?.id) names.set(interaction.user, nameOf(payload.d.user));
        else if (payload.d.member) names.set(interaction.user, nameOf(payload.d.member.user));
        inOrder(interaction.channel, () => inbound.answer(interaction));
      }
    }
  };

  const pause = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  /** Discord refused for good: say how to fix it, once, and stay down. */
  const refuse = (why: string): void => {
    if (refused) return;
    refused = true;
    report('disconnected');
    logger.warn(why);
    void gateway.destroy().catch(() => {});
  };

  const run = async (inbound: Inbound): Promise<void> => {
    let wait = retryMs;
    while (!stopped && !refused) {
      try {
        await gateway.connect({
          dispatch: (payload) => { try { dispatch(payload, inbound); } catch (error) { logger.error(`Discord event: ${errorMessage(error)}`); } },
          ready: () => { if (!stopped && !refused) report('connected'); },
          closed: (code) => {
            if (stopped) return;
            if (code === BAD_TOKEN) refuse('Discord refused the bot token. Connect Discord again in Settings › Channels.');
            else if (code === DISALLOWED_INTENTS) refuse('Discord refused the Message Content intent. Turn it on under Bot in the Discord Developer Portal, then restart the bot.');
            else if (FATAL_CLOSES.has(code)) refuse(`Discord closed the connection for good (code ${code}). Restart the bot to try again.`);
            else report('disconnected');
          },
        });
        return;
      } catch (error) {
        if (stopped || refused) return;
        if (isBadToken(error)) return refuse('Discord refused the bot token. Connect Discord again in Settings › Channels.');
        report('disconnected');
        logger.warn(`Discord: ${errorMessage(error)}. Trying again.`);
        await pause(wait);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  };

  const connection: ChatConnection = {
    kind: DISCORD,
    chat,

    async identify() {
      let username = options.bot?.username ?? '';
      try {
        const me = await api.me();
        botId = me.id;
        username = me.username;
      } catch (error) {
        if (!options.bot) throw error;
        logger.warn(`Discord isn't reachable yet (${errorMessage(error)}); Serra keeps trying. Your other chats work meanwhile.`);
        report('disconnected');
      }
      names.set(discordId(botId), username);
      if (owner === null) logger.info(`Discord: ${username} is waiting for its owner to send it the code from the Serra app.`);
      return { self: discordId(botId), lock: `discord-${botId}`, describe: `${username} on Discord` };
    },

    async listen(inbound) {
      loop = run(inbound).catch((error: unknown) => logger.error(`Discord stopped: ${errorMessage(error)}`));
    },

    async stop() {
      stopped = true;
      wake?.();
      await loop;
      await gateway.destroy().catch(() => {});
      await Promise.allSettled([...queues.values()]);
      report('disconnected');
    },

    watch(listener) { listeners.push(listener); },

    async hold(ref, on) {
      // The request is the thread's first message, or a message in a DM: in its conversation either way, unless it was
      // written inside a thread.
      const conversation = ref.conversation.slice(DISCORD.length + 1);
      const thread = store.threadOf(conversation, ref.id);
      const channel = thread !== undefined && thread !== ref.id && store.homeOf(thread) === conversation ? thread : conversation;
      await api.react(channel, ref.id, HELD, on).catch(() => {});
    },

    saw() {},

    /** The owner's DM with the bot, opened once (Discord gives the same one each time) and known as theirs from then on. */
    async ownerSpace() {
      if (owner === null) return null;
      if (ownerDm?.owner !== owner) {
        const opened = await api.openDm(owner);
        ownerDm = { owner, channel: opened.id };
      }
      channels.dms.set(ownerDm.channel, owner);
      return discordId(ownerDm.channel);
    },
  };
  return { connection, writer };
};
