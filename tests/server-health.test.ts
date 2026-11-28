// Server health and unpairing (SB-33): the Mac follows each paired server's event stream and shows one state for it
// (`checking`, `up`, `offline`, `not paired`), its profiles' live status, its devices, and Forget. These run a real
// gateway on 127.0.0.1 in this process; nothing listens anywhere else.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { serverHandlers } from '../app/main/servers.ts';
import { serverEngines } from '../src/gateway/engines.ts';
import { eventLog } from '../src/gateway/events.ts';
import { protocolSkew, serverHealth, type ServerHealth } from '../src/gateway/health.ts';
import { serverPairing } from '../src/gateway/pairing.ts';
import { startGateway, type Gateway } from '../src/gateway/server.ts';
import { addDevice, listDevices, openPairing, revokeDevice, writeGatewayRuntime } from '../src/gateway/state.ts';
import type { SecretStore } from '../src/secrets.ts';
import { createProfile } from '../src/setup.ts';
import type { BotStatus } from '../src/contracts.ts';

const folder = (t: TestContext, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const profile = (root: string, id: string, name: string): void => {
  createProfile(join(root, id), {
    version: 1, bot: { id, name }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/tmp/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
};

const silent = () => ({ close() {} });

const gatewayOn = async (t: TestContext, root: string, events: ReturnType<typeof eventLog>, port = 0): Promise<Gateway> => {
  const gateway = await startGateway({
    root, addresses: ['127.0.0.1'], port, events, heartbeatMs: 200,
    engines: serverEngines({ root, runtime: { version: '0.0.0-test', platform: 'linux' }, events, subscribe: silent }),
  });
  writeGatewayRuntime(root, { pid: process.pid, port: gateway.port, addresses: ['127.0.0.1'], startedAt: new Date().toISOString() });
  t.after(() => gateway.close());
  return gateway;
};

const memorySecrets = (): SecretStore & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    get: (service, account) => Promise.resolve(items.get(`${service}/${account}`) ?? null),
    set: (service, account, value) => { items.set(`${service}/${account}`, value); return Promise.resolve(); },
    remove: (service, account) => { items.delete(`${service}/${account}`); return Promise.resolve(); },
  };
};

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((wake) => setTimeout(wake, 20));
  }
};

const UP: BotStatus = { state: 'up', pid: 42, startedAt: '2026-11-28T09:00:00.000Z', slackConnected: true, counts: { needsYou: 1, running: 2 } } as BotStatus;

/** A server with Friday, and a Mac paired with it by code, following its health. */
const pairedPair = async (t: TestContext, { offlineAfterMs = 300 } = {}) => {
  const root = folder(t, 'serra-server-');
  profile(root, 'friday', 'Friday');
  const events = eventLog();
  const gateway = await gatewayOn(t, root, events);
  const secrets = memorySecrets();
  const pairing = serverPairing({ root: folder(t, 'serra-mac-'), secrets, device: 'MacBook Air' });
  t.after(() => pairing.close());
  const code = openPairing(root);
  const probe = await pairing.probe(`127.0.0.1:${gateway.port}`, code);
  const paired = await pairing.pair(probe.probeId, code);
  assert.ok(paired.ok);
  const health = serverHealth({ servers: () => pairing.list(), client: (id) => pairing.client(id), offlineAfterMs, retryMs: 50 });
  t.after(() => health.close());
  const one = (): ServerHealth => health.snapshot()[0]!;
  return { root, events, gateway, secrets, pairing, health, one, serverId: paired.server.id };
};

test('a paired server is checking, then up with its profiles; a status report changes only that profile', async (t) => {
  const { health, one, events, root } = await pairedPair(t);
  let changes = 0;
  health.subscribe(() => { changes += 1; });
  health.sync();
  assert.equal(one().state, 'checking');
  assert.deepEqual(one().profiles, []);
  await until(() => one().state === 'up', 'up');
  assert.deepEqual(one().profiles.map((entry) => [entry.id, entry.name, entry.status]), [['friday', 'Friday', null]]);
  assert.equal(one().via, 'address');
  assert.match(one().address, /^127\.0\.0\.1:\d+$/);
  assert.match(one().fingerprint, /^sha256 [0-9a-f]{4}…[0-9a-f]{2}$/);
  assert.equal(one().protocol, 2);
  assert.equal(one().skew, null);
  assert.ok(changes > 0);

  events.publish('friday', 'status', UP);
  await until(() => one().profiles[0]?.status !== null, 'the status');
  assert.deepEqual(one().profiles[0]?.status, UP);
  // A report that isn't one is `checking` again, never a guess.
  events.publish('friday', 'status', { state: 'up' });
  await until(() => one().profiles[0]?.status === null, 'a bad report dropped');

  // A new profile on the server: the Mac reads the list again and shows it.
  profile(root, 'scout', 'Scout');
  events.publish(null, 'profiles', null);
  await until(() => one().profiles.length === 2, 'the new profile');
  // Nothing secret is in a view.
  const text = JSON.stringify(health.snapshot());
  assert.equal(/BEGIN CERTIFICATE|srv_|token/i.test(text), false);
});

test('a server that stops answering is offline only after a while, all its profiles with it, and back when it answers', async (t) => {
  const { health, one, gateway, root, events } = await pairedPair(t, { offlineAfterMs: 400 });
  health.sync();
  await until(() => one().state === 'up', 'up');
  const port = gateway.port;
  await gateway.close();
  // A short drop isn't news: it stays up for a moment.
  await new Promise((wake) => setTimeout(wake, 150));
  assert.equal(one().state, 'up');
  await until(() => one().state === 'offline', 'offline');
  assert.ok(one().lastSeen);
  // Its profiles are still listed (dimmed in the window), with the server's one state for all of them.
  assert.equal(one().profiles.length, 1);

  await gatewayOn(t, root, events, port);
  health.retry();
  await until(() => one().state === 'up', 'up again');
});

test('a server that never answered goes offline too', async (t) => {
  const { health, one, gateway } = await pairedPair(t, { offlineAfterMs: 200 });
  await gateway.close();
  health.sync();
  assert.equal(one().state, 'checking');
  await until(() => one().state === 'offline', 'offline');
  assert.equal(one().lastSeen, null);
});

test('a revoked Mac shows not paired and stops knocking; pairing again follows the server afresh', async (t) => {
  const { health, one, root, pairing, gateway } = await pairedPair(t);
  health.sync();
  await until(() => one().state === 'up', 'up');
  const [device] = listDevices(root);
  revokeDevice(root, device!.id);
  await until(() => one().state === 'unpaired', 'unpaired');
  // Retry doesn't bring a refused key back.
  health.retry();
  await new Promise((wake) => setTimeout(wake, 200));
  assert.equal(one().state, 'unpaired');

  const code = openPairing(root);
  const probe = await pairing.probe(`127.0.0.1:${gateway.port}`, code);
  assert.equal((await pairing.pair(probe.probeId, code)).ok, true);
  health.sync();
  await until(() => one().state === 'up', 'up after pairing again');
});

test('the app’s handlers: devices mark this Mac, it can revoke another but not itself, and Forget revokes it there first', async (t) => {
  const { health, one, root, pairing, serverId } = await pairedPair(t);
  const handlers = serverHandlers(pairing, health);
  health.sync();
  await until(() => one().state === 'up', 'up');
  addDevice(root, 'Mac mini');
  const devices = await handlers.devices(serverId);
  assert.deepEqual(devices.map((device) => [device.name, device.thisMac]).sort(), [['Mac mini', false], ['MacBook Air', true]]);
  const mine = devices.find((device) => device.thisMac)!;
  const other = devices.find((device) => !device.thisMac)!;
  await assert.rejects(Promise.resolve().then(() => handlers.revoke(serverId, mine.id)), /Use Forget/);
  await assert.rejects(Promise.resolve().then(() => handlers.revoke(serverId, '../x')), /Pick a device/);
  await assert.rejects(Promise.resolve().then(() => handlers.devices('nope')), /Pick a server/);
  const left = await handlers.revoke(serverId, other.id);
  assert.deepEqual(left.map((device) => device.name), ['MacBook Air']);

  assert.deepEqual(await handlers.forget(serverId), { revoked: true });
  // Revoked on the server, gone here, and no longer followed.
  assert.deepEqual(listDevices(root), []);
  assert.deepEqual(pairing.list(), []);
  assert.deepEqual(handlers.status(), []);
  // Its profile folders are untouched: Forget deletes nothing there.
  assert.ok(existsSync(join(root, 'friday', 'profile.json')));
});

test('Forget with the server unreachable still unpairs here, and says the server still lists this Mac', async (t) => {
  const { root, pairing, secrets, serverId, gateway, health } = await pairedPair(t);
  const handlers = serverHandlers(pairing, health);
  await gateway.close();
  assert.deepEqual(await handlers.forget(serverId), { revoked: false });
  assert.deepEqual(pairing.list(), []);
  assert.equal(secrets.items.size, 0);
  assert.equal(listDevices(root).length, 1);
});

test('protocol skew: N and N-1 work together; older is the server’s update, newer is the app’s', () => {
  assert.equal(protocolSkew(3, 3), null);
  assert.equal(protocolSkew(2, 3), null);
  assert.equal(protocolSkew(4, 3), null);
  assert.equal(protocolSkew(1, 3), 'server');
  assert.equal(protocolSkew(5, 3), 'app');
});
