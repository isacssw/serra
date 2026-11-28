// Where the gateway may listen (ux-rules F1): this computer's loopback, and its Tailscale addresses. Never 0.0.0.0,
// `::`, a LAN or a public address: being on the same Wi-Fi or the internet must not even reach the pairing endpoint.
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { isIP } from 'node:net';

/** Tailscale's IPv4 range, 100.64.0.0/10 (CGNAT). */
const isTailscaleV4 = (address: string): boolean => {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
};
/** Tailscale's IPv6 range, fd7a:115c:a1e0::/48. */
const isTailscaleV6 = (address: string): boolean => /^fd7a:115c:a1e0:/i.test(address);

const isLoopback = (address: string): boolean => address === '127.0.0.1' || address === '::1';

/** True for an address the gateway may bind: loopback or Tailscale. */
export const mayListenOn = (address: string): boolean =>
  isIP(address) !== 0 && (isLoopback(address) || isTailscaleV4(address) || isTailscaleV6(address));

/**
 * The addresses to listen on: 127.0.0.1, then each Tailscale address this computer has (on `tailscale0`, or a
 * `utun` on macOS). `only`: the addresses the owner asked for, each refused unless `mayListenOn` allows it.
 */
export const listenAddresses = (only: readonly string[] = [], interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] => {
  if (only.length) {
    for (const address of only) {
      if (!mayListenOn(address)) throw new Error(`The gateway listens only on 127.0.0.1 and Tailscale addresses, not ${address}.`);
    }
    return [...new Set(only)];
  }
  const tailscale = Object.values(interfaces).flat()
    .filter((info): info is NetworkInterfaceInfo => Boolean(info) && !info!.internal)
    .map((info) => info.address)
    .filter((address) => isTailscaleV4(address) || isTailscaleV6(address));
  return ['127.0.0.1', ...new Set(tailscale)];
};
