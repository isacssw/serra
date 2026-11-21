import type { webApi } from '@slack/bolt';
import type { T3Question, T3QuestionRequest } from './t3-questions.ts';

export const QUESTION_ACTION = /^serra_question_(?:choice_\d+|select|multi|submit)$/;
export type QuestionAnswer = string | string[];
export interface SlackQuestion extends T3QuestionRequest {
  ts: string;
  nonce: string;
  index: number;
  answers: Record<string, QuestionAnswer>;
  runId: string | null;
}

const short = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const plain = (text: string) => ({ type: 'plain_text' as const, text, emoji: true });
const optionValue = (question: T3Question, index: number): string => question.options[index]!.value ?? question.options[index]!.label;
type QuestionMessage = { text: string; blocks: Extract<webApi.ChatPostMessageArguments, { blocks: unknown }>['blocks'] };

/** Oversized or ambiguous forms stay in T3 rather than silently losing choices or answers. */
export const canShowQuestion = (request: T3QuestionRequest): boolean =>
  request.questions.length > 0 && request.questions.length <= 20 &&
  new Set(request.questions.map((question) => question.id)).size === request.questions.length &&
  request.questions.every((question) => question.id.length > 0 && question.question.trim().length > 0 &&
    question.question.length <= 2_500 && question.options.length <= 20 &&
    question.options.every((option) => option.label.trim().length > 0 && option.label.length <= 2_000 &&
      option.description.length <= 2_000));

/** Choice values are indices into the saved form, never provider answers supplied by a Slack payload. */
export const questionMessage = (state: SlackQuestion, recipient: string): QuestionMessage => {
  const question = state.questions[state.index]!;
  const blockId = `sq:${state.nonce}:choices`;
  const blocks: QuestionMessage['blocks'] = [
    { type: 'section', text: { type: 'mrkdwn', text: `<@${recipient}> I need your input (${state.index + 1}/${state.questions.length}).` } },
    { type: 'section', text: plain(question.question) },
  ];
  if (question.options.length) {
    for (const [index, option] of question.options.entries()) {
      const label = option.label.length > 75 ? `${index + 1}. ${option.label}` : option.label;
      const description = option.description === option.label ? '' : option.description;
      const explanation = description ? `${label}: ${description}` : label;
      // Keep complete choices outside the controls. A label and its explanation can each fit a
      // section even when their combination does not; at most 45 blocks are needed for 20 options.
      if (explanation.length <= 3_000) blocks.push({ type: 'section', text: plain(explanation) });
      else blocks.push({ type: 'section', text: plain(label) }, { type: 'section', text: plain(description) });
    }
    const options = question.options.map((option, index) => ({
      // Number shortened captions so choices with the same opening words remain distinguishable.
      text: plain(short(option.label.length > 75 ? `${index + 1}. ${option.label}` : option.label, 75)), value: String(index),
      ...(option.description ? { description: plain(short(option.description, 75)) } : {}),
    }));
    if (!question.multiSelect && options.length <= 5) {
      blocks.push({ type: 'actions', block_id: blockId, elements: options.map((option, index) => ({
        type: 'button', action_id: `serra_question_choice_${index}`, text: option.text, value: state.nonce,
      })) });
    } else if (question.multiSelect) {
      blocks.push({ type: 'actions', block_id: blockId, elements: [{
        type: 'multi_static_select', action_id: 'serra_question_multi', placeholder: plain('Choose one or more'), options,
      }] });
      blocks.push({ type: 'actions', block_id: `sq:${state.nonce}:submit`, elements: [{
        type: 'button', action_id: 'serra_question_submit', text: plain('Submit answer'), value: state.nonce, style: 'primary',
      }] });
    } else {
      blocks.push({ type: 'actions', block_id: blockId, elements: [{
        type: 'static_select', action_id: 'serra_question_select', placeholder: plain('Choose an answer'), options,
      }] });
    }
  }
  const custom = !question.options.length || question.allowCustomAnswer !== false;
  const instruction = !question.options.length ? 'Reply in this thread with your answer.' : custom
    ? 'Choose an option or reply in this thread with your own answer.'
    : 'Choose an option, or reply in this thread with its label or number.';
  blocks.push({ type: 'context', elements: [plain(`${instruction} Only the requester or bot owner can answer.`)] });
  return { text: question.question, blocks };
};

export interface QuestionInteraction {
  channel: string;
  messageTs: string;
  user: string;
  nonce: string;
  actionId: string;
  indices?: number[];
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const indicesOf = (values: unknown): number[] | undefined => {
  if (!Array.isArray(values) || !values.every((item) => record(item) && typeof item.value === 'string' && /^\d{1,3}$/.test(item.value))) return undefined;
  return values.map((item) => Number(item.value));
};

/** Accept only message interactions with a known action and form nonce. Views and shortcuts are unrelated. */
export const questionInteraction = (body: unknown): QuestionInteraction | null => {
  if (!record(body) || body.type !== 'block_actions' || !record(body.channel) || !record(body.user) ||
    !record(body.message) || typeof body.channel.id !== 'string' || typeof body.user.id !== 'string' ||
    typeof body.message.ts !== 'string' || !Array.isArray(body.actions) || body.actions.length !== 1) return null;
  const action: unknown = body.actions[0];
  if (!record(action) || typeof action.action_id !== 'string' || !QUESTION_ACTION.test(action.action_id) || typeof action.block_id !== 'string') return null;
  const nonce = /^sq:([a-f0-9]{32}):(?:choices|submit)$/.exec(action.block_id)?.[1];
  if (!nonce) return null;
  let indices: number[] | undefined;
  const choice = /^serra_question_choice_(\d+)$/.exec(action.action_id);
  if (choice) {
    if (action.value !== nonce) return null;
    indices = [Number(choice[1])];
  } else if (action.action_id === 'serra_question_select') indices = indicesOf([action.selected_option]);
  else if (action.action_id === 'serra_question_submit') {
    if (action.value !== nonce) return null;
    const values = record(body.state) && record(body.state.values) ? body.state.values[`sq:${nonce}:choices`] : undefined;
    const selection = record(values) ? values.serra_question_multi : undefined;
    indices = indicesOf(record(selection) ? selection.selected_options : undefined);
  }
  return { channel: body.channel.id, messageTs: body.message.ts, user: body.user.id, nonce, actionId: action.action_id, ...(indices ? { indices } : {}) };
};

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

/** Plain text prevents provider text or a custom reply from creating Slack mentions or links. */
/** A card closed because some knowledge its thread used was made private: fixed copy, none of the worker's words. */
export const closedMessage = (): QuestionMessage => ({
  text: 'This question was closed: some knowledge it used was made private.',
  blocks: [{ type: 'section', text: plain('This question was closed: some knowledge it used was made private.') }],
});

export const answeredMessage = (state: SlackQuestion, answeredBy?: string): QuestionMessage => ({
  text: answeredBy ? 'Answer sent. Continuing…' : 'This question is no longer waiting for an answer.',
  blocks: [
    { type: 'section', text: plain(answeredBy ? 'Answer sent. Continuing…' : 'This question is no longer waiting for an answer.') },
    ...state.questions.flatMap((question) => {
      const answer = Object.hasOwn(state.answers, question.id) ? state.answers[question.id] : undefined;
      const label = (value: string): string => question.options.find((option) => (option.value ?? option.label) === value)?.label ?? value;
      return answer === undefined ? [] : [{ type: 'section' as const, text: plain(short(`${question.question}\n${Array.isArray(answer) ? answer.map(label).join(', ') : label(answer)}`, 3_000)) }];
    }),
    ...(answeredBy ? [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text: `Answered by <@${answeredBy}>.` }] }] : []),
  ],
});
