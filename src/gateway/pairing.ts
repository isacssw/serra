// Pairing this Mac with a server, and the servers it is paired with (SB-32). Two ways in, both ending in a device
// token in the Keychain and a pinned certificate in `servers.json`:
//
//   code: probe the address (TLS handshake only) → the owner compares three words → the code goes over the pinned
//         connection → token. Nothing is sent before the words match (ux-rules F5).
//   SSH:  `serra server pair --ssh` over the owner's keys → token and certificate on the SSH channel → a tunnel from
//         this Mac's loopback to the server's gateway carries every later call.
//
// `servers.json` holds no secret: names, routes, the certificate (public) and when it was added. Server management
// (forget, revoke, the server's own screen) is in the app's Settings › Servers (SB-33), over `client` and `forget`.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic.ts';
import { isArrayOf, isNumber, isOneOf, isRecord, isString, isTime, readJsonOrNull, type Guard } from '../lib/guards.ts';
import type { SecretStore } from '../secrets.ts';
import { certFingerprint } from './cert.ts';
import {
  gatewayClient, GatewayUnreachable, NotPaired, parseAddress, probeServer, sendCode, type Endpoint, type GatewayClient, type Probe,
} from './client.ts';
import type { ServerProfile } from './engines.ts';
import { openTunnel, pairOverSsh, sshHostName, type SshOptions, type Tunnel } from './ssh.ts';
import { normalizeCode, PAIRING_MINUTES } from './state.ts';

export type ServerRoute = { kind: 'https'; host: string; port: number } | { kind: 'ssh'; target: string; port: number };

export interface PairedServer {
  id: string;
  name: string;
  protocol: number;
  route: ServerRoute;
  cert: string;
  fingerprint: string;
  deviceId: string;
  addedAt: string;
}

interface ServersFile { version: 1; servers: PairedServer[] }

const isRoute: Guard<ServerRoute> = (value): value is ServerRoute =>
  isRecord(value) && isNumber(value.port) && ((value.kind === 'https' && isString(value.host)) || (value.kind === 'ssh' && isString(value.target)));
const isPaired: Guard<PairedServer> = (value): value is PairedServer =>
  isRecord(value) && isString(value.id) && /^s_[a-z0-9]{6,16}$/.test(value.id) && isString(value.name) && isNumber(value.protocol) && isRoute(value.route)
  && isString(value.cert) && isString(value.fingerprint) && isString(value.deviceId) && isTime(value.addedAt);
const isServersFile: Guard<ServersFile> = (value): value is ServersFile =>
  isRecord(value) && isOneOf(1)(value.version) && isArrayOf(isPaired)(value.servers);

export const SERVERS_FILE = 'servers.json';
const ACCOUNT = 'device-token';
export const tokenService = (serverId: string): string => `dev.serra.server.${serverId}`;

export const readServers = (root: string): PairedServer[] =>
  (readJsonOrNull(join(root, SERVERS_FILE), isServersFile)?.servers ?? []).filter((server) => {
    // A certificate that doesn't match its fingerprint is not trusted, whatever the file says.
    try { return certFingerprint(server.cert) === server.fingerprint; } catch { return false; }
  });

const writeServers = (root: string, servers: PairedServer[]): void =>
  writeFileAtomic(join(root, SERVERS_FILE), `${JSON.stringify({ version: 1, servers }, null, 2)}\n`, { mode: 0o600 });

/** A paired server as the window shows it, with the profiles it has. */
export interface ServerView { id: string; name: string; via: 'address' | 'ssh'; profiles: ServerProfile[] }

/** The first contact with an address: who answered, and the words to compare. */
export interface PairProbe { probeId: string; name: string; words: [string, string, string] }

export type PairOutcome =
  | { ok: true; server: ServerView }
  | { ok: false; reason: 'wrong'; triesLeft: number }
  | { ok: false; reason: 'locked' | 'expired' };

export interface ServerPairing {
  /** Reaches the address and reads its certificate; the words come from it and the typed code. Sends no secret. */
  probe(address: string, code: string): Promise<PairProbe>;
  /** Sends the code to the probed server. The window calls this only after the owner says the words match. */
  pair(probeId: string, code: string): Promise<PairOutcome>;
  /** Forgets a probe: the words didn't match, or the owner closed the dialog. */
  cancel(probeId: string): void;
  /** Pairs over SSH with the owner's keys: no code, no words. */
  pairOverSsh(target: string): Promise<ServerView>;
  list(): PairedServer[];
  /** A client for a paired server, opening its tunnel first when it is reached over SSH. */
  client(serverId: string): GatewayClient;
  /**
   * Removes a server from this Mac: first this Mac's device on the server (best effort, a few seconds), so no key is
   * left there that nobody holds, then its entry and its token here. Deletes no data on the server. `revoked` is false
   * when the server couldn't be reached: it still lists this Mac until `serra server devices revoke` there.
   */
  forget(serverId: string): Promise<{ revoked: boolean }>;
  close(): void;
}

export const serverPairing = ({ root, secrets, device, ssh = {}, now = () => new Date() }: {
  /** The app's data folder: `~/.local/share/serra`. */
  root: string;
  secrets: SecretStore;
  /** This Mac's name, as the server lists it. */
  device: string;
  ssh?: SshOptions;
  now?: () => Date;
}): ServerPairing => {
  const probes = new Map<string, { probe: Probe; code: string; until: number }>();
  const tunnels = new Map<string, Promise<Tunnel>>();

  const save = (server: PairedServer): void => {
    writeServers(root, [...readServers(root).filter((known) => known.id !== server.id), server]);
  };

  /**
   * A server may claim the id of one this Mac already knows only from the same address, where pairing again is how
   * a server that made a new certificate is trusted again. From anywhere else it would take over that server's
   * entry, so it is refused.
   */
  const refuseTakeover = (serverId: string, fingerprint: string, where: string): void => {
    const known = readServers(root).find((server) => server.id === serverId);
    if (!known || known.fingerprint === fingerprint) return;
    const was = known.route.kind === 'https' ? `https:${known.route.host}` : `ssh:${known.route.target}`;
    if (was !== where) throw new GatewayUnreachable(`This server says it is ${known.name}, which this Mac reaches elsewhere. Nothing was paired.`);
  };

  /**
   * Paired again with a server this Mac already knew: its old device is revoked with its old token, so the server
   * doesn't keep a key nobody holds. Best effort: an old token that no longer works has nothing left to revoke.
   */
  const retireOld = async (serverId: string, keep: string): Promise<void> => {
    const old = readServers(root).find((known) => known.id === serverId);
    if (!old || old.deviceId === keep) return;
    try { await clientFor(old).revoke(old.deviceId); } catch { /* gone already, or unreachable: nothing to do here */ }
  };

  const endpointFor = (server: PairedServer): (() => Promise<Endpoint>) => async () => {
    if (server.route.kind === 'https') return { host: server.route.host, port: server.route.port };
    let open = tunnels.get(server.id);
    if (!open) {
      const route = server.route;
      open = openTunnel(route.target, route.port, ssh);
      tunnels.set(server.id, open);
      // A tunnel that fails or ends is opened again on the next call.
      open.then((tunnel) => tunnel.closed.then(() => { if (tunnels.get(server.id) === open) tunnels.delete(server.id); }), () => { tunnels.delete(server.id); })
        .catch(() => {});
    }
    return { host: '127.0.0.1', port: (await open).port };
  };

  const clientFor = (server: PairedServer): GatewayClient => gatewayClient({
    endpoint: endpointFor(server),
    pin: { cert: server.cert, fingerprint: server.fingerprint },
    name: server.name,
    token: async () => {
      const token = await secrets.get(tokenService(server.id), ACCOUNT);
      if (!token) throw new Error(`This Mac has no key for ${server.name}. Pair again.`);
      return token;
    },
  });

  const view = async (server: PairedServer): Promise<ServerView> => {
    const { profiles } = await clientFor(server).profiles();
    return { id: server.id, name: server.name, via: server.route.kind === 'ssh' ? 'ssh' : 'address', profiles };
  };

  const sweep = (): void => {
    const at = now().getTime();
    for (const [id, entry] of probes) if (entry.until <= at) probes.delete(id);
  };

  return {
    async probe(address, code) {
      const endpoint = parseAddress(address);
      if (!endpoint) throw new GatewayUnreachable('That isn’t an address. Try t480 or t480:47820.');
      const probe = await probeServer(endpoint, code);
      refuseTakeover(probe.hello.id, probe.pin.fingerprint, `https:${endpoint.host}`);
      sweep();
      const probeId = randomBytes(12).toString('hex');
      probes.set(probeId, { probe, code: normalizeCode(code), until: now().getTime() + PAIRING_MINUTES * 60_000 });
      return { probeId, name: probe.hello.name, words: probe.words };
    },
    async pair(probeId, code) {
      sweep();
      const entry = probes.get(probeId);
      if (!entry) return { ok: false, reason: 'expired' };
      // The words the owner compared came from this code: another one would go out unchecked.
      if (normalizeCode(code) !== entry.code) throw new Error('The code changed since the words were shown. Continue again.');
      // A probe is used once: whatever the server says, a new code means new words.
      probes.delete(probeId);
      const outcome = await sendCode(entry.probe, entry.code, device);
      if (!outcome.ok) return outcome;
      await retireOld(outcome.server.id, outcome.deviceId);
      await secrets.set(tokenService(outcome.server.id), ACCOUNT, outcome.token);
      const server: PairedServer = {
        id: outcome.server.id,
        name: outcome.server.name,
        protocol: outcome.server.protocol,
        route: { kind: 'https', host: entry.probe.endpoint.host, port: entry.probe.endpoint.port },
        cert: entry.probe.pin.cert,
        fingerprint: entry.probe.pin.fingerprint,
        deviceId: outcome.deviceId,
        addedAt: now().toISOString(),
      };
      save(server);
      return { ok: true, server: await view(server) };
    },
    cancel(probeId) { probes.delete(probeId); },
    async pairOverSsh(target) {
      const paired = await pairOverSsh(target, device, ssh);
      refuseTakeover(paired.server.id, paired.fingerprint, `ssh:${target.trim()}`);
      await retireOld(paired.server.id, paired.deviceId);
      await secrets.set(tokenService(paired.server.id), ACCOUNT, paired.token);
      const server: PairedServer = {
        id: paired.server.id,
        name: paired.server.name || sshHostName(target),
        protocol: paired.server.protocol,
        route: { kind: 'ssh', target: target.trim(), port: paired.port },
        cert: paired.cert,
        fingerprint: paired.fingerprint,
        deviceId: paired.deviceId,
        addedAt: now().toISOString(),
      };
      // A tunnel to an earlier pairing of the same server may point at an old port.
      void tunnels.get(server.id)?.then((tunnel) => tunnel.close(), () => {});
      tunnels.delete(server.id);
      save(server);
      return view(server);
    },
    list: () => readServers(root),
    client(serverId) {
      const server = readServers(root).find((known) => known.id === serverId);
      if (!server) throw new Error('This Mac isn’t paired with that server.');
      return clientFor(server);
    },
    async forget(serverId) {
      const known = readServers(root).find((server) => server.id === serverId);
      let revoked = false;
      if (known) {
        try { await clientFor(known).revoke(known.deviceId, { timeoutMs: 5000 }); revoked = true; }
        // Already revoked there counts as done; unreachable leaves it listed, and the owner is told.
        catch (error) { revoked = error instanceof NotPaired; }
      }
      void tunnels.get(serverId)?.then((tunnel) => tunnel.close(), () => {});
      tunnels.delete(serverId);
      writeServers(root, readServers(root).filter((server) => server.id !== serverId));
      await secrets.remove(tokenService(serverId), ACCOUNT);
      return { revoked };
    },
    close() {
      for (const open of tunnels.values()) void open.then((tunnel) => tunnel.close(), () => {});
      tunnels.clear();
      probes.clear();
    },
  };
};
