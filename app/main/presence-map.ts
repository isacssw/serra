// Every profile's live status at once (SB-11, profiles phase 2). One subscription per profile folder to its daemon's
// `status.sock`, kept open while the profile is listed, so the switcher, the menubar and notifications see each bot as
// it is now. A profile reports null (`checking`) until its daemon first answers; never a guessed or cached state.
// Reading only: following a profile never writes into its folder.
import type { BotEvent, BotStatus } from '../../src/contracts.ts';
import { subscribeStatus } from '../../src/status-socket.ts';
import type { StatusSubscriber } from './status.ts';

/** A profile the map follows: its folder and the name its notifications and menubar row use. */
export interface FollowedProfile { dir: string; name: string }

interface PresenceListener {
  /** A profile's status changed (null: it is no longer followed). */
  status?(dir: string, status: BotStatus | null): void;
  /** One of a profile's daemon events. */
  event?(dir: string, event: BotEvent): void;
  /** The followed set or a name changed. */
  profiles?(profiles: readonly FollowedProfile[]): void;
}

export interface PresenceMap {
  /** Follows exactly these profiles from now on, in this order. Profiles already followed keep their connection. */
  follow(profiles: readonly FollowedProfile[]): void;
  /** The profiles followed, in order. */
  profiles(): readonly FollowedProfile[];
  /** The last report from the daemon of `dir`, or null before the first one (and for a folder not followed). */
  status(dir: string): BotStatus | null;
  /** Every followed profile's status, by folder. */
  snapshot(): Record<string, BotStatus | null>;
  subscribe(listener: PresenceListener): () => void;
  /** Stops following everything. Listeners hear nothing more. */
  close(): void;
}

export const presenceMap = (subscribe: StatusSubscriber = subscribeStatus, log: (message: string) => void = console.error): PresenceMap => {
  interface Followed { profile: FollowedProfile; status: BotStatus | null; connection: { close(): void } }
  const followed = new Map<string, Followed>();
  let order: FollowedProfile[] = [];
  const listeners = new Set<PresenceListener>();
  let closed = false;

  const each = (call: (listener: PresenceListener) => void): void => {
    for (const listener of [...listeners]) {
      try { call(listener); } catch (error) { log(`[serra] a presence listener failed: ${String(error)}`); }
    }
  };

  const start = (profile: FollowedProfile): Followed => {
    const entry: Followed = { profile, status: null, connection: { close: () => {} } };
    followed.set(profile.dir, entry);
    entry.connection = subscribe(profile.dir, (message) => {
      // A message still in flight from a profile dropped (or followed again since) is not this entry's.
      if (closed || followed.get(profile.dir) !== entry) return;
      if (message.type === 'status') {
        if (entry.status !== null && JSON.stringify(entry.status) === JSON.stringify(message.status)) return;
        entry.status = message.status;
        each((listener) => listener.status?.(profile.dir, message.status));
      } else each((listener) => listener.event?.(profile.dir, message.event));
    });
    return entry;
  };

  return {
    follow: (profiles) => {
      if (closed) return;
      const wanted = new Map(profiles.map((profile) => [profile.dir, profile]));
      let changed = profiles.length !== order.length || profiles.some((profile, index) => order[index]?.dir !== profile.dir || order[index]?.name !== profile.name);
      for (const [dir, entry] of [...followed]) {
        if (wanted.has(dir)) continue;
        followed.delete(dir);
        try { entry.connection.close(); } catch { /* already gone */ }
        each((listener) => listener.status?.(dir, null));
        changed = true;
      }
      for (const profile of wanted.values()) {
        const entry = followed.get(profile.dir);
        if (entry) entry.profile = profile;
        else start(profile);
      }
      order = [...wanted.values()];
      if (changed) each((listener) => listener.profiles?.(order));
    },
    profiles: () => order,
    status: (dir) => followed.get(dir)?.status ?? null,
    snapshot: () => Object.fromEntries(order.map((profile) => [profile.dir, followed.get(profile.dir)?.status ?? null])),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close: () => {
      closed = true;
      for (const entry of followed.values()) {
        try { entry.connection.close(); } catch { /* already gone */ }
      }
      followed.clear();
      order = [];
      listeners.clear();
    },
  };
};
