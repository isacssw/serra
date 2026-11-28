// What the Mac app answers itself about servers (SB-32): pairing with a code or over SSH, and the servers this Mac is
// paired with. The work is in src/gateway/pairing.ts; this only parses the window's input. The code and the device
// token never come back to the window, and never into a log.
import type { ServerPairing } from '../../src/gateway/pairing.ts';
import { SshFailed } from '../../src/gateway/ssh.ts';
import type { Handlers } from './bridge.ts';

const text = (value: unknown, what: string, max = 300): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${what} is needed.`);
  return value.trim();
};

export const serverHandlers = (pairing: ServerPairing): Handlers<'servers'> => ({
  probe: (address, code) => pairing.probe(text(address, 'An address'), text(code, 'The code', 32)),
  pair: (probeId, code) => pairing.pair(text(probeId, 'A pairing', 64), text(code, 'The code', 32)),
  cancel: (probeId) => { if (typeof probeId === 'string') pairing.cancel(probeId); },
  pairOverSsh: async (target) => {
    try { return { ok: true, server: await pairing.pairOverSsh(text(target, 'An SSH address')) }; }
    catch (error) {
      if (error instanceof SshFailed) return { ok: false, detail: error.detail, message: error.message };
      throw error;
    }
  },
  list: () => pairing.list().map((server) => ({ id: server.id, name: server.name })),
});
