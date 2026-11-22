import type { T3Question, T3QuestionRequest } from './t3-questions.ts';

export type QuestionAnswer = string | string[];
/** A T3 question shown as a card in the chat, saved with the job so answers and buttons survive a restart. */
export interface QuestionCard extends T3QuestionRequest {
  /** The card's message ID in the chat. */
  ts: string;
  nonce: string;
  index: number;
  answers: Record<string, QuestionAnswer>;
  runId: string | null;
}

const optionValue = (question: T3Question, index: number): string => question.options[index]!.value ?? question.options[index]!.label;

/** Oversized or ambiguous forms stay in T3 rather than silently losing choices or answers. */
export const canShowQuestion = (request: T3QuestionRequest): boolean =>
  request.questions.length > 0 && request.questions.length <= 20 &&
  new Set(request.questions.map((question) => question.id)).size === request.questions.length &&
  request.questions.every((question) => question.id.length > 0 && question.question.trim().length > 0 &&
    question.question.length <= 2_500 && question.options.length <= 20 &&
    question.options.every((option) => option.label.trim().length > 0 && option.label.length <= 2_000 &&
      option.description.length <= 2_000));

/** Someone chose answers on a question card and submitted them. */
export interface QuestionInteraction {
  channel: string;
  /** The card's message ID. */
  messageTs: string;
  user: string;
  nonce: string;
  /** The chosen options, by index into the saved form. */
  indices?: number[];
}

export const choiceAnswer = (question: T3Question, indices: number[] | undefined): QuestionAnswer | null => {
  if (!indices?.length || (!question.multiSelect && indices.length !== 1) ||
    new Set(indices).size !== indices.length || indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= question.options.length)) return null;
  const values = indices.map((index) => optionValue(question, index));
  return question.multiSelect ? values : values[0]!;
};

/** A plain thread reply answers the current question, respecting providers that forbid custom answers. */
export const typedAnswer = (question: T3Question, text: string): QuestionAnswer | null => {
  const input = text.trim();
  if (!input || input.length > 4_000) return null;
  const match = (value: string): number => {
    const index = question.options.findIndex((option) => [option.label, option.value].some((label) => label?.toLowerCase() === value.toLowerCase()));
    return index !== -1 ? index : /^\d+$/.test(value) ? Number(value) - 1 : -1;
  };
  const exact = match(input);
  if (exact >= 0 && exact < question.options.length) return choiceAnswer(question, [exact]);
  if (question.multiSelect) {
    const indices = input.split(',').map((value) => match(value.trim()));
    const chosen = choiceAnswer(question, indices);
    if (chosen !== null) return chosen;
  }
  return !question.options.length || question.allowCustomAnswer !== false ? input : null;
};

