// What a server keeps about itself and the Macs that may reach it, all under the profiles folder
// (`~/.local/share/serra`), private to its user:
//
//   server.json            { id, name, protocol }: who this server is
//   devices.json           the paired devices: id, name, when added, and a hash of each one's token (never the token)
//   gateway/cert.pem       the gateway's self-signed certificate, pinned by each Mac at pairing
//   gateway/key.pem        its key (mode 600)
//   gateway/pairing.json   the open pairing: a hash of its code, when it ends and the tries left (mode 600)
//   gateway/device-use.json  when each device last called, written by the gateway only
//
// Codes are 6 characters, single use, 10 minutes and 5 tries (ux-rules F4). Device tokens are 32 random bytes; only
// their SHA-256 is stored, and a revoked device is refused on its next call (F6). Nothing here is ever logged.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic.ts';
import { isArrayOf, isNumber, isRecord, isString, isTime, readJsonOrNull, type Guard } from '../lib/guards.ts';
import { certFingerprint, certMatchesKey, selfSignedCert } from './cert.ts';
import { pairingWords } from './words.ts';

/** The gateway's protocol. A Mac and a server work together at N and N-1 (design §4.7). */
export const GATEWAY_PROTOCOL = 1;
export const DEFAULT_GATEWAY_PORT = 47_820;

export const PAIRING_MINUTES = 10;
const PAIRING_TRIES = 5;
/** No 0/O, 1/I/L: a code is read off one screen and typed on another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export interface ServerIdentity { id: string; name: string; protocol: number }

const isIdentity: Guard<ServerIdentity> = (value): value is ServerIdentity =>
  isRecord(value) && isString(value.id) && /^s_[a-z0-9]{6,16}$/.test(value.id) && isString(value.name) && isNumber(value.protocol);

const gatewayDir = (root: string): string => join(root, 'gateway');

const ensureDir = (dir: string): void => { mkdirSync(dir, { recursive: true, mode: 0o700 }); };

/** The computer's name as people say it: `t480`, not `t480.local`. */
const defaultServerName = (): string => hostname().split('.')[0]?.slice(0, 40) || 'server';

/** This server's identity, made on first use with a new id and the computer's name. */
export const serverIdentity = (root: string, name = defaultServerName()): ServerIdentity => {
  const path = join(root, 'server.json');
  const found = readJsonOrNull(path, isIdentity);
  if (found) return found.protocol === GATEWAY_PROTOCOL ? found : { ...found, protocol: GATEWAY_PROTOCOL };
  ensureDir(root);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const id = `s_${Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')}`;
  const identity = { id, name, protocol: GATEWAY_PROTOCOL };
  writeFileAtomic(path, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
};

/** The gateway's certificate and key, made once. A key that no longer matches its certificate makes a new pair. */
export const gatewayCert = (root: string, name: string): { cert: string; key: string; fingerprint: string } => {
  const dir = gatewayDir(root);
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    if (certMatchesKey(cert, key)) return { cert, key, fingerprint: certFingerprint(cert) };
  }
  ensureDir(dir);
  const made = selfSignedCert(name);
  writeFileAtomic(keyPath, made.key, { mode: 0o600 });
  writeFileAtomic(certPath, made.cert, { mode: 0o600 });
  return { ...made, fingerprint: certFingerprint(made.cert) };
};

/** The three words for this server's certificate and a pairing's code, as `serra server pair` shows them. */
export const serverWords = (root: string, code: string): [string, string, string] => pairingWords(gatewayCert(root, serverIdentity(root).name).fingerprint, code);

// ---------------------------------------------------------------------------------------------------------------
// A short exclusive lock, so the gateway and the CLI never lose each other's change to the same file
// ---------------------------------------------------------------------------------------------------------------

const withLock = <T>(path: string, work: () => T, timeoutMs = 3000): T => {
  const lock = `${path}.lock`;
  const mine = `${process.pid}:${randomBytes(8).toString('hex')}`;
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeFileSync(fd, mine); } finally { closeSync(fd); }
      break;
    }
    catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      // A lock older than 10 seconds belongs to a process that died holding it.
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true }); } catch { /* gone already */ }
      if (Date.now() > until) throw new Error(`Busy: ${path}. Try again.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return work(); } finally {
    // Only our own lock: one taken over as stale by someone else stays theirs.
    try { if (readFileSync(lock, 'utf8') === mine) rmSync(lock, { force: true }); } catch { /* gone already */ }
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------------------------------------------

interface PairingFile { salt: string; hash: string; expiresAt: string; triesLeft: number; pairedDevice?: string }

const isPairing: Guard<PairingFile> = (value): value is PairingFile =>
  isRecord(value) && isString(value.salt) && isString(value.hash) && isTime(value.expiresAt) && isNumber(value.triesLeft)
  && (value.pairedDevice === undefined || isString(value.pairedDevice));

const pairingPath = (root: string): string => join(gatewayDir(root), 'pairing.json');

/** `K7Q4MX` as people read it: `K7Q-4MX`. */
export const formatCode = (code: string): string => `${code.slice(0, 3)}-${code.slice(3)}`;

/** What someone typed, as a code: capitals, without spaces or dashes. */
export const normalizeCode = (typed: string): string => typed.toUpperCase().replace(/[\s-]/g, '');

const codeHash = (salt: string, code: string): string => createHmac('sha256', Buffer.from(salt, 'hex')).update(code).digest('hex');

/** Opens a pairing: a new code that replaces any other, valid for 10 minutes and 5 tries. Returns the code. */
export const openPairing = (root: string, now = new Date()): string => {
  ensureDir(gatewayDir(root));
  const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const salt = randomBytes(16).toString('hex');
  const file: PairingFile = { salt, hash: codeHash(salt, code), expiresAt: new Date(now.getTime() + PAIRING_MINUTES * 60_000).toISOString(), triesLeft: PAIRING_TRIES };
  withLock(pairingPath(root), () => writeFileAtomic(pairingPath(root), JSON.stringify(file), { mode: 0o600 }));
  return code;
};

/** Ends the open pairing, if any (Ctrl-C in `serra server pair`). */
export const closePairing = (root: string): void => { withLock(pairingPath(root), () => rmSync(pairingPath(root), { force: true })); };

export type PairingState =
  | { state: 'open'; expiresAt: string; triesLeft: number }
  | { state: 'paired'; device: string }
  | { state: 'closed' };

/** Where the open pairing stands, for `serra server pair` while it waits. */
export const pairingState = (root: string, now = new Date()): PairingState => {
  const file = readJsonOrNull(pairingPath(root), isPairing);
  if (!file) return { state: 'closed' };
  if (file.pairedDevice) return { state: 'paired', device: file.pairedDevice };
  if (file.triesLeft <= 0 || Date.parse(file.expiresAt) <= now.getTime()) return { state: 'closed' };
  return { state: 'open', expiresAt: file.expiresAt, triesLeft: file.triesLeft };
};

export type CodeCheck = { ok: true } | { ok: false; reason: 'wrong'; triesLeft: number } | { ok: false; reason: 'locked' | 'expired' };

/**
 * Checks a typed code against the open pairing. A wrong code uses a try; the fifth wrong one, or the time running
 * out, ends the pairing (`locked`, `expired`), so a new code is needed. A right one ends it too: codes are single
 * use. `device` is the name the pairing is recorded under, so `serra server pair` can say who paired.
 */
export const useCode = (root: string, typed: string, device: string, now = new Date()): CodeCheck => withLock(pairingPath(root), () => {
  const file = readJsonOrNull(pairingPath(root), isPairing);
  if (!file || file.pairedDevice) return { ok: false, reason: 'expired' };
  if (Date.parse(file.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' };
  if (file.triesLeft <= 0) return { ok: false, reason: 'locked' };
  const expected = Buffer.from(file.hash, 'hex');
  const given = Buffer.from(codeHash(file.salt, normalizeCode(typed).slice(0, 32)), 'hex');
  if (expected.length === given.length && timingSafeEqual(expected, given)) {
    writeFileAtomic(pairingPath(root), JSON.stringify({ ...file, triesLeft: 0, pairedDevice: cleanDeviceName(device) }), { mode: 0o600 });
    return { ok: true };
  }
  const triesLeft = file.triesLeft - 1;
  writeFileAtomic(pairingPath(root), JSON.stringify({ ...file, triesLeft }), { mode: 0o600 });
  return triesLeft > 0 ? { ok: false, reason: 'wrong', triesLeft } : { ok: false, reason: 'locked' };
});

// ---------------------------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------------------------

interface StoredDevice { id: string; name: string; addedAt: string; tokenHash: string }
/** A paired device as the owner sees it: never its token or hash. */
export interface DeviceView { id: string; name: string; addedAt: string; lastUsed: string | null }

const isDevice: Guard<StoredDevice> = (value): value is StoredDevice =>
  isRecord(value) && isString(value.id) && isString(value.name) && isTime(value.addedAt) && isString(value.tokenHash);
const isDevices = isArrayOf(isDevice);
const isUse: Guard<Record<string, string>> = (value): value is Record<string, string> => isRecord(value) && Object.values(value).every(isTime);

const devicesPath = (root: string): string => join(root, 'devices.json');
const usePath = (root: string): string => join(gatewayDir(root), 'device-use.json');
const readDevices = (root: string): StoredDevice[] => readJsonOrNull(devicesPath(root), isDevices) ?? [];
const writeDevices = (root: string, devices: StoredDevice[]): void => writeFileAtomic(devicesPath(root), `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A device's name as it is kept and shown: printable, one line, at most 40 characters. */
const cleanDeviceName = (name: unknown): string => {
  const clean = (typeof name === 'string' ? name : '').replace(/[^\p{L}\p{N} ._'’()-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return clean || 'A Mac';
};

/** Adds a device and returns it with its token, the only time the token exists in the clear on this server. */
export const addDevice = (root: string, name: string, now = new Date()): { device: DeviceView; token: string } => {
  const token = `srv_${randomBytes(32).toString('base64url')}`;
  const stored: StoredDevice = { id: `d_${randomBytes(6).toString('hex')}`, name: cleanDeviceName(name), addedAt: now.toISOString(), tokenHash: tokenHash(token) };
  ensureDir(root);
  withLock(devicesPath(root), () => writeDevices(root, [...readDevices(root), stored]));
  return { device: { id: stored.id, name: stored.name, addedAt: stored.addedAt, lastUsed: null }, token };
};

/** The device a token belongs to, or null: unknown, malformed and revoked tokens alike. Reads the file each time. */
export const deviceForToken = (root: string, token: string | undefined): DeviceView | null => {
  if (!token || !/^srv_[\w-]{43}$/.test(token)) return null;
  const given = Buffer.from(tokenHash(token), 'hex');
  const found = readDevices(root).find((device) => {
    const stored = Buffer.from(device.tokenHash, 'hex');
    return stored.length === given.length && timingSafeEqual(stored, given);
  });
  return found ? { id: found.id, name: found.name, addedAt: found.addedAt, lastUsed: null } : null;
};

/** Records when a device last called. The gateway alone writes this file, so it can never undo a revoke. */
export const noteDeviceUse = (root: string, id: string, now = new Date()): void => {
  const use = readJsonOrNull(usePath(root), isUse) ?? {};
  const known = new Set(readDevices(root).map((device) => device.id));
  const next = Object.fromEntries(Object.entries({ ...use, [id]: now.toISOString() }).filter(([key]) => known.has(key)));
  ensureDir(gatewayDir(root));
  writeFileSync(usePath(root), JSON.stringify(next), { mode: 0o600 });
};

export const listDevices = (root: string): DeviceView[] => {
  const use = readJsonOrNull(usePath(root), isUse) ?? {};
  return readDevices(root).map((device) => ({ id: device.id, name: device.name, addedAt: device.addedAt, lastUsed: use[device.id] ?? null }));
};

/** Removes a device by id, or by name when one device has it. Its token stops working on its next call. */
export const revokeDevice = (root: string, which: string): DeviceView => withLock(devicesPath(root), () => {
  const devices = readDevices(root);
  const byId = devices.filter((device) => device.id === which);
  const matches = byId.length ? byId : devices.filter((device) => device.name.toLowerCase() === which.toLowerCase());
  if (matches.length === 0) throw new Error(`No device ${which}. See serra server devices.`);
  if (matches.length > 1) throw new Error(`${matches.length} devices are called ${which}. Revoke one by its id.`);
  const target = matches[0]!;
  writeDevices(root, devices.filter((device) => device.id !== target.id));
  return { id: target.id, name: target.name, addedAt: target.addedAt, lastUsed: null };
});

// ---------------------------------------------------------------------------------------------------------------
// The running gateway, so `serra server pair` knows where it listens
// ---------------------------------------------------------------------------------------------------------------

export interface GatewayRuntime { pid: number; port: number; addresses: string[]; startedAt: string }

const isRuntime: Guard<GatewayRuntime> = (value): value is GatewayRuntime =>
  isRecord(value) && isNumber(value.pid) && isNumber(value.port) && isArrayOf(isString)(value.addresses) && isTime(value.startedAt);

const runtimePath = (root: string): string => join(gatewayDir(root), 'gateway.json');

export const writeGatewayRuntime = (root: string, runtime: GatewayRuntime): void => {
  ensureDir(gatewayDir(root));
  writeFileAtomic(runtimePath(root), JSON.stringify(runtime), { mode: 0o600 });
};

export const clearGatewayRuntime = (root: string, pid = process.pid): void => {
  if (readJsonOrNull(runtimePath(root), isRuntime)?.pid === pid) rmSync(runtimePath(root), { force: true });
};

/** The gateway running now, or null when none is (its process is gone). */
export const runningGateway = (root: string, alive: (pid: number) => boolean): GatewayRuntime | null => {
  const runtime = readJsonOrNull(runtimePath(root), isRuntime);
  return runtime && alive(runtime.pid) ? runtime : null;
};
