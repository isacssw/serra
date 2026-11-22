import assert from 'node:assert/strict';
import test from 'node:test';
import { canShowQuestion, choiceAnswer, typedAnswer, type QuestionCard } from '../src/questions.ts';
import { answeredMessage, questionInteraction, questionMessage } from '../src/slack/questions.ts';
import type { T3Question } from '../src/t3-questions.ts';

const question: T3Question = {
  id: 'scope', header: 'Scope', question: 'Which area should I investigate?',
  options: [{ label: 'Frontend', description: 'Browser behavior', value: 'front' }, { label: 'Backend', description: 'API behavior', value: 'back' }],
};
const state = (q = question): QuestionCard => ({ requestId: 'request-1', questions: [q], ts: '200.1', index: 0, answers: {}, nonce: 'a'.repeat(32), runId: 'run-1' });

test('forms keep question and option text plain, with complete descriptions and usable buttons', () => {
  const q = { ...question, question: '<!channel> Which <@USER> area?' };
  const message = questionMessage(state(q), 'UOWNER');
  assert.equal(message.text, q.question);
  const blocks = JSON.parse(JSON.stringify(message.blocks));
  assert.equal(blocks[1].text.type, 'plain_text');
  assert.equal(blocks[1].text.text, q.question);
  assert.equal(blocks[2].text.text, 'Frontend: Browser behavior');
  const buttons = blocks.find((block: { type: string }) => block.type === 'actions').elements;
  assert.deepEqual(buttons.map((button: { action_id: string }) => button.action_id), ['serra_question_choice_0', 'serra_question_choice_1']);
});

test('long labels from the failed form render completely while only button captions are shortened', () => {
  const labels = [130, 115, 88].map((length, index) => `Choice ${index + 1}: `.padEnd(length, String(index + 1)));
  const q = { ...question, options: labels.map((label) => ({ label, description: label })) };
  assert.equal(canShowQuestion({ requestId: 'request-long', questions: [q] }), true);
  const blocks = JSON.parse(JSON.stringify(questionMessage(state(q), 'UOWNER').blocks));
  const sections = blocks.filter((block: { type: string }) => block.type === 'section');
  const buttons = blocks.find((block: { type: string }) => block.type === 'actions').elements;
  for (const [index, label] of labels.entries()) {
    const displayed = sections.find((block: { text: { text: string } }) => block.text.text.includes(label)).text.text;
    assert.equal(displayed, `${index + 1}. ${label}`, 'a duplicated description should not repeat the full label');
    assert.ok(buttons[index].text.text.length <= 75);
    assert.ok(buttons[index].text.text.startsWith(`${index + 1}. `));
    assert.equal(choiceAnswer(q, [index]), label, 'the answer must retain the complete original label');
    assert.equal(typedAnswer(q, String(index + 1)), label);
  }
});

test('long choice captions stay distinct and within limits for buttons, dropdowns and multi-selects', () => {
  for (const [count, multiSelect, control] of [[3, false, 'button'], [6, false, 'static_select'], [3, true, 'multi_static_select']] as const) {
    const prefix = 'Identical opening words '.repeat(5);
    const q = { ...question, multiSelect, options: Array.from({ length: count }, (_, index) => ({
      label: `${prefix}choice ${index + 1}`, description: index % 2 ? '' : `Full explanation ${index + 1}`, value: `value-${index}`,
    })) };
    const blocks = JSON.parse(JSON.stringify(questionMessage(state(q), 'UOWNER').blocks));
    const elements = blocks.filter((block: { type: string }) => block.type === 'actions').flatMap((block: { elements: unknown[] }) => block.elements);
    const controls = elements.filter((element: { type: string }) => element.type === control);
    const captions = control === 'button' ? controls.map((button: { text: { text: string } }) => button.text.text)
      : controls[0].options.map((option: { text: { text: string } }) => option.text.text);
    assert.equal(new Set(captions).size, count);
    assert.ok(captions.every((caption: string, index: number) => caption.length <= 75 && caption.startsWith(`${index + 1}. `)));
    for (const [index, option] of q.options.entries()) {
      assert.ok(blocks.some((block: { text?: { text: string } }) => block.text?.text.includes(option.label)), 'the complete label must remain visible above controls');
      if (option.description) assert.ok(blocks.some((block: { text?: { text: string } }) => block.text?.text.includes(option.description)));
      assert.deepEqual(choiceAnswer(q, [index]), multiSelect ? [`value-${index}`] : `value-${index}`);
    }
  }
});

test('maximum supported long choices split full explanations into valid sections without exceeding block limits', () => {
  const q = { ...question, multiSelect: true, options: Array.from({ length: 20 }, (_, index) => ({
    label: `Choice ${index + 1}: `.padEnd(2_000, 'L'), description: `Explanation ${index + 1}: `.padEnd(2_000, 'D'),
  })) };
  assert.equal(canShowQuestion({ requestId: 'large-but-supported', questions: [q] }), true);
  const blocks = JSON.parse(JSON.stringify(questionMessage(state(q), 'UOWNER').blocks));
  assert.ok(blocks.length <= 50);
  const sections = blocks.filter((block: { type: string }) => block.type === 'section');
  assert.ok(sections.every((block: { text: { text: string } }) => block.text.text.length <= 3_000));
  for (const option of q.options) {
    assert.ok(sections.some((block: { text: { text: string } }) => block.text.text.includes(option.label)));
    assert.ok(sections.some((block: { text: { text: string } }) => block.text.text === option.description));
  }
  const menu = blocks.find((block: { type: string }) => block.type === 'actions').elements[0];
  assert.ok(menu.options.every((option: { text: { text: string }; description: { text: string } }) => option.text.text.length <= 75 && option.description.text.length <= 75));
});

test('multi-select choices require a submit button and do not preselect an answer', () => {
  const message = questionMessage(state({ ...question, multiSelect: true, initialAnswer: 'front' }), 'UOWNER');
  const blocks = JSON.parse(JSON.stringify(message.blocks));
  const choices = blocks.find((block: { type: string }) => block.type === 'actions').elements[0];
  assert.equal(choices.type, 'multi_static_select');
  assert.equal(choices.initial_options, undefined);
  assert.match(JSON.stringify(blocks), /serra_question_submit/);
});

test('choice validation uses saved values, rejects forged indices, and preserves multi-selection', () => {
  assert.equal(choiceAnswer(question, [1]), 'back');
  for (const indices of [undefined, [], [-1], [2], [NaN], [0.1], [0, 1]]) assert.equal(choiceAnswer(question, indices), null);
  assert.deepEqual(choiceAnswer({ ...question, multiSelect: true }, [1, 0]), ['back', 'front']);
  assert.equal(choiceAnswer({ ...question, multiSelect: true }, [0, 0]), null);
});

test('thread replies support labels, numbers and custom answers while respecting restricted choices', () => {
  assert.equal(typedAnswer(question, 'backend'), 'back');
  assert.equal(typedAnswer(question, '1'), 'front');
  assert.equal(typedAnswer(question, 'Both, starting with the API'), 'Both, starting with the API');
  assert.equal(typedAnswer({ ...question, allowCustomAnswer: false }, 'Both'), null);
  assert.deepEqual(typedAnswer({ ...question, multiSelect: true }, 'Frontend, 2'), ['front', 'back']);
  assert.equal(typedAnswer({ ...question, options: [] }, 'A longer explanation'), 'A longer explanation');
  assert.equal(typedAnswer(question, ' '), null);
  assert.equal(typedAnswer(question, 'x'.repeat(4_001)), null);
});

test('interactive payloads are bound to the message, form nonce, and saved choice index', () => {
  const nonce = 'b'.repeat(32);
  const body = { type: 'block_actions', channel: { id: 'C1' }, user: { id: 'U1' }, message: { ts: '200.1' },
    actions: [{ action_id: 'serra_question_choice_1', block_id: `sq:${nonce}:choices`, value: nonce }] };
  assert.deepEqual(questionInteraction(body), { channel: 'C1', user: 'U1', messageTs: '200.1', nonce, indices: [1] });
  assert.equal(questionInteraction({ ...body, type: 'view_submission' }), null);
  assert.equal(questionInteraction({ ...body, actions: [{ ...body.actions[0], value: 'forged' }] }), null);
  assert.equal(questionInteraction({ ...body, actions: [{ ...body.actions[0], block_id: 'sq:forged:choices' }] }), null);
  const multi = { ...body, actions: [{ action_id: 'serra_question_submit', block_id: `sq:${nonce}:submit`, value: nonce }],
    state: { values: { [`sq:${nonce}:choices`]: { serra_question_multi: { selected_options: [{ value: '0' }, { value: '1' }] } } } } };
  assert.deepEqual(questionInteraction(multi)?.indices, [0, 1]);
  // Changing a multi-select isn't an answer until Submit: the bot never hears of it.
  assert.equal(questionInteraction({ ...body, actions: [{ action_id: 'serra_question_multi', block_id: `sq:${nonce}:choices`, selected_options: [{ value: '0' }] }] }), null);
});

test('large and ambiguous forms fall back to T3; completed cards contain no interactive controls', () => {
  assert.equal(canShowQuestion({ requestId: '1', questions: [question] }), true);
  assert.equal(canShowQuestion({ requestId: '1', questions: [question, question] }), false);
  assert.equal(canShowQuestion({ requestId: '1', questions: [{ ...question, question: 'x'.repeat(2_501) }] }), false);
  assert.equal(canShowQuestion({ requestId: '1', questions: [{ ...question, options: Array(21).fill(question.options[0]) }] }), false);
  assert.equal(canShowQuestion({ requestId: '1', questions: [{ ...question, options: [{ label: 'x'.repeat(2_001), description: '' }] }] }), false);
  assert.equal(canShowQuestion({ requestId: '1', questions: [{ ...question, options: [{ label: 'Valid', description: 'x'.repeat(2_001) }] }] }), false);
  const result = answeredMessage({ ...state(), answers: { scope: '<!channel> custom answer' } }, 'UOWNER');
  assert.doesNotMatch(JSON.stringify(result.blocks), /"type":"(?:button|actions|static_select)"/);
  assert.match(JSON.stringify(result.blocks), /"type":"plain_text","text":"Which area/);
});
