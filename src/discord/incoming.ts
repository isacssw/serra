/**
 * What a Discord event means for Serra: a message for the core (and in which conversation and thread), an answer on
 * a question card, a pairing code, or nothing.
 *
 * - **A DM** has no threads, so it works like a Telegram private chat: a reply to a message Serra knows continues that
 *   message's job; a new message carries on the job used last in the DM if it was used within `CONTINUE_MS` and the
 *   bot still owns it; otherwise (or when it starts with `new`) it starts a job of its own.
 * - **A server channel**: only a message that mentions the bot is for Serra. From the owner, Serra starts a Discord
 *   thread from it and works there (as in a Slack thread); a mention inside a thread uses that thread. Anyone else's
 *   mention is answered in place, so a refusal doesn't open a thread.
 * - **A thread Serra works in**: every message reaches the core, a mention or not, like a reply in a Slack thread.
 *
 * Messages from bots and webhooks, and Discord's own system messages, are never for Serra.
 */
import { ComponentType, InteractionType, MessageType, type APIInteraction, type GatewayMessageCreateDispatchData } from '@discordjs/core/http-only';
import type { ThreadStore } from '../chat/threads.ts';
import type { QuestionInteraction } from '../questions.ts';
import type { IncomingFile, IncomingMessage } from '../types.ts';
import type { DiscordChannelInfo } from './api.ts';
import { discordId, QUESTION_DATA } from './chat.ts';

/** How long a DM's last job takes new messages without a reply. As on Telegram. */
export const CONTINUE_MS = 30 * 60 * 1000;
/** A pairing code as the app shows it: 8 letters and digits, sent alone. */
const CODE = /^[A-Za-z2-9]{8}$/;
/** Discord's thread channel types: announcement, public and private threads. */
const THREADS = new Set([10, 11, 12]);

export type Translated =
  | { kind: 'message'; msg: IncomingMessage; conversation: string; thread: string; from: string; text: string }
  /** The owner hasn't paired yet and someone DMs the bot: `code` when the message could be the pairing code. */
  | { kind: 'unpaired'; channel: string; from: string; code: string | null };

export type Clicked =
  | { kind: 'answer'; interaction: QuestionInteraction; ack: { id: string; token: string } }
  /** A press that isn't a card answer: Discord still waits for an answer. */
  | { kind: 'ignored'; ack: { id: string; token: string } };

export interface TranslateContext {
  botId: string;
  /** The owner's Discord user ID, or null before pairing. */
  owner: string | null;
  store: Pick<ThreadStore, 'threadOf' | 'lastIn' | 'homeOf' | 'recordHome'>;
  owns(conversation: string, thread: string): boolean;
  now: number;
  /** Asks Discord about a channel, for a mention in a thread Serra doesn't know yet. */
  channel(id: string): Promise<DiscordChannelInfo>;
  /** Starts a public thread from the message; rejects when the bot may not. */
  startThread(channel: string, message: string, name: string): Promise<{ id: string }>;
}

/** The name a person shows as, for `displayName`. */
export const nameOf = (user: { id: string; username: string; global_name?: string | null }): string => user.global_name || user.username || user.id;

/** A thread's title, from the request: its first line, without mentions. */
export const threadName = (text: string): string =>
  text.replace(/<@[!&]?\d+>/g, '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 80) ?? 'Serra';

const filesOf = (message: GatewayMessageCreateDispatchData): IncomingFile[] => message.attachments.map((attachment) => ({
  id: attachment.id, name: attachment.filename, size: attachment.size,
  ...(attachment.content_type ? { mimetype: attachment.content_type } : {}),
  // The signed CDN link: downloaded when the turn starts, with no token (`files.ts`).
  url_private: attachment.url,
}));

export const translateMessage = async (message: GatewayMessageCreateDispatchData, context: TranslateContext): Promise<Translated | null> => {
  if (message.author.bot || message.webhook_id || (message.type !== MessageType.Default && message.type !== MessageType.Reply)) return null;
  const from = message.author.id;
  const channel = message.channel_id;
  const id = message.id;
  let text = message.content;
  const files = filesOf(message);
  if (!text.trim() && files.length === 0) return null;

  if (!message.guild_id) {
    if (context.owner === null) {
      return { kind: 'unpaired', channel, from, code: CODE.test(text.trim()) ? text.trim().toUpperCase() : null };
    }
    const fresh = /^\/?new\b[:\s]*/i.exec(text);
    if (fresh) text = text.slice(fresh[0].length).trim();
    if (!text.trim() && files.length === 0) return null;
    const reference = message.message_reference?.message_id;
    const replyTo = reference ? context.store.threadOf(channel, reference) : undefined;
    const last = context.store.lastIn(channel);
    const thread = replyTo
      ?? (!fresh && last && context.now - last.at < CONTINUE_MS && context.owns(discordId(channel), last.thread) ? last.thread : id);
    const msg: IncomingMessage = {
      channel: discordId(channel), threadTs: thread, messageTs: id, user: discordId(from), text, direct: true, im: true, ...(files.length ? { files } : {}),
    };
    return { kind: 'message', msg, conversation: channel, thread, from, text };
  }

  const mention = message.mentions.some((user) => user.id === context.botId);
  let conversation: string;
  let thread: string;
  const home = context.store.homeOf(channel);
  if (home !== undefined) {
    // A thread Serra works in, or worked in.
    if (!mention && !context.owns(discordId(home), channel)) return null;
    conversation = home;
    thread = channel;
  } else {
    if (!mention) return null;
    const info = await context.channel(channel);
    if (THREADS.has(info.type) && info.parentId) {
      // A mention inside a thread someone else started: the job lives in that thread.
      conversation = info.parentId;
      thread = channel;
      context.store.recordHome(thread, conversation);
    } else {
      conversation = channel;
      thread = id;
      if (from === context.owner) {
        try {
          await context.startThread(channel, id, threadName(text));
          context.store.recordHome(id, channel);
        } catch { /* No permission to start threads here: answer in place, as replies. */ }
      }
    }
  }
  const msg: IncomingMessage = {
    channel: discordId(conversation), threadTs: thread, messageTs: id, user: discordId(from), text, direct: mention, ...(files.length ? { files } : {}),
  };
  return { kind: 'message', msg, conversation, thread, from, text };
};

export const translateInteraction = (interaction: APIInteraction, store: Pick<ThreadStore, 'homeOf'>): Clicked | null => {
  if (interaction.type !== InteractionType.MessageComponent) return null;
  const ack = { id: interaction.id, token: interaction.token };
  const user = interaction.member?.user.id ?? interaction.user?.id;
  const match = interaction.data.component_type === ComponentType.Button ? QUESTION_DATA.exec(interaction.data.custom_id) : null;
  if (!match || !user || !interaction.channel?.id) return { kind: 'ignored', ack };
  const channel = interaction.channel.id;
  return {
    kind: 'answer', ack,
    interaction: { channel: discordId(store.homeOf(channel) ?? channel), messageTs: interaction.message.id, user: discordId(user), nonce: match[1] ?? '', indices: [Number(match[2])] },
  };
};
