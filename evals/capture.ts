// Builds the brief Serra's own code sends a worker for one eval case: a real `createBot` with a recording chat
// client and a T3 stub that keeps the brief instead of starting a thread, or `taskBrief` for a task started in the
// app. Nothing here decides what goes into the brief; that is the code under test.
import { createBot } from '../src/bot.ts';
import { loadConfig } from '../src/config.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { createStore } from '../src/state.ts';
import { taskBrief } from '../src/tasks.ts';
import type { webApi } from '@slack/bolt';

export interface EvalCase {
  /** dm: a DM with the bot. channel: a workspace channel. shared: a channel shared with another company. app: an app task. */
  via: 'dm' | 'channel' | 'shared' | 'app';
  /** Slack member ID of who writes the request. */
  user: string;
  text: string;
  /** Earlier messages in the thread, oldest first. */
  history?: { user: string; text: string }[];
  /** Display names to use instead of the fixture's, as a chat app would report them. */
  names?: Record<string, string>;
  /** The chat app says nothing about the channel (a failed or empty lookup). */
  noChannelInfo?: boolean;
}

const BOT_USER = 'UMOSS00001';
const NAMES: Record<string, string> = {
  UROBIN0001: 'Robin Vale', UPRIYA0001: 'Priya Nair', UJONAS0001: 'Jonas Berg', UDANA0001: 'Dana Ruiz (Brightmoor)',
  USAM000001: 'Sam Okafor', UKENJI0001: 'Kenji Sato', ULENA00001: 'Lena Fischer', UOMAR00001: 'Omar Haddad', UHOLLIS001: 'Priscilla Hollis (Hollis Freight)',
};
const CHANNELS = { dm: 'DMOSS00001', channel: 'CTEAM00001', shared: 'CSHARED001' } as const;
let calls = 0;

export const buildBrief = async (profileDir: string, item: EvalCase): Promise<string> => {
  const config = loadConfig({ profileDir, env: { SLACK_BOT_TOKEN: 'xoxb-eval', SLACK_APP_TOKEN: 'xapp-eval' } });
  if (item.via === 'app') return taskBrief(config, item.text);

  const channel = CHANNELS[item.via];
  // A new thread per call, so a second brief from the same profile is a new job, not a follow-up.
  const base = 1_700_000_000 + (++calls) * 1000;
  const threadTs = `${base}.000100`;
  const history = (item.history ?? []).map((line, index) => ({ ts: `${base}.${String(index + 2).padStart(4, '0')}00`, user: line.user, text: line.text }));
  const messageTs = history.length ? `${base + 1}.000100` : threadTs;
  const thread = history.length ? [{ ts: threadTs, user: history[0]!.user, text: history[0]!.text }, ...history.slice(1)] : [];

  const quiet = (): void => {};
  const client = {
    users: { info: async ({ user }: { user: string }) => ({ user: { real_name: item.names?.[user] ?? NAMES[user] ?? user } }) },
    conversations: {
      replies: async () => ({ messages: thread }),
      info: async () => (item.noChannelInfo ? {} : { channel: { id: channel, is_im: item.via === 'dm', is_ext_shared: item.via === 'shared', is_shared: item.via === 'shared' } }),
    },
    chat: {
      getPermalink: async () => ({ permalink: `https://larchwood.slack.test/archives/${channel}/p1` }),
      postMessage: async () => ({ ts: '1700000002.000100' }), update: async () => ({}), delete: async () => ({}),
    },
    reactions: { add: async () => ({}), remove: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as unknown as webApi.WebClient;

  let brief = '';
  const knowledge = createKnowledge(config.knowledgeDir);
  const bot = createBot({
    config, client, botUserId: () => BOT_USER, store: createStore(config.statePath), loadIndex: () => knowledge.loadIndex(), loadKnowledge: (visibility) => knowledge.briefKnowledge(visibility),
    logger: { info: quiet, warn: (m: string) => process.stderr.write(`warn: ${m}\n`), error: (m: string) => process.stderr.write(`error: ${m}\n`), debug: quiet },
    t3: {
      startThread: async (input: { brief: string }) => { brief = input.brief; return 't3-eval'; },
      sendToThread: async () => {},
      showThread: async () => ({ thread: { threadId: 't3-eval', link: 'https://t3.test/t3-eval', status: 'idle', latestRunId: null, activeRunId: null, pendingRequestCount: 0 }, messages: [] }),
    } as never,
    questions: { listQuestions: async () => [], answerQuestion: async () => {} },
    fetchBase: async () => {}, share: async (_client, text) => text, reviewRequest: async (_client, text) => ({ reply: text, postedFor: null }),
    receive: async () => '', timing: { quietMs: 5, retryMs: 5 }, events: () => {},
  });
  const text = item.via === 'dm' ? item.text : `<@${BOT_USER}> ${item.text}`;
  await bot.handle({ channel, threadTs, messageTs, user: item.user, text, direct: true });
  if (!brief) throw new Error(`No brief for ${item.text}`);
  return brief;
};
