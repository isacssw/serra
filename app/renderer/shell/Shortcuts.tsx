// Listens for ⌘N and ⌘, anywhere in the window (even in a field), opens their screen and puts focus there: the
// composer for New task, the page heading for Settings. The command palette closes first.
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { CLOSE_COMMAND_PALETTE } from './events.ts';
import { isMac } from './keys.ts';
import { NEW_TASK_PATH, shortcutPath } from './shortcuts.logic.ts';

/**
 * Moves focus to a screen once React has committed it: the composer for New task, else the screen's heading. `main`
 * carries the rendered path (App.tsx), so this waits for that, never for timing. If focus moves on its own first
 * (the owner pressed Tab, clicked) away from `from`, the request is dropped rather than pulling focus back. `from` is
 * null when focus is expected to move meanwhile (the command palette closing hands it back).
 */
export const focusScreen = (path: string, from: Element | null, tries = 30): void => {
  if (from && document.activeElement !== from) return;
  const main = document.querySelector<HTMLElement>('[data-serra-main]');
  const target = main?.dataset.path === path
    ? (path === NEW_TASK_PATH ? document.getElementById('new-task-request') : main.querySelector<HTMLElement>('h1'))
    : null;
  if (!target) { if (tries > 0) requestAnimationFrame(() => focusScreen(path, from, tries - 1)); return; }
  if (target.tagName === 'H1') target.tabIndex = -1;
  target.focus();
};

export const Shortcuts = () => {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const path = shortcutPath(event, isMac);
      if (!path || event.defaultPrevented) return;
      event.preventDefault();
      const palette = document.querySelector('dialog[data-command-palette][open]');
      window.dispatchEvent(new Event(CLOSE_COMMAND_PALETTE));
      navigate(path);
      // With the palette open, focus moves as it closes, so don't treat that as the owner moving on.
      focusScreen(path, palette ? null : document.activeElement);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return null;
};
