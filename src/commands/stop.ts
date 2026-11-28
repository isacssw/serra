import { stopBot } from '../bot-service.ts';
import type { Command } from '../manage.ts';

const command: Command = {
  summary: 'Stop the service until next login.',
  usage: ['pnpm bot stop --profile /absolute/profile'],
  service: true,
  async run({ profileDir, log }) {
    await stopBot(profileDir);
    log('Stopped. The installed service will start again at next login.');
  },
};
export default command;
