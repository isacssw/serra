// The main window's options and the rules for what it may load. Pure, so tests can check the security settings.
import { pathToFileURL } from 'node:url';
import type { BrowserWindowConstructorOptions } from 'electron';
import type { AppPrefs } from './bridge.ts';

/**
 * The window runs web content only: no Node, no `require`, isolated from the preload, sandboxed.
 * `window.serra` from the preload is its only way to the main process.
 */
export const windowOptions = (
  preload: string,
  bounds: AppPrefs['window'],
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions => ({
  width: bounds.width,
  height: bounds.height,
  ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
  minWidth: 640,
  minHeight: 420,
  title: 'Serra',
  // On macOS the title bar is the top of the window's own content: the traffic lights sit in the sidebar's first row
  // (Sidebar.tsx keeps that row clear and draggable). Elsewhere the system frame stays.
  ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
  show: false,
  webPreferences: {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  },
});

/**
 * Whether a frame may call the bridge or the window may navigate to `url`: the app's own files, or the renderer
 * dev server when one is set (APP-10). Anything else (a link the user followed, an injected frame) is refused.
 */
export const isAppUrl = (url: string, { fileRoot, devUrl }: { /** Absolute folder the app's pages load from. */ fileRoot: string; devUrl?: string }): boolean => {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return false; }
  if (devUrl) {
    const dev = new URL(devUrl);
    if (parsed.origin === dev.origin) return true;
  }
  return parsed.protocol === 'file:' && parsed.href.startsWith(pathToFileURL(fileRoot.endsWith('/') ? fileRoot : `${fileRoot}/`).href);
};

/** Only web links leave the app, so a page can't make main open a file or an app through `openExternal`. */
export const isExternalUrl = (url: string): boolean => {
  try { return ['https:', 'http:'].includes(new URL(url).protocol); }
  catch { return false; }
};

/**
 * The browser permissions the window may use: only writing text to the clipboard (Copy report on Diagnostics, Copy
 * manifest in the first-run wizard). Camera, microphone, notifications from the page, reading the clipboard and
 * everything else stay refused.
 */
export const allowsPermission = (permission: string): boolean => permission === 'clipboard-sanitized-write';
