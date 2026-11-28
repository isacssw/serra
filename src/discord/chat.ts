/**
 * Discord as a chat: the `ChatPort` the core calls freely and the `WorkerWriter` only `deliver` holds. Everything that
 * knows Discord's messages lives here: who can see a conversation, the copy of Serra's notices, Markdown and buttons,
 * the 👀 and ⏳ reactions and "typing…".
 *
 * Where things are. A conversation is where the request was written: a server channel, or a DM. A job's thread is,
 * in a server, a Discord thread Serra started from the request (its ID is the request's), or the thread the request
 * was written in; Serra remembers which conversation each thread channel belongs to (`homeOf`). In a DM, which has no
 * threads, a job's thread is its first message, and Serra answers as replies to it (`src/chat/threads.ts` keeps which
 * message belongs to which job, as for Telegram).
 *
 * Who can see a conversation: the owner's DM with the bot is theirs alone; everything else (someone else's DM, any
 * server channel or thread) counts as outside, since Discord can't say who in a server is on the owner's team.
 */
import { ButtonStyle, ComponentType } from '@discordjs/core/http-only';
import { chatId, chatName, rawId } from '../chat/connection.ts';
import { MessageGone, type Audience, type ChatError, type ChatPort, type HistoryLine, type InPlaceOf, type MessageRef, type Notice, type OwnerNotify, type PersonId, type Replacement, type Result, type Target, type WorkerOut } from '../chat/port.ts';
import type { ThreadStore } from '../chat/threads.ts';
import { clearedFor, type Cleared, type WorkerWriter } from '../chat/writer.ts';
import type { Clock } from '../clock.ts';
import { errorMessage } from '../lib/errors.ts';
import type { QuestionCard } from '../questions.ts';
import { DiscordError, isBadToken, isUnknown, type Buttons, type DiscordApi } from './api.ts';
import { receiveDiscordFiles } from './files.ts';
import { link, messageText } from './markup.ts';

export const DISCORD = 'discord';
/** A Discord ID (channel or user) as the core keeps it. */
export const discordId = (raw: string): string => chatId(DISCORD, raw);

/** The reactions Serra puts on a person's message: seen and being worked on, and held for an update (as on Slack). */
export const SEEN = '👀';
export const HELD = '⏳';

/** How old an answer about who can see a conversation may be when worker words are written on it. */
const CLEARED_TTL_MS = 60_000;
/** Buttons a question card shows (two rows of five); more options are listed and answered by number. */
const MAX_BUTTONS = 10;
/** How many earlier messages of a server thread reach the worker. */
const HISTORY = 30;

type Logger = { warn(message: string): void; debug(message: string): void };

/** A question card's button: `q:<nonce>:<option>`, well inside Discord's 100 characters. */
export const questionData = (nonce: string, index: number): string => `q:${nonce}:${index}`;
export const QUESTION_DATA = /^q:([a-f0-9]{32}):(\d{1,2})$/;

const QUESTION_HINTS: Record<Extract<Notice, { kind: 'question-hint' }>['hint'], string> = {
  'choose': 'Choose an answer first.',
  'invalid-answer': 'Please choose one of the answers, or reply with its label or number.',
  'changed': 'That question changed or was already answered in T3. I’ll check for the next one.',
  'not-sent': 'I couldn’t send that answer to T3. Please try again, or answer in T3.',
  'owner-only': 'Only the bot’s owner can allow this.',
  'unconfirmed': 'I couldn’t confirm who can see this conversation just now, so I haven’t taken that answer. Please answer again in a minute.',
};

const noticeText = (notice: Notice): string => {
  switch (notice.kind) {
    case 'here': return 'I\'m here. What do you need?';
    case 'refused': return 'Sorry, I only take requests from my owner.';
    case 'failed': return notice.owner
      ? 'Something went wrong on my side, so I couldn\'t pick this up. The details are in Serra\'s Jobs and log.'
      : 'Something went wrong on my side, so I couldn\'t pick this up. My owner will take a look.';
    case 'withheld': return 'Some of what I knew for this answer has since been made private, so I won\'t post it. Ask again and I\'ll answer with what I may share now.';
    case 'unconfirmed': return 'I couldn\'t confirm who can see this conversation just now, so I haven\'t posted my answer here. Ask again in a minute and I\'ll try again.';
    case 'setup-problem': return notice.problem === 'bad-token'
      ? 'I can\'t check who can see this conversation: my Discord token isn\'t accepted. I\'ve told my owner how to fix it.'
      : 'I can\'t check who can see this conversation: I\'m missing a permission here. I\'ve told my owner how to fix it.';
    case 'fresh-session': return 'Some knowledge this conversation used has changed, so I\'m carrying on in a fresh session.';
    case 'waiting-in-t3': return notice.where === 'app'
      ? 'I\'m waiting for you in the Serra app: answer it in Jobs › Transcript. Messages here reach me once it\'s answered.'
      : 'I\'m waiting for you in T3: it needs an action there, such as a token, an approval, or a question Discord can\'t show. Messages here reach me once it\'s answered.';
    case 'images-unsupported': return `${notice.agent} can't see images, so it only got the file's path.`;
    case 'question-hint': return QUESTION_HINTS[notice.hint];
  }
};

/** A message's text as Serra keeps it in its thread record. */
const lineText = (out: WorkerOut): string => {
  switch (out.kind) {
    case 'reply': case 'status': case 'review': return out.markdown;
    case 'progress': return out.text;
    case 'question': return out.card.questions[out.card.index]?.question ?? '';
    case 'answered': return 'Answer sent.';
    case 'failure-detail': return 'Something went wrong on my side.';
  }
};

/** A lookup's failure as the core reads it: the token or a permission needs the owner; anything else may pass later. */
const chatError = (error: unknown): ChatError => {
  if (isBadToken(error)) return { kind: 'setup', problem: 'bad-token', code: '401' };
  if (error instanceof DiscordError && error.status === 403) return { kind: 'setup', problem: 'missing-permission', code: String(error.code ?? 403) };
  return { kind: 'retry' };
};

export interface DiscordChatOptions {
  api: DiscordApi;
  store: ThreadStore;
  /** The bot's Discord user ID, known after it signed in. */
  botId: () => string;
  /** The owner's Discord user ID, or null before they paired. */
  owner: () => string | null;
  /** Names learned from messages, by core ID. */
  names: ReadonlyMap<string, string>;
  /** What Serra learned about channels from messages: a DM's person, a server channel's server. */
  channels: { dms: Map<string, string>; guilds: Map<string, string> };
  profileDir: string;
  logger: Logger;
  clock: Pick<Clock, 'now'>;
  /** For attachment downloads from Discord's CDN. Tests pass one. */
  fetch?: typeof fetch;
}

export const createDiscordChat = ({ api, store, botId, owner, names, channels, profileDir, logger, clock, fetch: fetchApi = fetch }: DiscordChatOptions): { chat: ChatPort; writer: WorkerWriter } => {
  const now = (): number => clock.now();
  const self = (): PersonId => discordId(botId());
  /** Never anyone's ID before pairing: a Discord user ID is a number. */
  const ownerId = (): PersonId => discordId(owner() ?? 'unpaired');
  const raw = (id: string): string => rawId(DISCORD, id);

  /** Where to post in a job's thread: its thread channel, or the conversation itself as a reply to the thread's first message. */
  const route = (target: Target): { channel: string; replyTo?: string } => {
    const conversation = raw(target.conversation);
    if (target.thread && store.homeOf(target.thread) === conversation) return { channel: target.thread };
    return { channel: conversation, ...(target.thread ? { replyTo: target.thread } : {}) };
  };
  /** The channel a message is in: its job's thread channel, except a thread's first message, which is in the conversation. */
  const channelOf = (ref: MessageRef): string => {
    const conversation = raw(ref.conversation);
    const thread = store.threadOf(conversation, ref.id);
    return thread !== undefined && thread !== ref.id && store.homeOf(thread) === conversation ? thread : conversation;
  };

  const audienceOf = async (target: Target): Promise<Result<Audience>> => {
    const conversation = raw(target.conversation);
    if (!channels.dms.has(conversation) && !channels.guilds.has(conversation)) {
      try {
        const info = await api.channel(conversation);
        if (info.type === 1 && info.recipient) channels.dms.set(conversation, info.recipient);
        else channels.guilds.set(conversation, '');
      } catch (error) { return { ok: false, error: chatError(error) }; }
    }
    const paired = owner();
    return { ok: true, value: paired !== null && channels.dms.get(conversation) === paired ? 'owner' : 'external' };
  };

  const post = async (target: Target, content: string, text: string, components?: Buttons): Promise<string> => {
    const { channel, replyTo } = route(target);
    const sent = await api.post(channel, content, { ...(replyTo ? { replyTo } : {}), ...(components ? { components } : {}) });
    if (target.thread) store.add(raw(target.conversation), target.thread, { id: sent.id, from: 'self', text }, now());
    return sent.id;
  };

  const footer = (link_: string | null, notify: OwnerNotify): string => {
    const t3 = link_ ? link(link_, 'T3 thread') : 'T3 thread';
    // `-#` is Discord's small grey line. The owner is named, never pinged: nothing Serra posts pings anyone.
    return `-# ${notify === 'cc' ? 'cc my owner · ' : ''}${t3}`;
  };
  const replyText = (body: string, link_: string | null, notify: OwnerNotify): string =>
    messageText(`${notify === 'callout' ? '**This one needs you.**\n\n' : ''}${body}`, footer(link_, notify));

  const questionMessage = (card: QuestionCard, copyOf?: { chat: string; link: string | null }): { content: string; components?: Buttons } => {
    const question = card.questions[card.index];
    if (!question) throw new Error(`The card has no question ${card.index + 1}`);
    const head = `**I need your input${card.questions.length > 1 ? ` (${card.index + 1}/${card.questions.length})` : ''}.**\n${question.question}`;
    const buttons = question.options.length > 0 && !question.multiSelect && question.options.length <= MAX_BUTTONS;
    const described = question.options.filter((option) => option.description && option.description !== option.label);
    const listed = question.options.length > 0 && !buttons
      ? `\n\n${question.options.map((option, index) => `${index + 1}. ${option.label}${option.description && option.description !== option.label ? ` — ${option.description}` : ''}`).join('\n')}`
      : buttons && described.length ? `\n\n${described.map((option) => `**${option.label}**: ${option.description}`).join('\n')}` : '';
    const custom = !question.options.length || question.allowCustomAnswer !== false;
    const how = !question.options.length ? 'Reply with your answer.'
      : buttons ? (custom ? 'Press an answer, or reply with your own.' : 'Press an answer.')
        : question.multiSelect ? 'Reply with the numbers, like 1,3.' : 'Reply with a number.';
    const who = question.id === 'permission' ? ' Only the bot owner can answer.' : '';
    // A copy (`src/chat/mirrors.ts`) is answered by its buttons only: a message here would be a new request.
    const content = messageText(`${head}${listed}`, copyOf
      ? `-# From ${chatName(copyOf.chat)}${copyOf.link ? ` · ${link(copyOf.link, 'Open thread')}` : ''}`
      : `-# ${how}${who}`);
    if (!buttons) return { content };
    const row = (from: number): Buttons[number] => ({
      type: ComponentType.ActionRow,
      components: question.options.slice(from, from + 5).map((option, index) => ({
        type: ComponentType.Button, style: ButtonStyle.Secondary, label: option.label.slice(0, 80) || String(from + index + 1), custom_id: questionData(card.nonce, from + index),
      })),
    });
    return { content, components: question.options.length > 5 ? [row(0), row(5)] : [row(0)] };
  };

  const answeredText = (card: QuestionCard, by?: PersonId, via?: string): string => {
    const lines = card.questions.flatMap((question) => {
      const answer = Object.hasOwn(card.answers, question.id) ? card.answers[question.id] : undefined;
      const label = (value: string): string => question.options.find((option) => (option.value ?? option.label) === value)?.label ?? value;
      return answer === undefined ? [] : [`${question.question}\n**${Array.isArray(answer) ? answer.map(label).join(', ') : label(answer)}**`];
    });
    const head = via ? `Answered in ${chatName(via)}.` : by ? 'Answer sent. Continuing…' : 'This question is no longer waiting for an answer.';
    return messageText([head, ...lines].join('\n\n'));
  };

  const render = (out: WorkerOut): { content: string; components?: Buttons } => {
    switch (out.kind) {
      case 'reply': return { content: replyText(out.markdown, out.link, out.notify) };
      case 'status': {
        const at = new Date(out.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return { content: messageText(out.markdown, `-# Updated ${at} · ${link(out.link, 'T3 thread')}`) };
      }
      case 'progress': return { content: `-# ${out.text.replace(/\s+/g, ' ').slice(0, 500)}` };
      case 'question': return questionMessage(out.card, out.copyOf);
      case 'answered': return { content: answeredText(out.card, out.by, out.via) };
      case 'review': return { content: messageText(out.markdown, `-# Prepared by ${out.from} · ${link(out.link, 'request thread')}`) };
      case 'failure-detail': return { content: `Something went wrong on my side.\n\`\`\`\n${out.line.slice(0, 500).replace(/`/g, 'ˋ')}\n\`\`\`` };
    }
  };

  const noticeContent = (notice: Replacement, inPlaceOf?: InPlaceOf): string => {
    if (notice.kind === 'question-closed') return 'This question was closed: some knowledge it used was made private.';
    if (notice.kind === 'question-over') return notice.answered ? 'Answer sent. Continuing…' : 'This question is no longer waiting for an answer.';
    const text = noticeText(notice);
    if (notice.kind === 'waiting-in-t3' && notice.link && !notice.where) return `${text}\n\n${link(notice.link, 'Open it in T3')}`;
    if (inPlaceOf?.frame === 'reply') return replyText(text, inPlaceOf.link, inPlaceOf.notify);
    return text;
  };

  const mentions = (text: string): string[] => [...new Set([...text.matchAll(/<@!?(\d{15,21})>/g)].map((match) => discordId(match[1] ?? '')))];

  const chat: ChatPort = {
    self: () => self(),
    owner: () => ownerId(),
    displayName: async (person) => names.get(person) ?? raw(person),
    parse: (_conversation, text) => ({ mentions: mentions(text), prose: text.replace(/<@[!&]?\d{15,21}>/g, ' ') }),
    async read(conversation, text, nameOf) {
      let readable = text;
      for (const person of mentions(text)) {
        const name = person === self() ? '' : `@${await nameOf(person)}`;
        readable = readable.replace(new RegExp(`<@!?${raw(person)}>`, 'g'), name);
      }
      const { prose } = chat.parse(conversation, text);
      return { text: readable.replace(/[ \t]{2,}/g, ' ').trim(), mentions: mentions(text), prose };
    },
    async history(target, before) {
      if (target.thread === null) return { lines: [], more: false };
      const conversation = raw(target.conversation);
      if (store.homeOf(target.thread) !== conversation) {
        const lines: HistoryLine[] = store.lines(conversation, target.thread, before).map((line) => ({
          id: line.id, text: line.text, files: [],
          from: line.from === 'self' ? { kind: 'self' } : { kind: 'person', id: discordId(line.from) },
        }));
        return { lines, more: false };
      }
      // A server thread: Discord keeps its history.
      try {
        const messages = await api.messages(target.thread, before, HISTORY);
        const lines: HistoryLine[] = messages.toReversed().map((message) => ({
          id: message.id, text: message.content, files: [],
          from: message.author.id === botId() ? { kind: 'self' } : message.author.bot ? { kind: 'bot', name: message.author.name } : { kind: 'person', id: discordId(message.author.id) },
        }));
        return { lines, more: messages.length === HISTORY };
      } catch (error) {
        logger.debug(`Reading Discord thread ${target.thread} failed: ${errorMessage(error)}`);
        return null;
      }
    },
    receiveFiles: (_conversation, files, limit) => receiveDiscordFiles(files, profileDir, limit, fetchApi),
    async permalink(ref) {
      const conversation = raw(ref.conversation);
      const guild = channels.dms.has(conversation) ? '@me' : channels.guilds.get(conversation);
      return guild ? `https://discord.com/channels/${guild}/${channelOf(ref)}/${ref.id}` : null;
    },
    async findReply(target, intent) {
      const found = store.replyOf(intent.runId);
      return found && found.chat === raw(target.conversation) ? found.id : null;
    },
    audience: (target) => audienceOf(target),
    async notice(target, notice, inPlaceOf) {
      const id = await post(target, noticeContent(notice, inPlaceOf), notice.kind);
      if (inPlaceOf?.runId) store.recordReply(inPlaceOf.runId, raw(target.conversation), id);
      return id;
    },
    async replaceWithNotice(ref, notice, frame) {
      return api.edit(channelOf(ref), ref.id, noticeContent(notice, frame === 'status' ? { runId: '', frame } : undefined))
        .then(() => true, (error: unknown) => { logger.debug(`Replacing Discord message ${ref.id} failed: ${errorMessage(error)}`); return false; });
    },
    async remove(ref) {
      await api.remove(channelOf(ref), ref.id).catch((error: unknown) => logger.debug(`Removing Discord message ${ref.id} failed: ${errorMessage(error)}`));
    },
    async acknowledge(ref, on) {
      await api.react(channelOf(ref), ref.id, SEEN, on).catch((error: unknown) => logger.debug(`👀 on Discord message ${ref.id} failed: ${errorMessage(error)}`));
    },
    async setWorking(target, on) {
      if (on) await api.typing(route(target).channel).catch(() => {});
    },
  };

  /** A proof is for one conversation and a short while, as Slack's writer checks. */
  const check = (proof: Cleared, conversation = proof.target.conversation): void => {
    if (proof.target.conversation !== conversation) throw new Error(`Cleared for ${proof.target.conversation}, not ${conversation}`);
    if (now() - proof.at > CLEARED_TTL_MS) throw new Error(`Who can see ${conversation} was checked too long ago to post on`);
  };

  const writer: WorkerWriter = {
    async clear(target) {
      const looked = await audienceOf(target);
      return looked.ok ? { ok: true, value: clearedFor(target, looked.value, now()) } : looked;
    },
    async send(proof, out) {
      check(proof);
      const { content, components } = render(out);
      const id = await post(proof.target, content, lineText(out), components);
      if (out.kind === 'reply' || out.kind === 'status') store.recordReply(out.runId, raw(proof.target.conversation), id);
      return id;
    },
    async revise(proof, ref, out) {
      check(proof, ref.conversation);
      const { content, components } = render(out);
      try { await api.edit(channelOf(ref), ref.id, content, components ? { components } : {}); }
      catch (error) {
        if (isUnknown(error)) throw new MessageGone(ref);
        throw error;
      }
    },
    async upload(proof, file) {
      check(proof);
      const { channel, replyTo } = route(proof.target);
      try {
        const sent = await api.upload(channel, file.path, { caption: file.label, ...(replyTo ? { replyTo } : {}) });
        if (proof.target.thread) store.add(raw(proof.target.conversation), proof.target.thread, { id: sent.id, from: 'self', text: file.label }, now());
        return null;
      } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
    },
  };

  return { chat, writer };
};
