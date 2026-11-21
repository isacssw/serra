/**
 * Start, stop and restart the bot's background service through launchd (`deploy.ts`'s driver).
 * The CLI's `start`, `stop` and `restart` commands and the app's menubar and bridge all call these.
 */
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { launchd, type ServiceDriver } from './deploy.ts';
import { acquireLock } from './lock.ts';

export interface BotServiceOptions {
  driver?: ServiceDriver;
  /** Where the service's plist lives. Default `~/Library/LaunchAgents`. */
  launchAgentsDir?: string;
}

interface Service { directory: string; label: string; plist: string; driver: ServiceDriver }

const service = (profileDir: string, options: BotServiceOptions): Service => {
  const directory = resolve(profileDir);
  const label = loadConfig({ profileDir: directory, env: {} }).serviceLabel;
  const plist = join(options.launchAgentsDir ?? join(homedir(), 'Library/LaunchAgents'), `${label}.plist`);
  return { directory, label, plist, driver: options.driver ?? launchd };
};

/**
 * Runs `work` holding the profile's deployment lock, the one a release switch holds: a manual start, stop or restart
 * never lands in the middle of a switch (the app's automatic bot update included).
 */
const exclusive = async <T>(directory: string, work: () => Promise<T>): Promise<T> => {
  let unlock: () => void;
  try { unlock = acquireLock(join(directory, 'deployment.lock')); }
  catch { throw new Error('The bot is switching to another version right now. Try again in a moment.'); }
  try { return await work(); } finally { unlock(); }
};

const load = async ({ label, plist, driver }: Service): Promise<void> => {
  if (!existsSync(plist)) throw new Error(`Service ${label} isn't installed. Activate a release first.`);
  await driver.start(plist);
};

/** Loads the installed service. Refuses when it is already loaded or was never installed. */
export const startBot = async (profileDir: string, options: BotServiceOptions = {}): Promise<void> => {
  const target = service(profileDir, options);
  await exclusive(target.directory, async () => {
    if (await target.driver.loaded(target.label)) throw new Error('The bot is already running.');
    await load(target);
  });
};

/** Stops the service until the next login or start. The daemon hands waiting messages to their workers first. */
export const stopBot = async (profileDir: string, options: BotServiceOptions = {}): Promise<void> => {
  const target = service(profileDir, options);
  await exclusive(target.directory, () => target.driver.stop(target.label));
};

/**
 * Stops the service when it is loaded, loads it again and waits until the daemon reports ready.
 * A stopped bot is simply started. Checks the plist first, so a missing installation never stops a running bot.
 */
export const restartBot = async (profileDir: string, options: BotServiceOptions = {}): Promise<void> => {
  const target = service(profileDir, options);
  if (!existsSync(target.plist)) throw new Error(`Service ${target.label} isn't installed. Activate a release first.`);
  await exclusive(target.directory, async () => {
    await target.driver.stop(target.label);
    // A crashed daemon leaves its ready marker behind; clear it so `ready` waits for the new one.
    rmSync(join(target.directory, 'ready.json'), { force: true });
    await load(target);
    await target.driver.ready(target.directory);
  });
};
