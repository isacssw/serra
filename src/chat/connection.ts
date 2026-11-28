/**
 * One chat the daemon serves: Slack today, Telegram or Discord next. The daemon starts every connection it is given,
 * and the core talks to all of them as one `ChatPort` (`router.ts`) and one `deliver` (`deliver.ts`), so a reply can only
 * go back to the chat its job came from.
 *
 * A connection is everything the daemon needs from a chat besides the port: signing in, the inbound events, the ⏳ mark
 * on a request held for an update, and (for a chat with the owner's DM) meeting capture's seam. Its `WorkerWriter` is
 * not here: the adapter hands it to `deliver` alongside, as a `ChatAdapter` (`deliver.ts`), and nothing else holds it.
 *
 * IDs: every conversation and person ID a connection hands the core names its chat, `kind:id`, so the same number in
 * two chats is two IDs and a job's key says where it lives. Slack is the exception: its IDs stay bare (`C0…`, `U0…`,
 * never a colon), so state, profiles and held requests written before this seam read as they did.
 */
import type { MeetingChat } from '../meeting-capture.ts';
import type { QuestionInteraction } from '../questions.ts';
import type { IncomingFile, IncomingMessage } from '../types.ts';
import type { ChatPort, MessageRef, PersonId } from './port.ts';

/** Which chat an ID belongs to: `slack`, `telegram`, …; lower case, a letter first. */
export type ChatKind = string;

/** Slack's IDs carry no prefix. */
export const SLACK: ChatKind = 'slack';

const PREFIX = /^([a-z][a-z0-9-]*):/;

/** The chat a conversation or person ID belongs to: its `kind:` prefix, or Slack for a bare ID. */
export const kindOf = (id: string): ChatKind => PREFIX.exec(id)?.[1] ?? SLACK;

/** `raw`, one of the chat's own IDs, as the core keeps it. An adapter names everything it hands the core this way. */
export const chatId = (kind: ChatKind, raw: string): string => (kind === SLACK ? raw : `${kind}:${raw}`);

/** The chat's own ID back from one `chatId` made. */
export const rawId = (kind: ChatKind, id: string): string => (kind === SLACK || !id.startsWith(`${kind}:`) ? id : id.slice(kind.length + 1));

/** Who the bot is in a chat, once it signed in. */
export interface ChatIdentity {
  /** The bot's own person ID there. */
  self: PersonId;
  /** Unique per bot identity in this chat, for the lock that keeps two daemons off one bot (`locks/<lock>.lock`). */
  lock: string;
  /** For the start-up log line: "@serra in Acme". */
  describe: string;
}

/** What a connection hands the daemon. The daemon decides what to do with each; the connection only translates. */
export interface Inbound {
  /**
   * A message that is for the core: a mention, a DM, an alert-channel post, or a reply in a thread the bot owns (`owns`).
   * Chatter in threads the bot doesn't own never comes here.
   */
  message(msg: IncomingMessage): Promise<void>;
  /** Someone submitted answers on a question card. */
  answer(interaction: QuestionInteraction): Promise<void>;
  /** The bot's thread, or one with a request held or being started: replies there reach the core without a mention. */
  owns(conversation: string, thread: string): boolean;
}

/** Whether the connection is up. A chat that reconnects on its own reports each drop and return. */
export type ConnectionState = 'connected' | 'disconnected';

/** Meeting capture's seam in a chat that has the owner's DM (SERRA-62). */
export interface MeetingSeam {
  chat: MeetingChat;
  /** A transcript file someone attached, as text. */
  readFile: (file: IncomingFile, maxChars: number) => Promise<{ name: string; text: string }>;
}

export interface ChatConnection {
  readonly kind: ChatKind;
  /** The read side and Serra's notices, for this chat's conversations only. */
  readonly chat: ChatPort;
  /** Signs in and says who the bot is. Nothing is delivered yet. Throws when the chat refuses. */
  identify(): Promise<ChatIdentity>;
  /** Starts delivering events to `inbound`. Called once, after `identify` and the lock. */
  listen(inbound: Inbound): Promise<void>;
  /** Stops delivering events. A chat paused for a move or an update stops here; work in flight finishes. */
  stop(): Promise<void>;
  /** Tells `listener` each time the connection drops or comes back. */
  watch(listener: (state: ConnectionState) => void): void;
  /** Marks a request held until an update is over (Slack: ⏳), or takes the mark away. Best effort. */
  hold(ref: MessageRef, on: boolean): Promise<void>;
  /**
   * The core is handling `msg` (a replay after a restart included): the adapter may learn from it. Slack learns whose
   * each DM is, so its check that the owner's DM is theirs alone has an answer.
   */
  saw(msg: Pick<IncomingMessage, 'channel' | 'user' | 'botId'>): void;
  /** Meeting capture, in a chat that has the owner's DM. Absent: meetings are never caught in this chat. */
  readonly meetings?: MeetingSeam;
}
