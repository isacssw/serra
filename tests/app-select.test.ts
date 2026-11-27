// SERRA-96: the shared Select's keyboard, as a person using it sees it: which option the list opens on, where the
// arrows, Home, End and paging go, what Enter, Tab and Escape do, and what typing jumps to.
import assert from 'node:assert/strict';
import test from 'node:test';
import { enabledFrom, isPrintable, openIndex, selectKey, typeahead, type SelectChoice } from '../app/renderer/ui/select.logic.ts';

const options: SelectChoice[] = [
  { label: 'T3' },
  { label: 'Claude Code' },
  { label: 'Codex', disabled: true },
  { label: 'Cursor' },
  { label: 'Gemini' },
];
const at = (open: boolean, active: number, selected = 0) => (key: string, altKey = false) => selectKey(key, { open, active, selected, options, altKey });

test('select: a closed list opens on the chosen option with arrows, Enter or Space; Home and End open at the ends', () => {
  const closed = at(false, -1, 3);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) assert.deepEqual(closed(key), { type: 'open', index: 3 });
  assert.deepEqual(closed('Home'), { type: 'open', index: 0 });
  assert.deepEqual(closed('End'), { type: 'open', index: 4 });
  assert.deepEqual(closed('Escape'), { type: 'none' });
  assert.deepEqual(closed('Tab'), { type: 'none' }, 'Tab on a closed list moves focus as usual');
});

test('select: a list whose value is gone or disabled opens on the first option that can be chosen', () => {
  assert.equal(openIndex(options, -1), 0);
  assert.equal(openIndex(options, 2), 0);
  assert.equal(openIndex([{ label: 'A', disabled: true }, { label: 'B' }], -1), 1);
});

test('select: arrows skip disabled options and stop at the ends; Home, End and paging stay on enabled options', () => {
  assert.deepEqual(at(true, 1)('ArrowDown'), { type: 'move', index: 3 }, 'Codex is disabled');
  assert.deepEqual(at(true, 3)('ArrowUp'), { type: 'move', index: 1 });
  assert.deepEqual(at(true, 4)('ArrowDown'), { type: 'move', index: 4 }, 'no wrap at the end');
  assert.deepEqual(at(true, 0)('ArrowUp'), { type: 'move', index: 0 }, 'no wrap at the start');
  assert.deepEqual(at(true, 3)('Home'), { type: 'move', index: 0 });
  assert.deepEqual(at(true, 0)('End'), { type: 'move', index: 4 });
  assert.deepEqual(at(true, 0)('PageDown'), { type: 'move', index: 4 });
  assert.deepEqual(at(true, 4)('PageUp'), { type: 'move', index: 0 });
  assert.equal(enabledFrom([{ label: 'A', disabled: true }], 0, 1), -1);
});

test('select: Enter, Space and Alt+Up choose and keep focus; Tab chooses and lets focus move; Escape closes', () => {
  assert.deepEqual(at(true, 3)('Enter'), { type: 'choose', index: 3, keepFocus: true });
  assert.deepEqual(at(true, 3)(' '), { type: 'choose', index: 3, keepFocus: true });
  assert.deepEqual(at(true, 3)('ArrowUp', true), { type: 'choose', index: 3, keepFocus: true });
  assert.deepEqual(at(true, 3)('Tab'), { type: 'choose', index: 3, keepFocus: false });
  assert.deepEqual(at(true, 3)('Escape'), { type: 'close' });
});

test('select: typing jumps to a label, a repeated letter cycles, and disabled options are skipped', () => {
  assert.equal(typeahead(options, 'g', 0), 4);
  assert.equal(typeahead(options, 'c', 0), 1, 'Claude Code first');
  assert.equal(typeahead(options, 'c', 1), 3, 'then Cursor: Codex is disabled');
  assert.equal(typeahead(options, 'c', 3), 1, 'and round again');
  assert.equal(typeahead(options, 'cl', 1), 1, 'a longer query stays on its match');
  assert.equal(typeahead(options, 'cu', 1), 3);
  assert.equal(typeahead(options, 'x', 0), -1);
  assert.equal(isPrintable('a', {}), true);
  assert.equal(isPrintable(' ', {}), false, 'Space chooses instead');
  assert.equal(isPrintable('a', { metaKey: true }), false);
  assert.equal(isPrintable('ArrowDown', {}), false);
});
