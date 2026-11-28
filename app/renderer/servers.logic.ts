// How the window shows paired servers (SB-33): one dot and one word per server, a short line under its name, the
// Diagnostics line, and each device's line. Uses the same words as profiles (UX rule B1): `checking`, `up`,
// `offline`, `update needed`; `not paired` only when the server refused this Mac's key, which pairing again fixes.
// Pure: imported by `node --test` as well as the renderer.
import type { ServerDevice, ServerHealth } from '../main/bridge.ts';
import type { Dot } from './presence.logic.ts';

export interface ServerPresence { dot: Dot; pulse: boolean; word: string }

export const serverPresence = (server: Pick<ServerHealth, 'state' | 'skew'>): ServerPresence => {
  if (server.state === 'checking') return { dot: 'faint', pulse: true, word: 'checking' };
  if (server.state === 'offline') return { dot: 'hollow', pulse: false, word: 'offline' };
  if (server.state === 'unpaired') return { dot: 'hollow', pulse: false, word: 'not paired' };
  if (server.skew) return { dot: 'warn', pulse: false, word: 'update needed' };
  return { dot: 'up', pulse: false, word: 'up' };
};

/** `2h ago`, `5 min ago`, `just now`, `3 days ago`. */
export const ago = (iso: string, now: Date): string => {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
};

/** The line under a server's name: its profiles, or `No profiles yet`; offline adds when it was last seen. */
export const serverSubtitle = (server: ServerHealth, now: Date): string => {
  const names = server.profiles.length ? server.profiles.map((profile) => profile.name).join(', ') : 'No profiles yet';
  if (server.state === 'unpaired') return 'Pair again to reach it';
  if (server.state === 'offline' && server.lastSeen) return `${names} · last seen ${ago(server.lastSeen, now)}`;
  return names;
};

/** What to do about a server, as its page's one button: Retry when offline, Pair again when refused. */
export const serverAction = (server: Pick<ServerHealth, 'state'>): 'retry' | 'pair' | null => {
  if (server.state === 'offline') return 'retry';
  if (server.state === 'unpaired') return 'pair';
  return null;
};

/** The one Diagnostics line (UX rule C7): where it is, its Serra version, its protocol, its certificate. */
export const serverDiagnostics = (server: ServerHealth): string =>
  [server.via === 'ssh' ? `ssh ${server.address}` : server.address, server.version ? `Serra ${server.version}` : null, server.protocol === null ? null : `protocol ${server.protocol}`, server.fingerprint]
    .filter(Boolean).join(' · ');

/** The server's update button, when one side is behind: `Update t480`, or `Update Serra` when the app is older. */
export const updateAction = (server: Pick<ServerHealth, 'state' | 'behind' | 'skew' | 'name'>): { label: string; target: 'server' | 'app' } | null => {
  if (server.state !== 'up') return null;
  const behind = server.behind ?? (server.skew === 'server' ? 'server' : server.skew === 'app' ? 'app' : null);
  if (behind === 'server') return { label: `Update ${server.name}`, target: 'server' };
  if (behind === 'app') return { label: 'Update Serra', target: 'app' };
  return null;
};

/** How an update ended, in a few words (ux-rules A4 Skew). */
export const updateEnding = (name: string, state: 'done' | 'rolled-back' | 'failed', message: string | null): { title: string; body: string } => {
  if (state === 'done') return { title: `${name} is updated`, body: '' };
  if (state === 'rolled-back') return { title: `${name} wasn’t updated`, body: `The new version didn’t start, so ${name} went back unchanged.` };
  return { title: `${name} wasn’t updated`, body: message ?? `Run serra server update on ${name}.` };
};

/** A device's line after its name: `this Mac`, `last used 3 days ago`, `not used yet`. */
export const deviceLine = (device: ServerDevice, now: Date): string => {
  if (device.thisMac) return 'this Mac';
  return device.lastUsed ? `last used ${ago(device.lastUsed, now)}` : 'not used yet';
};

/** The Forget dialog's sentence (A4): who stays there, and that nothing is deleted. */
export const forgetBody = (server: Pick<ServerHealth, 'name' | 'profiles'>): string => {
  const names = server.profiles.map((profile) => profile.name);
  if (!names.length) return `Nothing on ${server.name} is deleted.`;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
  return `${list} ${names.length === 1 ? 'stays' : 'stay'} on ${server.name} and ${names.length === 1 ? 'leaves' : 'leave'} this app. Nothing is deleted.`;
};

/** The toast after Forget. When the server couldn't be told, the few words that finish the job there. */
export const forgetToast = (name: string, revoked: boolean): string =>
  revoked ? `${name} forgotten` : `${name} forgotten. On ${name}, run serra server devices revoke to remove this Mac.`;

/** The command that makes a profile on a server, shown while it has none. */
export const newProfileHint = (name: string): string => `On ${name}, run pnpm setup in the Serra folder.`;

/** Settings › Servers' path for one server. */
export const serverPath = (id: string): string => `/settings/servers?server=${encodeURIComponent(id)}`;
