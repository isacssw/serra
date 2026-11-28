// The profiles on disk (SB-10): `profiles.json` beside the profile folders, each folder's name, setup state and
// agent, and a one-off read of each daemon's status. Listing reads only: it never writes into a profile folder, and
// it writes `profiles.json` only when the owner changes the order or a colour, or adds or removes a profile.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BotStatus } from './contracts.ts';
import { readProfileFile } from './config.ts';
import { acpAgents, readAgentBackend } from './agent/acp-agents.ts';
import { setupProgress } from './setup.ts';
import { statusSocketPath, subscribeStatus } from './status-socket.ts';
import { arrange, emptyProfilesFile, localRef, parseProfilesFile, PROFILES_FILE, type ProfilesFile } from './profile-order.ts';

/** Profile folders directly under `root` (`~/.local/share/serra/<bot-id>`, where `pnpm run setup` puts them). */
export const profilesUnder = (root: string): string[] => {
  let names: string[];
  try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }
  return names.map((name) => join(root, name)).filter((dir) => existsSync(join(dir, 'profile.json')));
};

export const readProfilesFile = (root: string): ProfilesFile => {
  try { return parseProfilesFile(JSON.parse(readFileSync(join(root, PROFILES_FILE), 'utf8'))); }
  catch { return emptyProfilesFile(); }
};

/** Writes the whole file at once (a temp file, then a rename), so a crash never leaves half of it. */
export const writeProfilesFile = (root: string, file: ProfilesFile): void => {
  mkdirSync(root, { recursive: true });
  const path = join(root, PROFILES_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
};

/** A profile folder found, with its ref. */
export interface FoundProfile { ref: string; dir: string }

/**
 * The profiles to list, in order: folders under `root` as `profiles.json` orders them, then the one in use when it
 * lives somewhere else (an older setup's own folder), last and keyed by its path.
 */
export const findProfiles = (root: string, active: string | null): FoundProfile[] => {
  const dirs = profilesUnder(root).map((dir) => resolve(dir));
  const byRef = new Map(dirs.map((dir) => [localRef(basename(dir)), dir]));
  const listed = arrange(dirs.map((dir) => basename(dir)), readProfilesFile(root)).map((ref) => ({ ref, dir: byRef.get(ref)! }));
  const current = active ? resolve(active) : null;
  if (current && !dirs.includes(current) && existsSync(join(current, 'profile.json'))) listed.push({ ref: current, dir: current });
  return listed;
};

/** True when `dir` sits directly in `root`, so `profiles.json` can order it. */
export const inRoot = (root: string, dir: string): boolean => dirname(resolve(dir)) === resolve(root);

/** The bot's name, or the folder's when profile.json can't be read. */
export const profileName = (dir: string): string => {
  try { return readProfileFile(dir).bot.name; } catch { return basename(dir); }
};

/** The agent new work uses, as the owner reads it. */
export const agentName = (dir: string): string => {
  const settings = readAgentBackend(dir);
  if (settings.backend === 't3') return 'T3';
  return acpAgents(settings).find((agent) => agent.id === settings.agent)?.name ?? settings.agent ?? 'T3';
};

export const setupDone = (dir: string, launchAgentsDir?: string): boolean =>
  setupProgress(dir, launchAgentsDir ? { launchAgentsDir } : {}).next === null;

/**
 * One status report from the daemon of `dir`: `stopped` at once without a socket, otherwise the first message, or
 * null when it doesn't answer in time. The socket is closed straight after, so nothing is followed.
 */
export const probeStatus = (dir: string, timeoutMs = 800): Promise<BotStatus | null> => {
  if (!existsSync(statusSocketPath(dir))) return Promise.resolve({ state: 'stopped' });
  return new Promise((done) => {
    let finished = false;
    let subscription: { close(): void } | null = null;
    const finish = (status: BotStatus | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription?.close();
      done(status);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    subscription = subscribeStatus(dir, (message) => { if (message.type === 'status') finish(message.status); }, { retryMs: 0 });
    if (finished) subscription.close();
  });
};
