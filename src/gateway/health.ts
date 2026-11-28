// How each paired server is doing, as the Mac app shows it (SB-33): one word for the server, and its profiles' live
// status. One event stream per server is followed for as long as it is paired; its profiles are read again whenever
// the stream comes back (or says it lost events), so the status shown is always the server's own report (ux-rules
// B5, B8). A server is `offline` only after its stream has been down for a while, so a Wi-Fi blip or a sleeping
// Mac doesn't flash the menubar, and then all its profiles are offline together (B9). A refused token stops the
// stream for good: the server shows `not paired` until the owner pairs again or forgets it.
//
// Nothing secret is in a view: no token, no certificate, only the server's name, how it is reached, and a short
// fingerprint for the Diagnostics line.
import { compareVersions, parseVersion } from '../app-updates.ts';
import { isBotStatus } from '../status-socket.ts';
import { GatewayUnreachable, NotPaired, type GatewayClient } from './client.ts';
import type { ServerProfile } from './engines.ts';
import type { PairedServer } from './pairing.ts';
import { GATEWAY_PROTOCOL } from './state.ts';

/** `checking` until the first answer; `up` once it answered; `offline` after a while without; `unpaired` when refused. */
type ServerState = 'checking' | 'up' | 'offline' | 'unpaired';

/** One paired server as the window and the menubar show it. */
export interface ServerHealth {
  id: string;
  name: string;
  via: 'address' | 'ssh';
  /** How the owner reaches it: `t480:47820` or `you@t480`. */
  address: string;
  state: ServerState;
  /** Which side needs an update to work together (design §4.7: N and N-1 work), or null. */
  skew: 'server' | 'app' | null;
  /** The protocol the server last said it speaks; null before it answered. */
  protocol: number | null;
  /** The Serra version it last said it runs; null before it answered, or from a server before SB-34. */
  version: string | null;
  /** Which side runs an older Serra than the other (SB-34): `server` offers Update t480, `app` Update Serra. */
  behind: 'server' | 'app' | null;
  /** When it last answered (ISO), for `last seen`; null before it ever did. */
  lastSeen: string | null;
  /** `sha256 9f3c…a1`, for the Diagnostics line. */
  fingerprint: string;
  /** Its profiles as it last listed them, each with its daemon's last report. */
  profiles: ServerProfile[];
}

/** Which side is too old for the other, from the server's protocol. */
export const protocolSkew = (protocol: number, mine = GATEWAY_PROTOCOL): ServerHealth['skew'] => {
  if (protocol < mine - 1) return 'server';
  if (protocol > mine + 1) return 'app';
  return null;
};

const shortFingerprint = (fingerprint: string): string => {
  const hex = fingerprint.replace(/^sha256:/i, '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return `sha256 ${hex.slice(0, 4)}…${hex.slice(-2)}`;
};

export interface ServerHealthFollower {
  /** Every paired server, in the order it was paired. */
  snapshot(): ServerHealth[];
  /** Follows the servers paired now: starts new ones and stops forgotten ones. Call after pairing or forgetting. */
  sync(): void;
  /** Connects again now, without waiting for the backoff (Retry, or the Mac woke up). Every server when no id. */
  retry(serverId?: string): void;
  /** Called after any change; returns a stop function. */
  subscribe(listener: () => void): () => void;
  close(): void;
}

interface Followed {
  server: PairedServer;
  state: ServerState;
  protocol: number | null;
  version: string | null;
  lastSeen: string | null;
  profiles: ServerProfile[];
  stop: () => void;
  offlineTimer: NodeJS.Timeout | null;
  /** Bumped on every (re)start, so a slow answer from before a retry is dropped. */
  generation: number;
}

/** Which of two Serra versions is older, or null when they match or either is unknown. */
const versionBehind = (server: string | null, app: string | undefined): ServerHealth['behind'] => {
  if (!server || !app || !parseVersion(server) || !parseVersion(app)) return null;
  const order = compareVersions(server, app);
  return order < 0 ? 'server' : order > 0 ? 'app' : null;
};

export const serverHealth = ({ servers, client, offlineAfterMs = 15_000, retryMs, now = () => new Date(), log = () => {}, appVersion }: {
  /** The paired servers (`ServerPairing.list`). */
  servers: () => PairedServer[];
  /** A client for one (`ServerPairing.client`). */
  client: (serverId: string) => GatewayClient;
  /** How long a stream may be down before its server shows `offline`. */
  offlineAfterMs?: number;
  /** The stream's first reconnect delay (tests: short). */
  retryMs?: number;
  now?: () => Date;
  /** One line per problem, never with a token (the client's errors carry none). */
  log?: (line: string) => void;
  /** This app's version, to say which side is behind. */
  appVersion?: string;
}): ServerHealthFollower => {
  const followed = new Map<string, Followed>();
  const listeners = new Set<() => void>();
  let closed = false;
  const changed = (): void => { for (const listener of listeners) { try { listener(); } catch { /* one bad listener can't stop the rest */ } } };

  const set = (entry: Followed, patch: Partial<Pick<Followed, 'state' | 'protocol' | 'version' | 'lastSeen' | 'profiles'>>): void => {
    Object.assign(entry, patch);
    changed();
  };

  const unpaired = (entry: Followed): void => {
    entry.stop();
    if (entry.offlineTimer) { clearTimeout(entry.offlineTimer); entry.offlineTimer = null; }
    if (entry.state !== 'unpaired') set(entry, { state: 'unpaired' });
  };

  /** Reads the server's profiles; only a good answer makes it `up`. */
  const load = async (entry: Followed): Promise<void> => {
    const generation = entry.generation;
    try {
      const answer = await client(entry.server.id).profiles();
      if (closed || generation !== entry.generation || followed.get(entry.server.id) !== entry) return;
      if (entry.offlineTimer) { clearTimeout(entry.offlineTimer); entry.offlineTimer = null; }
      const profiles = answer.profiles.map((profile) => ({ ...profile, status: isBotStatus(profile.status) ? profile.status : null }));
      set(entry, { state: 'up', protocol: answer.server.protocol, version: answer.server.version, lastSeen: now().toISOString(), profiles });
    } catch (error) {
      if (closed || generation !== entry.generation) return;
      if (error instanceof NotPaired) { unpaired(entry); return; }
      // The stream decides when it is offline; one failed read is not news.
      log(`[serra] ${entry.server.name}: ${error instanceof GatewayUnreachable || error instanceof Error ? error.message : 'no answer'}`);
    }
  };

  const status = (entry: Followed, profile: string, payload: unknown): void => {
    const index = entry.profiles.findIndex((known) => known.id === profile);
    // A profile this Mac hasn't listed yet: read the list again rather than guess its name.
    if (index < 0) { void load(entry); return; }
    // Only a well-formed report counts; anything else is `checking`, never a guessed colour.
    const next = isBotStatus(payload) ? payload : null;
    const profiles = entry.profiles.slice();
    profiles[index] = { ...profiles[index]!, status: next };
    set(entry, { profiles, lastSeen: now().toISOString() });
  };

  const start = (entry: Followed): void => {
    entry.generation += 1;
    const generation = entry.generation;
    const waitThenOffline = (): void => {
      if (entry.offlineTimer || entry.state === 'offline' || entry.state === 'unpaired') return;
      entry.offlineTimer = setTimeout(() => {
        entry.offlineTimer = null;
        if (!closed && generation === entry.generation && entry.state !== 'unpaired') set(entry, { state: 'offline' });
      }, offlineAfterMs);
    };
    let stream: GatewayClient;
    try { stream = client(entry.server.id); } catch { unpaired(entry); return; }
    // Until the first connection, the clock to `offline` runs too: a server that never answers goes offline.
    waitThenOffline();
    entry.stop = stream.follow({
      state: (state) => {
        if (generation !== entry.generation) return;
        if (state === 'live') void load(entry);
        else waitThenOffline();
      },
      reset: () => { if (generation === entry.generation) void load(entry); },
      event: (event) => {
        if (generation !== entry.generation) return;
        if (event.channel === 'status' && event.profile) status(entry, event.profile, event.payload);
        else if (event.channel === 'profiles') void load(entry);
      },
      notPaired: () => { if (generation === entry.generation) unpaired(entry); },
    }, retryMs === undefined ? {} : { retryMs });
  };

  const stopEntry = (entry: Followed): void => {
    entry.generation += 1;
    entry.stop();
    if (entry.offlineTimer) { clearTimeout(entry.offlineTimer); entry.offlineTimer = null; }
  };

  const sync = (): void => {
    if (closed) return;
    const paired = servers();
    const ids = new Set(paired.map((server) => server.id));
    let removed = false;
    for (const [id, entry] of followed) {
      if (ids.has(id)) continue;
      stopEntry(entry);
      followed.delete(id);
      removed = true;
    }
    for (const server of paired) {
      const known = followed.get(server.id);
      // Paired again (a new token, a new route): follow it afresh.
      if (known && known.server.deviceId === server.deviceId && JSON.stringify(known.server.route) === JSON.stringify(server.route)) continue;
      if (known) stopEntry(known);
      const entry: Followed = { server, state: 'checking', protocol: null, version: null, lastSeen: null, profiles: [], stop: () => {}, offlineTimer: null, generation: 0 };
      followed.set(server.id, entry);
      start(entry);
      changed();
    }
    if (removed) changed();
  };

  return {
    snapshot: () => [...followed.values()].map((entry): ServerHealth => ({
      id: entry.server.id,
      name: entry.server.name,
      via: entry.server.route.kind === 'ssh' ? 'ssh' : 'address',
      address: entry.server.route.kind === 'ssh' ? entry.server.route.target : `${entry.server.route.host}:${entry.server.route.port}`,
      state: entry.state,
      skew: entry.protocol === null ? null : protocolSkew(entry.protocol),
      protocol: entry.protocol,
      version: entry.version,
      behind: versionBehind(entry.version, appVersion),
      lastSeen: entry.lastSeen,
      fingerprint: shortFingerprint(entry.server.fingerprint),
      profiles: entry.profiles,
    })),
    sync,
    retry(serverId) {
      if (closed) return;
      for (const entry of followed.values()) {
        if (serverId !== undefined && entry.server.id !== serverId) continue;
        stopEntry(entry);
        // Unpaired stays unpaired: only pairing again fixes it. Offline keeps its word until an answer comes.
        if (entry.state === 'unpaired') continue;
        start(entry);
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {
      closed = true;
      for (const entry of followed.values()) stopEntry(entry);
      followed.clear();
      listeners.clear();
    },
  };
};
