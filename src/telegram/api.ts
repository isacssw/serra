/**
 * Telegram's Bot API over `fetch`: one POST per method to `api.telegram.org/bot<token>/<method>`, JSON in and out, and
 * multipart for uploads. No library: the Bot API is plain HTTPS, and every call Serra makes is listed here.
 *
 * The token is in every URL, so no error from here carries a URL or a `fetch` message: only Telegram's own words, or
 * a fixed sentence. Tests hand in a `fetch` that plays Telegram (`tests/fakes/telegram.ts`).
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { isRecord } from '../lib/guards.ts';

const BASE = 'https://api.telegram.org';

/** Telegram refused a call: its `error_code` and `description`, and how long to wait when it asks (429). */
export class TelegramError extends Error {
  readonly code: number;
  readonly description: string;
  readonly retryAfter: number | undefined;
  constructor(code: number, description: string, retryAfter?: number) {
    super(`Telegram: ${description}`);
    this.name = 'TelegramError';
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

/** Telegram couldn't be reached, or answered with something that isn't the Bot API. Asking again may work. */
class TelegramUnreachable extends Error {
  constructor(what: string) {
    super(`Couldn't reach Telegram (${what})`);
    this.name = 'TelegramUnreachable';
  }
}

interface TelegramUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface TelegramChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string }
interface TelegramEntity { type: string; offset: number; length: number; user?: TelegramUser }
interface TelegramFile { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string; mime_type?: string }
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: TelegramMessage;
  photo?: (TelegramFile & { width?: number; height?: number })[];
  document?: TelegramFile;
}
interface TelegramCallback { id: string; from: TelegramUser; message?: TelegramMessage; data?: string }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback }

export type InlineKeyboard = { text: string; callback_data: string }[][];

/** What `sendMessage` and `editMessageText` take besides the chat and the text. */
interface SendOptions {
  /** The message this one answers, so it shows as a reply. */
  replyTo?: number;
  keyboard?: InlineKeyboard;
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  /** Long-polls for updates after `offset`, for up to `timeout` seconds. */
  getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chat: string, html: string, options?: SendOptions): Promise<TelegramMessage>;
  editMessageText(chat: string, message: number, html: string, options?: Pick<SendOptions, 'keyboard'>): Promise<void>;
  deleteMessage(chat: string, message: number): Promise<void>;
  /** One emoji on a message, or none. */
  setReaction(chat: string, message: number, emoji: string | null): Promise<void>;
  /** "typing…" for about five seconds. */
  sendTyping(chat: string): Promise<void>;
  answerCallback(id: string, text?: string): Promise<void>;
  /** Uploads a local file into the chat, as a photo when it is one. */
  sendFile(chat: string, path: string, options: { caption?: string; replyTo?: number; photo: boolean }): Promise<TelegramMessage>;
  /** A file's bytes, up to `maxBytes`. */
  download(fileId: string, maxBytes: number): Promise<Buffer>;
}

/** Bot API errors that mean the token is wrong or revoked: the owner fixes it in the app, retrying won't. */
export const isBadToken = (error: unknown): boolean => error instanceof TelegramError && (error.code === 401 || error.code === 404);

export const createTelegramApi = (token: () => string, fetchApi: typeof fetch = fetch): TelegramApi => {
  const url = (method: string): string => `${BASE}/bot${token()}/${method}`;
  const parse = async (response: Response): Promise<unknown> => {
    let body: unknown;
    try { body = await response.json(); } catch { throw new TelegramUnreachable(`HTTP ${response.status}`); }
    if (!isRecord(body)) throw new TelegramUnreachable(`HTTP ${response.status}`);
    if (body.ok === true) return body.result;
    const parameters = isRecord(body.parameters) ? body.parameters : {};
    throw new TelegramError(
      typeof body.error_code === 'number' ? body.error_code : response.status,
      typeof body.description === 'string' ? body.description.slice(0, 300) : 'unknown error',
      typeof parameters.retry_after === 'number' ? parameters.retry_after : undefined,
    );
  };
  const send = async (method: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> => {
    let response: Response;
    const timeout = AbortSignal.timeout(timeoutMs);
    try { response = await fetchApi(url(method), { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch (error) {
      if (signal?.aborted) throw error;
      // `fetch`'s own message can quote the URL, and with it the token.
      throw new TelegramUnreachable(timeout.aborted ? 'timed out' : 'network');
    }
    return parse(response);
  };
  const call = (method: string, params: Record<string, unknown>, { timeoutMs = 30_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> =>
    send(method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }, timeoutMs, signal);

  const message = (value: unknown): TelegramMessage => {
    if (!isRecord(value) || typeof value.message_id !== 'number') throw new TelegramUnreachable('no message');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Telegram's documented shape; the fields read are checked where used
    return value as unknown as TelegramMessage;
  };
  const options = ({ replyTo, keyboard }: SendOptions = {}): Record<string, unknown> => ({
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });

  return {
    async getMe() {
      const me = await call('getMe', {});
      if (!isRecord(me) || typeof me.id !== 'number') throw new TelegramUnreachable('no bot');
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above
      return me as unknown as TelegramUser;
    },
    async getUpdates(offset, timeout, signal) {
      const updates = await call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeout + 15) * 1000, ...(signal ? { signal } : {}) });
      // Each update is read field by field (incoming.ts).
      return Array.isArray(updates) ? updates.filter((update): update is TelegramUpdate => isRecord(update) && typeof update.update_id === 'number') : [];
    },
    sendMessage: async (chat, html, sendOptions) =>
      message(await call('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...options(sendOptions) })),
    async editMessageText(chat, id, html, editOptions) {
      try {
        await call('editMessageText', { chat_id: chat, message_id: id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...options(editOptions) });
      } catch (error) {
        // An edit to the same text is not a failure.
        if (error instanceof TelegramError && /message is not modified/.test(error.description)) return;
        throw error;
      }
    },
    async deleteMessage(chat, id) { await call('deleteMessage', { chat_id: chat, message_id: id }); },
    async setReaction(chat, id, emoji) {
      await call('setMessageReaction', { chat_id: chat, message_id: id, reaction: emoji ? [{ type: 'emoji', emoji }] : [] });
    },
    async sendTyping(chat) { await call('sendChatAction', { chat_id: chat, action: 'typing' }); },
    async answerCallback(id, text) { await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); },
    async sendFile(chat, path, { caption, replyTo, photo }) {
      const form = new FormData();
      form.set('chat_id', chat);
      if (caption) form.set('caption', caption.slice(0, 1024));
      if (replyTo) form.set('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
      form.set(photo ? 'photo' : 'document', await openAsBlob(path), basename(path));
      return message(await send(photo ? 'sendPhoto' : 'sendDocument', { method: 'POST', body: form }, 120_000));
    },
    async download(fileId, maxBytes) {
      const file = await call('getFile', { file_id: fileId });
      if (!isRecord(file) || typeof file.file_path !== 'string') throw new TelegramUnreachable('no file');
      if (typeof file.file_size === 'number' && file.file_size > maxBytes) throw new TelegramError(413, 'file is too big');
      let response: Response;
      try { response = await fetchApi(`${BASE}/file/bot${token()}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) }); }
      catch { throw new TelegramUnreachable('download'); }
      if (!response.ok) { await response.body?.cancel(); throw new TelegramUnreachable(`download HTTP ${response.status}`); }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new TelegramError(413, 'file is too big');
      return bytes;
    },
  };
};
