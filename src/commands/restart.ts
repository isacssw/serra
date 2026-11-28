import { restartBot } from '../bot-service.ts';
import type { Command } from '../manage.ts';

const command: Command = {
  summary: 'Stop the service if it runs, start it again and wait until the bot is ready.',
  usage: ['pnpm bot restart --profile /absolute/profile'],
  service: true,
  async run({ profileDir, log }) {
    log('Restarting. The bot hands waiting messages to their workers before it stops.');
    await restartBot(profileDir);
    log('Bot is ready.');
  },
};
export default command;
