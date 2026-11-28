// What the Mac app answers itself about servers (SB-32, SB-33): pairing with a code or over SSH, the servers this Mac
// is paired with and how each is doing, their devices, and Forget. The work is in src/gateway (pairing.ts,
// health.ts); this only parses the window's input. The code and the device token never come back to the window, and
// never into a log.
import type { ServerDevice } from '../../src/api.ts';
import type { ServerHealthFollower } from '../../src/gateway/health.ts';
import type { ServerPairing } from '../../src/gateway/pairing.ts';
import { SERVER_ID } from '../../src/gateway/client.ts';
import { SshFailed } from '../../src/gateway/ssh.ts';
import { isArrayOf, isRecord, isString, isTime } from '../../src/lib/guards.ts';
import type { Handlers } from './bridge.ts';

const text = (value: unknown, what: string, max = 300): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${what} is needed.`);
  return value.trim();
};

const serverId = (value: unknown): string => {
  if (typeof value !== 'string' || !SERVER_ID.test(value)) throw new Error('Pick a server.');
  return value;
};

/** Device ids as servers make them (`state.ts`). */
const DEVICE_ID = /^d_[a-f0-9]{12}$/;

interface Listed { id: string; name: string; addedAt: string; lastUsed: string | null }
const isListed = (value: unknown): value is Listed =>
  isRecord(value) && isString(value.id) && DEVICE_ID.test(value.id) && isString(value.name) && isTime(value.addedAt)
  && (value.lastUsed === null || isTime(value.lastUsed));

export const serverHandlers = (pairing: ServerPairing, health: ServerHealthFollower): Handlers<'servers'> => {
  const paired = (id: unknown) => {
    const found = pairing.list().find((server) => server.id === serverId(id));
    if (!found) throw new Error('This Mac isn’t paired with that server any more.');
    return found;
  };
  const devices = async (id: unknown): Promise<ServerDevice[]> => {
    const server = paired(id);
    const listed: unknown = await pairing.client(server.id).devices();
    if (!isArrayOf(isListed)(listed)) throw new Error(`${server.name} sent a list this app can’t read.`);
    return listed.map((device) => ({
      id: device.id, name: device.name.slice(0, 40), addedAt: device.addedAt, lastUsed: device.lastUsed, thisMac: device.id === server.deviceId,
    }));
  };
  return {
    probe: (address, code) => pairing.probe(text(address, 'An address'), text(code, 'The code', 32)),
    pair: async (probeId, code) => {
      const outcome = await pairing.pair(text(probeId, 'A pairing', 64), text(code, 'The code', 32));
      if (outcome.ok) health.sync();
      return outcome;
    },
    cancel: (probeId) => { if (typeof probeId === 'string') pairing.cancel(probeId); },
    pairOverSsh: async (target) => {
      try {
        const server = await pairing.pairOverSsh(text(target, 'An SSH address'));
        health.sync();
        return { ok: true, server };
      } catch (error) {
        if (error instanceof SshFailed) return { ok: false, detail: error.detail, message: error.message };
        throw error;
      }
    },
    list: () => pairing.list().map((server) => ({ id: server.id, name: server.name })),
    status: () => health.snapshot(),
    retry: (id) => { health.retry(paired(id).id); },
    devices,
    revoke: async (id, deviceId) => {
      const server = paired(id);
      if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw new Error('Pick a device.');
      if (deviceId === server.deviceId) throw new Error(`This is this Mac. Use Forget ${server.name} instead.`);
      await pairing.client(server.id).revoke(deviceId);
      return devices(server.id);
    },
    forget: async (id) => {
      const server = paired(id);
      const outcome = await pairing.forget(server.id);
      health.sync();
      return outcome;
    },
  };
};
