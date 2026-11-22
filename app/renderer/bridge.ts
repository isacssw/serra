// The window's only way to the main process: `window.serra` from the preload (app/main/bridge.ts).
import type { SerraBridge } from '../main/bridge.ts';
import { isSetupIncomplete } from '../../src/setup-incomplete.ts';

declare global {
  interface Window {
    /** Absent when the page runs outside Electron (a plain browser on the Vite dev server). */
    serra?: SerraBridge;
  }
}

/** Dispatched on `window` when a call fails for want of a profile: setup's state rereads and the gate shows. */
export const SETUP_INCOMPLETE_EVENT = 'serra:setup-incomplete';

let source: SerraBridge | null = null;
let wrapped: SerraBridge | null = null;

/** Wraps every call so a `SetupIncomplete` failure also tells the shell, wherever it came from. */
const wrap = (bridge: SerraBridge): SerraBridge => {
  const out: Record<string, unknown> = {};
  for (const [namespace, api] of Object.entries(bridge)) {
    if (namespace === 'on') { out[namespace] = api; continue; }
    const methods: Record<string, unknown> = {};
    for (const [name, method] of Object.entries(api as Record<string, (...args: unknown[]) => Promise<unknown>>)) {
      methods[name] = (...args: unknown[]) => method(...args).catch((error: unknown) => {
        if (isSetupIncomplete(error)) window.dispatchEvent(new Event(SETUP_INCOMPLETE_EVENT));
        throw error;
      });
    }
    out[namespace] = methods;
  }
  return out as unknown as SerraBridge;
};

export const serra = (): SerraBridge | null => {
  const bridge = window.serra ?? null;
  if (!bridge) return null;
  if (bridge !== source) { source = bridge; wrapped = wrap(bridge); }
  return wrapped;
};
