/**
 * Discord in memory: its REST API behind `@discordjs/rest`'s `makeRequest` (so Serra's own `createDiscordApi` and the
 * library's request handling run for real), and a Gateway that hands the connection events. People write with `say`
 * and press buttons with `click`; every message, edit, reaction, thread and upload the bot makes is recorded.
 *
 * Nothing here reaches the network or a real bot. The token is a fixture value, not a real one, and the snowflakes are
 * made up.
 */
import type { GatewayDispatchPayload } from '@discordjs/core/http-only';
import type { DiscordGateway } from '../../src/discord/gateway.ts';

/** A token-shaped fixture, built from its parts so no secret scanner reads it as a real one. */
const fixtureToken = (id: string, n: string): string => [Buffer.from(id).toString('base64url'), 'Gfixtu', `fixturevalue-discord-${n.repeat(13)}`].join('.');
export const DISCORD_TOKEN = fixtureToken('11111111111111111', '0');
/** Another bot's token: shaped right, but not the one the fake accepts. */
export const OTHER_DISCORD_TOKEN = fixtureToken('22222222222222222', '1');
export const DISCORD_BOT = { id: '1111111111111111111', username: 'friday-serra' };

type Json = Record<string, unknown>;
const json = (status: number, body: unknown): Response => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, code: number, message: string): Response => json(status, { code, message });

export interface Sent { channel: string; id: string; content: string; replyTo?: string; components?: { components: { label: string; custom_id: string }[] }[]; mentions: unknown; flags?: number }
interface Channel { type: number; parent_id?: string; recipient?: string; guild?: string }

export const createFakeDiscord = ({ token = DISCORD_TOKEN }: { token?: string } = {}) => {
  let next = 2_000_000_000_000_000_000n;
  const snowflake = (): string => String(next++);
  const sent: Sent[] = [];
  const edits: { channel: string; id: string; content: string; components: unknown }[] = [];
  const reactions: { channel: string; id: string; emoji: string; on: boolean }[] = [];
  const deleted: { channel: string; id: string }[] = [];
  const typing: string[] = [];
  const threads: { channel: string; message: string; name: string }[] = [];
  const acks: string[] = [];
  const uploads: { channel: string; name: string; caption?: string }[] = [];
  /** Every request: method, URL and whether it carried the bot token, to check where it went. */
  const requests: { method: string; url: string; auth: string | null }[] = [];
  const channels = new Map<string, Channel>();
  /** Messages people wrote, per channel, for history. */
  const history = new Map<string, { id: string; author: { id: string; username: string; bot?: boolean }; content: string }[]>();
  /** Channels where starting a thread is refused (no permission). */
  const noThreads = new Set<string>();
  let busy = 0;
  let activity = 0;

  const route = async (method: string, path: string, query: URLSearchParams, body: Json): Promise<Response> => {
    let match: RegExpExecArray | null;
    if (method === 'GET' && path === '/users/@me') return json(200, { id: DISCORD_BOT.id, username: DISCORD_BOT.username, bot: true, discriminator: '0' });
    if ((match = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path)) && method === 'POST') {
      const [, channel = '', message = ''] = match;
      if (noThreads.has(channel)) return fail(403, 50013, 'Missing Permissions');
      threads.push({ channel, message, name: String(body.name) });
      channels.set(message, { type: 11, parent_id: channel, guild: channels.get(channel)?.guild ?? '' });
      return json(201, { id: message, type: 11, parent_id: channel });
    }
    if ((match = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/.exec(path))) {
      const [, channel = '', id = '', emoji = ''] = match;
      reactions.push({ channel, id, emoji: decodeURIComponent(emoji), on: method === 'PUT' });
      return json(204, null);
    }
    if ((match = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
      const [, channel = '', id = ''] = match;
      if (method === 'DELETE') { deleted.push({ channel, id }); return json(204, null); }
      if (!sent.some((message) => message.channel === channel && message.id === id)) return fail(404, 10008, 'Unknown Message');
      edits.push({ channel, id, content: String(body.content), components: body.components });
      return json(200, { id, channel_id: channel, content: body.content, author: { id: DISCORD_BOT.id, username: DISCORD_BOT.username } });
    }
    if ((match = /^\/channels\/(\d+)\/messages$/.exec(path))) {
      const [, channel = ''] = match;
      if (method === 'GET') {
        const before = BigInt(query.get('before') ?? '0');
        const limit = Number(query.get('limit') ?? 50);
        const all = [...(history.get(channel) ?? []), ...sent.filter((message) => message.channel === channel).map((message) => ({ id: message.id, author: { id: DISCORD_BOT.id, username: DISCORD_BOT.username, bot: true }, content: message.content }))];
        return json(200, all.filter((message) => BigInt(message.id) < before).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, limit));
      }
      const id = snowflake();
      const reference = body.message_reference as { message_id?: string } | undefined;
      if (body.files) {
        uploads.push({ channel, name: String(body.files), ...(body.content ? { caption: String(body.content) } : {}) });
        return json(200, { id, channel_id: channel });
      }
      sent.push({
        channel, id, content: String(body.content), mentions: body.allowed_mentions, ...(typeof body.flags === 'number' ? { flags: body.flags } : {}),
        ...(reference?.message_id ? { replyTo: reference.message_id } : {}), ...(body.components ? { components: body.components as Sent['components'] } : {}),
      });
      return json(200, { id, channel_id: channel, content: body.content, author: { id: DISCORD_BOT.id, username: DISCORD_BOT.username } });
    }
    if ((match = /^\/channels\/(\d+)\/typing$/.exec(path))) { typing.push(match[1] ?? ''); return json(204, null); }
    if ((match = /^\/channels\/(\d+)$/.exec(path))) {
      const id = match[1] ?? '';
      const channel = channels.get(id);
      if (!channel) return fail(404, 10003, 'Unknown Channel');
      return json(200, { id, type: channel.type, ...(channel.parent_id ? { parent_id: channel.parent_id } : {}), ...(channel.recipient ? { recipients: [{ id: channel.recipient, username: 'someone' }] } : {}) });
    }
    if ((match = /^\/interactions\/(\d+)\/([^/]+)\/callback$/.exec(path))) { acks.push(match[1] ?? ''); return json(204, null); }
    return fail(404, 0, `404: Not Found ${method} ${path}`);
  };

  const makeRequest = async (url: string, init: RequestInit): Promise<Response> => {
    busy += 1;
    activity += 1;
    try {
      const headers = new Headers(init.headers);
      const parsed = new URL(url);
      requests.push({ method: init.method ?? 'GET', url, auth: headers.get('authorization') });
      if (parsed.origin !== 'https://discord.com' || !parsed.pathname.startsWith('/api/v10/')) throw new TypeError('fetch failed');
      // An interaction's answer is authorised by the interaction's own token, in the URL: the bot token isn't sent.
      if (!parsed.pathname.startsWith('/api/v10/interactions/') && headers.get('authorization') !== `Bot ${token}`) return fail(401, 0, '401: Unauthorized');
      let body: Json = {};
      if (init.body instanceof FormData) {
        body = JSON.parse(String(init.body.get('payload_json') ?? '{}')) as Json;
        const file = init.body.get('files[0]');
        body.files = file && typeof file !== 'string' ? file.name : 'file';
      } else if (typeof init.body === 'string') body = JSON.parse(init.body) as Json;
      return await route(init.method ?? 'GET', decodeURIComponent(parsed.pathname.slice('/api/v10'.length)), parsed.searchParams, body);
    } finally { busy -= 1; }
  };

  // --- the Gateway ---
  let events: Parameters<DiscordGateway['connect']>[0] | null = null;
  let connects = 0;
  let refuseConnects = 0;
  let destroyed = 0;
  const gateway: DiscordGateway = {
    async connect(handlers) {
      connects += 1;
      if (refuseConnects > 0) { refuseConnects -= 1; throw new TypeError('fetch failed'); }
      events = handlers;
      handlers.ready();
    },
    async destroy() { destroyed += 1; events = null; },
  };

  /** Waits until the bot has done everything it will do for now: no request in flight, and none for a while. */
  const idle = async (): Promise<void> => {
    let quiet = 0;
    let seen = activity;
    while (quiet < 30) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (busy === 0 && seen === activity) quiet += 1;
      else { quiet = 0; seen = activity; }
    }
  };

  const dispatch = async (payload: GatewayDispatchPayload): Promise<void> => {
    if (!events) throw new Error('the bot is not connected to the fake Gateway');
    events.dispatch(payload);
    await idle();
  };

  return {
    makeRequest, gateway,
    sent, edits, reactions, deleted, typing, threads, acks, uploads, requests, channels, history, noThreads,
    connects: () => connects, destroyed: () => destroyed, connected: () => events !== null,
    /** The next `n` connections fail as if Discord were unreachable. */
    refuseNextConnects: (n: number) => { refuseConnects = n; },
    /** The socket drops with `code`, and (unless `stayDown`) the library resumes it. */
    drop: async (code: number, { stayDown = false }: { stayDown?: boolean } = {}) => {
      events?.closed(code);
      if (!stayDown) events?.ready();
      await idle();
    },
    /** A server text channel, a DM, or a thread Discord knows about. */
    addChannel: (id: string, channel: Channel) => { channels.set(id, channel); },
    /**
     * Someone writes. In a DM when `guild` is absent (the channel is the DM's), else in a server channel or thread.
     * `mention` puts the bot's mention in front. Returns the message's ID once the bot has done what it will.
     */
    say: async ({ from, channel, text, guild, mention = false, replyTo, name = `Person ${from}`, attachment, bot = false }:
      { from: string; channel: string; text: string; guild?: string; mention?: boolean; replyTo?: string; name?: string; attachment?: { url: string; filename: string; size?: number }; bot?: boolean }): Promise<string> => {
      const id = snowflake();
      const content = mention ? `<@${DISCORD_BOT.id}> ${text}` : text;
      const author = { id: from, username: name.toLowerCase().replace(/\s+/g, '_'), global_name: name, discriminator: '0', avatar: null, ...(bot ? { bot: true } : {}) };
      history.set(channel, [...(history.get(channel) ?? []), { id, author, content }]);
      await dispatch({
        t: 'MESSAGE_CREATE', op: 0, s: 1,
        d: {
          id, channel_id: channel, author, content, type: replyTo ? 19 : 0, timestamp: '', edited_timestamp: null, tts: false, mention_everyone: false,
          mentions: mention ? [{ id: DISCORD_BOT.id, username: DISCORD_BOT.username, discriminator: '0', avatar: null, bot: true }] : [],
          mention_roles: [], attachments: attachment ? [{ id: snowflake(), size: 12, proxy_url: attachment.url, ...attachment }] : [], embeds: [], pinned: false,
          ...(guild ? { guild_id: guild } : {}), ...(replyTo ? { message_reference: { message_id: replyTo, channel_id: channel } } : {}),
        },
      } as unknown as GatewayDispatchPayload);
      return id;
    },
    /** Someone presses a button on a message the bot sent. */
    click: async ({ from, message, customId, guild }: { from: string; message: Sent; customId: string; guild?: string }): Promise<void> => {
      const user = { id: from, username: `person${from}`, global_name: `Person ${from}`, discriminator: '0', avatar: null };
      await dispatch({
        t: 'INTERACTION_CREATE', op: 0, s: 2,
        d: {
          id: snowflake(), application_id: DISCORD_BOT.id, type: 3, token: 'interaction-token-fixture', version: 1,
          channel: { id: message.channel, type: guild ? 11 : 1 }, channel_id: message.channel,
          data: { custom_id: customId, component_type: 2 },
          message: { id: message.id, channel_id: message.channel },
          ...(guild ? { guild_id: guild, member: { user } } : { user }),
        },
      } as unknown as GatewayDispatchPayload);
    },
    idle,
  };
};
