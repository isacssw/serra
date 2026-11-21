// The window's own keyboard shortcuts besides ⌘K (palette.logic.ts): ⌘N starts a task, ⌘, opens Settings.
// Pure functions: imported by `node --test` as well as the renderer.
import type { KeyPress } from '../commands/palette.logic.ts';

/** Where ⌘N goes: the New task composer. */
export const NEW_TASK_PATH = '/jobs/new';
/** Where ⌘, goes: the first settings screen, as macOS apps open their settings. */
export const SETTINGS_PATH = '/settings/bot';

/** The path a shortcut opens, or null when the keys aren't one. ⌘ on macOS, Ctrl elsewhere, no other modifier. */
export const shortcutPath = (press: KeyPress): string | null => {
  if (press.metaKey === press.ctrlKey || press.altKey || press.shiftKey) return null;
  if (press.key.toLowerCase() === 'n') return NEW_TASK_PATH;
  if (press.key === ',') return SETTINGS_PATH;
  return null;
};
