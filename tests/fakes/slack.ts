/**
 * A recording Slack. It implements `SlackApi`, the Web API surface the daemon calls, so the compiler checks it against
 * the real client's types, and records every call in order (`calls`) for tests to assert on. It keeps a little state the
 * way Slack does: posted and edited messages show up in `conversations.replies`, reactions add and remove, a deleted
 * message can't be edited. Any method can be failed or held on cue: `fail` throws Slack's error shape, `hang` records
 * the call (Slack received it) and never answers, which is how a scenario simulates a crash mid-call.
 */
import type { SlackApi } from '../../src/slack-api.ts';

export type SlackMethod =
  | 'auth.test' | 'chat.postMessage' | 'chat.update' | 'chat.delete' | 'chat.getPermalink' | 'reactions.add' | 'reactions.remove'
  | 'assistant.threads.setStatus' | 'users.info' | 'conversations.info' | 'conversations.replies' | 'files.info' | 'filesUploadV2';

interface SlackCall { method: SlackMethod; args: Record<string, unknown> }

/** A message as `conversations.replies` returns it. */
export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  text?: string;
  blocks?: unknown[];
  files?: unknown[];
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
}

/** The error a WebClient call rejects with: Slack's code in `data.error`. */
export const slackError = (code: string): Error => Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });

export interface FakeSlackOptions {
  botUserId?: string;
  botId?: string;
  team?: string;
  /** Display names by user ID. */
  names?: Record<string, string>;
  /** The workspace each user is in; defaults to the bot's team. */
  teams?: Record<string, string>;
  /** Channels shared with another company. Every other channel is internal. */
  external?: Set<string> | Iterable<string>;
  /** The time, for message ts as Slack makes them (seconds, then a sequence). Defaults to the real clock. */
  now?: () => number;
  files?: Record<string, Record<string, unknown>>;
  /** Whether `conversations.replies` returns message metadata when asked. Default true; false for a workspace that leaves it out. */
  returnsMetadata?: boolean;
  /** Store posted text as Slack does: `&`, `<`, `>` escaped outside link markup, and bare links wrapped as `<url>`. */
  rewritesText?: boolean;
}

/** What Slack stores for posted text: link and mention markup (`<http…>`, `<@…>`, `<#…>`, `<!…>`) kept, other `&<>` escaped, bare URLs wrapped. */
export const slackStoredText = (text: string): string => text.split(/(<(?:https?:|mailto:|@|#|!)[^<>]+>)/).map((part, index) => index % 2 === 1
  ? part
  : part.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/https?:\/\/[^\s&]+/g, (url) => `<${url}>`)).join('');

type Rule = { times: number; act: (args: Record<string, unknown>) => unknown };

export const createFakeSlack = (options: FakeSlackOptions = {}) => {
  const botUserId = options.botUserId ?? 'UBOT';
  const team = options.team ?? 'THOME';
  let counter = 0;
  const now = options.now ?? Date.now;
  const nextTs = (): string => `${Math.floor(now() / 1000)}.${String(++counter).padStart(6, '0')}`;
  const calls: SlackCall[] = [];
  /** Messages Slack accepted, in order, with the ts it gave each. */
  const posted: (Record<string, unknown> & { ts: string })[] = [];
  /** Edits Slack applied, in order. */
  const edited: Record<string, unknown>[] = [];
  /** Every message in every thread, as Slack would hold it. Tests may add people's messages with `addMessage`. */
  const messages = new Map<string, SlackMessage[]>();
  /** Deleted message ts, live: a test may push one to act as someone deleting it. */
  const deleted: string[] = [];
  const reactions = new Map<string, Set<string>>();
  // A Set given here stays live: the test may share a channel outside, or stop sharing it, mid-test.
  const external = options.external instanceof Set ? options.external : new Set(options.external ?? []);
  const names: Record<string, string> = { ...options.names };
  const teams: Record<string, string> = { ...options.teams };
  const rules = new Map<SlackMethod, Rule[]>();
  const before = new Map<SlackMethod, ((args: Record<string, unknown>) => void | Promise<void>)[]>();

  const threadKey = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;
  const inThread = (channel: string, threadTs: string): SlackMessage[] => {
    const key = threadKey(channel, threadTs);
    if (!messages.has(key)) messages.set(key, []);
    return messages.get(key)!;
  };
  const find = (channel: string, ts: string): SlackMessage | undefined =>
    [...messages.entries()].filter(([key]) => key.startsWith(`${channel}:`)).flatMap(([, list]) => list).find((message) => message.ts === ts);

  let markHung = (): void => {};
  let hungSignal = new Promise<void>((resolve) => { markHung = resolve; });
  const HANG_AFTER = Symbol('hang after');
  const HANG = Symbol('hang');
  /** Records the call, runs hooks, applies a scripted failure or hold, then Slack's answer. */
  const call = async <R>(method: SlackMethod, args: unknown, answer: () => R): Promise<R> => {
    const record = { ...(args as Record<string, unknown> | undefined) };
    calls.push({ method, args: record });
    for (const hook of before.get(method) ?? []) await hook(record);
    const rule = rules.get(method)?.[0];
    if (rule) {
      rule.times -= 1;
      if (rule.times <= 0) rules.get(method)!.shift();
      const outcome = rule.act(record);
      if (outcome instanceof Error) throw outcome;
      if (outcome === HANG) { markHung(); return new Promise<never>(() => {}); }
      if (outcome === HANG_AFTER) {
        answer();
        markHung();
        return new Promise<never>(() => {});
      }
    }
    return answer();
  };

  const post = (args: Record<string, unknown>): SlackMessage => {
    const channel = String(args.channel);
    const ts = nextTs();
    const threadTs = typeof args.thread_ts === 'string' ? args.thread_ts : ts;
    const message: SlackMessage = {
      ts, user: botUserId, bot_id: options.botId ?? 'BBOT',
      text: typeof args.text !== 'string' ? '' : options.rewritesText ? slackStoredText(args.text) : args.text,
      ...(threadTs !== ts ? { thread_ts: threadTs } : {}),
      ...(Array.isArray(args.blocks) ? { blocks: args.blocks as unknown[] } : {}),
      ...(args.metadata ? { metadata: args.metadata as SlackMessage['metadata'] } : {}),
    };
    inThread(channel, threadTs).push(message);
    posted.push({ ...args, ts });
    return message;
  };

  const client: SlackApi = {
    auth: { test: (args) => call('auth.test', args, () => ({ ok: true, user_id: botUserId, bot_id: options.botId ?? 'BBOT', user: 'serra', team: 'Acme', team_id: team })) },
    chat: {
      postMessage: (args) => call('chat.postMessage', args, () => {
        const message = post(args as unknown as Record<string, unknown>);
        return { ok: true, ts: message.ts, channel: String(args.channel) };
      }),
      update: (args) => call('chat.update', args, () => {
        if (deleted.includes(args.ts)) throw slackError('message_not_found');
        edited.push({ ...(args as unknown as Record<string, unknown>) });
        const message = find(args.channel, args.ts);
        if (message) {
          const fields = args as unknown as Record<string, unknown>;
          if (typeof fields.text === 'string') message.text = fields.text;
          if (Array.isArray(fields.blocks)) message.blocks = fields.blocks as unknown[];
        }
        return { ok: true, ts: args.ts, channel: args.channel };
      }),
      delete: (args) => call('chat.delete', args, () => {
        deleted.push(args.ts);
        for (const list of messages.values()) {
          const index = list.findIndex((message) => message.ts === args.ts);
          if (index !== -1) list.splice(index, 1);
        }
        return { ok: true, ts: args.ts, channel: args.channel };
      }),
      getPermalink: (args) => call('chat.getPermalink', args, () => ({ ok: true, permalink: `https://slack.test/archives/${args.channel}/p${args.message_ts.replace('.', '')}` })),
    },
    reactions: {
      add: (args) => call('reactions.add', args, () => {
        const key = `${args.channel}:${args.timestamp}`;
        if (!reactions.has(key)) reactions.set(key, new Set());
        reactions.get(key)!.add(args.name);
        return { ok: true };
      }),
      remove: (args) => call('reactions.remove', args, () => {
        const target = args as { channel?: string; timestamp?: string };
        reactions.get(`${target.channel}:${target.timestamp}`)?.delete(args.name);
        return { ok: true };
      }),
    },
    assistant: { threads: { setStatus: (args) => call('assistant.threads.setStatus', args, () => ({ ok: true })) } },
    users: {
      info: (args) => call('users.info', args, () => ({ ok: true, user: { id: args.user, real_name: names[args.user] ?? args.user, team_id: teams[args.user] ?? team } })),
    },
    conversations: {
      info: (args) => call('conversations.info', args, () => ({
        ok: true, channel: { id: args.channel, is_im: args.channel.startsWith('D'), is_ext_shared: external.has(args.channel), is_pending_ext_shared: false },
      })),
      replies: (args) => call('conversations.replies', args, () => {
        const oldest = typeof args.oldest === 'string' ? Number(args.oldest) : -Infinity;
        const list = inThread(args.channel, args.ts).filter((message) => message.ts === args.ts || Number(message.ts) >= oldest);
        // Slack's message element type is wider than what these tests keep; the fields here are a subset of it.
        const shown = list.map((message) => ({ ...message, ...(args.include_all_metadata && options.returnsMetadata !== false ? {} : { metadata: undefined }) }));
        return { ok: true, has_more: false, messages: shown as NonNullable<Awaited<ReturnType<SlackApi['conversations']['replies']>>['messages']> };
      }),
    },
    files: {
      info: (args) => call('files.info', args, () => {
        const file = options.files?.[args.file];
        if (!file) throw slackError('file_not_found');
        return { ok: true, file };
      }),
    },
    filesUploadV2: (args) => call('filesUploadV2', args, () => ({ ok: true, files: [] })),
  };

  return {
    client,
    calls,
    posted,
    edited,
    deleted,
    botUserId,
    /** The calls to one method, in order. */
    callsTo: (method: SlackMethod): Record<string, unknown>[] => calls.filter((entry) => entry.method === method).map((entry) => entry.args),
    /** The messages in a thread, as Slack holds them now. */
    thread: (channel: string, threadTs: string): SlackMessage[] => inThread(channel, threadTs),
    /** A person's message, so it shows in `conversations.replies`. Returns its ts. */
    addMessage: (channel: string, message: SlackMessage): string => {
      inThread(channel, message.thread_ts ?? message.ts).push(message);
      return message.ts;
    },
    /** `channel:ts` of every message carrying this reaction now. */
    withReaction: (name: string): string[] => [...reactions.entries()].filter(([, names]) => names.has(name)).map(([at]) => at),
    /** The reactions a message carries now. */
    reactionsOn: (channel: string, ts: string): string[] => [...(reactions.get(`${channel}:${ts}`) ?? [])],
    /** The next `times` calls to `method` fail with Slack's `code`, or with the given error. */
    fail: (method: SlackMethod, error: string | Error, times = 1): void => {
      const rule: Rule = { times, act: () => (typeof error === 'string' ? slackError(error) : error) };
      rules.set(method, [...(rules.get(method) ?? []), rule]);
    },
    /** The next call to `method` reaches Slack (it is recorded and takes effect) but never answers: the process died waiting. */
    hangAfter: (method: SlackMethod): void => {
      rules.set(method, [...(rules.get(method) ?? []), { times: 1, act: () => HANG_AFTER }]);
    },
    /** The next call to `method` is recorded and never answers, without taking effect. */
    hang: (method: SlackMethod): void => {
      rules.set(method, [...(rules.get(method) ?? []), { times: 1, act: () => HANG }]);
    },
    /** Runs before every call to `method`, for tests that change the world mid-call. */
    before: (method: SlackMethod, hook: (args: Record<string, unknown>) => void | Promise<void>): void => {
      before.set(method, [...(before.get(method) ?? []), hook]);
    },
    /** Resolves once a call has been held by `hang` or `hangAfter`. */
    whenHung: (): Promise<void> => hungSignal,
    /** Forgets earlier holds, for the next process. */
    resetHung: (): void => { hungSignal = new Promise<void>((resolve) => { markHung = resolve; }); },
    shareExternally: (channel: string): void => { external.add(channel); },
    setName: (user: string, name: string): void => { names[user] = name; },
  };
};

export type FakeSlack = ReturnType<typeof createFakeSlack>;
