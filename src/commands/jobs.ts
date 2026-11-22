import { profileT3Bin } from '../cleanup.ts';
import { formatJobs, listJobs, t3ThreadLookup } from '../jobs.ts';
import type { Command } from '../manage.ts';
import { t3TaskState } from '../tasks.ts';

const command: Command = {
  summary: 'List jobs: needs you, running, done today. Reads state.json, tasks.json and logs/events.jsonl, never writes them.',
  usage: ['pnpm bot jobs --profile /absolute/profile [--channel C0123456789] [--all] [--slack-url https://acme.slack.com] [--json]'],
  async run({ option, flag, profileDir, log }) {
    const doneTodayOnly = !flag('--all');
    const channel = option('--channel');
    const slackUrl = option('--slack-url');
    if (slackUrl && !/^https:\/\/[\w.-]+\/?$/.test(slackUrl)) throw new Error('--slack-url needs the workspace URL, like https://acme.slack.com');
    // T3 adds each thread's title and link. A broken profile still lists the jobs, just without them.
    const t3Bin = (() => { try { return profileT3Bin(profileDir); } catch { return undefined; } })();
    const listing = await listJobs(profileDir, {
      doneTodayOnly,
      ...(channel ? { channel } : {}),
      ...(slackUrl ? { slackUrl } : {}),
      ...(t3Bin ? { threads: t3ThreadLookup(t3Bin), tasks: t3TaskState(t3Bin), runs: t3TaskState(t3Bin) } : {}),
    });
    log(flag('--json') ? JSON.stringify(listing, null, 2) : formatJobs(listing, { doneTodayOnly }));
  },
};
export default command;
