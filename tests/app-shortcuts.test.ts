// ⌘N and ⌘, (shell/shortcuts.logic.ts): the window's shortcuts besides ⌘K.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NEW_TASK_PATH, SETTINGS_PATH, shortcutPath } from '../app/renderer/shell/shortcuts.logic.ts';

const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('shortcuts: ⌘N opens New task and ⌘, opens Settings on macOS', () => {
  assert.equal(shortcutPath(press('n', { metaKey: true }), true), NEW_TASK_PATH);
  assert.equal(shortcutPath(press('N', { metaKey: true }), true), NEW_TASK_PATH);
  assert.equal(shortcutPath(press(',', { metaKey: true }), true), SETTINGS_PATH);
});

test('shortcuts: Ctrl+N stays with the text field on macOS, and is the shortcut elsewhere', () => {
  assert.equal(shortcutPath(press('n', { ctrlKey: true }), true), null);
  assert.equal(shortcutPath(press('n', { ctrlKey: true }), false), NEW_TASK_PATH);
  assert.equal(shortcutPath(press('n', { metaKey: true }), false), null);
});

test('shortcuts: extra modifiers or other keys are not shortcuts', () => {
  assert.equal(shortcutPath(press('n', { metaKey: true, shiftKey: true }), true), null);
  assert.equal(shortcutPath(press('n', { metaKey: true, altKey: true }), true), null);
  assert.equal(shortcutPath(press('n', { metaKey: true, ctrlKey: true }), true), null);
  assert.equal(shortcutPath(press('k', { metaKey: true }), true), null);
  assert.equal(shortcutPath(press('n'), true), null);
});
