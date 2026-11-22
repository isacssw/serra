/** How the bot takes part in a chat thread: who a message is for, what the worker is told, and when the owner is pinged. */

import type { InboundText } from './chat/port.ts';
import { createTracker, systemClock, type Clock, type Timer } from './clock.ts';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Who a message in a thread the bot already owns is meant for.
 * `bot`: it @mentions the bot, or is a DM.
 * `others`: it @mentions people and doesn't name the bot, so it is people talking to each other.
 * `open`: nobody is mentioned, or the bot is named without an @, which can be talking to it or about it.
 *   The worker decides whether it needs an answer.
 */
export type Audience = 'bot' | 'others' | 'open';

/** `said` as the chat read it (`ChatPort.read`): who it mentions, and its words without the mentions. */
export const audienceOf = (said: Pick<InboundText, 'mentions' | 'prose'>, bot: { userId: string; name: string }): Audience => {
  if (said.mentions.includes(bot.userId)) return 'bot';
  // People also call the bot by name without the @.
  const named = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(bot.name)}(?![\\p{L}\\p{N}])`, 'iu').test(said.prose);
  return said.mentions.length > 0 && !named ? 'others' : 'open';
};

/** A display name, safe to use as a speaker label: one line, and unable to imitate the owner marker. */
export const speakerName = (name: string): string => name.replace(/[\r\n()[\]<>]/g, ' ').replace(/\s+/g, ' ').trim() || 'someone';

export interface ThreadLine {
  speaker: string;
  text: string;
  /** `others` reaches the worker as context only: it was said to other people. */
  audience: Audience;
}

/** Every line of the message starts with `>`, so text inside it can't pass for another speaker. */
const quoted = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');

/** Ends a turn nobody @mentioned the bot in. The worker may well stay quiet, so no one is waiting on it. */
const NO_MENTION_HINT = 'Nobody @mentioned you. If none of this needs you, reply with only `(quiet)`.';

/**
 * One worker turn for everything said in the thread since the last one, oldest first.
 * Several quick messages become one turn and one reply, instead of a reply to each.
 */
export const followUpMessage = (lines: ThreadLine[]): string => {
  const body = lines
    .map((line) => `${line.speaker} wrote${line.audience === 'others' ? ', to someone else' : ''}:\n${quoted(line.text)}`)
    .join('\n\n');
  // Without this, a worker answers every message in the thread, including people talking to each other.
  const hint = lines.some((line) => line.audience === 'bot') ? '' : `\n\n${NO_MENTION_HINT}`;
  return `Slack now supports native question forms with selectable options and typed thread answers. Use a question tool for clarification when available; secrets and permission approvals stay in T3.\n\nNew in the Slack thread:\n\n${body}${hint}`;
};

/**
 * Collects what is said in each thread and hands it over in one go: after `quietMs` without a new message,
 * and only once the worker is free, so messages sent during a run become one next turn.
 */
export const createBatcher = <T>({ quietMs, retryMs, busy, flush, onError, clock = systemClock }: {
  quietMs: number;
  retryMs: number;
  busy: (key: string) => Promise<boolean>;
  flush: (key: string, items: T[]) => Promise<void>;
  onError: (key: string, error: unknown, items: T[]) => void | Promise<void>;
  clock?: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
}) => {
  const items = new Map<string, T[]>();
  const timers = new Map<string, Timer>();
  const running = createTracker();
  /** Threads whose turn is being checked or handed over right now. */
  const attempting = new Set<string>();

  const send = async (key: string): Promise<void> => {
    const batch = items.get(key) ?? [];
    items.delete(key);
    if (batch.length === 0) return;
    try { await flush(key, batch); } catch (error) { await onError(key, error, batch); }
  };

  const attempt = async (key: string): Promise<void> => {
    attempting.add(key);
    try { await attemptOnce(key); } finally { attempting.delete(key); }
  };

  const attemptOnce = async (key: string): Promise<void> => {
    timers.delete(key);
    // An unreadable thread state must not hold messages back forever.
    const isBusy = await busy(key).catch(() => false);
    // A message that arrived while the state was being read set its own timer, which sends the whole batch.
    if (timers.has(key)) return;
    if (isBusy) schedule(key, retryMs);
    else await send(key);
  };

  const schedule = (key: string, ms: number): void => {
    clock.clearTimeout(timers.get(key));
    timers.set(key, clock.setTimeout(() => { void running.track(attempt(key)); }, ms));
  };

  return {
    /** `wake: false` keeps the item for the next turn without starting one. */
    add(key: string, item: T, { wake = true, keep = 40 }: { wake?: boolean; keep?: number } = {}): void {
      const batch = [...(items.get(key) ?? []), item];
      items.set(key, batch.slice(-keep));
      if (wake) schedule(key, quietMs);
    },
    /** A turn is waiting to be handed over in this thread. Context kept with `wake: false` alone starts none. */
    holds(key: string): boolean {
      return timers.has(key) || attempting.has(key);
    },
    /** Sends what is waiting for a turn, without waiting for quiet. For shutdown. */
    async drain(): Promise<void> {
      const waiting = [...timers.keys()];
      for (const key of waiting) { clock.clearTimeout(timers.get(key)); timers.delete(key); }
      await Promise.allSettled([running.idle(), ...waiting.map((key) => send(key))]);
    },
    /** Resolves once no turn is being checked or handed over. Timers still waiting don't count. */
    idle(): Promise<void> {
      return running.idle();
    },
  };
};

/** How a reply notifies the owner: `callout` for a new blocker, `cc` once so they follow the thread, otherwise nothing. */
export type OwnerNotice = 'callout' | 'cc' | 'none';

export const ownerNotice = ({ blocked, askOpen, ownerFollows }: {
  /** The reply has a `Needs owner:` line. */
  blocked: boolean;
  /** The owner was already pinged for a blocker and hasn't written in the thread since. */
  askOpen: boolean;
  /** The owner started the thread, wrote in it, or was already cc'd, so Slack shows them its replies. */
  ownerFollows: boolean;
}): OwnerNotice => {
  if (blocked && !askOpen) return 'callout';
  if (!blocked && !ownerFollows) return 'cc';
  return 'none';
};

/** Words that only check whether the bot is there. A message made of nothing else needs no worker. */
const PING_WORDS = new Set([
  'hi', 'hey', 'hello', 'hiya', 'howdy', 'yo', 'sup', 'ping', 'test', 'testing', 'just', 'are', 'r', 'you', 'u', 'there',
  'still', 'available', 'alive', 'awake', 'up', 'online', 'around', 'guys', 'all', 'ok', 'okay', 'morning', 'good',
]);

/**
 * "are you there?", "Hi Are you there?", "hey, just testing": a check that the bot is alive, not a request.
 * Starting a worker and a worktree for it takes minutes and answers nothing, so the bot answers it itself.
 */
export const isPing = (text: string, botName: string): boolean => {
  const words = text
    .toLowerCase()
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(botName.toLowerCase())}(?![\\p{L}\\p{N}])`, 'gu'), ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.length > 0 && words.length <= 8 && words.every((word) => PING_WORDS.has(word));
};
