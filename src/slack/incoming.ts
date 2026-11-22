import type { IncomingFile, IncomingMessage } from '../types.ts';
import type { MessageTrigger } from '../config.ts';
import { matchMessageTrigger } from '../message-triggers.ts';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keep just the file fields we consume; Slack may send reduced file objects. */
export const incomingFiles = (value: unknown): IncomingFile[] => !Array.isArray(value) ? [] : value.filter(record).map((file) => ({
  ...Object.fromEntries(['id', 'name', 'title', 'mimetype', 'url_private', 'url_private_download'].flatMap((key) => typeof file[key] === 'string' ? [[key, file[key]]] : [])),
  ...(typeof file.size === 'number' ? { size: file.size } : {}),
  ...(typeof file.is_external === 'boolean' ? { is_external: file.is_external } : {}),
}));

/** Text and links from the alert's visible Slack content; never fetch images, actions or external files. */
export const alertText = (event: Record<string, unknown>): string => {
  let remaining = 500;
  const render = (value: unknown, depth = 0): string => {
    if (--remaining < 0 || depth > 8) return '';
    if (typeof value === 'string') return value.slice(0, 20_000);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => render(item, depth + 1)).filter(Boolean).join('\n');
    if (!record(value)) return '';
    if (value.type === 'link' && typeof value.url === 'string') {
      return typeof value.text === 'string' && value.text !== value.url ? `<${value.url}|${value.text}>` : value.url;
    }
    if (value.type === 'rich_text_section' && Array.isArray(value.elements)) {
      return value.elements.slice(0, 50).map((item) => render(item, depth + 1)).join('');
    }
    if (typeof value.value === 'string') return `${typeof value.title === 'string' ? `${value.title}: ` : ''}${value.value}`.slice(0, 20_000);
    const parts = ['text', 'fields', 'elements'].map((key) => render(value[key], depth + 1)).filter(Boolean);
    return parts.join('\n');
  };
  const parts = [typeof event.text === 'string' ? event.text.slice(0, 20_001) : '', render(event.blocks)];
  if (Array.isArray(event.attachments)) {
    for (const attachment of event.attachments.slice(0, 50).filter(record)) {
      const title = typeof attachment.title === 'string' ? attachment.title : '';
      parts.push(typeof attachment.title_link === 'string' ? `<${attachment.title_link}${title ? `|${title}` : ''}>` : title);
      for (const key of ['pretext', 'text', 'fields', 'blocks', 'fallback']) parts.push(render(attachment[key]));
    }
  }
  const text = [...new Set(parts.filter((part) => part.trim()))].join('\n\n');
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n[Alert content truncated.]` : text;
};

/** Accept human uploads as well as plain text, while retaining channel ownership and mention deduplication. */
export const incomingMessage = (event: unknown, kind: 'message' | 'app_mention', botUserId: string,
  ownsThread: (channel: string, threadTs: string) => boolean,
  options: { messageTriggers?: readonly MessageTrigger[]; botId?: string } = {}): IncomingMessage | null => {
  if (!record(event) || event.user === botUserId || event.hidden ||
    typeof event.channel !== 'string' || typeof event.ts !== 'string') return null;
  if (event.bot_id) {
    if (kind !== 'message' || typeof event.bot_id !== 'string' || event.bot_id === options.botId ||
      event.thread_ts !== undefined || event.channel_type === 'im' || event.channel_type === 'mpim' ||
      (event.subtype !== undefined && event.subtype !== 'bot_message') ||
      !matchMessageTrigger(options.messageTriggers ?? [], event.channel, { botId: event.bot_id })) return null;
    const text = alertText(event);
    if (!text.trim()) return null;
    return { channel: event.channel, threadTs: event.ts, messageTs: event.ts, user: event.bot_id, botId: event.bot_id, text, direct: true };
  }
  if (typeof event.user !== 'string' || (event.subtype !== undefined && event.subtype !== 'file_share')) return null;
  const text = typeof event.text === 'string' ? event.text : '';
  const isDm = event.channel_type === 'im';
  const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : event.ts;
  if (kind === 'message' && !isDm) {
    if (text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`)) return null;
    if (event.thread_ts === undefined && event.channel_type !== 'mpim' &&
      matchMessageTrigger(options.messageTriggers ?? [], event.channel, { userId: event.user })) {
      const content = alertText(event);
      if (!content.trim()) return null;
      return { channel: event.channel, threadTs, messageTs: event.ts, user: event.user, text: content, direct: true, automaticTrigger: true };
    }
    if (!event.thread_ts || !ownsThread(event.channel, threadTs)) return null;
  }
  return { channel: event.channel, threadTs, messageTs: event.ts, user: event.user, text,
    direct: kind === 'app_mention' || isDm, files: incomingFiles(event.files), ...(isDm && kind === 'message' ? { im: true } : {}) };
};
