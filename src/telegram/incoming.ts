/**
 * What a Telegram update means for Serra: a message for the core (and in which thread), an answer on a question card,
 * a `/start` (pairing), or nothing. Telegram has no threads, so the thread is worked out here:
 *
 * - A reply to a message Serra knows continues that message's thread.
 * - In a private chat, a new message carries on the thread used last there if it was used within `continueMs` and the
 *   bot still owns it; otherwise (or after `/new`) it starts a thread of its own.
 * - In a group, only a message that mentions the bot, or a reply in a thread the bot owns, is for Serra.
 */
import type { QuestionInteraction } from '../questions.ts';
import type { IncomingFile, IncomingMessage } from '../types.ts';
import type { TelegramMessage, TelegramUpdate } from './api.ts';
import { QUESTION_DATA, telegramId } from './chat.ts';
import type { ThreadStore } from './threads.ts';

/** How long a private chat's last thread takes new messages without a reply. */
export const CONTINUE_MS = 30 * 60 * 1000;

export type Translated =
  | { kind: 'message'; msg: IncomingMessage; chat: string; thread: string; from: string; text: string }
  | { kind: 'answer'; interaction: QuestionInteraction; callback: string }
  /** A click that isn't a card answer: Telegram still waits for an answer to stop the spinner. */
  | { kind: 'ignored-click'; callback: string }
  | { kind: 'start'; chat: string; from: string; code: string };

export interface TranslateContext {
  botId: string;
  username: string;
  store: Pick<ThreadStore, 'threadOf' | 'lastIn'>;
  owns(conversation: string, thread: string): boolean;
  now: number;
}

/** The name a person shows as, for `displayName`. */
export const nameOf = (user: { first_name?: string; last_name?: string; username?: string; id: number }): string =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : String(user.id));

const filesOf = (message: TelegramMessage): IncomingFile[] => {
  const files: IncomingFile[] = [];
  // Telegram sends each photo in several sizes, smallest first: the largest is the one to read.
  const photo = message.photo?.at(-1);
  if (photo) files.push({ id: photo.file_id, name: `photo-${message.message_id}.jpg`, mimetype: 'image/jpeg', ...(photo.file_size ? { size: photo.file_size } : {}) });
  const document = message.document;
  if (document) {
    files.push({ id: document.file_id, name: document.file_name ?? `file-${message.message_id}`, ...(document.mime_type ? { mimetype: document.mime_type } : {}), ...(document.file_size ? { size: document.file_size } : {}) });
  }
  return files;
};

export const translateUpdate = (update: TelegramUpdate, context: TranslateContext): Translated | null => {
  const callback = update.callback_query;
  if (callback) {
    const match = QUESTION_DATA.exec(callback.data ?? '');
    const card = callback.message;
    if (!match || !card) return { kind: 'ignored-click', callback: callback.id };
    return {
      kind: 'answer', callback: callback.id,
      interaction: { channel: telegramId(card.chat.id), messageTs: String(card.message_id), user: telegramId(callback.from.id), nonce: match[1] ?? '', indices: [Number(match[2])] },
    };
  }
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type === 'channel') return null;
  const chat = String(message.chat.id);
  const conversation = telegramId(chat);
  const id = String(message.message_id);
  const from = String(message.from.id);
  let text = message.text ?? message.caption ?? '';
  const files = filesOf(message);
  if (!text.trim() && files.length === 0) return null;
  const isPrivate = message.chat.type === 'private';
  const mention = context.username !== '' && new RegExp(`@${context.username.replace(/\W/g, '')}\\b`, 'i').test(text);

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (start && isPrivate) return { kind: 'start', chat, from, code: start[1] ?? '' };

  const replyTo = message.reply_to_message ? context.store.threadOf(chat, String(message.reply_to_message.message_id)) : undefined;
  let thread: string;
  let direct: boolean;
  if (isPrivate) {
    direct = true;
    const fresh = /^\/new(?:@\w+)?\b/.exec(text);
    if (fresh) text = text.slice(fresh[0].length).trim();
    const last = context.store.lastIn(chat);
    thread = replyTo
      ?? (!fresh && last && context.now - last.at < CONTINUE_MS && context.owns(conversation, last.thread) ? last.thread : id);
    if (!text.trim() && files.length === 0) return null;
  } else {
    const owned = replyTo !== undefined && context.owns(conversation, replyTo);
    if (!mention && !owned) return null;
    direct = mention;
    thread = owned ? replyTo : id;
  }
  const msg: IncomingMessage = {
    channel: conversation, threadTs: thread, messageTs: id, user: telegramId(from), text, direct,
    ...(files.length ? { files } : {}), ...(isPrivate ? { im: true } : {}),
  };
  return { kind: 'message', msg, chat, thread, from, text };
};
