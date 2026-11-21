// APP-28: the theme pref, its native theme in main, and the window's theme store, control and ⌘K action.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Theme } from '../app/main/bridge.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { createHandlers } from '../app/main/ipc/index.ts';
import { followTheme, type NativeThemeTarget } from '../app/main/native-theme.ts';
import { defaultPrefs, memoryPrefs, readPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { builtinActions } from '../app/renderer/commands/builtin.ts';
import { createActionRegistry, searchActions, type ActionContext } from '../app/renderer/commands/registry.ts';
import { applyTheme, createThemeStore, switchThemeAction, themes, type ThemeRoot } from '../app/renderer/theme.logic.ts';

const handlersWith = (prefs: HandlerContext['prefs']) => createHandlers({
  profileDirOrNull: () => null,
  profileDir: () => { throw new Error('no profile'); },
  prefs,
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

/** A prefs store that keeps what electron-store would: the JSON on disk. */
const jsonPrefs = () => {
  let json = 'null';
  return { get: () => readPrefs(JSON.parse(json)), set: (prefs: typeof defaultPrefs) => { json = JSON.stringify(prefs); }, json: () => json };
};

const context: ActionContext = { bridge: null, navigate: () => {}, toast: () => {} };

// ---------------------------------------------------------------------------------------------------------------
// Pref and native theme (main)
// ---------------------------------------------------------------------------------------------------------------

test('theme pref: each theme saves through setPrefs, survives a reload from disk, and the default is system', async () => {
  const stored = jsonPrefs();
  assert.equal(stored.get().theme, 'system');
  const handlers = handlersWith(stored);
  for (const theme of ['dark', 'light', 'system'] as const) {
    assert.equal((await handlers.app.setPrefs({ theme })).theme, theme);
    assert.equal(JSON.parse(stored.json()).theme, theme);
    assert.equal(stored.get().theme, theme, 'read back from the saved JSON');
    assert.equal((await handlers.app.getPrefs()).theme, theme);
  }
  // A hand-edited file with a bad theme opens on the default instead of failing.
  assert.equal(readPrefs({ theme: 'sepia', lastScreen: '/brief' }).theme, 'system');
  assert.equal(readPrefs({ theme: 'sepia', lastScreen: '/brief' }).lastScreen, '/brief');
});

test('native theme: set from the saved pref at startup', () => {
  const native: NativeThemeTarget = { themeSource: 'system' };
  followTheme(memoryPrefs({ ...defaultPrefs, theme: 'dark' }), native);
  assert.equal(native.themeSource, 'dark');
});

test('native theme: follows every saved change, and a rejected change leaves it alone', async () => {
  const native: NativeThemeTarget = { themeSource: 'system' };
  const prefs = followTheme(memoryPrefs(), native);
  const handlers = handlersWith(prefs);
  await handlers.app.setPrefs({ theme: 'light' });
  assert.equal(native.themeSource, 'light');
  await handlers.app.setPrefs({ theme: 'dark' });
  assert.equal(native.themeSource, 'dark');
  assert.throws(() => handlers.app.setPrefs({ theme: 'neon' as Theme }), /theme must be one of/);
  assert.equal(native.themeSource, 'dark');
  await handlers.app.setPrefs({ lastScreen: '/brief' });
  assert.equal(native.themeSource, 'dark', 'saving another pref keeps the theme');
  await handlers.app.setPrefs({ theme: 'system' });
  assert.equal(native.themeSource, 'system');
  assert.equal(prefs.get().theme, 'system');
});

test('native theme: main wraps the real prefs store with it before opening any window', () => {
  const source = readFileSync(new URL('../app/main/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const stored = followTheme\(electronPrefs\(\), nativeTheme\);/);
  assert.ok(source.indexOf('followTheme(') < source.indexOf('createMainWindow('));
});

// ---------------------------------------------------------------------------------------------------------------
// Window (renderer)
// ---------------------------------------------------------------------------------------------------------------

test('applyTheme: light and dark set data-theme on <html>; system removes it', () => {
  const root: ThemeRoot = { dataset: {} };
  applyTheme('dark', root);
  assert.equal(root.dataset.theme, 'dark');
  applyTheme('light', root);
  assert.equal(root.dataset.theme, 'light');
  applyTheme('system', root);
  assert.equal('theme' in root.dataset, false);
});

test('styles: data-theme overrides color-scheme, and every colour token is a light-dark() pair', () => {
  const css = readFileSync(new URL('../app/renderer/styles.css', import.meta.url), 'utf8');
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  const tokens = [...css.matchAll(/^\s*--color-[a-z-]+:\s*(.+);$/gm)].map((match) => match[1] ?? '');
  assert.ok(tokens.length >= 12);
  for (const value of tokens) assert.match(value, /^light-dark\(#[0-9a-f]{6}(?:[0-9a-f]{2})?, #[0-9a-f]{6}(?:[0-9a-f]{2})?\)$/);
});

test('renderer: no hard-coded white or black text or fills that ignore the theme', async () => {
  const { readdirSync } = await import('node:fs');
  const root = new URL('../app/renderer/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.tsx'));
  for (const file of files) {
    const source = readFileSync(new URL(file, root), 'utf8');
    // Backdrops dim whatever is behind a dialog, in both themes.
    const raw = source.match(/(?<!backdrop:)\b(?:text|bg|border|fill|stroke)-(?:white|black)\b/g) ?? [];
    assert.deepEqual(raw, [], `${file} uses ${raw.join(', ')}`);
  }
});

test('theme store: applies at once, then saves; the latest choice wins', async () => {
  const applied: Theme[] = [];
  const saved: Theme[] = [];
  const store = createThemeStore({ apply: (theme) => applied.push(theme), save: async (theme) => { saved.push(theme); return theme; } });
  let notified = 0;
  const off = store.subscribe(() => { notified += 1; });
  store.load('light');
  assert.deepEqual(saved, [], 'loading the saved theme does not save it again');
  assert.equal(store.current(), 'light');
  const pending = store.set('dark');
  assert.equal(store.current(), 'dark', 'applied before the save finishes');
  assert.deepEqual(applied, ['light', 'dark']);
  await pending;
  assert.deepEqual(saved, ['dark']);
  assert.equal(notified, 2);
  off();
  await store.set('system');
  assert.equal(notified, 2, 'unsubscribed');
  assert.equal(store.current(), 'system');
  store.load('neon' as Theme);
  assert.equal(store.current(), 'system', 'a bad stored value falls back to system');
});

test('theme store: a failed save puts the previous theme back and reports the error', async () => {
  const applied: Theme[] = [];
  const store = createThemeStore({ apply: (theme) => applied.push(theme), save: async () => { throw new Error('disk full'); } });
  store.load('light');
  await assert.rejects(store.set('dark'), /disk full/);
  assert.equal(store.current(), 'light');
  assert.deepEqual(applied, ['light', 'dark', 'light']);
  await assert.rejects(store.set('sepia' as Theme), /Theme must be System, Light, Dark/);
  assert.equal(store.current(), 'light');
});

test('⌘K: Switch theme… lists System, Light and Dark, marks the current one, and switches', async () => {
  const saved: Theme[] = [];
  const store = createThemeStore({ apply: () => {}, save: async (theme) => { saved.push(theme); return theme; } });
  store.load('system');
  const action = switchThemeAction(store);
  const choices = await action.argument?.choices?.(context);
  assert.deepEqual(choices?.map((choice) => choice.label), ['System', 'Light', 'Dark']);
  assert.deepEqual(choices?.map((choice) => choice.value), [...themes]);
  assert.equal(choices?.find((choice) => choice.detail === 'Current')?.value, 'system');
  await action.run(context, 'dark');
  assert.equal(store.current(), 'dark');
  assert.deepEqual(saved, ['dark']);
  assert.equal((await action.argument?.choices?.(context))?.find((choice) => choice.detail === 'Current')?.value, 'dark');
  await assert.rejects(async () => action.run(context, 'sepia'), /Pick System, Light or Dark/);
  assert.match(action.button, /Settings › Appearance › Theme/);
});

test('⌘K: Switch theme… registers next to the built-ins and is found by "dark" and "appearance"', () => {
  const registry = createActionRegistry();
  const action = switchThemeAction(createThemeStore({ apply: () => {}, save: async (theme) => theme }));
  registry.register(builtinActions);
  registry.register([action]);
  for (const query of ['theme', 'dark', 'appearance']) {
    assert.ok(searchActions(registry.list(), query).some((result) => result.action.id === action.id), query);
  }
});
