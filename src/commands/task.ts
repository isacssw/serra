import type { Command } from '../manage.ts';
import { previewTask, startTask } from '../tasks.ts';

/** Arguments after the command name, without `--profile <folder>` and flags. */
const words = (args: string[]): string[] =>
  args.slice(1).filter((arg, index, rest) => !arg.startsWith('--') && rest[index - 1] !== '--profile');

const command: Command = {
  summary: "Start a task without Slack: a T3 thread with the bot's brief and knowledge, listed in jobs.",
  usage: [
    'pnpm bot task "Update the onboarding page for the new pricing" --profile /absolute/profile',
    'pnpm bot task "Update the onboarding page for the new pricing" --preview --profile /absolute/profile',
  ],
  async run({ args, flag, profileDir, log }) {
    const request = words(args).join(' ');
    if (flag('--preview')) { log(previewTask(profileDir, request)); return; }
    const task = await startTask(profileDir, request);
    log(`Started ${task.title} on ${task.branch}.`);
    log(task.link ?? `thread ${task.threadId}`);
  },
};
export default command;
