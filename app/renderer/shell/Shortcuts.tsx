// Listens for ⌘N and ⌘, anywhere in the window (even in a field) and opens their screen.
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { shortcutPath } from './shortcuts.logic.ts';

export const Shortcuts = () => {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const path = shortcutPath(event);
      if (!path || event.defaultPrevented) return;
      event.preventDefault();
      navigate(path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return null;
};
