// Listens for ⌘N and ⌘, anywhere in the window (even in a field), opens their screen and puts focus there: the
// composer for New task, the page heading for Settings. The command palette closes first.
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { CLOSE_COMMAND_PALETTE } from './events.ts';
import { NEW_TASK_PATH, shortcutPath } from './shortcuts.logic.ts';

const isMac = /Mac/.test(navigator.userAgent);

/** Focuses the screen's composer, or its heading, once the route has rendered (a few frames at most). */
const focusScreen = (path: string, tries = 10): void => {
  const target = path === NEW_TASK_PATH
    ? document.getElementById('new-task-request')
    : document.querySelector<HTMLElement>('[data-serra-main] h1');
  if (!target) { if (tries > 0) requestAnimationFrame(() => focusScreen(path, tries - 1)); return; }
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
      window.dispatchEvent(new Event(CLOSE_COMMAND_PALETTE));
      navigate(path);
      // The palette gives focus back as it closes; take it after that, on the new screen.
      requestAnimationFrame(() => requestAnimationFrame(() => focusScreen(path)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return null;
};
