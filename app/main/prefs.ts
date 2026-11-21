// App preferences: window size and place, theme, last screen, and the profile folder the app manages.
// Pure logic here; `prefs-store.ts` keeps them in electron-store. Nothing about the bot lives in prefs.
import { isAbsolute } from 'node:path';
import type { AppPrefs, Theme } from './bridge.ts';

export const defaultPrefs: AppPrefs = {
  theme: 'system',
  lastScreen: null,
  window: { width: 1100, height: 720, maximized: false },
  profileDir: null,
  includePrereleases: null,
};

/** Where prefs are read from and saved to. */
export interface PrefsStore {
  get(): AppPrefs;
  set(prefs: AppPrefs): void;
}

const themes: readonly Theme[] = ['system', 'light', 'dark'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const MIN_WIDTH = 640;
const MIN_HEIGHT = 420;

const parseField = (key: string, value: unknown): Partial<AppPrefs> => {
  switch (key) {
    case 'theme':
      if (!themes.includes(value as Theme)) throw new Error(`theme must be one of ${themes.join(', ')}.`);
      return { theme: value as Theme };
    case 'lastScreen':
      if (value !== null && (typeof value !== 'string' || value.length > 200)) throw new Error('lastScreen must be a route or null.');
      return { lastScreen: value };
    case 'profileDir':
      if (value !== null && (typeof value !== 'string' || !isAbsolute(value))) throw new Error('profileDir must be an absolute folder path or null.');
      return { profileDir: value };
    case 'includePrereleases':
      if (value !== null && typeof value !== 'boolean') throw new Error('includePrereleases must be true, false or null.');
      return { includePrereleases: value };
    case 'window': {
      if (!isRecord(value)) throw new Error('window must be an object.');
      const { width, height, x, y, maximized } = value;
      const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
      if (!int(width) || !int(height) || width < MIN_WIDTH || height < MIN_HEIGHT) throw new Error(`window needs whole width and height of at least ${MIN_WIDTH}×${MIN_HEIGHT}.`);
      if ((x !== undefined && !int(x)) || (y !== undefined && !int(y))) throw new Error('window x and y must be whole numbers.');
      if (typeof maximized !== 'boolean') throw new Error('window.maximized must be true or false.');
      return { window: { width, height, maximized, ...(int(x) && int(y) ? { x, y } : {}) } };
    }
    default:
      throw new Error(`Unknown preference: ${key}.`);
  }
};

/** Applies an update from the window. Throws on an unknown key or a bad value, so nothing bad is saved. */
export const mergePrefs = (current: AppPrefs, patch: unknown): AppPrefs => {
  if (!isRecord(patch)) throw new Error('Preferences must be an object.');
  let next = { ...current };
  for (const [key, value] of Object.entries(patch)) next = { ...next, ...parseField(key, value) };
  return next;
};

/** Reads stored prefs leniently: a field that is missing or broken falls back to its default instead of failing. */
export const readPrefs = (stored: unknown): AppPrefs => {
  let prefs = { ...defaultPrefs };
  if (!isRecord(stored)) return prefs;
  for (const [key, value] of Object.entries(stored)) {
    try { prefs = { ...prefs, ...parseField(key, value) }; }
    catch { /* keep the default for this field */ }
  }
  return prefs;
};

/** A prefs store in memory, for tests and smoke runs. */
export const memoryPrefs = (initial: AppPrefs = defaultPrefs): PrefsStore => {
  let prefs = initial;
  return { get: () => prefs, set: (next) => { prefs = next; } };
};
