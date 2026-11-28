/**
 * A second chat, beside Slack: a whole `ChatConnection` in memory, with its own kind (`fake`), its own IDs and its own
 * writer for `deliver`. It is what a Telegram or Discord adapter plugs into, so a test that runs the real daemon with
 * Slack and this chat at once shows the seam holds: messages come in through `say` and `click`, and every notice,
 * reply, edit, ⏳ and 👀 the core makes is recorded here, never on Slack.
 *
 * A message is written `@bot` to mention the bot, and a person `@fake:7`.
 */
import type { ChatAdapter } from '../../src/chat/deliver.ts';
import { chatId, rawId, type ChatIdentity, type Inbound } from '../../src/chat/connection.ts';
import type { Audience, InPlaceOf, MessageRef, Notice, Replacement, Result, Target, WorkerFile, WorkerOut } from '../../src/chat/port.ts';
import { clearedFor, type WorkerWriter } from '../../src/chat/writer.ts';
import type { QuestionInteraction } from '../../src/questions.ts';
import type { IncomingMessage } from '../../src/types.ts';

export const FAKE = 'fake';
/** An ID in the fake chat, as the core sees it. */
export const fake = (raw: string): string => chatId(FAKE, raw);

export interface SecondChatOptions {
  /** The owner's ID in this chat, raw. */
  owner?: string;
  /** Who can see each conversation (raw IDs). Team unless listed; `null`: the chat won't say. */
  audiences?: Record<string, Audience | null>;
  /** The owner's own conversation (raw ID), for copies of approvals. Absent: the chat takes no copies. */
  ownerSpace?: string;
}

export const createSecondChat = ({ owner = '1', audiences = {}, ownerSpace }: SecondChatOptions = {}) => {
  const self = fake('bot');
  let next = 0;
  const id = (): string => `${++next}`;
  let inbound: Inbound | null = null;
  const notices: { target: Target; notice: Notice; inPlaceOf?: InPlaceOf; id: string }[] = [];
  const replaced: { ref: MessageRef; notice: Replacement }[] = [];
  const sent: { target: Target; out: WorkerOut; id: string }[] = [];
  const revised: { ref: MessageRef; out: WorkerOut }[] = [];
  const uploads: { target: Target; file: WorkerFile }[] = [];
  const acknowledged: { ref: MessageRef; on: boolean }[] = [];
  const held: { ref: MessageRef; on: boolean }[] = [];
  const seen: string[] = [];
  const working: { target: Target; on: boolean }[] = [];
  let stopped = false;
  /** While true, every write and edit fails, as when the chat is unreachable. */
  let offline = false;
  const reachable = (): void => { if (offline) throw new Error('the fake chat is unreachable'); };

  const audienceOf = (target: Target): Result<Audience> => {
    const found = audiences[rawId(FAKE, target.conversation)];
    return found === null ? { ok: false, error: { kind: 'retry' } } : { ok: true, value: found ?? 'team' };
  };
  const mentions = (text: string): string[] => [...new Set([...text.matchAll(/@(fake:\w+|bot)\b/g)].map((match) => (match[1] === 'bot' ? self : match[1] ?? '')))];

  const writer: WorkerWriter = {
    clear: async (target) => { const looked = audienceOf(target); return looked.ok ? { ok: true, value: clearedFor(target, looked.value, Date.now()) } : looked; },
    send: async (proof, out) => { reachable(); const message = id(); sent.push({ target: proof.target, out, id: message }); return message; },
    revise: async (_proof, ref, out) => { reachable(); revised.push({ ref, out }); },
    upload: async (proof, file) => { uploads.push({ target: proof.target, file }); return null; },
  };

  const adapter: ChatAdapter = {
    writer,
    connection: {
      kind: FAKE,
      chat: {
        self: () => self,
        owner: () => fake(owner),
        displayName: async (person) => `Person ${rawId(FAKE, person)}`,
        parse: (_conversation, text) => ({ mentions: mentions(text), prose: text.replace(/@(fake:\w+|bot)\b/g, ' ') }),
        read: async (_conversation, text, nameOf) => {
          let readable = text;
          for (const person of mentions(text)) {
            readable = person === self ? readable.replaceAll('@bot', '') : readable.replaceAll(`@${person}`, `@${await nameOf(person)}`);
          }
          return { text: readable.replace(/\s{2,}/g, ' ').trim(), mentions: mentions(text), prose: text.replace(/@(fake:\w+|bot)\b/g, ' ') };
        },
        history: async () => ({ lines: [], more: false }),
        receiveFiles: async () => '',
        permalink: async (ref) => `https://chat.example/${rawId(FAKE, ref.conversation)}/${ref.id}`,
        findReply: async () => null,
        audience: async (target) => audienceOf(target),
        notice: async (target, notice, inPlaceOf) => { const message = id(); notices.push({ target, notice, ...(inPlaceOf ? { inPlaceOf } : {}), id: message }); return message; },
        replaceWithNotice: async (ref, notice) => { if (offline) return false; replaced.push({ ref, notice }); return true; },
        remove: async () => {},
        acknowledge: async (ref, on) => { acknowledged.push({ ref, on }); },
        setWorking: async (target, on) => { working.push({ target, on }); },
      },
      identify: async (): Promise<ChatIdentity> => ({ self, lock: `${FAKE}-bot`, describe: '@bot in the fake chat' }),
      listen: async (handlers) => { inbound = handlers; },
      stop: async () => { stopped = true; },
      watch: () => {},
      hold: async (ref, on) => { held.push({ ref, on }); },
      saw: (msg) => { seen.push(msg.user); },
      ...(ownerSpace === undefined ? {} : { ownerSpace: async () => fake(ownerSpace) }),
    },
  };

  const listening = (): Inbound => {
    if (!inbound || stopped) throw new Error('The fake chat is not listening');
    return inbound;
  };

  return {
    adapter, notices, replaced, sent, revised, uploads, acknowledged, held, seen, working,
    /**
     * Someone writes in the fake chat. A DM (`dm: true`) or a mention is for the bot; a plain reply reaches the core only
     * in a thread the bot owns, as an adapter filters it.
     */
    say: async ({ from, text, conversation = 'dm', thread, ts, dm = false }:
      { from: string; text: string; conversation?: string; thread?: string; ts: string; dm?: boolean }): Promise<boolean> => {
      const channel = fake(conversation);
      const threadTs = thread ?? ts;
      const direct = dm || text.includes('@bot');
      if (!direct && !listening().owns(channel, threadTs)) return false;
      const msg: IncomingMessage = { channel, threadTs, messageTs: ts, user: fake(from), text, direct, ...(dm ? { im: true } : {}) };
      await listening().message(msg);
      return true;
    },
    /** Someone presses answers on a question card. */
    click: (interaction: Omit<QuestionInteraction, 'channel' | 'user'> & { conversation?: string; from: string }): Promise<void> => {
      const { conversation = 'dm', from, ...rest } = interaction;
      return listening().answer({ ...rest, channel: fake(conversation), user: fake(from) });
    },
    stopped: (): boolean => stopped,
    /** The chat becomes unreachable (`true`) or comes back. */
    setOffline: (value: boolean): void => { offline = value; },
  };
};
