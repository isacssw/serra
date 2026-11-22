// Wires every bridge method to its handler. Kept free of Electron imports so tests can register on a fake ipcMain.
import { SETUP_INCOMPLETE } from '../../../src/setup-incomplete.ts';
import { bridgeMethods, invokeChannel, type Handlers, type InvokeResult, type Namespace } from '../bridge.ts';
import { appHandlers } from './app.ts';
import { botHandlers } from './bot.ts';
import { briefHandlers } from './brief.ts';
import type { HandlerContext } from './context.ts';
import { diagnosticsHandlers } from './diagnostics.ts';
import { jobsHandlers } from './jobs.ts';
import { pagesHandlers } from './pages.ts';
import { peopleHandlers } from './people.ts';
import { proposalsHandlers } from './proposals.ts';
import { secretsHandlers } from './secrets.ts';
import { settingsHandlers } from './settings.ts';
import { toolsHandlers } from './tools.ts';
import { tasksHandlers } from './tasks.ts';
import { setupHandlers } from './setup.ts';
import { updatesHandlers } from './updates.ts';

export type AllHandlers = { [N in Namespace]: Handlers<N> };

/** One handler set per namespace, each from its own `ipc/<namespace>.ts`. */
export const createHandlers = (context: HandlerContext): AllHandlers => ({
  app: appHandlers(context),
  setup: setupHandlers(context),
  bot: botHandlers(context),
  jobs: jobsHandlers(context),
  proposals: proposalsHandlers(context),
  pages: pagesHandlers(context),
  brief: briefHandlers(context),
  settings: settingsHandlers(context),
  secrets: secretsHandlers(context),
  tools: toolsHandlers(context),
  updates: updatesHandlers(context),
  diagnostics: diagnosticsHandlers(context),
  people: peopleHandlers(context),
  tasks: tasksHandlers(context),
});

/** The part of `ipcMain` registration needs. `event.senderFrame.url` is checked before a handler runs. */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: { senderFrame: { url: string } | null }, ...args: unknown[]) => Promise<InvokeResult>): void;
}

/**
 * Registers one `ipcMain.handle` channel per bridge method. Calls from a frame that isn't the app's own page are
 * refused. A handler's error goes back as `{ ok: false, error }` with just its message, never a stack.
 * Returns the channels it registered.
 */
export const registerHandlers = (
  ipc: IpcRegistrar,
  handlers: AllHandlers,
  isTrustedSender: (url: string) => boolean,
  log: (message: string) => void = console.error,
): string[] => {
  const channels: string[] = [];
  for (const [namespace, names] of Object.entries(bridgeMethods)) {
    const set = handlers[namespace as Namespace] as Record<string, (...args: unknown[]) => unknown>;
    for (const method of names) {
      const handler = set[method];
      if (typeof handler !== 'function') throw new Error(`No handler for ${namespace}.${method}.`);
      const channel = invokeChannel(namespace, method);
      ipc.handle(channel, async (event, ...args) => {
        const url = event.senderFrame?.url ?? '';
        if (!isTrustedSender(url)) {
          log(`[serra] refused ${channel} from ${url || 'an unknown frame'}`);
          return { ok: false, error: 'This page may not use the Serra bridge.' };
        }
        try {
          return { ok: true, value: await handler(...args) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // No profile yet: the code lets the window show its shared setup state instead of the message.
          return (error as { code?: unknown } | null)?.code === SETUP_INCOMPLETE ? { ok: false, error: message, code: SETUP_INCOMPLETE } : { ok: false, error: message };
        }
      });
      channels.push(channel);
    }
  }
  return channels;
};
