// The Mac's side of the gateway: reaching a server, pinned to the certificate it showed at pairing. Every request
// checks that the server presents exactly that certificate (its SHA-256), whatever name or address it is reached by,
// so a machine in the middle, or another server at the same address, gets no request at all. The device token goes in
// a header only, never a URL (ux-rules F7), and never into an error or a log.
import { request as httpsRequest } from 'node:https';
import { connect, type PeerCertificate } from 'node:tls';
import { bridgeMethods } from '../api.ts';
import type { EngineHandlers } from '../handlers/index.ts';
import { isArrayOf, isNumber, isRecord, isString } from '../lib/guards.ts';
import { certFingerprint, pemFromDer } from './cert.ts';
import type { ServerProfile } from './engines.ts';
import { DEFAULT_GATEWAY_PORT, type ServerIdentity } from './state.ts';
import { pairingWords } from './words.ts';

export interface Endpoint { host: string; port: number }

/**
 * An address as the owner types it: `t480`, `t480:47820`, `100.101.102.103`, `[fd7a:115c:a1e0::1]:47820`, or
 * `https://t480.tailnet.ts.net:47820`. Null for anything else.
 */
export const parseAddress = (text: string): Endpoint | null => {
  let value = text.trim();
  if (!value) return null;
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : DEFAULT_GATEWAY_PORT };
    } catch { return null; }
  }
  if (/^[a-z]+:\/\//i.test(value)) return null;
  let port = DEFAULT_GATEWAY_PORT;
  const bracket = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(value);
  if (bracket) return { host: bracket[1]!, port: bracket[2] ? Number(bracket[2]) : port };
  const withPort = /^([^:\s/]+):(\d{1,5})$/.exec(value);
  if (withPort) { value = withPort[1]!; port = Number(withPort[2]); }
  if (port < 1 || port > 65_535) return null;
  if (/^[0-9a-f:]+$/i.test(value) && value.includes(':')) return { host: value, port };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value)) return null;
  return { host: value, port };
};

/** The certificate a paired server must show: PEM, and its fingerprint. */
export interface Pin { cert: string; fingerprint: string }

/** Why a server couldn't be reached, in the owner's words. Never carries a token. */
export class GatewayUnreachable extends Error {}

const reachError = (endpoint: Endpoint, error: unknown): GatewayUnreachable => {
  const code = isRecord(error) && isString(error.code) ? error.code : '';
  const where = `${endpoint.host}:${endpoint.port}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new GatewayUnreachable(`Can’t find ${endpoint.host}.`);
  if (code === 'ECONNREFUSED') return new GatewayUnreachable(`Nothing answers at ${where}. Is serra server gateway running there?`);
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return new GatewayUnreachable(`${where} didn’t answer.`);
  // The pin, or the TLS check against the pinned certificate: either way it showed another certificate.
  if (code === 'PIN' || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return new GatewayUnreachable(`${where} isn’t the server this Mac paired with.`);
  return new GatewayUnreachable(`Can’t reach ${where}.`);
};

/**
 * The certificate the server at `endpoint` shows, read from a TLS handshake that sends nothing else. The owner
 * compares its words with the server's before anything secret goes to it.
 */
export const probeCertificate = (endpoint: Endpoint, timeoutMs = 8000): Promise<Pin> => new Promise((done, fail) => {
  // Not verified on purpose: there is nothing to verify against yet. Only the certificate is read, and the
  // socket is closed before any data is written.
  const socket = connect({ host: endpoint.host, port: endpoint.port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
    const der = socket.getPeerX509Certificate()?.raw;
    socket.destroy();
    if (!der) { fail(new GatewayUnreachable(`${endpoint.host} sent no certificate.`)); return; }
    const cert = pemFromDer(der);
    done({ cert, fingerprint: certFingerprint(cert) });
  });
  socket.once('timeout', () => { socket.destroy(); fail(reachError(endpoint, { code: 'TIMEOUT' })); });
  socket.once('error', (error) => { fail(reachError(endpoint, error)); });
});

const pinnedOptions = (endpoint: Endpoint, pin: Pin) => ({
  host: endpoint.host,
  port: endpoint.port,
  ca: [pin.cert],
  // The certificate must be the pinned one, byte for byte; its names don't matter (a tunnel reaches it as 127.0.0.1).
  checkServerIdentity: (_host: string, cert: PeerCertificate): Error | undefined =>
    certFingerprint(cert.raw) === pin.fingerprint ? undefined : Object.assign(new Error('pin'), { code: 'PIN' }),
  agent: false as const,
});

interface Reply { status: number; body: unknown }

/** One JSON request to a pinned server. */
export const pinnedRequest = (endpoint: Endpoint, pin: Pin, { method = 'GET', path, body, token, timeoutMs = 30_000 }: {
  method?: string; path: string; body?: unknown; token?: string; timeoutMs?: number;
}): Promise<Reply> => new Promise((done, fail) => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (text !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(text)); }
  if (token) headers.authorization = `Bearer ${token}`;
  const request = httpsRequest({ ...pinnedOptions(endpoint, pin), method, path, headers, timeout: timeoutMs }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => {
      let parsed: unknown = null;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
      done({ status: response.statusCode ?? 0, body: parsed });
    });
    response.on('error', (error) => fail(reachError(endpoint, error)));
  });
  request.once('timeout', () => { request.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); });
  request.once('error', (error) => fail(reachError(endpoint, error)));
  request.end(text);
});

/** What `/.well-known/serra` says. */
interface ServerHello extends ServerIdentity { minProtocol: number }

const isHello = (value: unknown): value is ServerHello =>
  isRecord(value) && value.serra === true && isString(value.id) && isString(value.name) && isNumber(value.protocol) && isNumber(value.minProtocol);

/** Who the pinned server says it is. Sends no secret. */
const serverHello = async (endpoint: Endpoint, pin: Pin): Promise<ServerHello> => {
  const reply = await pinnedRequest(endpoint, pin, { path: '/.well-known/serra', timeoutMs: 8000 });
  if (reply.status !== 200 || !isHello(reply.body)) throw new GatewayUnreachable(`${endpoint.host} isn’t a Serra server.`);
  return { id: reply.body.id, name: reply.body.name, protocol: reply.body.protocol, minProtocol: reply.body.minProtocol };
};

/** A server first contacted: its certificate, the three words for it and the typed code, and who it says it is. */
export interface Probe { endpoint: Endpoint; pin: Pin; words: [string, string, string]; hello: ServerHello }

/** Server ids as servers make them (`state.ts`). Anything else is refused before it is kept. */
export const SERVER_ID = /^s_[a-z0-9]{6,16}$/;

/** Reads the server's certificate and says who it is. The code stays here: it only goes into the words. */
export const probeServer = async (endpoint: Endpoint, code: string): Promise<Probe> => {
  const pin = await probeCertificate(endpoint);
  const hello = await serverHello(endpoint, pin);
  if (!SERVER_ID.test(hello.id)) throw new GatewayUnreachable(`${endpoint.host} isn’t a Serra server.`);
  return { endpoint, pin, words: pairingWords(pin.fingerprint, code), hello };
};

export type CodeOutcome =
  | { ok: true; token: string; deviceId: string; server: ServerIdentity }
  | { ok: false; reason: 'wrong'; triesLeft: number }
  | { ok: false; reason: 'locked' | 'expired' };

/** Sends the code to the pinned server. Only call once the owner said the words match. */
export const sendCode = async (probe: Probe, code: string, device: string): Promise<CodeOutcome> => {
  const reply = await pinnedRequest(probe.endpoint, probe.pin, { method: 'POST', path: '/pair', body: { code, device }, timeoutMs: 15_000 });
  const body = isRecord(reply.body) ? reply.body : {};
  if (reply.status === 200 && isString(body.token) && isRecord(body.device) && isString(body.device.id) && isRecord(body.server)
    && isString(body.server.id) && body.server.id === probe.hello.id && isString(body.server.name) && isNumber(body.server.protocol)) {
    return { ok: true, token: body.token, deviceId: body.device.id, server: { id: body.server.id, name: body.server.name, protocol: body.server.protocol } };
  }
  if (reply.status === 401 && isNumber(body.triesLeft)) return { ok: false, reason: 'wrong', triesLeft: body.triesLeft };
  if (reply.status === 410) return { ok: false, reason: body.error === 'locked' ? 'locked' : 'expired' };
  throw new GatewayUnreachable(`${probe.hello.name} didn’t take the code.`);
};

// ---------------------------------------------------------------------------------------------------------------
// A paired server
// ---------------------------------------------------------------------------------------------------------------

const isServerProfile = (value: unknown): value is ServerProfile =>
  isRecord(value) && isString(value.id) && isString(value.name) && (value.status === null || isRecord(value.status));

/** A gateway event as the Mac receives it. */
export interface RemoteEvent { seq: number; profile: string | null; channel: string; payload: unknown }

type StreamState = 'connecting' | 'live' | 'offline';

/** The token was refused: the device was revoked, or the server forgot it. Pairing again is the fix. */
export class NotPaired extends Error {}

export interface GatewayClient {
  /** The server's profiles and their state. */
  profiles(): Promise<{ server: ServerIdentity; profiles: ServerProfile[] }>;
  /** One engine call on one of the server's profiles. Throws the handler's message, as the app's IPC does. */
  call(profile: string, namespace: string, method: string, args: readonly unknown[]): Promise<unknown>;
  devices(): Promise<unknown>;
  revoke(deviceId: string): Promise<void>;
  /**
   * Follows the event log. Reconnects by itself with `Last-Event-ID` (1 s, then up to 30 s apart), so events missed
   * while away arrive in order; `reset` says the log no longer had them, so reload. Returns a stop function.
   */
  follow(listener: { event(event: RemoteEvent): void; reset?(): void; state?(state: StreamState): void }, options?: { retryMs?: number }): () => void;
}

/**
 * A client for one paired server. `endpoint` is asked before each connection, so a route can change (an SSH tunnel
 * opened again on another port); `token` is read when needed and never kept in an error.
 */
export const gatewayClient = ({ endpoint, pin, token, name }: {
  endpoint: () => Promise<Endpoint>; pin: Pin; token: () => Promise<string>; name: string;
}): GatewayClient => {
  const authed = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const reply = await pinnedRequest(await endpoint(), pin, { method, path, body, token: await token() });
    if (reply.status === 401) throw new NotPaired(`This Mac isn’t paired with ${name} any more.`);
    return reply;
  };
  const failed = (reply: Reply): Error => new Error(isRecord(reply.body) && isString(reply.body.error) ? reply.body.error : `${name} answered ${reply.status}.`);
  return {
    async profiles() {
      const reply = await authed('GET', '/profiles');
      const body = reply.body;
      if (reply.status !== 200 || !isRecord(body) || !isArrayOf(isServerProfile)(body.profiles) || !isRecord(body.server)) throw failed(reply);
      const { server } = body;
      if (!isString(server.id) || !isString(server.name) || !isNumber(server.protocol)) throw failed(reply);
      return { server: { id: server.id, name: server.name, protocol: server.protocol }, profiles: body.profiles };
    },
    async call(profile, namespace, method, args) {
      const reply = await authed('POST', '/rpc', { profile, namespace, method, args });
      const result = reply.body;
      if (reply.status !== 200 || !isRecord(result) || typeof result.ok !== 'boolean') throw failed(reply);
      if (!result.ok) throw new Error(isString(result.error) ? result.error : `${name} couldn’t do that.`);
      return result.value;
    },
    async devices() {
      const reply = await authed('GET', '/devices');
      if (reply.status !== 200 || !isRecord(reply.body)) throw failed(reply);
      return reply.body.devices;
    },
    async revoke(deviceId) {
      const reply = await authed('DELETE', `/devices/${encodeURIComponent(deviceId)}`);
      if (reply.status !== 200) throw failed(reply);
    },
    follow(listener, { retryMs = 1000 } = {}) {
      let stopped = false;
      let lastSeq: number | null = null;
      let wait = retryMs;
      let current: { destroy(): void } | null = null;
      let timer: NodeJS.Timeout | null = null;
      const state = (next: StreamState): void => { if (!stopped) listener.state?.(next); };
      const again = (): void => {
        current = null;
        if (stopped) return;
        state('offline');
        timer = setTimeout(() => { void open(); }, wait);
        wait = Math.min(wait * 2, 30_000);
      };
      const open = async (): Promise<void> => {
        if (stopped) return;
        state('connecting');
        let target: Endpoint;
        let secret: string;
        try { target = await endpoint(); secret = await token(); } catch { again(); return; }
        if (stopped) return;
        const headers: Record<string, string> = { accept: 'text/event-stream', authorization: `Bearer ${secret}` };
        if (lastSeq !== null) headers['last-event-id'] = String(lastSeq);
        let finished = false;
        const drop = (): void => { if (finished) return; finished = true; again(); };
        const request = httpsRequest({ ...pinnedOptions(target, pin), method: 'GET', path: '/events', headers }, (response) => {
          response.on('close', drop);
          if (response.statusCode !== 200) { response.resume(); return; }
          wait = retryMs;
          state('live');
          let buffer = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            buffer += chunk;
            let end: number;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              let id: number | null = null;
              let kind = 'message';
              let data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('id: ')) id = Number(line.slice(4));
                else if (line.startsWith('event: ')) kind = line.slice(7);
                else if (line.startsWith('data: ')) data += line.slice(6);
              }
              if (id !== null && Number.isSafeInteger(id)) lastSeq = id;
              if (kind === 'reset') listener.reset?.();
              else if (kind === 'message' && data && id !== null) {
                try {
                  const parsed: unknown = JSON.parse(data);
                  if (isRecord(parsed) && isString(parsed.channel)) {
                    listener.event({ seq: id, profile: isString(parsed.profile) ? parsed.profile : null, channel: parsed.channel, payload: parsed.payload });
                  }
                } catch { /* a broken line is skipped */ }
              }
            }
          });
          response.on('error', () => { /* 'close' follows */ });
        });
        request.on('error', drop);
        current = request;
        request.end();
      };
      void open();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        current?.destroy();
      };
    },
  };
};

/**
 * The engine of one profile on a paired server, shaped like the local one (`createEngine`), so the app's router can
 * send a window's calls there as it sends them here. Every method resolves through the gateway.
 */
export const remoteEngine = (client: GatewayClient, profile: string): EngineHandlers => {
  const engine: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const [namespace, methods] of Object.entries(bridgeMethods)) {
    if (namespace === 'app' || namespace === 'servers') continue;
    engine[namespace] = Object.fromEntries(methods.map((method: string) => [method, (...args: unknown[]) => client.call(profile, namespace, method, args)]));
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from bridgeMethods, which lists every engine method
  return engine as unknown as EngineHandlers;
};

