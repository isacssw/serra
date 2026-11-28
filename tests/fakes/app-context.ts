// The Mac app's context as one object, as tests describe it, split the way app/main/index.ts splits it: the engine's
// `CoreContext` (src/handlers/context.ts) and the app's `HostContext` (app/main/host.ts). The split reads the object
// on every call, so a test that changes a field later is seen.
import type { AppUpdater } from '../../app/main/app-updater.ts';
import { appHandlers, selectProfileIn, type HostContext } from '../../app/main/host.ts';
import type { PrefsStore } from '../../app/main/prefs.ts';
import { routeHandlers, type AllHandlers } from '../../app/main/router.ts';
import type { CoreContext, HostPort } from '../../src/handlers/context.ts';
import { createEngine } from '../../src/handlers/index.ts';
import type { ProfileNames } from '../../src/handlers/slack-names.ts';
import type { Handlers } from '../../src/api.ts';

/** No server pairing in tests that don't need it: each call says so. */
const noServers: Handlers<'servers'> = {
  probe: () => { throw new Error('No servers in this test.'); },
  pair: () => { throw new Error('No servers in this test.'); },
  cancel: () => {},
  pairOverSsh: () => { throw new Error('No servers in this test.'); },
  list: () => [],
  status: () => [],
  retry: () => {},
  devices: () => { throw new Error('No servers in this test.'); },
  revoke: () => { throw new Error('No servers in this test.'); },
  forget: () => { throw new Error('No servers in this test.'); },
};

/** Everything either half may need. */
export type AppContext = Omit<CoreContext, 'host' | 'selectProfile' | 'runtime' | 'appUpdater'> & HostPort & {
  prefs: PrefsStore;
  runtime: HostContext['runtime'];
  openExternal(url: string): Promise<void>;
  appUpdater?: AppUpdater;
};

const hostContext = (app: AppContext): HostContext => ({
  get prefs() { return app.prefs; },
  get runtime() { return app.runtime; },
  get appUpdater() { return app.appUpdater; },
  profileDirOrNull: () => app.profileDirOrNull(),
  profileDir: () => app.profileDir(),
  openExternal: (url) => app.openExternal(url),
  openPath: (path) => app.openPath(path),
  ...(app.chooseFolder ? { chooseFolder: (options) => app.chooseFolder!(options) } : {}),
  ...(app.confirm ? { confirm: (options) => app.confirm!(options) } : {}),
  ...(app.trashItem ? { trashItem: (path) => app.trashItem!(path) } : {}),
});

export const engineContext = (app: AppContext): CoreContext => ({
  get host() { return hostContext(app); },
  get profilePinned() { return app.profilePinned; },
  get status() { return app.status; },
  get runtime() { return { version: app.runtime.version, platform: app.runtime.platform }; },
  get appUpdater() { return app.appUpdater; },
  get presence() { return app.presence; },
  get botFollowsApp() { return app.botFollowsApp; },
  get push() { return app.push; },
  get every() { return app.every; },
  get expectStop() { return app.expectStop; },
  get profileDirs() { return app.profileDirs; },
  get guardQuit() { return app.guardQuit; },
  get switchBlocked() { return app.switchBlocked; },
  profileDir: () => app.profileDir(),
  profileDirOrNull: () => app.profileDirOrNull(),
  selectProfile: (dir, options) => selectProfileIn(app.prefs)(dir, options),
});

/** Every namespace, routed as the app routes them. */
export const createHandlers = (app: AppContext, names?: ProfileNames, servers: Handlers<'servers'> = noServers): AllHandlers =>
  routeHandlers(appHandlers(hostContext(app)), servers, createEngine(engineContext(app), names));
