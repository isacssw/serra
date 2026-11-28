/**
 * Telegram as a chat: the `ChatPort` the core calls freely and the `WorkerWriter` only `deliver` holds. Everything that
 * knows Telegram's messages lives here: who can see a chat, the copy of Serra's notices, HTML and inline keyboards,
 * the 👀 reaction and "typing…", and the thread record Serra keeps because Telegram has none (`src/chat/threads.ts`).
 *
 * Who can see a chat: the owner's private chat with the bot is theirs alone; any other chat (someone else's private
 * chat, a group) counts as outside, since Telegram can't say who is on the owner's team.
 */
import { extname } from 'node:path';
import { chatId, rawId } from '../chat/connection.ts';
import { MessageGone, type Audience, type ChatPort, type HistoryLine, type InPlaceOf, type Notice, type OwnerNotify, type PersonId, type Replacement, type Result, type Target, type WorkerOut } from '../chat/port.ts';
import { clearedFor, type Cleared, type WorkerWriter } from '../chat/writer.ts';
import type { Clock } from '../clock.ts';
import { errorMessage } from '../lib/errors.ts';
import type { QuestionCard } from '../questions.ts';
import { TelegramError, type InlineKeyboard, type TelegramApi } from './api.ts';
import { receiveTelegramFiles } from './files.ts';
import { escapeHtml, link, markdownToHtml, messageHtml, plain } from './markup.ts';
import type { ThreadStore } from '../chat/threads.ts';

export const TELEGRAM = 'telegram';
/** A Telegram ID (chat or user) as the core keeps it. */
export const telegramId = (raw: string | number): string => chatId(TELEGRAM, String(raw));

/** The reactions Serra puts on a person's message: seen and being worked on, and held for an update. */
export const SEEN = '👀';
export const HELD = '😴';

/** How old an answer about who can see a chat may be when worker words are written on it. */
const CLEARED_TTL_MS = 60_000;
/** Buttons a question card shows; more options are listed and answered by number. */
const MAX_BUTTONS = 8;

type Logger = { warn(message: string): void; debug(message: string): void };

/** A question card's button: `q:<nonce>:<option>`, well inside Telegram's 64 bytes. */
export const questionData = (nonce: string, index: number): string => `q:${nonce}:${index}`;
export const QUESTION_DATA = /^q:([a-f0-9]{32}):(\d{1,2})$/;

const QUESTION_HINTS: Record<Extract<Notice, { kind: 'question-hint' }>['hint'], string> = {
  'choose': 'Choose an answer first.',
  'invalid-answer': 'Please choose one of the answers, or reply with its label or number.',
  'changed': 'That question changed or was already answered in T3. I’ll check for the next one.',
  'not-sent': 'I couldn’t send that answer to T3. Please try again, or answer in T3.',
  'owner-only': 'Only the bot’s owner can allow this.',
  'unconfirmed': 'I couldn’t confirm who can see this chat just now, so I haven’t taken that answer. Please answer again in a minute.',
};

const noticeText = (notice: Notice): string => {
  switch (notice.kind) {
    case 'here': return 'I\'m here. What do you need?';
    case 'refused': return 'Sorry, I only take requests from my owner.';
    case 'failed': return notice.owner
      ? 'Something went wrong on my side, so I couldn\'t pick this up. The details are in Serra\'s Jobs and log.'
      : 'Something went wrong on my side, so I couldn\'t pick this up. My owner will take a look.';
    case 'withheld': return 'Some of what I knew for this answer has since been made private, so I won\'t post it. Ask again and I\'ll answer with what I may share now.';
    case 'unconfirmed': return 'I couldn\'t confirm who can see this chat just now, so I haven\'t posted my answer here. Ask again in a minute and I\'ll try again.';
    case 'setup-problem': return 'I can\'t check who can see this chat: my Telegram token isn\'t accepted. I\'ve told my owner how to fix it.';
    case 'fresh-session': return 'Some knowledge this conversation used has changed, so I\'m carrying on in a fresh session.';
    case 'waiting-in-t3': return notice.where === 'app'
      ? 'I\'m waiting for you in the Serra app: answer it in Jobs › Transcript. Messages here reach me once it\'s answered.'
      : 'I\'m waiting for you in T3: it needs an action there, such as a token, an approval, or a question Telegram can\'t show. Messages here reach me once it\'s answered.';
    case 'images-unsupported': return `${notice.agent} can't see images, so it only got the file's path.`;
    case 'question-hint': return QUESTION_HINTS[notice.hint];
  }
};

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface TelegramChatOptions {
  api: TelegramApi;
  store: ThreadStore;
  /** The bot's Telegram user ID and @username, known after `getMe`. */
  botId: () => string;
  username: () => string;
  /** The owner's Telegram user ID, or null before they paired. */
  owner: () => string | null;
  /** Names learned from messages: Telegram has no lookup by ID. */
  names: ReadonlyMap<string, string>;
  profileDir: string;
  logger: Logger;
  clock: Pick<Clock, 'now'>;
}

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

export const createTelegramChat = ({ api, store, botId, username, owner, names, profileDir, logger, clock }: TelegramChatOptions): { chat: ChatPort; writer: WorkerWriter } => {
  const now = (): number => clock.now();
  const self = (): PersonId => telegramId(botId());
  /** Never anyone's ID before pairing: a Telegram user ID is a number. */
  const ownerId = (): PersonId => telegramId(owner() ?? 'unpaired');
  const raw = (id: string): string => rawId(TELEGRAM, id);
  /** The bot's @mention. Usernames are letters, digits and underscores, so nothing in one needs escaping. */
  const mention = (): RegExp => new RegExp(`@${username().replace(/\W/g, '')}\\b`, 'gi');

  const audienceOf = (target: Target): Audience => {
    const paired = owner();
    // A private chat's ID is the person's own user ID.
    return paired !== null && raw(target.conversation) === paired ? 'owner' : 'external';
  };

  /** Posts in a thread, as a reply to its first message, and records the message in the thread. */
  const post = async (target: Target, html: string, text: string, keyboard?: InlineKeyboard): Promise<string> => {
    const chat = raw(target.conversation);
    const sent = await api.sendMessage(chat, html, { ...(target.thread ? { replyTo: Number(target.thread) } : {}), ...(keyboard ? { keyboard } : {}) });
    const id = String(sent.message_id);
    if (target.thread) store.add(chat, target.thread, { id, from: 'self', text }, now());
    return id;
  };

  const footer = (link_: string | null, notify: OwnerNotify): string => {
    const t3 = link_ ? link(link_, 'T3 thread') : 'T3 thread';
    return `<i>${notify === 'cc' ? 'cc my owner · ' : ''}${t3}</i>`;
  };
  const replyHtml = (body: string, link_: string | null, notify: OwnerNotify): string =>
    `${notify === 'callout' ? '<b>This one needs you.</b>\n\n' : ''}${messageHtml(body, footer(link_, notify))}`;

  const questionHtml = (card: QuestionCard): { html: string; keyboard?: InlineKeyboard } => {
    const question = card.questions[card.index];
    if (!question) throw new Error(`The card has no question ${card.index + 1}`);
    const head = `<b>I need your input${card.questions.length > 1 ? ` (${card.index + 1}/${card.questions.length})` : ''}.</b>\n${markdownToHtml(question.question)}`;
    const buttons = question.options.length > 0 && !question.multiSelect && question.options.length <= MAX_BUTTONS;
    const listed = question.options.length > 0 && !buttons
      ? `\n\n${question.options.map((option, index) => `${index + 1}. ${escapeHtml(option.label)}${option.description && option.description !== option.label ? ` — ${escapeHtml(option.description)}` : ''}`).join('\n')}`
      : buttons ? `\n\n${question.options.filter((option) => option.description && option.description !== option.label).map((option) => `<b>${escapeHtml(option.label)}</b>: ${escapeHtml(option.description)}`).join('\n')}`.trimEnd() : '';
    const custom = !question.options.length || question.allowCustomAnswer !== false;
    const how = !question.options.length ? 'Reply with your answer.'
      : buttons ? (custom ? 'Tap an answer, or reply with your own.' : 'Tap an answer.')
        : question.multiSelect ? 'Reply with the numbers, like 1,3.' : 'Reply with a number.';
    const who = question.id === 'permission' ? ' Only the bot owner can answer.' : '';
    const html = `${head}${listed}\n\n<i>${how}${who}</i>`.slice(0, 4000);
    if (!buttons) return { html };
    return { html, keyboard: question.options.map((option, index) => [{ text: option.label.slice(0, 60), callback_data: questionData(card.nonce, index) }]) };
  };

  const answeredHtml = (card: QuestionCard, by?: PersonId): string => {
    const lines = card.questions.flatMap((question) => {
      const answer = Object.hasOwn(card.answers, question.id) ? card.answers[question.id] : undefined;
      const label = (value: string): string => question.options.find((option) => (option.value ?? option.label) === value)?.label ?? value;
      return answer === undefined ? [] : [`${markdownToHtml(question.question)}\n<b>${escapeHtml(Array.isArray(answer) ? answer.map(label).join(', ') : label(answer))}</b>`];
    });
    return [by ? 'Answer sent. Continuing…' : 'This question is no longer waiting for an answer.', ...lines].join('\n\n').slice(0, 4000);
  };

  const render = (out: WorkerOut): { html: string; keyboard?: InlineKeyboard } => {
    switch (out.kind) {
      case 'reply': return { html: replyHtml(out.markdown, out.link, out.notify) };
      case 'status': {
        const at = new Date(out.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return { html: messageHtml(out.markdown, `<i>Updated ${at} · ${link(out.link, 'T3 thread')}</i>`) };
      }
      case 'progress': return { html: `<i>${escapeHtml(out.text.slice(0, 500))}</i>` };
      case 'question': return questionHtml(out.card);
      case 'answered': return { html: answeredHtml(out.card, out.by) };
      case 'review': return { html: messageHtml(out.markdown, `<i>Prepared by ${escapeHtml(out.from)} · ${link(out.link, 'request thread')}</i>`) };
      case 'failure-detail': return { html: `Something went wrong on my side.\n<code>${escapeHtml(out.line.slice(0, 500))}</code>` };
    }
  };

  const noticeHtml = (notice: Replacement, inPlaceOf?: InPlaceOf): string => {
    if (notice.kind === 'question-closed') return plain('This question was closed: some knowledge it used was made private.');
    if (notice.kind === 'question-over') return plain(notice.answered ? 'Answer sent. Continuing…' : 'This question is no longer waiting for an answer.');
    const text = noticeText(notice);
    if (notice.kind === 'waiting-in-t3' && notice.link && !notice.where) return `${plain(text)}\n\n${link(notice.link, 'Open it in T3')}`;
    if (inPlaceOf?.frame === 'reply') return replyHtml(text, inPlaceOf.link, inPlaceOf.notify);
    return plain(text);
  };

  const chat: ChatPort = {
    self: () => self(),
    owner: () => ownerId(),
    displayName: async (person) => names.get(person) ?? raw(person),
    parse(_conversation, text) {
      if (!username()) return { mentions: [], prose: text };
      return { mentions: mention().test(text) ? [self()] : [], prose: text.replace(mention(), ' ') };
    },
    async read(conversation, text) {
      const { mentions, prose } = chat.parse(conversation, text);
      return { text: prose.replace(/[ \t]{2,}/g, ' ').trim(), mentions, prose };
    },
    async history(target, before) {
      if (target.thread === null) return { lines: [], more: false };
      const lines: HistoryLine[] = store.lines(raw(target.conversation), target.thread, before).map((line) => ({
        id: line.id, text: line.text, files: [],
        from: line.from === 'self' ? { kind: 'self' } : { kind: 'person', id: telegramId(line.from) },
      }));
      return { lines, more: false };
    },
    receiveFiles: (_conversation, files, limit) => receiveTelegramFiles(api, files, profileDir, limit),
    async permalink(ref) {
      // Only a supergroup's messages have links; a private chat's don't.
      const group = /^-100(\d+)$/.exec(raw(ref.conversation));
      return group ? `https://t.me/c/${group[1]}/${ref.id}` : null;
    },
    async findReply(target, intent) {
      const found = store.replyOf(intent.runId);
      return found && found.chat === raw(target.conversation) ? found.id : null;
    },
    audience: async (target) => ({ ok: true, value: audienceOf(target) }),
    async notice(target, notice, inPlaceOf) {
      const id = await post(target, noticeHtml(notice, inPlaceOf), notice.kind);
      if (inPlaceOf?.runId) store.recordReply(inPlaceOf.runId, raw(target.conversation), id);
      return id;
    },
    async replaceWithNotice(ref, notice, frame) {
      return api.editMessageText(raw(ref.conversation), Number(ref.id), noticeHtml(notice, frame === 'status' ? { runId: '', frame } : undefined))
        .then(() => true, (error: unknown) => { logger.debug(`Replacing Telegram message ${ref.id} failed: ${errorMessage(error)}`); return false; });
    },
    async remove(ref) {
      await api.deleteMessage(raw(ref.conversation), Number(ref.id)).catch((error: unknown) => logger.debug(`Removing Telegram message ${ref.id} failed: ${errorMessage(error)}`));
    },
    async acknowledge(ref, on) {
      await api.setReaction(raw(ref.conversation), Number(ref.id), on ? SEEN : null).catch((error: unknown) => logger.debug(`👀 on Telegram message ${ref.id} failed: ${errorMessage(error)}`));
    },
    async setWorking(target, on) {
      if (on) await api.sendTyping(raw(target.conversation)).catch(() => {});
    },
  };

  /** A proof is for one conversation and a short while, as Slack's writer checks. */
  const check = (proof: Cleared, conversation = proof.target.conversation): void => {
    if (proof.target.conversation !== conversation) throw new Error(`Cleared for ${proof.target.conversation}, not ${conversation}`);
    if (now() - proof.at > CLEARED_TTL_MS) throw new Error(`Who can see ${conversation} was checked too long ago to post on`);
  };

  const writer: WorkerWriter = {
    clear: async (target): Promise<Result<Cleared>> => ({ ok: true, value: clearedFor(target, audienceOf(target), now()) }),
    async send(proof, out) {
      check(proof);
      const { html, keyboard } = render(out);
      const id = await post(proof.target, html, lineText(out), keyboard);
      if (out.kind === 'reply' || out.kind === 'status') store.recordReply(out.runId, raw(proof.target.conversation), id);
      return id;
    },
    async revise(proof, ref, out) {
      check(proof, ref.conversation);
      const { html, keyboard } = render(out);
      try { await api.editMessageText(raw(ref.conversation), Number(ref.id), html, keyboard ? { keyboard } : {}); }
      catch (error) {
        if (error instanceof TelegramError && /message to edit not found|MESSAGE_ID_INVALID/i.test(error.description)) throw new MessageGone(ref);
        throw error;
      }
    },
    async upload(proof, file) {
      check(proof);
      const chat = raw(proof.target.conversation);
      try {
        const sent = await api.sendFile(chat, file.path, { caption: file.label, photo: IMAGE.has(extname(file.path).toLowerCase()), ...(proof.target.thread ? { replyTo: Number(proof.target.thread) } : {}) });
        if (proof.target.thread) store.add(chat, proof.target.thread, { id: String(sent.message_id), from: 'self', text: file.label }, now());
        return null;
      } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
    },
  };

  return { chat, writer };
};
