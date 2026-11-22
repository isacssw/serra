import { existsSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { launchd, readPrepared } from '../deploy.ts';
import type { Command } from '../manage.ts';

const command: Command = {
  summary: 'Show whether the service is loaded and which release is active.',
  usage: ['pnpm bot status --profile /absolute/profile'],
  macOnly: true,
  async run({ profileDir: directory, log }) {
    const config = loadConfig({ profileDir: directory, env: {} });
    log(`Service ${config.serviceLabel}: ${await launchd.loaded(config.serviceLabel) ? 'loaded' : 'stopped'}`);
    log(`Profile: ${directory}\nLogs: ${directory}/logs/bot.log`);
    const active = readPrepared(`${directory}/active.json`);
    if (active) log(`Active release: ${active.release}`);
    else if (existsSync(`${directory}/active.json`)) log("Active release: unknown (active.json can't be read).");
    else log('No release activated for this profile.');
  },
};
export default command;
