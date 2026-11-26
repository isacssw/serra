import type { Command } from '../manage.ts';
import { previewInterview, startInterview } from '../tasks.ts';

const command: Command = {
  summary: 'Start the knowledge interview: a T3 thread that asks you how you work and writes proposals to review.',
  usage: [
    'pnpm bot interview --profile /absolute/profile',
    'pnpm bot interview --preview --profile /absolute/profile',
  ],
  async run({ flag, profileDir, log }) {
    if (flag('--preview')) { log(previewInterview(profileDir).brief); return; }
    const task = await startInterview(profileDir);
    log(`Started ${task.title} on ${task.branch}. Its proposals appear in pnpm bot proposals and the app's Proposals screen.`);
    log(task.link ?? `thread ${task.threadId}`);
  },
};
export default command;
