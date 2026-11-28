/**
 * The typed bridge between the window and the main process: `window.serra` in the renderer.
 *
 * The window has no Node, `require` or file access. Everything it can do is a method of `SerraApi` (src/api.ts), the
 * engine's API: `src/handlers/<namespace>.ts` answers each one, except `app`, which this app answers itself
 * (`host.ts`). The router (`router.ts`) sends each call to the one that answers it.
 *
 * This module is loaded in three places, so it imports types only, plus two pure modules (`api.ts` and
 * `setup-incomplete.ts`):
 * - the sandboxed preload (bundled to one CommonJS file; `createBridge` below builds `window.serra`),
 * - the main process (`invokeChannel` and `pushChannel` name the IPC channels),
 * - the renderer (`import type { SerraBridge }`, and the API's types re-exported here).
 */
// The value imports: pure modules, so the preload bundle stays free of Node.
import { bridgeMethods, type InvokeResult, type Namespace, type SerraApi, type SerraPushes } from '../../src/api.ts';
import { SETUP_INCOMPLETE, SetupIncomplete } from '../../src/setup-incomplete.ts';

export type {
  AppInfo, AppPrefs, BriefDocument, Handlers, InvokeResult, Namespace, ProfileEntry, ProfilesView, SavedSection, SerraApi, SerraPushes, ServerDevice, ServerHealth,
  SetupDetection, StarPromptState, Theme, UndoHandle,
} from '../../src/api.ts';

type Promisified<T> = { [M in keyof T]: T[M] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never };

export type Unsubscribe = () => void;

/** `window.serra`. */
export type SerraBridge = { [N in Namespace]: Promisified<SerraApi[N]> } & {
  on: { [P in keyof SerraPushes]: (listener: (payload: SerraPushes[P]) => void) => Unsubscribe };
};

// ---------------------------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------------------------

const pushChannels = ['status', 'event', 'releaseLog', 'appUpdate', 'navigate', 'proposals', 'jobs', 'names', 'agentBackend', 'profiles', 'presence', 'servers'] as const satisfies readonly (keyof SerraPushes)[];

export const invokeChannel = (namespace: string, method: string): string => `serra:${namespace}.${method}`;
export const pushChannel = (name: keyof SerraPushes): string => `serra:on.${name}`;

/**
 * Builds `window.serra` from two transport functions (the preload passes `ipcRenderer.invoke` and a wrapper of
 * `ipcRenderer.on`). Kept free of Electron so tests can build a bridge over fake transports.
 */
export const createBridge = (
  invoke: (channel: string, args: unknown[]) => Promise<InvokeResult>,
  listen: (channel: string, listener: (payload: unknown) => void) => Unsubscribe,
): SerraBridge => {
  const bridge: Record<string, Record<string, unknown>> = {};
  for (const [namespace, names] of Object.entries(bridgeMethods)) {
    const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of names) {
      api[method] = async (...args: unknown[]) => {
        const result = await invoke(invokeChannel(namespace, method), args);
        if (!result.ok) throw result.code === SETUP_INCOMPLETE ? new SetupIncomplete() : new Error(result.error);
        return result.value;
      };
    }
    bridge[namespace] = api;
  }
  const on: Record<string, (listener: (payload: unknown) => void) => Unsubscribe> = {};
  for (const name of pushChannels) on[name] = (listener) => listen(pushChannel(name), listener);
  bridge.on = on;
  return bridge as unknown as SerraBridge;
};
