// The app's router: each call from the window goes to whoever answers it. `app.*` is the app's own (host.ts); every
// other namespace goes to the engine that holds the profile in use. In phase 4 that is always the engine running in
// this process (src/handlers); a profile on a server would route to that server's engine instead. Kept free of
// Electron imports so tests can register on a fake ipcMain.
import { invokeHandler, type EngineHandlers } from '../../src/handlers/index.ts';
import { bridgeMethods } from '../../src/api.ts';
import { invokeChannel, type Handlers, type InvokeResult, type Namespace } from './bridge.ts';

export type AllHandlers = { [N in Namespace]: Handlers<N> };

/** Every namespace's handlers: the app's own, and the engine's (local only for now). */
export const routeHandlers = (host: Handlers<'app'>, engine: EngineHandlers): AllHandlers => ({ app: host, ...engine });

/** The part of `ipcMain` registration needs. `event.senderFrame.url` is checked before a handler runs. */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: { senderFrame: { url: string } | null }, ...args: unknown[]) => Promise<InvokeResult>): void;
}

/**
 * Registers one `ipcMain.handle` channel per API method. Calls from a frame that isn't the app's own page are
 * refused. A handler's error goes back as `{ ok: false, error }` with just its message, never a stack
 * (`invokeHandler`). Returns the channels it registered.
 */
export const registerHandlers = (
  ipc: IpcRegistrar,
  handlers: AllHandlers,
  isTrustedSender: (url: string) => boolean,
  log: (message: string) => void = console.error,
): string[] => {
  const channels: string[] = [];
  for (const [namespace, names] of Object.entries(bridgeMethods)) {
    const set: unknown = Reflect.get(handlers, namespace);
    for (const method of names) {
      if (typeof set !== 'object' || set === null || typeof Reflect.get(set, method) !== 'function') throw new Error(`No handler for ${namespace}.${method}.`);
      const channel = invokeChannel(namespace, method);
      ipc.handle(channel, async (event, ...args) => {
        const url = event.senderFrame?.url ?? '';
        if (!isTrustedSender(url)) {
          log(`[serra] refused ${channel} from ${url || 'an unknown frame'}`);
          return { ok: false, error: 'This page may not use the Serra bridge.' };
        }
        return invokeHandler(handlers, namespace, method, args);
      });
      channels.push(channel);
    }
  }
  return channels;
};
