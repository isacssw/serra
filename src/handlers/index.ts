// The engine: one handler set per namespace of the API (src/api.ts), each from its own `src/handlers/<namespace>.ts`,
// and the one way a call reaches them (`invokeHandler`). It runs wherever the profiles are: inside the Mac app today
// (app/main/router.ts sends the window's calls here), headless on a server later. `app` isn't here: the Mac app
// answers it itself (app/main/host.ts).
import { bridgeMethods, type Handlers, type InvokeResult, type Namespace } from '../api.ts';
import { isRecord } from '../lib/guards.ts';
import { SETUP_INCOMPLETE } from '../setup-incomplete.ts';
import { botHandlers } from './bot.ts';
import { briefHandlers } from './brief.ts';
import { channelsHandlers } from './channels.ts';
import type { CoreContext } from './context.ts';
import { diagnosticsHandlers } from './diagnostics.ts';
import { jobsHandlers } from './jobs.ts';
import { meetingsHandlers } from './meetings.ts';
import { pagesHandlers } from './pages.ts';
import { peopleHandlers } from './people.ts';
import { profilesHandlers } from './profiles.ts';
import { proposalsHandlers } from './proposals.ts';
import { secretsHandlers } from './secrets.ts';
import { settingsHandlers } from './settings.ts';
import { toolsHandlers } from './tools.ts';
import { tasksHandlers } from './tasks.ts';
import { setupHandlers } from './setup.ts';
import { profileSlackNames } from './slack-names.ts';
import { updatesHandlers } from './updates.ts';

/** The namespaces the Mac app answers itself: its prefs and links, and the servers it is paired with. */
type HostNamespace = 'app' | 'servers' | 'moves';

/** The namespaces the engine answers: all but the app's own. */
export type EngineHandlers = { [N in Exclude<Namespace, HostNamespace>]: Handlers<N> };

/** Every namespace's handlers over one context. Jobs and Settings share one Slack names cache. */
export const createEngine = (context: CoreContext, names = profileSlackNames(context)): EngineHandlers => ({
  setup: setupHandlers(context),
  profiles: profilesHandlers(context),
  bot: botHandlers(context),
  jobs: jobsHandlers(context, { names }),
  proposals: proposalsHandlers(context),
  pages: pagesHandlers(context),
  brief: briefHandlers(context),
  settings: settingsHandlers(context, { names }),
  secrets: secretsHandlers(context),
  channels: channelsHandlers(context),
  tools: toolsHandlers(context),
  updates: updatesHandlers(context),
  diagnostics: diagnosticsHandlers(context),
  people: peopleHandlers(context),
  tasks: tasksHandlers(context),
  meetings: meetingsHandlers(context),
});

/** True for a namespace and method of the API (`bridgeMethods`), so nothing else on a handler set can be called. */
const isMethod = (namespace: string, method: string): boolean =>
  Object.entries(bridgeMethods).some(([name, methods]) => name === namespace && methods.some((entry) => entry === method));

/**
 * Runs one call: `namespace.method(...args)` on `handlers`. Never throws: a handler's error comes back as
 * `{ ok: false, error }` with just its message, never a stack, and no profile yet as `code: SETUP_INCOMPLETE`, so the
 * window can show its shared setup state instead of the message.
 */
export const invokeHandler = async (handlers: object, namespace: string, method: string, args: readonly unknown[]): Promise<InvokeResult> => {
  const set: unknown = isMethod(namespace, method) ? Reflect.get(handlers, namespace) : undefined;
  const handler: unknown = isRecord(set) ? set[method] : undefined;
  if (typeof handler !== 'function') return { ok: false, error: `No handler for ${namespace}.${method}.` };
  try {
    const value: unknown = await Reflect.apply(handler, undefined, args);
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return isRecord(error) && error.code === SETUP_INCOMPLETE ? { ok: false, error: message, code: SETUP_INCOMPLETE } : { ok: false, error: message };
  }
};
