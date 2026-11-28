/**
 * Discord's REST API, as far as Serra uses it: `@discordjs/rest` (rate-limit queues, retries) under `@discordjs/core`'s
 * typed routes. Every call Serra makes is listed in `DiscordApi`; tests run this same code over a fake `makeRequest`
 * (`tests/fakes/discord.ts`).
 *
 * The token travels only in the Authorization header, never in a URL, and no error from here carries it: Discord's
 * own status and code, or a fixed sentence.
 */
import { API, MessageFlags, type APIActionRowComponent, type APIComponentInMessageActionRow, type APIMessage } from '@discordjs/core/http-only';
import { DiscordAPIError, HTTPError, REST, type RESTOptions } from '@discordjs/rest';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Discord refused a call: the HTTP status, and Discord's own error code (`50013` Missing Permissions, …) when it gave one. */
export class DiscordError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, code: number | null, what: string) {
    super(`Discord: ${what} (HTTP ${status}${code === null ? '' : `, code ${code}`})`);
    this.name = 'DiscordError';
    this.status = status;
    this.code = code;
  }
}

/** Discord couldn't be reached. Asking again may work. */
class DiscordUnreachable extends Error {
  constructor() {
    super('Couldn\'t reach Discord');
    this.name = 'DiscordUnreachable';
  }
}

/** The token is wrong or was reset: the owner fixes it in the app, retrying won't (and Discord bans tokens that keep trying). */
export const isBadToken = (error: unknown): boolean =>
  // The library's own errors too: the Gateway asks REST for its URL before it connects.
  (error instanceof DiscordError || error instanceof DiscordAPIError || error instanceof HTTPError) && error.status === 401;
/** The message or channel is gone. */
export const isUnknown = (error: unknown): boolean => error instanceof DiscordError && (error.code === 10008 || error.code === 10003 || error.status === 404);

/** A Discord channel as Serra needs it: its kind, the channel a thread belongs to, a DM's other person. */
export interface DiscordChannelInfo {
  id: string;
  /** Discord's channel type: 1 is a DM, 10–12 a thread, anything else a server channel. */
  type: number;
  parentId: string | null;
  /** A DM's other person, by their user ID. */
  recipient: string | null;
}

/** A message as Serra reads it back (thread history). */
interface DiscordMessage {
  id: string;
  author: { id: string; bot: boolean; name: string };
  content: string;
}

export type Buttons = APIActionRowComponent<APIComponentInMessageActionRow>[];

/** What a message Serra posts carries besides its text. */
interface PostOptions {
  /** The message this one answers, so it shows as a reply. */
  replyTo?: string;
  /** Rows of buttons. An edit without them takes the buttons away. */
  components?: Buttons;
}

export interface DiscordApi {
  /** The bot itself. */
  me(): Promise<{ id: string; username: string }>;
  /** Posts a message. Nobody is ever pinged by it, and links don't unfurl. */
  post(channel: string, content: string, options?: PostOptions): Promise<{ id: string }>;
  edit(channel: string, message: string, content: string, options?: Pick<PostOptions, 'components'>): Promise<void>;
  remove(channel: string, message: string): Promise<void>;
  /** The bot's own reaction on a message, added or taken away. */
  react(channel: string, message: string, emoji: string, on: boolean): Promise<void>;
  /** "Serra is typing…" for about ten seconds. */
  typing(channel: string): Promise<void>;
  /** Starts a public thread from a message in a server channel. The thread's ID is the message's. */
  startThread(channel: string, message: string, name: string): Promise<{ id: string }>;
  channel(id: string): Promise<DiscordChannelInfo>;
  /** The bot's DM channel with a person, opened if need be (a bot may always open one; it needs no permission). */
  openDm(user: string): Promise<{ id: string }>;
  /** Up to `limit` messages before `before`, newest first, as Discord gives them. */
  messages(channel: string, before: string, limit: number): Promise<DiscordMessage[]>;
  /** Answers a button press without changing the message, so Discord stops waiting. */
  acknowledge(interaction: string, token: string): Promise<void>;
  /** Uploads a local file into a channel. */
  upload(channel: string, path: string, options: { caption?: string; replyTo?: string }): Promise<{ id: string }>;
}

/** No `@everyone`, role or person is ever pinged by what Serra posts: mentions still show as names. */
const NO_PINGS = { parse: [] as never[] };
/** Links stay links, without a preview card under every reply. */
const QUIET = MessageFlags.SuppressEmbeds;

/** `call`'s error, as Serra reads it: Discord's status and code, without the request or the token. */
const translate = (error: unknown, what: string): Error => {
  if (error instanceof DiscordAPIError) return new DiscordError(error.status, typeof error.code === 'number' ? error.code : null, what);
  if (error instanceof HTTPError) return new DiscordError(error.status, null, what);
  return new DiscordUnreachable();
};

const call = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
  try { return await work(); } catch (error) { throw translate(error, what); }
};

const messageOf = (message: APIMessage): DiscordMessage => ({
  id: message.id, content: message.content,
  author: { id: message.author.id, bot: message.author.bot === true, name: message.author.global_name ?? message.author.username },
});

/** The REST client Serra uses: the token from `token()`, read on first use. `makeRequest` is the tests' fake. */
export const createDiscordRest = (token: () => string, options: Pick<Partial<RESTOptions>, 'makeRequest'> = {}): REST => {
  const rest = new REST({ version: '10', timeout: 30_000, retries: 2, ...options });
  let set = false;
  // Set lazily, so a token that can't be read yet doesn't stop the daemon starting.
  const original = rest.request.bind(rest);
  rest.request = async (request) => {
    if (!set) { rest.setToken(token()); set = true; }
    return original(request);
  };
  return rest;
};

export const createDiscordApi = (rest: REST): DiscordApi => {
  const api = new API(rest);
  return {
    me: () => call('who am I', async () => {
      const user = await api.users.getCurrent();
      return { id: user.id, username: user.username };
    }),
    post: (channel, content, { replyTo, components } = {}) => call('post', async () => {
      const message = await api.channels.createMessage(channel, {
        content, allowed_mentions: NO_PINGS, flags: QUIET,
        ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
        ...(components ? { components } : {}),
      });
      return { id: message.id };
    }),
    edit: (channel, message, content, { components } = {}) => call('edit', async () => {
      await api.channels.editMessage(channel, message, { content, allowed_mentions: NO_PINGS, flags: QUIET, components: components ?? [] });
    }),
    remove: (channel, message) => call('remove', () => api.channels.deleteMessage(channel, message)),
    react: (channel, message, emoji, on) => call('react', () => (on
      ? api.channels.addMessageReaction(channel, message, emoji)
      : api.channels.deleteOwnMessageReaction(channel, message, emoji))),
    typing: (channel) => call('typing', () => api.channels.showTyping(channel)),
    startThread: (channel, message, name) => call('start a thread', async () => {
      const thread = await api.channels.createThread(channel, { name: name.slice(0, 100) || 'Serra', auto_archive_duration: 10_080 }, message);
      return { id: thread.id };
    }),
    channel: (id) => call('channel', async () => {
      const channel = await api.channels.get(id);
      const recipients = 'recipients' in channel && Array.isArray(channel.recipients) ? channel.recipients : [];
      return {
        id: channel.id, type: channel.type,
        parentId: 'parent_id' in channel && typeof channel.parent_id === 'string' ? channel.parent_id : null,
        recipient: recipients[0]?.id ?? null,
      };
    }),
    openDm: (user) => call('open a DM', async () => ({ id: (await api.users.createDM(user)).id })),
    messages: (channel, before, limit) => call('history', async () => (await api.channels.getMessages(channel, { before, limit })).map(messageOf)),
    acknowledge: (interaction, token) => call('answer a click', () => api.interactions.deferMessageUpdate(interaction, token)),
    upload: (channel, path, { caption, replyTo }) => call('upload', async () => {
      const message = await api.channels.createMessage(channel, {
        ...(caption ? { content: caption.slice(0, 1_000) } : {}), allowed_mentions: NO_PINGS, flags: QUIET,
        ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
        files: [{ name: basename(path), data: await readFile(path) }],
      });
      return { id: message.id };
    }),
  };
};
