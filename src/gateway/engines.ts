// The engine on a server: the same handlers the Mac app runs (src/handlers), one set per profile folder, over a
// headless context. A server has no window and no person at it, so its `host` can do nothing: no dialog, no Finder,
// no Trash, and no confirm, so nothing that needs the owner's click goes ahead. Each profile's pushes, and every
// profile's live status, go into the gateway's event log.
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createEngine, type EngineHandlers } from '../handlers/index.ts';
import type { CoreContext, HostPort } from '../handlers/context.ts';
import { presenceMap, type PresenceMap } from '../presence-map.ts';
import { profileName, profilesUnder } from '../profiles.ts';
import { socketStatusSource, type FollowingStatusSource, type StatusSubscriber } from '../status-source.ts';
import { subscribeStatus } from '../status-socket.ts';
import type { BotStatus } from '../contracts.ts';
import type { EventLog } from './events.ts';

const NOT_HERE = 'That needs the Mac: it can’t be done on a server.';

/** What a server can do for the engine: nothing that needs a person at it. */
export const headlessHost: HostPort = {
  openPath: () => Promise.reject(new Error(NOT_HERE)),
};

/** A profile on the server as a paired Mac lists it. */
export interface ServerProfile { id: string; name: string; status: BotStatus | null }

export interface ServerEngines {
  /** The profiles on this server, in folder order, with each one's live status (null until its daemon reports). */
  profiles(): ServerProfile[];
  /** The engine for one profile folder, by its name; null for one that isn't a profile here. */
  engine(id: string): EngineHandlers | null;
  close(): void;
}

/** A profile's folder name: letters, digits, `.`, `_` and `-`, never a path. */
const PROFILE_ID = /^[\w][\w.-]{0,63}$/;

export const serverEngines = ({ root, runtime, events, subscribe = subscribeStatus }: {
  root: string;
  runtime: { version: string; platform: string };
  events: EventLog;
  subscribe?: StatusSubscriber;
}): ServerEngines => {
  const presence: PresenceMap = presenceMap(subscribe, () => {});
  const engines = new Map<string, { engine: EngineHandlers; status: FollowingStatusSource }>();
  const dirs = (): string[] => profilesUnder(root);
  const follow = (): string[] => {
    const found = dirs();
    presence.follow(found.map((dir) => ({ dir, name: profileName(dir) })));
    return found;
  };
  presence.subscribe({ status: (dir, status) => { events.publish(basename(dir), 'status', status); } });
  follow();

  const make = (dir: string, id: string): EngineHandlers => {
    const status = socketStatusSource(dir, subscribe);
    const context: CoreContext = {
      profileDir: () => dir,
      profileDirOrNull: () => dir,
      profilePinned: true,
      selectProfile: () => { throw new Error('A server’s profiles are picked on the Mac.'); },
      status,
      runtime,
      host: headlessHost,
      presence,
      profileDirs: dirs,
      push: (channel, payload) => { events.publish(id, channel, payload); },
    };
    const engine = createEngine(context);
    engines.set(id, { engine, status });
    return engine;
  };

  return {
    profiles: () => follow().map((dir) => ({ id: basename(dir), name: profileName(dir), status: presence.status(dir) })),
    engine(id) {
      if (!PROFILE_ID.test(id)) return null;
      const known = engines.get(id);
      if (known) return known.engine;
      const dir = join(root, id);
      if (!existsSync(join(dir, 'profile.json'))) return null;
      return make(dir, id);
    },
    close() {
      presence.close();
      for (const { status } of engines.values()) status.close();
      engines.clear();
    },
  };
};
