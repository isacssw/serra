// The app's router: each call from the window goes to whoever answers it. `app.*`, `servers.*` and `moves.*` are the
// app's own (host.ts, servers.ts, moves.ts); every other namespace goes to the engine that holds the profile in use. Today that is the
// engine running in this process (src/handlers); a profile on a paired server routes to that server's engine
// (`remoteEngine` in src/gateway/client.ts has the same shape) once the window can pick one (phase 6). Kept free of
// Electron imports so tests can register on a fake ipcMain.
import { invokeHandler, type EngineHandlers } from '../../src/handlers/index.ts';
import { bridgeMethods } from '../../src/api.ts';
import { invokeChannel, type Handlers, type InvokeResult, type Namespace } from './bridge.ts';

export type AllHandlers = { [N in Namespace]: Handlers<N> };

/** Every namespace's handlers: the app's own, and the engine's (local only for now). */
export const routeHandlers = (host: Handlers<'app'>, servers: Handlers<'servers'>, moves: Handlers<'moves'>, engine: EngineHandlers): AllHandlers => ({ app: host, servers, moves, ...engine });

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
