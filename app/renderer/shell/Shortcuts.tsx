// Listens for ⌘N and ⌘, anywhere in the window (even in a field), opens their screen and puts focus there: the
// composer for New task, the page heading for Settings. The command palette closes first.
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { CLOSE_COMMAND_PALETTE } from './events.ts';
import { isMac } from './keys.ts';
import { NEW_TASK_PATH, shortcutPath } from './shortcuts.logic.ts';


/** Focuses the screen's composer, or its heading, once the route has rendered (a few frames at most). */
/** The screen's heading now, so focusScreen can wait for the next screen's instead of taking the outgoing one. */
export const currentHeading = (): Element | null => document.querySelector('[data-serra-main] h1');

export const focusScreen = (path: string, before: Element | null = null, tries = 20): void => {
  const found = path === NEW_TASK_PATH
    ? document.getElementById('new-task-request')
    : document.querySelector<HTMLElement>('[data-serra-main] h1');
  // The outgoing screen's heading is only right when the route didn't change (already there); give the new one time.
  const target = found && (found !== before || tries === 0) && found.isConnected ? found : null;
  if (!target) { if (tries > 0) requestAnimationFrame(() => focusScreen(path, before, tries - 1)); return; }
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
      const before = currentHeading();
      window.dispatchEvent(new Event(CLOSE_COMMAND_PALETTE));
      navigate(path);
      // The palette gives focus back as it closes; take it after that, on the new screen.
      requestAnimationFrame(() => requestAnimationFrame(() => focusScreen(path, before)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return null;
};
