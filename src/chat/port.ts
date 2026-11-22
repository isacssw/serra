/**
 * What the core needs from a chat: reading what people wrote, Serra's own fixed notices, and acknowledgements. Slack
 * implements it in `src/slack/`; a second chat is another adapter, with no change here or in the core.
 *
 * Nothing in `ChatPort` takes free text to post. The worker's words go out only through `deliver` (`deliver.ts`), the
 * one function handed a `WorkerWriter` (`writer.ts`), which checks who can see the target right before each write.
 */
import type { Visibility } from '../owner-model.ts';
import type { QuestionCard } from '../questions.ts';
import type { IncomingFile } from '../types.ts';

/** Who can see a conversation: only the owner, the owner's team, or people outside it as well. */
export type Audience = Visibility;

/** A person in the chat, by the chat's own ID. Only compared with other IDs (such as the owner's), never parsed. */
export type PersonId = string;

/**
 * Where messages go: a conversation, and the thread in it (`null`: the conversation itself, as for a review request).
 * Made by an adapter from an inbound message or a configured conversation; the core stores and compares it. What a
 * thread is, per chat, is the adapter's business.
 */
export interface Target { readonly conversation: string; readonly thread: string | null }

/** One message the chat holds, by its conversation and the chat's ID for it. */
export interface MessageRef { readonly conversation: string; readonly id: string }

/** A lookup the chat refuses until the owner fixes the app: a permission it lacks, or a token it doesn't accept. */
export type SetupProblem = 'missing-permission' | 'bad-token';

/**
 * Why a lookup failed: `retry` may work later; `setup` won't until the owner fixes the app. `code` is the chat's own
 * error code, for the log and the app only: it never goes into a notice.
 */
export type ChatError = { kind: 'retry' } | { kind: 'setup'; problem: SetupProblem; code: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: ChatError };

/** An edit failed because the message is gone (someone deleted it). Callers post a new one instead. */
export class MessageGone extends Error {
  constructor(ref: MessageRef) {
    super(`message ${ref.id} in ${ref.conversation} is gone`);
    this.name = 'MessageGone';
  }
}

declare const t3Link: unique symbol;
/** A T3 thread's web link, as T3 gave it. Only `t3LinkOf` makes one, so worker text can't pass for a link in a notice. */
export type T3Link = string & { readonly [t3Link]: true };
/** `url` as a T3 link: an http(s) URL with nothing a chat could read as markup, or null. */
export const t3LinkOf = (url: string): T3Link | null =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand exists only in the type; this is its constructor
  /^https?:\/\/[^\s<>|]+$/.test(url) ? url as T3Link : null;

/** How many attached files one turn downloads for the worker. */
export const MAX_ATTACHMENTS = 5;

/**
 * Serra's own words: a closed list, none with a free-text field, so worker text can't travel as a notice. The adapter
 * owns the copy.
 */
export type Notice =
  /** The answer to "are you there?". */
  | { kind: 'here' }
  /** Someone the owner hasn't added asked for something. */
  | { kind: 'refused' }
  /** Handling a request failed. `owner`: the owner asked, and is pointed at the app for the detail. */
  | { kind: 'failed'; owner: boolean }
  /** In place of worker words written with knowledge since taken back for who can see the thread. */
  | { kind: 'withheld' }
  /** In place of worker words when the chat couldn't confirm who can see the thread. */
  | { kind: 'unconfirmed' }
  /** In place of worker words when the chat won't say who can see the thread until the owner fixes the app. */
  | { kind: 'setup-problem'; problem: SetupProblem }
  /** The thread carries on in a fresh T3 session because some knowledge it used changed. */
  | { kind: 'fresh-session' }
  /** The worker waits for something only T3 can show (a token, an approval, a form too big for the chat). */
  | { kind: 'waiting-in-t3'; link: T3Link | null }
  /** Feedback on an answer to a question card. */
  | { kind: 'question-hint'; hint: 'choose' | 'invalid-answer' | 'changed' | 'not-sent' | 'unconfirmed' };

/** What a message can be replaced with: a notice, or a question card's fixed text. */
export type Replacement = Notice
  /** A card closed because its thread's knowledge was taken back. */
  | { kind: 'question-closed' }
  /** A card that waits for nothing any more, when the chat couldn't confirm who sees it to show the answers. */
  | { kind: 'question-over'; answered: boolean };

/** How a reply tells the owner: `callout` for a new blocker, `cc` once so they follow the thread, otherwise nothing. */
export type OwnerNotify = 'callout' | 'cc' | 'none';

/**
 * Where a notice stands in for a run's reply: which run (so a restart finds it instead of posting again) and the frame
 * the reply would have had.
 */
export type InPlaceOf = { runId: string } & ({ frame: 'reply'; link: T3Link | null; notify: OwnerNotify } | { frame: 'status' });

/** A message read back from a thread, its text as the chat holds it (pass it to `read`). */
export interface HistoryLine {
  id: string;
  from: { kind: 'self' } | { kind: 'bot'; name?: string } | { kind: 'person'; id: PersonId } | { kind: 'unknown' };
  text: string;
  files: IncomingFile[];
}

/** A message's text as the worker reads it. */
export interface InboundText {
  /** The bot's own mention removed, everyone else's as `@Name`. */
  text: string;
  /** The people the message mentions, without duplicates. */
  mentions: PersonId[];
  /** The text with every mention left out, to look for the bot's name written without a mention. */
  prose: string;
}

/** The worker's words, as the core hands them over. Markdown is the worker's; the adapter converts and truncates. Only
 * `deliver` writes these (`deliver.ts`). */
export type WorkerOut =
  /** A run's reply. `link` is the T3 thread. */
  | { kind: 'reply'; markdown: string; link: string; notify: OwnerNotify; runId: string }
  /** A run the worker started on its own: one status message, edited as runs end. */
  | { kind: 'status'; markdown: string; link: string; runId: string; updatedAt: number }
  /** What a long run is doing now, in one line. */
  | { kind: 'progress'; text: string }
  /** A question card for `to`. */
  | { kind: 'question'; card: QuestionCard; to: PersonId }
  /** A question card once answered or no longer waiting: it repeats the questions and the answers chosen. */
  | { kind: 'answered'; card: QuestionCard; by?: PersonId }
  /** A review request in the code-review channel, prepared by `from` for the owner, linking back to `link`. */
  | { kind: 'review'; markdown: string; from: string; link: string }
  /** The first line of an error, which can be raw `t3` or `git` output. */
  | { kind: 'failure-detail'; line: string };

/** A local file the worker's reply attaches. */
export interface WorkerFile { path: string; label: string; altText?: string }

/** What the reply to a run that a restart may have cut off looks like, to find it in the thread. */
interface ReplyIntent { runId: string; at: string; text?: string }

/**
 * Everything the core may call freely: none of it can post the worker's words. An adapter may need to learn from inbound
 * events too (Slack's learns whose each DM is, `sawDm`): that stays between the adapter and the wiring that feeds it.
 */
export interface ChatPort {
  /** The bot's own ID. Known only after the chat connects. */
  self(): PersonId;
  /** A person's name as the chat shows it, or their ID when it can't say. */
  displayName(person: PersonId): Promise<string>;
  /** Who a message mentions, and its words without the mentions: enough to tell who it is for, with no lookup. */
  parse(text: string): Pick<InboundText, 'mentions' | 'prose'>;
  /** A message's text as the worker reads it: mentions as the names `nameOf` gives. */
  read(text: string, nameOf: (person: PersonId) => Promise<string>): Promise<InboundText>;
  /** The thread's messages before `before`, oldest first; `more` when older ones were left out. Null when it can't be read. */
  history(target: Target, before: string): Promise<{ lines: HistoryLine[]; more: boolean } | null>;
  /** Downloads attached files for the worker and says where they are, or why one couldn't be had. */
  receiveFiles(files: IncomingFile[], limit: number): Promise<string>;
  permalink(ref: MessageRef): Promise<string | null>;
  /** The ID of the reply to `intent.runId` the bot already posted in the thread, or null when there is none or the chat can't say. */
  findReply(target: Target, intent: ReplyIntent): Promise<string | null>;
  /**
   * Who can see `target`, for a reply to `requester`. `fresh` asks the chat again (before anything is posted); without
   * it a recent answer may be reused (building a brief). An error is never `team`.
   */
  audience(target: Target, requester: PersonId, options?: { fresh?: boolean }): Promise<Result<Audience>>;
  /** Posts a notice in the thread, or in place of a run's reply. Returns the message's ID. */
  notice(target: Target, notice: Notice, inPlaceOf?: InPlaceOf): Promise<string | undefined>;
  /** Replaces a message, such as a card or a status line, with a notice. False when it couldn't (it was deleted, say). */
  replaceWithNotice(ref: MessageRef, notice: Replacement, frame?: 'status'): Promise<boolean>;
  /** Removes a message the bot posted. Best effort. */
  remove(ref: MessageRef): Promise<void>;
  /** Marks a message as seen and being worked on (Slack: 👀), or takes the mark away. Best effort. */
  acknowledge(ref: MessageRef, on: boolean): Promise<void>;
  /** Shows or clears the chat's own "working on it" status in the thread. Best effort. */
  setWorking(target: Target, on: boolean): Promise<void>;
}
