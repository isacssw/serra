// The window's own keyboard shortcuts besides ⌘K (palette.logic.ts): ⌘N starts a task, ⌘, opens Settings.
// Pure functions: imported by `node --test` as well as the renderer.
import type { KeyPress } from '../commands/palette.logic.ts';

/** Where ⌘N goes: the New task composer. */
export const NEW_TASK_PATH = '/jobs/new';
/** Where ⌘, goes: the first settings screen, as macOS apps open their settings. */
export const SETTINGS_PATH = '/settings/bot';

/**
 * The path a shortcut opens, or null when the keys aren't one. ⌘ alone on macOS, Ctrl alone elsewhere: on a Mac,
 * Ctrl+N is the text system's "next line" in every field, so it must stay with the field.
 */
export const shortcutPath = (press: KeyPress, mac: boolean): string | null => {
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (!command || press.altKey || press.shiftKey) return null;
  if (press.key.toLowerCase() === 'n') return NEW_TASK_PATH;
  if (press.key === ',') return SETTINGS_PATH;
  return null;
};

/** Where Add… goes: a new profile (SB-10). The only kind of thing to add for now, so there's no sheet to pick from. */
export const ADD_PROFILE_PATH = '/setup/new';

/** ⌘1…⌘9 switch to that profile (`index` from 0), ⌘⇧N opens Add…; null for any other keys. */
export const profileShortcut = (press: KeyPress, mac: boolean): { kind: 'switch'; index: number } | { kind: 'add' } | null => {
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (!command || press.altKey) return null;
  if (press.shiftKey) return press.key.toLowerCase() === 'n' ? { kind: 'add' } : null;
  return /^[1-9]$/.test(press.key) ? { kind: 'switch', index: Number(press.key) - 1 } : null;
};
