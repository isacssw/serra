/**
 * Telegram as a `ChatConnection` (`src/chat/connection.ts`): a bot @BotFather made, reached by long polling
 * (`getUpdates`), so nothing listens on this machine and no server is needed. It signs in with `getMe`, hands the
 * daemon each update as a message or a card answer (`incoming.ts`), pairs the owner with the app's one-time code
 * (`pairing.ts`), and puts 😴 on a request held for an update.
 *
 * Updates for one chat are handled in order; different chats don't wait for each other. A poll that fails is retried
 * with a growing pause, and the app sees the connection as down until one succeeds again.
 */
import type { ChatConnection, ConnectionState, Inbound } from '../chat/connection.ts';
import type { ChatAdapter } from '../chat/deliver.ts';
import type { Clock } from '../clock.ts';
import { errorMessage } from '../lib/errors.ts';
import { createTelegramApi, isBadToken, TelegramError, type TelegramApi, type TelegramUpdate } from './api.ts';
import { createTelegramChat, HELD, TELEGRAM, telegramId } from './chat.ts';
import { nameOf, translateUpdate } from './incoming.ts';
import { pairTelegramOwner, takePairingCode } from './pairing.ts';
import { escapeHtml } from './markup.ts';
import { createThreadStore, type ThreadStore } from '../chat/threads.ts';

type Logger = { info(message: string): void; warn(message: string): void; error(message: string): void; debug(message: string): void };

export interface TelegramConnectionOptions {
  /** The bot token, read on first use. */
  token: () => string;
  profileDir: string;
  /** The owner's Telegram user ID, when already paired. */
  ownerId?: string;
  /**
   * The bot as the profile names it. With it, a token Telegram refuses (or one that can't be read) at start leaves
   * Telegram down and retrying, and the rest of the bot, Slack included, starts anyway.
   */
  bot?: { id: string; username: string };
  logger: Logger;
  clock: Pick<Clock, 'now'>;
  /** Telegram's Bot API. Tests pass one over a fake `fetch`. */
  api?: TelegramApi;
  fetch?: typeof fetch;
  /** Seconds one `getUpdates` waits for news. */
  pollSeconds?: number;
  /** The pause after a failed poll, doubling up to a minute. */
  retryMs?: number;
  store?: ThreadStore;
}

const PAIRED = 'You\'re connected. Send me anything here, and I\'ll take it from there.';
const NOT_PAIRED = 'I\'m not connected to anyone yet. Open me from the Serra app to connect.';
const HERE = 'I\'m here. What do you need?';
const REFUSED = 'Sorry, I only take requests from my owner.';

export const createTelegramConnection = (options: TelegramConnectionOptions): ChatAdapter => {
  const { profileDir, logger, clock, pollSeconds = 25, retryMs = 5_000 } = options;
  const api = options.api ?? createTelegramApi(options.token, options.fetch);
  const store = options.store ?? createThreadStore(profileDir, 'telegram', (message) => logger.warn(message));
  let botId = '';
  let username = '';
  let owner: string | null = options.ownerId ?? null;
  const names = new Map<string, string>();
  const { chat, writer } = createTelegramChat({
    api, store, botId: () => botId, username: () => username, owner: () => owner, names, profileDir, logger, clock,
  });

  const listeners: ((state: ConnectionState) => void)[] = [];
  let state: ConnectionState | null = null;
  const report = (next: ConnectionState): void => {
    if (state === next) return;
    state = next;
    for (const listener of listeners) listener(next);
  };

  const abort = new AbortController();
  let loop: Promise<void> = Promise.resolve();
  /** Each chat's updates, in order. */
  const queues = new Map<string, Promise<void>>();
  const inOrder = (key: string, work: () => Promise<void>): void => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => logger.error(`Telegram update failed: ${errorMessage(error)}`));
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  };

  /** A fixed line from Serra (pairing and `/start`), never the worker's words. */
  const say = async (chatId: string, text: string): Promise<void> => {
    await api.sendMessage(chatId, escapeHtml(text)).catch((error: unknown) => logger.warn(`Couldn't answer on Telegram: ${errorMessage(error)}`));
  };

  const start = async (chatId: string, from: string, code: string): Promise<void> => {
    if (owner === null && code && takePairingCode(profileDir, code, clock.now())) {
      try { pairTelegramOwner(profileDir, from); } catch (error) {
        logger.error(`Couldn't save the Telegram owner: ${errorMessage(error)}`);
        return say(chatId, 'Something went wrong on my side. Open me from the Serra app again to connect.');
      }
      owner = from;
      logger.info('Telegram: paired with the owner.');
      return say(chatId, PAIRED);
    }
    if (owner === null) return say(chatId, NOT_PAIRED);
    // `/start` from the owner is a hello; anyone else is told no, as any request from them would be.
    return say(chatId, from === owner ? HERE : REFUSED);
  };

  const handle = (update: TelegramUpdate, inbound: Inbound): void => {
    const from = update.message?.from ?? update.callback_query?.from;
    if (from) names.set(telegramId(from.id), nameOf(from));
    const translated = translateUpdate(update, { botId, username, store, owns: inbound.owns, now: clock.now() });
    if (!translated) return;
    switch (translated.kind) {
      case 'ignored-click':
        void api.answerCallback(translated.callback).catch(() => {});
        return;
      case 'answer': {
        // Telegram shows a spinner on the button until the bot answers the click.
        void api.answerCallback(translated.callback).catch(() => {});
        const { interaction } = translated;
        inOrder(interaction.channel, () => inbound.answer(interaction));
        return;
      }
      case 'start':
        inOrder(telegramId(translated.chat), () => start(translated.chat, translated.from, translated.code));
        return;
      case 'message': {
        // Recorded first, so a reply to this message finds its thread even while the core is still on it.
        store.add(translated.chat, translated.thread, { id: translated.msg.messageTs, from: translated.from, text: translated.text }, clock.now());
        const { msg } = translated;
        inOrder(msg.channel, () => inbound.message(msg));
      }
    }
  };

  const pause = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  const poll = async (inbound: Inbound): Promise<void> => {
    let offset = 0;
    let wait = retryMs;
    while (!abort.signal.aborted) {
      let updates: TelegramUpdate[];
      try { updates = await api.getUpdates(offset, pollSeconds, abort.signal); }
      catch (error) {
        if (abort.signal.aborted) return;
        report('disconnected');
        const retryAfter = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 0;
        logger.warn(isBadToken(error) ? 'Telegram refused the bot token. Connect Telegram again in Settings › Channels.'
          : error instanceof TelegramError && error.code === 409 ? 'Another program is reading this Telegram bot\'s messages. Serra will keep trying.'
            : `Telegram: ${errorMessage(error)}. Trying again.`);
        await pause(Math.max(wait, retryAfter));
        wait = Math.min(wait * 2, 60_000);
        continue;
      }
      wait = retryMs;
      report('connected');
      for (const update of updates) {
        // Confirmed by the next call's offset: an update is handed over once, and the core's `heard` list makes a repeat harmless.
        offset = Math.max(offset, update.update_id + 1);
        try { handle(update, inbound); } catch (error) { logger.error(`Telegram update ${update.update_id}: ${errorMessage(error)}`); }
      }
    }
  };

  const connection: ChatConnection = {
    kind: TELEGRAM,
    chat,

    async identify() {
      const me = await api.getMe().catch((error: unknown) => {
        if (!options.bot) throw error;
        logger.warn(`Telegram isn't reachable yet (${errorMessage(error)}); Serra keeps trying. Slack works meanwhile.`);
        report('disconnected');
        return { id: Number(options.bot.id), username: options.bot.username, first_name: options.bot.username };
      });
      botId = String(me.id);
      username = me.username ?? '';
      names.set(telegramId(me.id), nameOf(me));
      if (owner === null) logger.info(`Telegram: @${username} is waiting for its owner to open it from the Serra app.`);
      return { self: telegramId(me.id), lock: `telegram-${botId}`, describe: `@${username} on Telegram` };
    },

    async listen(inbound) {
      loop = poll(inbound).catch((error: unknown) => logger.error(`Telegram polling stopped: ${errorMessage(error)}`));
    },

    async stop() {
      abort.abort();
      await loop;
      await Promise.allSettled([...queues.values()]);
      report('disconnected');
    },

    watch(listener) { listeners.push(listener); },

    async hold(ref, on) {
      await api.setReaction(ref.conversation.slice(TELEGRAM.length + 1), Number(ref.id), on ? HELD : null).catch(() => {});
    },

    saw() {},

    // The owner's private chat with the bot has the owner's own user ID.
    ownerSpace: async () => (owner === null ? null : telegramId(owner)),
  };
  return { connection, writer };
};
