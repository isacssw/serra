// The gateway and pairing (SB-32): a server serves its engine over pinned HTTPS to the Macs paired with it, by a
// short-lived code and three words, or over SSH. These run a real gateway on 127.0.0.1 in this process.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/handlers/index.ts';
import { headlessHost, serverEngines } from '../src/gateway/engines.ts';
import { eventLog } from '../src/gateway/events.ts';
import { listenAddresses, mayListenOn } from '../src/gateway/listen.ts';
import { startGateway, type Gateway } from '../src/gateway/server.ts';
import {
  addDevice, closePairing, formatCode, listDevices, normalizeCode, openPairing, pairingState, serverIdentity, serverWords,
  useCode, writeGatewayRuntime,
} from '../src/gateway/state.ts';
import {
  gatewayClient, GatewayUnreachable, NotPaired, parseAddress, pinnedRequest, probeCertificate, remoteEngine, type RemoteEvent,
} from '../src/gateway/client.ts';
import { readServers, serverPairing, SERVERS_FILE, tokenService } from '../src/gateway/pairing.ts';
import { selfSignedCert, certFingerprint } from '../src/gateway/cert.ts';
import { pairingWords } from '../src/gateway/words.ts';
import { SshFailed } from '../src/gateway/ssh.ts';
import type { SecretStore } from '../src/secrets.ts';
import { runCli } from '../src/manage.ts';
import { createProfile } from '../src/setup.ts';
import { stoppedStatusSource } from '../src/status-source.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const folder = (t: TestContext, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A server's profiles folder with one profile, "Friday". */
const serverRoot = (t: TestContext): string => {
  const root = folder(t, 'serra-server-');
  createProfile(join(root, 'friday'), {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/tmp/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  return root;
};

/** No daemon anywhere: every profile's status socket stays silent. */
const silent = () => ({ close() {} });

const gatewayOn = async (t: TestContext, root: string, options: { port?: number; events?: ReturnType<typeof eventLog>; heartbeatMs?: number } = {}): Promise<Gateway> => {
  const events = options.events ?? eventLog();
  const gateway = await startGateway({
    root, addresses: ['127.0.0.1'], port: options.port ?? 0, events, heartbeatMs: options.heartbeatMs ?? 200,
    engines: serverEngines({ root, runtime: { version: '0.0.0-test', platform: 'linux' }, events, subscribe: silent }),
  });
  writeGatewayRuntime(root, { pid: process.pid, port: gateway.port, addresses: ['127.0.0.1'], startedAt: new Date().toISOString() });
  t.after(() => gateway.close());
  return gateway;
};

/** The Keychain, in memory. */
const memorySecrets = (): SecretStore & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    get: (service, account) => Promise.resolve(items.get(`${service}/${account}`) ?? null),
    set: (service, account, value) => { items.set(`${service}/${account}`, value); return Promise.resolve(); },
    remove: (service, account) => { items.delete(`${service}/${account}`); return Promise.resolve(); },
  };
};

const macSide = (t: TestContext, extra: Partial<Parameters<typeof serverPairing>[0]> = {}) => {
  const root = folder(t, 'serra-mac-');
  const secrets = memorySecrets();
  const pairing = serverPairing({ root, secrets, device: 'MacBook Air', ...extra });
  t.after(() => pairing.close());
  return { root, secrets, pairing };
};

// ---------------------------------------------------------------------------------------------------------------
// Codes, words and addresses
// ---------------------------------------------------------------------------------------------------------------

test('a code works once: a wrong one uses a try, the right one pairs, and then it is spent', (t) => {
  const root = folder(t, 'serra-code-');
  const code = openPairing(root);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(formatCode('K7Q4MX'), 'K7Q-4MX');
  assert.equal(normalizeCode(' k7q-4mx '), 'K7Q4MX');
  const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  assert.deepEqual(useCode(root, wrong, 'Mac'), { ok: false, reason: 'wrong', triesLeft: 4 });
  // Typed as people type it: lower case, with the dash.
  assert.deepEqual(useCode(root, formatCode(code).toLowerCase(), 'MacBook Air'), { ok: true });
  assert.deepEqual(pairingState(root), { state: 'paired', device: 'MacBook Air' });
  assert.deepEqual(useCode(root, code, 'Another'), { ok: false, reason: 'expired' });
  // The file holds a salted hash, never the code, and only its owner can read it.
  const file = readFileSync(join(root, 'gateway/pairing.json'), 'utf8');
  assert.equal(file.includes(code), false);
  assert.equal(statSync(join(root, 'gateway/pairing.json')).mode & 0o077, 0);
});

test('five wrong codes lock the pairing, and ten minutes end it', (t) => {
  const root = folder(t, 'serra-code-');
  const code = openPairing(root);
  const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  for (const left of [4, 3, 2, 1]) assert.deepEqual(useCode(root, wrong, 'Mac'), { ok: false, reason: 'wrong', triesLeft: left });
  assert.deepEqual(useCode(root, wrong, 'Mac'), { ok: false, reason: 'locked' });
  // Locked means locked: the right code no longer works either.
  assert.deepEqual(useCode(root, code, 'Mac'), { ok: false, reason: 'locked' });

  const start = new Date('2026-11-28T10:00:00Z');
  const fresh = openPairing(root, start);
  assert.deepEqual(useCode(root, fresh, 'Mac', new Date('2026-11-28T10:10:01Z')), { ok: false, reason: 'expired' });
  assert.deepEqual(pairingState(root, new Date('2026-11-28T10:10:01Z')), { state: 'closed' });
  closePairing(root);
  assert.deepEqual(useCode(root, fresh, 'Mac', start), { ok: false, reason: 'expired' });
});

test('the three words follow the certificate: the same on both sides, different for another server', () => {
  const one = certFingerprint(selfSignedCert('t480').cert);
  const other = certFingerprint(selfSignedCert('t480').cert);
  assert.deepEqual(pairingWords(one), pairingWords(one));
  assert.equal(pairingWords(one).length, 3);
  assert.notDeepEqual(pairingWords(one), pairingWords(other));
});

test('the gateway listens only on loopback and Tailscale, never on every address or a LAN', () => {
  for (const address of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.5', '8.8.8.8', '100.128.0.1', 'localhost']) assert.equal(mayListenOn(address), false, address);
  for (const address of ['127.0.0.1', '::1', '100.101.102.103', 'fd7a:115c:a1e0::1']) assert.equal(mayListenOn(address), true, address);
  assert.throws(() => listenAddresses(['0.0.0.0']), /only on 127\.0\.0\.1 and Tailscale/);
  const found = listenAddresses([], {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '', cidr: null }],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null }],
    tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false, netmask: '255.255.255.255', mac: '', cidr: null }],
  });
  assert.deepEqual(found, ['127.0.0.1', '100.101.102.103']);
});

test('addresses read the way people type them', () => {
  assert.deepEqual(parseAddress('t480'), { host: 't480', port: 47_820 });
  assert.deepEqual(parseAddress('t480:9000'), { host: 't480', port: 9000 });
  assert.deepEqual(parseAddress('100.101.102.103'), { host: '100.101.102.103', port: 47_820 });
  assert.deepEqual(parseAddress('https://t480.tail1234.ts.net:47821'), { host: 't480.tail1234.ts.net', port: 47_821 });
  assert.deepEqual(parseAddress('[fd7a:115c:a1e0::1]:9000'), { host: 'fd7a:115c:a1e0::1', port: 9000 });
  for (const bad of ['', 'http://t480', 't480:99999', 'a b', '-oProxyCommand=x']) assert.equal(parseAddress(bad), null, bad);
});

// ---------------------------------------------------------------------------------------------------------------
// Pairing with a code, end to end
// ---------------------------------------------------------------------------------------------------------------

test('pairing with a code: words first, a wrong code says tries left, the right one gives a token kept in the Keychain', async (t) => {
  const root = serverRoot(t);
  const gateway = await gatewayOn(t, root);
  const { root: macRoot, secrets, pairing } = macSide(t);
  const code = openPairing(root);

  const probe = await pairing.probe(`127.0.0.1:${gateway.port}`);
  assert.equal(probe.name, serverIdentity(root).name);
  // The Mac's words are the server's words.
  assert.deepEqual(probe.words, serverWords(root));
  // Nothing was paired by probing.
  assert.deepEqual(listDevices(root), []);

  const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  assert.deepEqual(await pairing.pair(probe.probeId, wrong), { ok: false, reason: 'wrong', triesLeft: 4 });
  const done = await pairing.pair(probe.probeId, formatCode(code));
  assert.equal(done.ok, true);
  assert.ok(done.ok);
  assert.deepEqual(done.server.profiles.map((profile) => [profile.id, profile.name]), [['friday', 'Friday']]);
  assert.equal(done.server.via, 'address');

  const [server] = readServers(macRoot);
  assert.equal(server?.id, serverIdentity(root).id);
  const token = secrets.items.get(`${tokenService(server!.id)}/device-token`);
  assert.match(token ?? '', /^srv_[\w-]{43}$/);
  // servers.json and devices.json never hold the token.
  assert.equal(readFileSync(join(macRoot, SERVERS_FILE), 'utf8').includes(token!), false);
  assert.equal(readFileSync(join(root, 'devices.json'), 'utf8').includes(token!), false);
  assert.deepEqual(listDevices(root).map((device) => device.name), ['MacBook Air']);
  // The probe is spent: a second pair with it is refused.
  assert.deepEqual(await pairing.pair(probe.probeId, code), { ok: false, reason: 'expired' });

  // Pairing the same Mac again replaces its entry and revokes the old device, so no stale key is left on the server.
  const again = await pairing.probe(`127.0.0.1:${gateway.port}`);
  assert.equal((await pairing.pair(again.probeId, openPairing(root))).ok, true);
  assert.equal(readServers(macRoot).length, 1);
  assert.equal(listDevices(root).length, 1);
  assert.notEqual(listDevices(root)[0]?.id, server!.deviceId);
});

test('the Mac reaches a paired server’s engine: the same answers as the engine running here', async (t) => {
  const root = serverRoot(t);
  const gateway = await gatewayOn(t, root);
  const { pairing } = macSide(t);
  const code = openPairing(root);
  const probe = await pairing.probe(`127.0.0.1:${gateway.port}`);
  const paired = await pairing.pair(probe.probeId, code);
  assert.ok(paired.ok);

  const remote = remoteEngine(pairing.client(paired.server.id), 'friday');
  const local = createEngine({
    profileDir: () => join(root, 'friday'), profileDirOrNull: () => join(root, 'friday'), selectProfile: () => {},
    status: stoppedStatusSource(), runtime: { version: '0.0.0-test', platform: 'linux' }, host: headlessHost,
  });
  assert.deepEqual(await remote.settings.read(), await local.settings.read());
  assert.deepEqual(await remote.brief.check('brief', '# Brief\n'), await local.brief.check('brief', '# Brief\n'));
  // A handler's error comes back as its message, as over the app's IPC.
  await assert.rejects(Promise.resolve(remote.pages.read('../../etc/passwd')), (error: Error) => !/at .*\.ts/.test(error.message));
  // What needs the Mac's own screen can't run on a server.
  await assert.rejects(Promise.resolve(remote.profiles.showBackup(join(root, 'friday'))), /needs the Mac|outside|backup/i);
});

test('no way in without a paired token: missing, made-up, revoked, or a path outside the profiles', async (t) => {
  const root = serverRoot(t);
  const gateway = await gatewayOn(t, root);
  const endpoint = { host: '127.0.0.1', port: gateway.port };
  const pin = await probeCertificate(endpoint);
  const call = (path: string, token?: string, body?: unknown, method = body ? 'POST' : 'GET') => pinnedRequest(endpoint, pin, { path, token, body, method });

  assert.equal((await call('/profiles')).status, 401);
  assert.equal((await call('/profiles', 'srv_' + 'a'.repeat(43))).status, 401);
  assert.equal((await call('/rpc', undefined, { profile: 'friday', namespace: 'settings', method: 'read', args: [] })).status, 401);
  assert.equal((await call('/events')).status, 401);
  // No pairing open: a code can't be guessed into one.
  assert.equal((await call('/pair', undefined, { code: 'K7Q4MX', device: 'x' })).status, 410);

  const { token, device } = addDevice(root, 'MacBook Air');
  assert.equal((await call('/profiles', token)).status, 200);
  // Only the engine's namespaces, and only profile folders: no `app`, no paths.
  const app = await call('/rpc', token, { profile: 'friday', namespace: 'app', method: 'info', args: [] });
  assert.deepEqual(app.body, { ok: false, error: 'No handler for app.info.' });
  const proto = await call('/rpc', token, { profile: 'friday', namespace: 'settings', method: 'constructor', args: [] });
  assert.deepEqual(proto.body, { ok: false, error: 'No handler for settings.constructor.' });
  for (const profile of ['..', '../friday', '/etc', 'friday/../..']) {
    assert.equal((await call('/rpc', token, { profile, namespace: 'settings', method: 'read', args: [] })).status, 404, profile);
  }

  // Revoked over the gateway: refused on the very next call.
  assert.equal((await call(`/devices/${device.id}`, token, undefined, 'DELETE')).status, 200);
  assert.equal((await call('/profiles', token)).status, 401);

  // Revoked with the CLI, in another process: refused on the next call too.
  const second = addDevice(root, 'Mac mini');
  assert.equal((await call('/profiles', second.token)).status, 200);
  const lines: string[] = [];
  assert.equal(await runCli(['server', 'devices', 'revoke', 'Mac mini', '--root', root], { log: (line) => lines.push(line), error: (line) => lines.push(line) }), 0);
  assert.match(lines.join('\n'), /Revoked Mac mini/);
  assert.equal((await call('/profiles', second.token)).status, 401);
});

test('a client pinned to one certificate sends nothing to a server showing another', async (t) => {
  const root = serverRoot(t);
  const gateway = await gatewayOn(t, root);
  const { token } = addDevice(root, 'MacBook Air');
  const impostor = selfSignedCert('t480');
  const client = gatewayClient({
    endpoint: () => Promise.resolve({ host: '127.0.0.1', port: gateway.port }),
    pin: { cert: impostor.cert, fingerprint: certFingerprint(impostor.cert) },
    token: () => Promise.resolve(token), name: 't480',
  });
  await assert.rejects(client.profiles(), (error: Error) => error instanceof GatewayUnreachable && /isn’t the server this Mac paired with/.test(error.message) && !error.message.includes(token));
  // The token was never presented: the device was never used.
  assert.deepEqual(listDevices(root).map((device) => device.lastUsed), [null]);
});

test('a revoked Mac is told it is no longer paired, and its open event stream ends', async (t) => {
  const root = serverRoot(t);
  const gateway = await gatewayOn(t, root);
  const { pairing } = macSide(t);
  const probe = await pairing.probe(`127.0.0.1:${gateway.port}`);
  const paired = await pairing.pair(probe.probeId, openPairing(root));
  assert.ok(paired.ok);
  const client = pairing.client(paired.server.id);
  const states: string[] = [];
  const live = new Promise<void>((done) => {
    const stop = client.follow({ event: () => {}, state: (state) => { states.push(state); if (state === 'live') done(); } }, { retryMs: 50 });
    t.after(stop);
  });
  await live;
  const [device] = listDevices(root);
  await runCli(['server', 'devices', 'revoke', device!.id, '--root', root], { log: () => {}, error: () => {} });
  await assert.rejects(client.profiles(), NotPaired);
  // The heartbeat rechecks the token, so the stream closes and can't come back.
  await new Promise((wake) => setTimeout(wake, 600));
  assert.equal(states.includes('offline'), true);
  assert.equal(states.at(-1) === 'live', false);
});

// ---------------------------------------------------------------------------------------------------------------
// Events and reconnecting
// ---------------------------------------------------------------------------------------------------------------

test('after a reconnect the Mac gets what it missed, in order; when the log no longer has it, a reset', async (t) => {
  const root = serverRoot(t);
  const events = eventLog(5);
  let gateway: Gateway | null = await gatewayOn(t, root, { events });
  const port = gateway.port;
  const { token } = addDevice(root, 'MacBook Air');
  const pin = await probeCertificate({ host: '127.0.0.1', port });
  const client = gatewayClient({ endpoint: () => Promise.resolve({ host: '127.0.0.1', port }), pin, token: () => Promise.resolve(token), name: 't480' });
  const seen: RemoteEvent[] = [];
  let resets = 0;
  let wake: (() => void) | null = null;
  const states: string[] = [];
  const stop = client.follow({
    event: (event) => { seen.push(event); wake?.(); },
    reset: () => { resets += 1; wake?.(); },
    state: (state) => { states.push(state); if (state === 'live') wake?.(); },
  }, { retryMs: 50 });
  t.after(stop);
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise<void>((done) => { wake = done; setTimeout(done, 50); });
    }
  };
  await until(() => states.includes('live'));
  events.publish('friday', 'jobs', null);
  await until(() => seen.length === 1);

  // The server goes away; two events happen while the Mac can't hear them.
  await gateway.close();
  gateway = null;
  await until(() => states.at(-1) === 'offline');
  events.publish('friday', 'status', { state: 'running' });
  events.publish('friday', 'proposals', null);
  gateway = await gatewayOn(t, root, { events, port });
  await until(() => seen.length === 3);
  assert.deepEqual(seen.map((event) => [event.seq, event.channel]), [[1, 'jobs'], [2, 'status'], [3, 'proposals']]);
  assert.equal(resets, 0);

  // Away for longer than the log keeps (5): told to reload instead of seeing a gap.
  await gateway.close();
  gateway = null;
  await until(() => states.at(-1) === 'offline');
  for (let index = 0; index < 8; index += 1) events.publish('friday', 'jobs', index);
  gateway = await gatewayOn(t, root, { events, port });
  await until(() => resets === 1);
  assert.equal(seen.length, 3);
  events.publish(null, 'profiles', null);
  await until(() => seen.length === 4);
  assert.equal(seen.at(-1)?.seq, 12);
});

// ---------------------------------------------------------------------------------------------------------------
// Over SSH
// ---------------------------------------------------------------------------------------------------------------

/**
 * A stand-in for `ssh`: it runs the remote command here, with a `serra` on the server's PATH that serves `root`,
 * and for `-L` forwards a local port, as the real one does. `FAKE_SSH=denied` refuses the key.
 */
const fakeSsh = (t: TestContext, root: string, { serra = true }: { serra?: boolean } = {}): string => {
  const dir = folder(t, 'serra-ssh-');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  if (serra) {
    writeFileSync(join(home, '.local/bin/serra'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO, 'src/manage.ts'))} "$@" --root ${JSON.stringify(root)}\n`);
    chmodSync(join(home, '.local/bin/serra'), 0o755);
  }
  const ssh = join(dir, 'ssh');
  writeFileSync(ssh, `#!${process.execPath}
const { spawn } = require('node:child_process');
const net = require('node:net');
const args = process.argv.slice(2);
let forward = null; const rest = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-o') { i += 1; continue; }
  if (args[i] === '-L') { forward = args[++i]; continue; }
  if (args[i] === '-T' || args[i] === '-N') continue;
  rest.push(args[i]);
}
require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(args) + '\\n');
if (process.env.FAKE_SSH === 'denied') { process.stderr.write('you@t480: Permission denied (publickey).\\n'); process.exit(255); }
if (forward) {
  const [, local, , remote] = forward.split(':');
  net.createServer((socket) => { const up = net.connect(Number(remote), '127.0.0.1'); socket.pipe(up).pipe(socket); up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy()); })
    .listen(Number(local), '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
} else {
  const child = spawn('/bin/sh', ['-c', rest.slice(1).join(' ')], { env: { ...process.env, HOME: ${JSON.stringify(home)} }, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.pipe(process.stdout);
  child.on('close', (code) => process.exit(code ?? 1));
}
`);
  chmodSync(ssh, 0o755);
  return ssh;
};

test('pairing over SSH: no code and no words, the token comes over SSH, and calls go through a loopback tunnel', async (t) => {
  const root = serverRoot(t);
  await gatewayOn(t, root);
  const ssh = fakeSsh(t, root);
  const { root: macRoot, secrets, pairing } = macSide(t, { ssh: { ssh } });
  const server = await pairing.pairOverSsh('you@t480');
  assert.deepEqual(server.profiles.map((profile) => profile.name), ['Friday']);
  assert.equal(server.via, 'ssh');
  const [saved] = readServers(macRoot);
  assert.deepEqual(saved?.route, { kind: 'ssh', target: 'you@t480', port: JSON.parse(readFileSync(join(root, 'gateway/gateway.json'), 'utf8')).port });
  assert.match(secrets.items.get(`${tokenService(saved!.id)}/device-token`) ?? '', /^srv_/);
  // ssh never asks for a password: BatchMode on every call, and the tunnel binds loopback on both ends.
  const calls = readFileSync(join(ssh, '../calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.every((call) => call.includes('BatchMode=yes')), true);
  const tunnel = calls.find((call) => call.includes('-L'));
  assert.match(tunnel?.[tunnel.indexOf('-L') + 1] ?? '', /^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/);
  assert.deepEqual(listDevices(root).map((device) => device.name), ['MacBook Air']);
  // A later call opens the tunnel again by itself.
  assert.equal((await pairing.client(saved!.id).profiles()).profiles.length, 1);
});

test('SSH failures say why in a few words, and nothing is paired', async (t) => {
  const root = serverRoot(t);
  await gatewayOn(t, root);
  const ssh = fakeSsh(t, root);
  const previous = process.env.FAKE_SSH;
  process.env.FAKE_SSH = 'denied';
  t.after(() => { if (previous === undefined) delete process.env.FAKE_SSH; else process.env.FAKE_SSH = previous; });
  const { root: macRoot, pairing } = macSide(t, { ssh: { ssh } });
  await assert.rejects(pairing.pairOverSsh('you@t480'), (error: Error) => error instanceof SshFailed && error.detail === 'key refused');
  delete process.env.FAKE_SSH;
  const bare = macSide(t, { ssh: { ssh: fakeSsh(t, root, { serra: false }) } });
  await assert.rejects(bare.pairing.pairOverSsh('you@t480'), (error: Error) => error instanceof SshFailed && error.detail === 'no serra');
  // Something that ssh would read as an option is refused before ssh runs.
  await assert.rejects(pairing.pairOverSsh('-oProxyCommand=touch /tmp/x'), (error: Error) => error instanceof SshFailed && error.detail === 'host unknown');
  assert.equal(existsSync(join(macRoot, SERVERS_FILE)), false);
  assert.deepEqual(listDevices(root), []);
});

test('serra server pair --ssh needs the gateway running, and never prints a token to a terminal', async (t) => {
  const root = serverRoot(t);
  const errors: string[] = [];
  const code = await runCli(['server', 'pair', '--ssh', '--device', 'Mac', '--root', root], { log: () => {}, error: (line) => errors.push(line) });
  assert.equal(code, 1);
  // Under node --test stdout is a pipe, so this is the gateway check; a terminal is refused before it (see the command).
  assert.match(errors.join('\n'), /gateway isn’t running|To pair by hand/);
  assert.deepEqual(listDevices(root), []);
});
