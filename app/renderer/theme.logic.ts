// The window's theme (APP-28): System, Light or Dark, from app prefs. `system` follows macOS; light and dark set
// `data-theme` on <html>, which overrides `color-scheme` (see styles.css). One store holds the choice, so the
// Appearance page and ⌘K always agree. Pure data and functions: imported by `node --test` as well as the renderer.
import type { Theme } from '../main/bridge.ts';
import type { Action } from './commands/registry.ts';

export const themes: readonly Theme[] = ['system', 'light', 'dark'];

export const themeLabels: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

const isTheme = (value: unknown): value is Theme => themes.includes(value as Theme);

/** Just what `applyTheme` touches, so tests can pass a plain object for <html>. */
export interface ThemeRoot { dataset: Record<string, string | undefined> }

/** Shows `theme` in the window at once: no reload, every light-dark() colour follows. */
export const applyTheme = (theme: Theme, root: ThemeRoot): void => {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
};

export interface ThemeStore {
  current(): Theme;
  subscribe(listener: () => void): () => void;
  /** The theme saved in prefs at launch. Applies it without saving it again. */
  load(theme: Theme): void;
  /**
   * Applies `theme` straight away, then saves it (main sets macOS's `nativeTheme` from the saved prefs). When saving
   * fails, the window goes back to the theme it had and the error is thrown for the caller to show.
   */
  set(theme: Theme): Promise<void>;
}

export const createThemeStore = ({ apply, save }: {
  apply(theme: Theme): void;
  /** Saves the theme in prefs and returns the one saved. */
  save(theme: Theme): Promise<Theme>;
}): ThemeStore => {
  let theme: Theme = 'system';
  const listeners = new Set<() => void>();
  const show = (next: Theme): void => {
    theme = next;
    apply(next);
    for (const listener of listeners) listener();
  };
  return {
    current: () => theme,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: (next) => show(isTheme(next) ? next : 'system'),
    set: async (next) => {
      if (!isTheme(next)) throw new Error(`Theme must be ${themes.map((t) => themeLabels[t]).join(', ')}.`);
      const before = theme;
      show(next);
      try {
        const saved = await save(next);
        // Another change may have come in while this one saved; the latest one wins.
        if (theme === next && saved !== next) show(saved);
      } catch (error) {
        if (theme === next) show(before);
        throw error;
      }
    },
  };
};

/** The Appearance page's control, in ⌘K: Switch theme… then System, Light or Dark. */
export const switchThemeAction = (store: ThemeStore): Action => ({
  id: 'app:theme',
  title: 'Switch theme…',
  group: 'Actions',
  keywords: ['theme', 'appearance', 'dark mode', 'light mode', 'system', 'colour', 'color'],
  button: 'Settings › Appearance › Theme',
  argument: {
    placeholder: 'Theme',
    hint: 'System follows macOS.',
    choices: async () => themes.map((value) => ({
      value,
      label: themeLabels[value],
      ...(value === store.current() ? { detail: 'Current' } : {}),
    })),
  },
  run: async (_context, value = '') => {
    if (!isTheme(value)) throw new Error('Pick System, Light or Dark.');
    await store.set(value);
  },
});
