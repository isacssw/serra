/**
 * Slack as a `ChatConnection` (`src/chat/connection.ts`): Bolt's Socket Mode app, its listeners, sign-in with
 * `auth.test`, the ⏳ on a held request, and meeting capture's seam in the owner's DM. The port and the writer are
 * `chat.ts`'s; this file is what the daemon used to do with Bolt itself.
 */
import { App, LogLevel, SocketModeReceiver, type Logger as BoltLogger } from '@slack/bolt';
import type { ChatConnection, ConnectionState, MeetingSeam } from '../chat/connection.ts';
import { SLACK } from '../chat/connection.ts';
import type { ChatAdapter } from '../chat/deliver.ts';
import type { PersonId } from '../chat/port.ts';
import type { Clock } from '../clock.ts';
import type { MessageTrigger } from '../config.ts';
import type { Logger, LogLevel as Level } from '../logging.ts';
import type { SlackApi } from './api.ts';
import { readAttachmentText, receiveAttachments } from './attachments.ts';
import { createSlackChat } from './chat.ts';
import { incomingMessage } from './incoming.ts';
import { QUESTION_ACTION, questionInteraction } from './questions.ts';

/** The reaction on a request held while Serra updates. */
const HELD_REACTION = 'hourglass_flowing_sand';

/** Bolt's socket client connection events, so the status socket can say whether Slack is connected. */
export interface SlackConnectionEvents { on(event: 'connected' | 'disconnected' | 'reconnecting', listener: () => void): unknown }

/** The Bolt app the connection registers its listeners on. Tests pass one with a receiver they drive. */
export type SlackApp = Pick<App, 'event' | 'message' | 'action' | 'start' | 'stop'>;

export interface SlackConnectionOptions {
  app: SlackApp;
  /** The Web API. In production, `app.client`. */
  client: SlackApi;
  /** The socket's connection events. Without them Slack counts as connected from `listen` on. */
  events?: SlackConnectionEvents;
  /** The owner's Slack member ID. */
  owner: PersonId;
  botToken: string;
  profileDir: string;
  /** The alert channels' triggers as they are now: a profile change applies without a restart. */
  messageTriggers: () => readonly MessageTrigger[];
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void; debug(message: string): void };
  clock: Pick<Clock, 'now'>;
  /** Downloads the files people attach. */
  receive?: typeof receiveAttachments;
}

const BOLT_LEVELS: Record<Level, LogLevel> = { debug: LogLevel.DEBUG, info: LogLevel.INFO, warn: LogLevel.WARN, error: LogLevel.ERROR };
const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error'];

/** The daemon's logger as Bolt types it: the same lines, levels by Bolt's names. */
const boltLogger = (logger: Logger): BoltLogger => ({
  debug: (...msg) => logger.debug(...msg),
  info: (...msg) => logger.info(...msg),
  warn: (...msg) => logger.warn(...msg),
  error: (...msg) => logger.error(...msg),
  setLevel: (level) => {
    const mine = LEVELS.find((name) => BOLT_LEVELS[name] === level);
    if (mine) logger.setLevel(mine);
  },
  getLevel: () => BOLT_LEVELS[logger.getLevel()],
  setName: (name) => logger.setName(name),
});

/** Bolt's real Socket Mode app, from the profile's tokens. The receiver is made here so its connection state is known. */
export const slackSocketApp = ({ botToken, appToken, logger: daemonLogger }: { botToken: string; appToken: string; logger: Logger }) => {
  const logger = boltLogger(daemonLogger);
  const receiver = new SocketModeReceiver({ appToken, logger, logLevel: LogLevel.INFO });
  const app = new App({ token: botToken, receiver, logger, logLevel: LogLevel.INFO });
  return { app, client: app.client, events: receiver.client };
};

export const createSlackConnection = (options: SlackConnectionOptions): ChatAdapter => {
  const { app, client, events, owner, botToken, profileDir, messageTriggers, logger, clock } = options;
  let botUserId = '';
  let botId = '';
  const { chat, writer, sawDm, sawOwnerWrite, ownerDm } = createSlackChat({
    client, owner, botUserId: () => botUserId, botToken, profileDir, logger, clock, ...(options.receive ? { receive: options.receive } : {}),
  });

  const meetings: MeetingSeam = {
    chat: {
      // No unfurling: meeting text is never turned into a link preview.
      post: async (channel, text, threadTs) => (await client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false, ...(threadTs ? { thread_ts: threadTs } : {}) })).ts,
      remove: async (channel, ts) => { await client.chat.delete({ channel, ts }); },
      earlierInThread: async (channel, threadTs, beforeTs) => {
        const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 20 });
        // People's messages only: an agent-view conversation can open with the app's own greeting.
        return (replies.messages ?? []).filter((message) => message.ts !== undefined && message.ts < beforeTs && !message.bot_id && message.user !== botUserId).length;
      },
    },
    readFile: (file, maxChars) => readAttachmentText(client, file, botToken, maxChars),
  };

  const connection: ChatConnection = {
    kind: SLACK,
    chat,
    meetings,

    async identify() {
      const auth = await client.auth.test();
      botUserId = auth.user_id ?? '';
      botId = auth.bot_id ?? '';
      if (!botUserId) throw new Error('Slack auth.test returned no bot user ID');
      return { self: botUserId, lock: botUserId, describe: `@${auth.user} in ${auth.team}` };
    },

    async listen(inbound) {
      const owns = (channel: string, threadTs: string): boolean => inbound.owns(channel, threadTs);
      app.event('app_mention', async ({ event }) => {
        const msg = incomingMessage(event, 'app_mention', botUserId, owns, { messageTriggers: messageTriggers(), botId });
        if (msg) await inbound.message(msg);
      });
      // Agent view emits this when someone opens the app. Wait for their message before starting work.
      app.event('app_home_opened', async () => {});
      app.action(QUESTION_ACTION, async ({ ack, body }) => {
        await ack();
        const interaction = questionInteraction(body);
        if (!interaction) return;
        sawDm(interaction.channel, interaction.user);
        await inbound.answer(interaction);
      });
      app.message(async ({ message }) => {
        const msg = incomingMessage(message, 'message', botUserId, owns, { messageTriggers: messageTriggers(), botId });
        if (msg) await inbound.message(msg);
      });
      await app.start();
    },

    async stop() { await app.stop(); },

    watch(listener: (state: ConnectionState) => void) {
      events?.on('connected', () => listener('connected'));
      for (const state of ['disconnected', 'reconnecting'] as const) events?.on(state, () => listener('disconnected'));
    },

    async hold(ref, on) {
      const reaction = { channel: ref.conversation, timestamp: ref.id, name: HELD_REACTION };
      await (on ? client.reactions.add(reaction) : client.reactions.remove(reaction)).catch(() => {});
    },

    saw(msg) {
      // Whose a DM is, for the check that the owner's DM is theirs alone: from every message handled, held requests
      // replayed after a restart included. A bot's alert says nothing about whose a DM is.
      if (msg.botId) return;
      sawDm(msg.channel, msg.user);
      sawOwnerWrite(msg.channel, msg.user);
    },

    // The owner's DM, once they wrote to the bot there: Slack won't say which DM is theirs otherwise (`owner-dm.ts`).
    ownerSpace: async () => ownerDm(),
  };
  return { connection, writer };
};
