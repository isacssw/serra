import { rollback } from '../deploy.ts';
import type { Command } from '../manage.ts';

const command: Command = {
  summary: 'Switch the service back to the previous installation.',
  usage: ['pnpm bot rollback --profile /absolute/profile'],
  service: true,
  async run({ profileDir, log }) {
    await rollback(profileDir, { log });
    log('Previous installation restored with the latest job state.');
  },
};
export default command;
