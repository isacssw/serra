/**
 * Telegram's Bot API in memory, behind a `fetch`: the real `createTelegramApi` talks to it, so a test runs Serra's own
 * HTTP calls. People write with `say` and press buttons with `click`; every message, edit, reaction and upload the bot
 * makes is recorded. `getUpdates` long-polls like Telegram's: it answers at once with waiting updates, or waits for the
 * next one (or the abort).
 *
 * Nothing here reaches the network or a real bot. The token is a fixture value, not a real one.
 */
import type { TelegramMessage, TelegramUpdate } from '../../src/telegram/api.ts';

export const TELEGRAM_TOKEN = '1111111:fixturevalue-telegram-0000000000000';
export const TELEGRAM_BOT = { id: 1111111, username: 'friday_serra_bot' };

type Json = Record<string, unknown>;
const ok = (result: unknown): Response => Response.json({ ok: true, result });
const fail = (code: number, description: string, retryAfter?: number): Response =>
  Response.json({ ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) }, { status: code });

export interface Sent { chat: string; id: number; text: string; replyTo?: number; keyboard?: { text: string; callback_data: string }[][] }

export const createFakeTelegram = ({ token = TELEGRAM_TOKEN }: { token?: string } = {}) => {
  let nextUpdate = 1;
  let nextMessage = 100;
  const updates: TelegramUpdate[] = [];
  const waiters: (() => void)[] = [];
  const pollWaiters: (() => void)[] = [];
  const calls: { method: string; body: Json }[] = [];
  const sent: Sent[] = [];
  const edits: { chat: string; id: number; text: string; keyboard?: unknown }[] = [];
  const reactions: { chat: string; id: number; emoji: string | null }[] = [];
  const deleted: { chat: string; id: number }[] = [];
  const answered: string[] = [];
  const typing: string[] = [];
  const uploads: { chat: string; kind: 'photo' | 'document'; name: string; caption?: string }[] = [];
  /** While set, every poll fails as if Telegram were unreachable. */
  let down = false;
  /** Every call fails, not only polling: Telegram can't be reached at all. */
  let unreachable = false;
  let polls = 0;
  /** Every URL the bot fetched, to check none went anywhere else. */
  const urls: string[] = [];

  const wake = (): void => { for (const waiter of waiters.splice(0)) waiter(); };

  const getUpdates = (offset: number, signal: AbortSignal | null | undefined): Promise<Response> => {
    polls += 1;
    for (const waiter of pollWaiters.splice(0)) waiter();
    const ready = (): TelegramUpdate[] => updates.filter((update) => update.update_id >= offset);
    if (ready().length) return Promise.resolve(ok(ready()));
    return new Promise((resolve, reject) => {
      const done = (): void => resolve(ok(ready()));
      waiters.push(done);
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const match = /^https:\/\/api\.telegram\.org\/(file\/)?bot([^/]+)\/(.+)$/.exec(url);
    if (!match) throw new TypeError('fetch failed');
    if (match[2] !== token) return fail(401, 'Unauthorized');
    if (match[1]) return new Response(Buffer.from(`bytes of ${match[3]}`));
    const method = match[3] ?? '';
    const body: Json = init?.body instanceof FormData
      ? Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : (value as File).name]))
      : init?.body ? JSON.parse(String(init.body)) as Json : {};
    calls.push({ method, body });
    if (unreachable && method !== 'getUpdates') throw new TypeError('fetch failed');
    const chat = String(body.chat_id ?? '');
    const id = Number(body.message_id ?? 0);
    switch (method) {
      case 'getMe': return ok({ id: TELEGRAM_BOT.id, is_bot: true, first_name: 'Friday', username: TELEGRAM_BOT.username });
      case 'getUpdates':
        if (down) {
          polls += 1;
          for (const waiter of pollWaiters.splice(0)) waiter();
          throw new TypeError('fetch failed');
        }
        return getUpdates(Number(body.offset ?? 0), init?.signal);
      case 'sendMessage': {
        const message = ++nextMessage;
        const reply = body.reply_parameters as { message_id?: number } | undefined;
        const markup = body.reply_markup as { inline_keyboard?: Sent['keyboard'] } | undefined;
        sent.push({ chat, id: message, text: String(body.text), ...(reply?.message_id ? { replyTo: reply.message_id } : {}), ...(markup?.inline_keyboard ? { keyboard: markup.inline_keyboard } : {}) });
        return ok({ message_id: message, chat: { id: Number(chat), type: Number(chat) > 0 ? 'private' : 'supergroup' }, date: 0, text: body.text });
      }
      case 'editMessageText':
        if (!sent.some((message) => message.chat === chat && message.id === id)) return fail(400, 'Bad Request: message to edit not found');
        edits.push({ chat, id, text: String(body.text), ...(body.reply_markup ? { keyboard: body.reply_markup } : {}) });
        return ok(true);
      case 'deleteMessage': deleted.push({ chat, id }); return ok(true);
      case 'setMessageReaction': {
        const reaction = body.reaction as { emoji: string }[];
        reactions.push({ chat, id, emoji: reaction[0]?.emoji ?? null });
        return ok(true);
      }
      case 'sendChatAction': typing.push(chat); return ok(true);
      case 'answerCallbackQuery': answered.push(String(body.callback_query_id)); return ok(true);
      case 'sendPhoto': case 'sendDocument': {
        const kind = method === 'sendPhoto' ? 'photo' : 'document';
        uploads.push({ chat, kind, name: String(body[kind]), ...(body.caption ? { caption: String(body.caption) } : {}) });
        return ok({ message_id: ++nextMessage, chat: { id: Number(chat), type: 'private' }, date: 0 });
      }
      case 'getFile': return ok({ file_id: body.file_id, file_path: `photos/${String(body.file_id)}.jpg`, file_size: 12 });
      default: return fail(404, `Not Found: method ${method}`);
    }
  };

  const push = (update: Omit<TelegramUpdate, 'update_id'>): void => {
    updates.push({ update_id: nextUpdate++, ...update });
    wake();
  };

  /** Resolves once the bot polls again: everything before it has been handed over. Then lets the handlers start. */
  const handedOver = async (): Promise<void> => {
    await new Promise<void>((resolve) => pollWaiters.push(resolve));
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls, sent, edits, reactions, deleted, answered, typing, uploads, urls,
    polls: () => polls,
    setDown: (value: boolean) => { down = value; },
    /** Telegram can't be reached at all (`true`): polling and every other call fail; or it is back. */
    setUnreachable: (value: boolean) => { down = value; unreachable = value; },
    /**
     * Someone writes to the bot: in their private chat with it (`chat` defaults to their own ID, as Telegram does), or
     * in a group (`chat` negative). Returns the message's ID once the bot has it.
     */
    say: async ({ from, text, chat = from, replyTo, name = `Person ${from}`, photo }:
      { from: number; text: string; chat?: number; replyTo?: number; name?: string; photo?: boolean }): Promise<number> => {
      const id = ++nextMessage;
      const message: TelegramMessage = {
        message_id: id, date: 0, from: { id: from, first_name: name }, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' },
        ...(photo ? { caption: text, photo: [{ file_id: `small-${id}`, file_size: 10 }, { file_id: `large-${id}`, file_size: 12 }] } : { text }),
        ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' } } } : {}),
      };
      const polled = handedOver();
      push({ message });
      await polled;
      return id;
    },
    /** Someone presses a button on a message the bot sent. */
    click: async ({ from, message, data }: { from: number; message: Sent; data: string }): Promise<void> => {
      const polled = handedOver();
      push({ callback_query: { id: `cb-${nextUpdate}`, from: { id: from, first_name: `Person ${from}` }, data, message: { message_id: message.id, date: 0, chat: { id: Number(message.chat), type: Number(message.chat) > 0 ? 'private' : 'supergroup' } } } });
      await polled;
    },
    /** Waits until the bot polls again. */
    nextPoll: () => new Promise<void>((resolve) => pollWaiters.push(resolve)),
  };
};
