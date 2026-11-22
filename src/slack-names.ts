/**
 * Slack names for the app (APP-29): a member ID like `U0EXAMPLE01` as the person's display name (else their real
 * name), a bot ID like `B0123456789` (an alert posted by an integration or webhook) as the bot's name, and a channel
 * ID as `#name`, so Jobs and notifications don't show raw IDs. `slackPlainText` turns Slack's mrkdwn into plain text.
 *
 * `createSlackNames` runs in the daemon (SERRA-55): the app asks the bot over the status socket and gets names back,
 * so the app never reads the bot token (`slack-names-store.ts` is the app's side). Lookups never block: `userName`
 * and `channelName` answer from the cache only, and `request` looks the misses up with the bot token (`users.info`,
 * `bots.info`, `conversations.info`), then calls `onResolved`. A lookup that fails leaves the raw ID in place and
 * isn't retried for a while. The token comes from `token()` (the daemon's own, already in memory) and is never
 * logged: errors carry Slack's error code only.
 */

/** The labels a DM or group DM gets. Their IDs start with `D` (or come back as `is_im`/`is_mpim`). */
export const DM_LABEL = 'DM';
export const GROUP_DM_LABEL = 'Group DM';

/** Slack member and channel IDs. Anything else (the app's own `app` channel, an empty requester) is never looked up. */
export const isSlackUserId = (id: string): boolean => /^[UW][A-Z0-9]{2,}$/.test(id);
/** A bot's ID: what a job's requester is when an integration, webhook or another app posted the message. */
export const isSlackBotId = (id: string): boolean => /^B[A-Z0-9]{2,}$/.test(id);
export const isSlackChannelId = (id: string): boolean => /^[CGD][A-Z0-9]{2,}$/.test(id);

/** Looks one ID up. Resolves null when Slack has no usable name; throws (with Slack's error code) when it refuses. */
export interface SlackNameLookup {
  user(id: string): Promise<string | null>;
  channel(id: string): Promise<string | null>;
  /** A bot's name (`bots.info`, covered by `users:read`). Without it, bot IDs stay raw. */
  bot?(id: string): Promise<string | null>;
}

interface SlackUserLike { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }
interface SlackChannelLike { name?: string; is_im?: boolean; is_mpim?: boolean }

/** The display name, else the real name, else the handle. */
export const userLabel = (user: SlackUserLike | undefined): string | null =>
  user?.profile?.display_name?.trim() || user?.real_name?.trim() || user?.profile?.real_name?.trim() || user?.name?.trim() || null;

/** `#name` for a channel, `DM` and `Group DM` for conversations without a name worth showing. */
export const channelLabel = (channel: SlackChannelLike | undefined): string | null => {
  if (!channel) return null;
  if (channel.is_im) return DM_LABEL;
  if (channel.is_mpim) return GROUP_DM_LABEL;
  return channel.name?.trim() ? `#${channel.name.trim()}` : null;
};

/** Slack's error code, never the request: the WebClient's errors don't carry the token, but nothing else is kept either. */
const slackError = (error: unknown): Error => {
  const code = (error as { data?: { error?: unknown } }).data?.error;
  return new Error(typeof code === 'string' ? code : (error as { code?: unknown }).code === 'slack_webapi_request_error' ? 'request_failed' : 'lookup_failed');
};

/** The real lookup, through Bolt's WebClient with the bot token. */
export const slackApiLookup = async (token: string): Promise<SlackNameLookup> => {
  // Loaded here so the renderer-facing modules that import this file don't pull in Bolt.
  const { webApi } = await import('@slack/bolt');
  const client = new webApi.WebClient(token, { retryConfig: { retries: 0 }, timeout: 10_000, logLevel: webApi.LogLevel.ERROR });
  return {
    user: async (id) => {
      try { return userLabel((await client.users.info({ user: id })).user as SlackUserLike | undefined); }
      catch (error) { throw slackError(error); }
    },
    channel: async (id) => {
      try { return channelLabel((await client.conversations.info({ channel: id })).channel as SlackChannelLike | undefined); }
      catch (error) { throw slackError(error); }
    },
    bot: async (id) => {
      try { return (await client.bots.info({ bot: id })).bot?.name?.trim() || null; }
      catch (error) { throw slackError(error); }
    },
  };
};

export interface SlackNamesOptions {
  /** The bot token, read when a batch needs it. Throws or resolves undefined when there is none. */
  token(): Promise<string | undefined>;
  /** Builds the lookup for a token. Tests pass a fake. */
  lookup?: (token: string) => Promise<SlackNameLookup>;
  /** How long a name is kept (default 6 h): people rename themselves and channels rarely. */
  ttlMs?: number;
  /** How long a failed lookup waits before it's tried again (default 10 min). */
  retryMs?: number;
  /** At most this many lookups at once (default 4), well under Slack's rate limits. */
  concurrency?: number;
  now?: () => number;
  /** Called once a batch found at least one new name. */
  onResolved?: () => void;
  /** Where a failed lookup is reported: the ID and Slack's error code, never the token. */
  log?: (message: string) => void;
}

export interface SlackNames {
  /** The cached name of a member or a bot, or undefined: the caller shows the raw ID. Never waits. */
  userName(id: string): string | undefined;
  channelName(id: string): string | undefined;
  /**
   * Looks up the IDs not cached yet, in the background. `users` takes member and bot IDs. Resolves true when a new
   * name was found. Never rejects.
   */
  request(ids: { users?: Iterable<string>; channels?: Iterable<string> }): Promise<boolean>;
}

type Kind = 'user' | 'bot' | 'channel';
interface Entry { name: string | null; until: number }

export const createSlackNames = ({
  token, lookup = slackApiLookup, ttlMs = 6 * 60 * 60_000, retryMs = 10 * 60_000, concurrency = 4,
  now = () => Date.now(), onResolved = () => {}, log = () => {},
}: SlackNamesOptions): SlackNames => {
  const cache = new Map<string, Entry>();
  const inFlight = new Set<string>();
  /** The last failure logged per ID, so a lookup that keeps failing the same way is logged once. */
  const reported = new Map<string, string>();
  let tokenReported = false;
  const keyOf = (kind: Kind, id: string): string => `${kind}:${id}`;

  const cached = (kind: Kind, id: string): string | undefined => {
    if (kind === 'channel' && id.startsWith('D')) return DM_LABEL;
    // An expired name is still shown while `request` refreshes it: a name a few hours old beats a raw ID.
    return cache.get(keyOf(kind, id))?.name ?? undefined;
  };

  /** True while the entry is fresh (or a recent failure is still waiting out its retry delay). */
  const fresh = (kind: Kind, id: string): boolean => (cache.get(keyOf(kind, id))?.until ?? 0) > now();

  const request: SlackNames['request'] = async ({ users = [], channels = [] }) => {
    const wanted: [Kind, string][] = [
      ...[...new Set(users)].filter(isSlackUserId).map((id): [Kind, string] => ['user', id]),
      ...[...new Set(users)].filter(isSlackBotId).map((id): [Kind, string] => ['bot', id]),
      // A DM's label is known without asking Slack (which would need `im:read`).
      ...[...new Set(channels)].filter((id) => isSlackChannelId(id) && !id.startsWith('D')).map((id): [Kind, string] => ['channel', id]),
    ].filter(([kind, id]) => !fresh(kind, id) && !inFlight.has(keyOf(kind, id)));
    if (wanted.length === 0) return false;
    for (const [kind, id] of wanted) inFlight.add(keyOf(kind, id));

    const fail = (kind: Kind, id: string, reason: string, quiet = false): void => {
      // A stale name stays shown until a lookup succeeds again; only a wait before the retry is recorded.
      const previous = cache.get(keyOf(kind, id))?.name ?? null;
      cache.set(keyOf(kind, id), { name: previous, until: now() + retryMs });
      if (!quiet && reported.get(keyOf(kind, id)) !== reason) log(`[serra] could not look up Slack ${kind} ${id}: ${reason}`);
      reported.set(keyOf(kind, id), reason);
    };

    let found = false;
    try {
      let client: SlackNameLookup;
      try {
        const value = await token();
        if (!value) throw new Error('no bot token');
        client = await lookup(value);
        tokenReported = false;
      } catch {
        // Whatever went wrong reading the token, its message isn't repeated: it could name the source or worse.
        if (!tokenReported) log('[serra] Slack names are off: the bot token could not be read. The app shows Slack IDs.');
        tokenReported = true;
        for (const [kind, id] of wanted) fail(kind, id, 'no token', true);
        return false;
      }
      const queue = [...wanted];
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [kind, id] = next;
          try {
            const name = await (kind === 'user' ? client.user(id) : kind === 'bot' ? (client.bot?.(id) ?? null) : client.channel(id));
            if (!name) { fail(kind, id, 'no name'); continue; }
            if (cache.get(keyOf(kind, id))?.name !== name) found = true;
            cache.set(keyOf(kind, id), { name, until: now() + ttlMs });
            reported.delete(keyOf(kind, id));
          } catch (error) {
            fail(kind, id, error instanceof Error ? error.message : 'lookup_failed');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
    } finally {
      for (const [kind, id] of wanted) inFlight.delete(keyOf(kind, id));
    }
    if (found) {
      try { onResolved(); } catch { /* a listener's failure isn't the lookup's */ }
    }
    return found;
  };

  return {
    userName: (id) => cached(isSlackBotId(id) ? 'bot' : 'user', id),
    channelName: (id) => cached('channel', id),
    request: (ids) => request(ids).catch(() => false),
  };
};

/**
 * Answers the app's name requests in the daemon (`StatusServerOptions.names`): looks up the misses, then gives the
 * names it knows for exactly the IDs asked, and nothing else. Never rejects.
 */
export const answerNameRequests = (names: SlackNames) => async ({ users, channels }: { users: string[]; channels: string[] }): Promise<{ users: Record<string, string>; channels: Record<string, string> }> => {
  await names.request({ users, channels });
  const named = (ids: string[], name: (id: string) => string | undefined): Record<string, string> =>
    Object.fromEntries(ids.flatMap((id) => { const found = name(id); return found ? [[id, found]] : []; }));
  return { users: named(users, names.userName), channels: named(channels, names.channelName) };
};

// ---------------------------------------------------------------------------------------------------------------
// mrkdwn as plain text
// ---------------------------------------------------------------------------------------------------------------

/** The emoji alert integrations put first in their messages. Any other `:shortcode:` is dropped. */
const EMOJI: Record<string, string> = {
  red_circle: '🔴', large_red_circle: '🔴', large_orange_circle: '🟠', orange_circle: '🟠', large_yellow_circle: '🟡',
  yellow_circle: '🟡', large_green_circle: '🟢', green_circle: '🟢', large_blue_circle: '🔵', white_check_mark: '✅',
  heavy_check_mark: '✔️', x: '❌', warning: '⚠️', rotating_light: '🚨', fire: '🔥', bug: '🐛', boom: '💥', eyes: '👀',
};

/** Who and what Slack markup mentions: `<@U…>` members and `<#C…>` channels, for `SlackNames.request`. */
export const slackMentions = (text: string): { users: string[]; channels: string[] } => ({
  users: [...new Set([...text.matchAll(/<@([UWB][A-Z0-9]{2,})(?:\|[^>]*)?>/g)].map((match) => match[1]!))],
  channels: [...new Set([...text.matchAll(/<#([CGD][A-Z0-9]{2,})(?:\|[^>]*)?>/g)].map((match) => match[1]!))],
});

/**
 * Slack mrkdwn as plain text, for a job's title and summary: `<url|text>` is its text, `<@U…>` is `@name` (the name
 * when `names` knows it, the label Slack sent, else the raw ID), `<#C…|name>` is `#name`, `<!here>` is `@here`,
 * `*bold*`, `_italic_`, `~strike~` and backticks lose their marks, emoji shortcodes become the emoji (or go), and
 * `&lt;` `&gt;` `&amp;` are decoded last so they never turn into markup. A title T3 cut short may leave a mark open:
 * that one goes too.
 */
export const slackPlainText = (text: string, names: { user?: (id: string) => string | undefined; channel?: (id: string) => string | undefined } = {}): string => text
  .replace(/<([^<>]+)>/g, (_whole, inner: string) => {
    const [target = '', label] = inner.split('|', 2) as [string, string | undefined];
    if (target.startsWith('@')) return `@${names.user?.(target.slice(1)) ?? label ?? target.slice(1)}`;
    if (target.startsWith('#')) {
      const name = names.channel?.(target.slice(1)) ?? (label ? `#${label}` : target);
      return name.startsWith('#') || name === DM_LABEL || name === GROUP_DM_LABEL ? name : `#${name}`;
    }
    if (target.startsWith('!subteam^')) return label ?? '@group';
    if (target.startsWith('!date^')) return label ?? '';
    if (target.startsWith('!')) return `@${target.slice(1)}`;
    return label ?? target.replace(/^mailto:/, '');
  })
  .replace(/:([a-z0-9_+-]+):/g, (_whole, code: string) => EMOJI[code] ?? '')
  // Bold, italic and strike marks hug the words they wrap; a lone mark (cut-off title) also goes, a `*` in `2 * 3` stays.
  .replace(/(^|[\s(\[])[*_~]+(?=\S)|(?<=\S)[*_~]+(?=$|[\s).,:;!?\]])/g, '$1')
  .replace(/`+/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/[ \t]{2,}/g, ' ')
  .trim();
