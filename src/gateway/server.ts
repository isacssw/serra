// The gateway: the server's engine over HTTPS, for the Macs paired with it (SB-32, server mode phase 5).
//
//   GET    /.well-known/serra   who this is: { serra, id, name, protocol, minProtocol }. No secrets, no auth.
//   POST   /pair                { code, device } → a device token, once, for the code `serra server pair` shows
//   GET    /profiles            the profiles here, with each one's state
//   POST   /rpc                 { profile, namespace, method, args } → the engine's answer, as the app's IPC gives it
//   GET    /events              the event log as server-sent events; `Last-Event-ID` resumes after a reconnect
//   GET    /devices             the paired devices;  DELETE /devices/<id> revokes one
//
// Everything but the first two needs `Authorization: Bearer <device token>`, checked against devices.json on every
// call, so a revoke takes effect on the next one; an open event stream rechecks every few seconds. The token is never
// in a URL or a log (ux-rules F7). TLS only, with the server's own certificate (F2), on loopback and Tailscale only (F1).
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { invokeHandler } from '../handlers/index.ts';
import { isRecord, isString } from '../lib/guards.ts';
import { eventLog, type EventLog, type GatewayEvent } from './events.ts';
import type { ServerEngines } from './engines.ts';
import { mayListenOn } from './listen.ts';
import {
  addDevice, deviceForToken, GATEWAY_PROTOCOL, gatewayCert, listDevices, noteDeviceUse, revokeDevice, serverIdentity,
  useCode, type DeviceView,
} from './state.ts';

/** The oldest protocol this gateway still serves: N and N-1 work together. */
const MIN_PROTOCOL = Math.max(1, GATEWAY_PROTOCOL - 1);
const MAX_BODY = 8 * 1024 * 1024;

export interface GatewayOptions {
  /** The profiles folder: `~/.local/share/serra`. */
  root: string;
  /** Loopback and Tailscale addresses only (`listenAddresses`). */
  addresses: readonly string[];
  port: number;
  engines: ServerEngines;
  events?: EventLog;
  log?: (line: string) => void;
  /** How often an open event stream pings and rechecks its token. */
  heartbeatMs?: number;
}

export interface Gateway {
  port: number;
  addresses: readonly string[];
  fingerprint: string;
  events: EventLog;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) { super(String(body.error)); this.status = status; this.body = body; }
}

const send = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  response.end(text);
};

const readBody = (request: IncomingMessage): Promise<unknown> => new Promise((done, fail) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY) { fail(new HttpError(413, { error: 'Too large.' })); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch { fail(new HttpError(400, { error: 'Not JSON.' })); }
  });
  request.on('error', fail);
});

const bearer = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
};

export const startGateway = async (options: GatewayOptions): Promise<Gateway> => {
  const { root, engines, log = () => {}, heartbeatMs = 5000 } = options;
  for (const address of options.addresses) {
    if (!mayListenOn(address)) throw new Error(`The gateway listens only on 127.0.0.1 and Tailscale addresses, not ${address}.`);
  }
  if (options.addresses.length === 0) throw new Error('The gateway needs an address to listen on.');
  const identity = serverIdentity(root);
  const { cert, key, fingerprint } = gatewayCert(root, identity.name);
  const events = options.events ?? eventLog();
  const streams = new Set<{ device: string; end(): void }>();
  let lastUseNote = new Map<string, number>();

  const authenticate = (request: IncomingMessage): DeviceView => {
    const device = deviceForToken(root, bearer(request));
    if (!device) throw new HttpError(401, { error: 'Not paired.' });
    // At most one write a minute per device.
    const now = Date.now();
    if ((lastUseNote.get(device.id) ?? 0) < now - 60_000) {
      lastUseNote = new Map(lastUseNote).set(device.id, now);
      try { noteDeviceUse(root, device.id); } catch { /* best effort */ }
    }
    return device;
  };

  const stream = (request: IncomingMessage, response: ServerResponse, device: DeviceView): void => {
    const header = request.headers['last-event-id'];
    const after = typeof header === 'string' && /^\d{1,15}$/.test(header) ? Number(header) : null;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const write = (event: GatewayEvent): void => {
      response.write(`id: ${event.seq}\ndata: ${JSON.stringify({ profile: event.profile, channel: event.channel, payload: event.payload })}\n\n`);
    };
    // Where the stream starts: what was missed since `Last-Event-ID`, or a reset when the log no longer has it.
    if (after === null) response.write(`id: ${events.last()}\nevent: hello\ndata: {}\n\n`);
    else {
      const missed = events.since(after);
      if (missed === null) response.write(`id: ${events.last()}\nevent: reset\ndata: {}\n\n`);
      else for (const event of missed) write(event);
    }
    const unsubscribe = events.subscribe(write);
    const entry = { device: device.id, end: () => { response.end(); } };
    streams.add(entry);
    const heartbeat = setInterval(() => {
      if (!deviceForToken(root, bearer(request))) { response.end(); return; }
      response.write(': ping\n\n');
    }, heartbeatMs);
    const stop = (): void => { clearInterval(heartbeat); unsubscribe(); streams.delete(entry); };
    response.on('close', stop);
    request.on('close', stop);
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', 'https://gateway').pathname;
    const method = request.method ?? 'GET';
    if (method === 'GET' && path === '/.well-known/serra') {
      send(response, 200, { serra: true, id: identity.id, name: identity.name, protocol: GATEWAY_PROTOCOL, minProtocol: MIN_PROTOCOL });
      return;
    }
    if (method === 'POST' && path === '/pair') {
      const body = await readBody(request);
      if (!isRecord(body) || !isString(body.code)) throw new HttpError(400, { error: 'A code is needed.' });
      const device = isString(body.device) ? body.device : '';
      const check = useCode(root, body.code, device);
      if (!check.ok) {
        log(`pairing refused (${check.reason})`);
        if (check.reason === 'wrong') throw new HttpError(401, { error: 'wrong', triesLeft: check.triesLeft });
        throw new HttpError(410, { error: check.reason });
      }
      const added = addDevice(root, device);
      log(`paired ${added.device.name} (${added.device.id})`);
      send(response, 200, { token: added.token, device: added.device, server: { ...identity, protocol: GATEWAY_PROTOCOL } });
      return;
    }
    const device = authenticate(request);
    if (method === 'GET' && path === '/profiles') {
      send(response, 200, { server: { ...identity, protocol: GATEWAY_PROTOCOL }, profiles: engines.profiles() });
      return;
    }
    if (method === 'POST' && path === '/rpc') {
      const body = await readBody(request);
      if (!isRecord(body) || !isString(body.profile) || !isString(body.namespace) || !isString(body.method) || !Array.isArray(body.args)) {
        throw new HttpError(400, { error: 'A call needs profile, namespace, method and args.' });
      }
      const engine = engines.engine(body.profile);
      if (!engine) throw new HttpError(404, { error: `No profile ${body.profile} on ${identity.name}.` });
      send(response, 200, await invokeHandler(engine, body.namespace, body.method, body.args));
      return;
    }
    if (method === 'GET' && path === '/events') { stream(request, response, device); return; }
    if (method === 'GET' && path === '/devices') { send(response, 200, { devices: listDevices(root) }); return; }
    const revoke = /^\/devices\/(d_[a-f0-9]{12})$/.exec(path);
    if (method === 'DELETE' && revoke) {
      const removed = revokeDevice(root, revoke[1]!);
      for (const open of [...streams]) if (open.device === removed.id) open.end();
      log(`revoked ${removed.name} (${removed.id})`);
      send(response, 200, { revoked: removed });
      return;
    }
    throw new HttpError(404, { error: 'Not found.' });
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof HttpError) send(response, error.status, error.body);
      else { log(`error: ${error instanceof Error ? error.message : String(error)}`); send(response, 500, { error: 'The server failed.' }); }
    });
  };

  const servers: Server[] = [];
  let port = options.port;
  try {
    for (const address of options.addresses) {
      const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, handler);
      server.headersTimeout = 15_000;
      server.requestTimeout = 120_000;
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(port, address, () => { server.off('error', fail); done(); });
      });
      const bound = server.address();
      if (typeof bound === 'object' && bound) port = bound.port;
      servers.push(server);
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  log(`listening on ${options.addresses.map((address) => (address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`)).join(', ')}`);

  return {
    port,
    addresses: options.addresses,
    fingerprint,
    events,
    close: async () => {
      for (const open of [...streams]) open.end();
      await Promise.all(servers.map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); })));
      engines.close();
    },
  };
};
