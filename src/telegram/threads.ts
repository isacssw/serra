/**
 * Telegram has no threads a bot can read back: no history API, and a reply only names the one message it answers. So
 * Serra keeps its own small record per profile (`telegram/threads.json`): which thread each message belongs to (a
 * thread is named by its first message, like a Slack thread), what was said in each thread, which thread was last
 * used in each chat, and the message each run's reply went out as, so a restart finds it instead of posting it again.
 *
 * Bounded: the newest threads, lines and replies are kept, older ones fall off. Written atomically on every change,
 * owner-only.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic.ts';
import { isRecord } from '../lib/guards.ts';

const MAX_MESSAGES = 5000;
const MAX_THREADS = 300;
const MAX_LINES = 60;
const MAX_REPLIES = 500;
const MAX_TEXT = 4000;

/** One message in a thread, as Serra saw it: `from` is `self` (the bot) or the person's Telegram user ID. */
interface ThreadLine { id: string; from: string; text: string }

interface ThreadsFile {
  version: 1;
  /** `chat:message` → the thread's first message. */
  messages: Record<string, string>;
  /** `chat:thread` → when it was last used, and its lines oldest first. */
  threads: Record<string, { at: number; lines: ThreadLine[] }>;
  /** chat → the thread last used there. */
  last: Record<string, string>;
  /** run ID → the message its reply went out as. */
  replies: Record<string, { chat: string; id: string }>;
}

const empty = (): ThreadsFile => ({ version: 1, messages: {}, threads: {}, last: {}, replies: {} });

/** The newest `max` entries of a record kept in insertion order. */
const newest = <T>(entries: Record<string, T>, max: number): Record<string, T> => {
  const keys = Object.keys(entries);
  if (keys.length <= max) return entries;
  return Object.fromEntries(keys.slice(-max).flatMap((key) => { const value = entries[key]; return value === undefined ? [] : [[key, value] as const]; }));
};

export interface ThreadStore {
  /** The thread a message belongs to, if Serra saw it. */
  threadOf(chat: string, message: string): string | undefined;
  /** The thread last used in a chat, and when. */
  lastIn(chat: string): { thread: string; at: number } | undefined;
  /** Records a message in a thread (and makes it the chat's last). `line` is what it said, for `history`. */
  add(chat: string, thread: string, line: ThreadLine, at: number): void;
  /** The thread's lines before message `before`, oldest first. */
  lines(chat: string, thread: string, before: string): ThreadLine[];
  /** The message a run's reply went out as. */
  replyOf(runId: string): { chat: string; id: string } | undefined;
  recordReply(runId: string, chat: string, id: string): void;
}

export const createThreadStore = (profileDir: string, warn: (message: string) => void = () => {}): ThreadStore => {
  const dir = join(profileDir, 'telegram');
  const path = join(dir, 'threads.json');
  let file: ThreadsFile = empty();
  if (existsSync(path)) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(value) && value.version === 1 && isRecord(value.messages) && isRecord(value.threads) && isRecord(value.last) && isRecord(value.replies)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Serra's own file, checked to the top level; entries are read defensively
        file = value as unknown as ThreadsFile;
      } else warn('telegram/threads.json is not Serra\'s format; starting a new one.');
    } catch { warn('telegram/threads.json can\'t be read; starting a new one.'); }
  }
  const save = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    file.messages = newest(file.messages, MAX_MESSAGES);
    file.threads = newest(file.threads, MAX_THREADS);
    file.replies = newest(file.replies, MAX_REPLIES);
    writeFileAtomic(path, JSON.stringify(file), { mode: 0o600 });
  };

  return {
    threadOf: (chat, message) => file.messages[`${chat}:${message}`],
    lastIn(chat) {
      const thread = file.last[chat];
      const at = thread === undefined ? undefined : file.threads[`${chat}:${thread}`]?.at;
      return thread !== undefined && at !== undefined ? { thread, at } : undefined;
    },
    add(chat, thread, line, at) {
      const key = `${chat}:${thread}`;
      const known = file.threads[key];
      // Moved to the end, so the newest threads are the ones kept.
      delete file.threads[key];
      const lines = [...(known?.lines ?? []).filter((each) => each.id !== line.id), { ...line, text: line.text.slice(0, MAX_TEXT) }].slice(-MAX_LINES);
      file.threads[key] = { at, lines };
      delete file.messages[`${chat}:${line.id}`];
      file.messages[`${chat}:${line.id}`] = thread;
      file.last[chat] = thread;
      save();
    },
    lines: (chat, thread, before) => (file.threads[`${chat}:${thread}`]?.lines ?? []).filter((line) => Number(line.id) < Number(before)),
    replyOf: (runId) => file.replies[runId],
    recordReply(runId, chat, id) {
      file.replies[runId] = { chat, id };
      save();
    },
  };
};
