import { activate } from '../deploy.ts';
import type { Command } from '../manage.ts';
import { runningJobs } from '../releases.ts';

const command: Command = {
  summary: 'Switch the service to the prepared release.',
  usage: ['pnpm bot activate --profile /absolute/profile'],
  service: true,
  async run({ profileDir, log }) {
    const running = runningJobs(profileDir);
    if (running.length) log(`${running.length} job${running.length === 1 ? '' : 's'} running. Their T3 runs keep going; replies resume once the new release is up.`);
    await activate(profileDir, { log });
    log('Bot connected. Cutover complete. Test a Slack question and a follow-up in an existing thread.');
  },
};
export default command;
