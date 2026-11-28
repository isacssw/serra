import { startBot } from '../bot-service.ts';
import type { Command } from '../manage.ts';

const command: Command = {
  summary: 'Load the installed service again after stop.',
  usage: ['pnpm bot start --profile /absolute/profile'],
  service: true,
  async run({ profileDir, log }) {
    await startBot(profileDir);
    log('Service loaded. Check status and logs.');
  },
};
export default command;
