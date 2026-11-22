// App preferences: window size and place, theme, last screen, the profile folder the app manages, and when to ask
// for a GitHub star.
// Pure logic here; `prefs-store.ts` keeps them in electron-store. Nothing about the bot lives in prefs.
import { isAbsolute } from 'node:path';
import type { AppPrefs, StarPromptState, Theme } from './bridge.ts';

export const defaultPrefs: AppPrefs = {
  theme: 'system',
  lastScreen: null,
  window: { width: 1100, height: 720, maximized: false },
  profileDir: null,
  includePrereleases: null,
  setupDraft: null,
  starPrompt: { since: null, finished: 0, asks: 0, shownIn: null, snoozedUntil: null, done: false },
};

/** Where prefs are read from and saved to. */
export interface PrefsStore {
  get(): AppPrefs;
  set(prefs: AppPrefs): void;
}

const themes: readonly Theme[] = ['system', 'light', 'dark'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The setup form's fields (`ProfileDraft`), the only keys a saved draft may hold. */
const DRAFT_FIELDS = ['botName', 'botId', 'ownerName', 'ownerSlackUserId', 'githubLogin', 'projectPath', 'remote', 'baseRef', 'githubRepo', 't3Bin', 'directory'];
const MIN_WIDTH = 640;
const MIN_HEIGHT = 420;

const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** The star request's memory, checked whole: a broken one throws, so `readPrefs` falls back to a fresh start. */
const parseStarPrompt = (value: unknown): StarPromptState => {
  if (!isRecord(value)) throw new Error('starPrompt must be an object.');
  const { since, finished, asks, shownIn, snoozedUntil, done } = value;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1_000_000;
  if (since !== null && !isTime(since)) throw new Error('starPrompt.since must be a time or null.');
  if (snoozedUntil !== null && !isTime(snoozedUntil)) throw new Error('starPrompt.snoozedUntil must be a time or null.');
  if (!count(finished) || !count(asks)) throw new Error('starPrompt counts must be whole numbers.');
  if (shownIn !== null && (typeof shownIn !== 'string' || shownIn.length > 64)) throw new Error('starPrompt.shownIn must be a version or null.');
  if (typeof done !== 'boolean') throw new Error('starPrompt.done must be true or false.');
  return { since, finished, asks, shownIn, snoozedUntil, done };
};

const pick = (a: string | null, b: string | null, first: boolean): string | null =>
  a && b ? ((Date.parse(a) <= Date.parse(b)) === first ? a : b) : a ?? b;

/**
 * A save of the star request's memory only moves it forward: an answer stays given, counts never drop, the clock
 * keeps its earliest start and the snooze its latest end. So a write from a stale copy can't undo "Don't ask again".
 */
export const combineStarPrompt = (saved: StarPromptState, incoming: StarPromptState): StarPromptState => ({
  since: pick(saved.since, incoming.since, true),
  finished: Math.max(saved.finished, incoming.finished),
  asks: Math.max(saved.asks, incoming.asks),
  shownIn: incoming.shownIn ?? saved.shownIn,
  snoozedUntil: pick(saved.snoozedUntil, incoming.snoozedUntil, false),
  done: saved.done || incoming.done,
});

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
    case 'setupDraft': {
      if (value === null) return { setupDraft: null };
      if (!isRecord(value)) throw new Error('setupDraft must be an object or null.');
      const draft: Record<string, string> = {};
      for (const [field, text] of Object.entries(value)) {
        if (!DRAFT_FIELDS.includes(field) || typeof text !== 'string' || text.length > 500) throw new Error(`setupDraft.${field} is not a setup field.`);
        draft[field] = text;
      }
      return { setupDraft: draft };
    }
    case 'starPrompt':
      return { starPrompt: parseStarPrompt(value) };
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
  for (const [key, value] of Object.entries(patch)) {
    const field = parseField(key, value);
    next = { ...next, ...field, ...(field.starPrompt ? { starPrompt: combineStarPrompt(next.starPrompt, field.starPrompt) } : {}) };
  }
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
