// Pairing over SSH, and reaching a server through it. SSH is its own proof: the owner's keys got the Mac in, so the
// server hands over a device token and its certificate on that channel, with no code and no words (ux-rules F3, F5).
// Then a tunnel from this Mac's loopback to the server's loopback carries the gateway, so nothing new opens on either
// side. The owner's own keys and agent only: BatchMode means ssh never asks for a password or a new host key (F10).
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { isNumber, isRecord, isString } from '../lib/guards.ts';
import { certFingerprint } from './cert.ts';

/** `you@t480`, `t480`, or an alias from `~/.ssh/config`. Never starts with `-`, so it can't be read as an option. */
const SSH_TARGET = /^(?:[a-z_][a-z0-9_.-]{0,31}@)?[a-z0-9](?:[a-z0-9.-]{0,252})$/i;

const isSshTarget = (target: string): boolean => SSH_TARGET.test(target.trim());

/** The server's name in a target: `t480` for `you@t480.home`. */
export const sshHostName = (target: string): string => target.trim().replace(/^[^@]*@/, '').split('.')[0] ?? target;

const BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];

/** Why ssh failed, in the few words the dialog shows. */
export type SshDetail = 'key refused' | 'host unknown' | 'timed out' | 'no serra' | 'no gateway' | 'failed';
export class SshFailed extends Error {
  readonly detail: SshDetail;
  constructor(detail: SshDetail, message: string) { super(message); this.detail = detail; }
}

const failure = (stderr: string, code: number | null): SshFailed => {
  if (/Permission denied|publickey|Too many authentication failures/i.test(stderr)) return new SshFailed('key refused', 'The server refused this Mac’s SSH key.');
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|Host key verification failed|No route to host/i.test(stderr)) {
    return new SshFailed('host unknown', 'SSH doesn’t know this server yet.');
  }
  if (/timed out|Connection refused|Connection closed/i.test(stderr)) return new SshFailed('timed out', 'The server didn’t answer over SSH.');
  if (code === 127 || /serra: (?:command )?not found/i.test(stderr)) return new SshFailed('no serra', 'Serra isn’t installed there.');
  if (/gateway isn’t running|gateway isn't running/i.test(stderr)) return new SshFailed('no gateway', 'Serra is there, but its gateway isn’t running.');
  return new SshFailed('failed', 'SSH failed.');
};

/** What `serra server pair --ssh` prints, checked: the token, and a certificate whose fingerprint it states. */
export interface SshPairing {
  server: { id: string; name: string; protocol: number };
  cert: string;
  fingerprint: string;
  port: number;
  token: string;
  deviceId: string;
}

const parseSshPairing = (stdout: string): SshPairing => {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new SshFailed('failed', 'The server’s answer wasn’t readable.'); }
  if (!isRecord(value) || !isRecord(value.server) || !isString(value.server.id) || !isString(value.server.name) || !isNumber(value.server.protocol)
    || !isString(value.cert) || !isString(value.fingerprint) || !isNumber(value.port) || !isString(value.token) || !isString(value.deviceId)) {
    throw new SshFailed('failed', 'The server’s answer wasn’t readable.');
  }
  let fingerprint: string;
  try { fingerprint = certFingerprint(value.cert); } catch { throw new SshFailed('failed', 'The server sent no valid certificate.'); }
  if (fingerprint !== value.fingerprint) throw new SshFailed('failed', 'The server’s certificate doesn’t match its fingerprint.');
  return {
    server: { id: value.server.id, name: value.server.name, protocol: value.server.protocol },
    cert: value.cert, fingerprint, port: value.port, token: value.token, deviceId: value.deviceId,
  };
};

/** A device name safe inside the remote shell's single quotes. */
const shellSafeName = (name: string): string => name.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40) || 'Mac';

export interface SshOptions { ssh?: string; timeoutMs?: number }

/** Runs `serra server pair --ssh` on `target` with the owner's keys. The token comes back on stdout only. */
export const pairOverSsh = (target: string, device: string, { ssh = 'ssh', timeoutMs = 60_000 }: SshOptions = {}): Promise<SshPairing> => {
  if (!isSshTarget(target)) return Promise.reject(new SshFailed('host unknown', 'That isn’t an SSH address.'));
  const remote = `PATH="$HOME/.local/bin:$PATH" serra server pair --ssh --device '${shellSafeName(device)}'`;
  return new Promise((done, fail) => {
    const child = spawn(ssh, [...BASE, '-T', target.trim(), remote], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new SshFailed('timed out', 'The server didn’t answer over SSH.')); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk).slice(0, 4000); });
    child.on('error', () => { clearTimeout(timer); fail(new SshFailed('failed', 'ssh isn’t available on this Mac.')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { fail(failure(stderr, code)); return; }
      try { done(parseSshPairing(stdout)); } catch (error) { fail(error); }
    });
  });
};

const freePort = (): Promise<number> => new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close(() => (port ? done(port) : fail(new Error('No free port on this Mac.'))));
  });
});

const accepts = (port: number): Promise<boolean> => new Promise((done) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});

export interface Tunnel { port: number; close(): void; closed: Promise<void> }

/** An SSH tunnel from 127.0.0.1 on this Mac to the server's gateway on its own 127.0.0.1. Loopback on both ends. */
export const openTunnel = async (target: string, remotePort: number, { ssh = 'ssh', timeoutMs = 15_000 }: SshOptions = {}): Promise<Tunnel> => {
  if (!isSshTarget(target)) throw new SshFailed('host unknown', 'That isn’t an SSH address.');
  const port = await freePort();
  const child = spawn(ssh, [...BASE, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`, target.trim()], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk).slice(0, 4000); });
  let exited: number | null | undefined;
  const closed = new Promise<void>((done) => { child.on('close', (code) => { exited = code; done(); }); child.on('error', () => { exited = -1; done(); }); });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited !== undefined) throw failure(stderr, exited);
    if (await accepts(port)) return { port, close: () => { child.kill('SIGTERM'); }, closed };
    await new Promise((wake) => setTimeout(wake, 100));
  }
  child.kill('SIGKILL');
  throw new SshFailed('timed out', 'The server didn’t answer over SSH.');
};
