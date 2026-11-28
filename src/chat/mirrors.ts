/**
 * Approvals follow the owner. When an agent asks the owner to allow a tool, the card goes to the job's thread as
 * always, and a copy goes to the owner's own private conversation in every other connected chat (the chat's
 * `ownerSpace`): whichever the owner answers first wins, and every copy then shows it's done. A Slack-only owner sees
 * no change: a copy never goes to the chat the job is in, nor anywhere but the owner's own conversation.
 *
 * The rules, pure and tested here; `src/bot.ts` posts and closes the copies, through `deliver` with the owner-only rule.
 */
import type { QuestionCard, QuestionInteraction } from '../questions.ts';
import type { MessageRef } from './port.ts';

/** The most answers a copy offers: every chat shows this many as buttons, so a copy is always answered by a tap. */
const COPY_MAX_OPTIONS = 5;

/** How long a copy that couldn't be shown as done (its chat was down) is tried again. */
const STALE_COPY_MS = 48 * 60 * 60 * 1000;

/** How often a stale copy is tried again. */
export const STALE_COPY_RETRY_MS = 60_000;

/**
 * Whether a card may follow the owner: a tool approval (question id `permission`, the owner's alone) with one question
 * and a few single answers, so every chat shows it as buttons and one tap settles it. Forms with several steps, and
 * ordinary questions (which may be the requester's), stay in the job's thread.
 */
export const mayFollowOwner = (card: Pick<QuestionCard, 'questions'>): boolean => {
  const [question, ...more] = card.questions;
  return question !== undefined && more.length === 0 && question.id === 'permission' && question.multiSelect !== true &&
    question.options.length > 0 && question.options.length <= COPY_MAX_OPTIONS;
};

/** The copy a press landed on, if it is one of the card's. */
const copyPressed = (card: Pick<QuestionCard, 'mirrors'>, press: Pick<QuestionInteraction, 'channel' | 'messageTs'>): MessageRef | undefined =>
  card.mirrors?.find((ref) => ref.conversation === press.channel && ref.id === press.messageTs);

/** Why a press on a copy answers nothing, or null when it may answer. */
export type CopyRefusal = 'not-a-copy' | 'not-open' | 'not-owner';

/**
 * Whether a press on a copy may answer the open card: it must be on one of this card's own copies (a copy of an earlier
 * card, or of a card since replaced, matches nothing), carry the card's nonce, while the card still waits on its first
 * and only question, and come from the owner as the copy's own chat knows them, asked at press time (`isOwnerThere`).
 */
export const refuseCopyPress = (
  card: Pick<QuestionCard, 'mirrors' | 'nonce' | 'index' | 'questions'>,
  press: Pick<QuestionInteraction, 'channel' | 'messageTs' | 'nonce' | 'user'>,
  isOwnerThere: (person: string, conversation: string) => boolean,
): CopyRefusal | null => {
  if (!copyPressed(card, press)) return 'not-a-copy';
  if (press.nonce !== card.nonce || card.index !== 0 || !mayFollowOwner(card)) return 'not-open';
  return isOwnerThere(press.user, press.channel) ? null : 'not-owner';
};

/** A copy that couldn't be changed to show it's done when the card closed: tried again until its chat answers. */
export interface StaleCopy extends MessageRef {
  /** What it should say: answered, no longer waiting, or closed because knowledge was taken back. */
  shows: 'answered' | 'over' | 'closed';
  /** When the card closed. */
  since: number;
}

/** The stale copies still worth trying at `now`. */
export const freshStale = (copies: readonly StaleCopy[], now: number): StaleCopy[] => copies.filter((copy) => now - copy.since < STALE_COPY_MS);
