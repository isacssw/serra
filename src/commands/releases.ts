import { activationPreflight, releaseStatus } from '../releases.ts';
import type { Command } from '../manage.ts';

const short = (sha: string | undefined): string => sha ? sha.slice(0, 12) : 'unknown commit';

const command: Command = {
  summary: 'Show the active and prepared releases, new commits on main and the jobs an activation would restart under.',
  usage: ['pnpm bot releases --profile /absolute/profile [--fetch]'],
  async run({ flag, profileDir, log }) {
    const status = await releaseStatus(profileDir, { fetch: flag('--fetch'), commits: true });
    const describe = (release: NonNullable<typeof status.active>): string =>
      `${release.release}\n  ${short(release.commit)}${release.dirty ? ' with uncommitted changes' : ''}${release.preparedAt ? `, prepared ${release.preparedAt}` : ''}`;
    log(`Active release: ${status.active ? describe(status.active) : 'none'}`);
    log(`Prepared release: ${status.prepared ? describe(status.prepared) : 'none'}`);
    if (status.prepared) log(status.activateProblems.length ? `  Cannot activate: ${status.activateProblems.join(' ')}` : '  Ready to activate.');
    if (status.activation === 'switching') log('The last cutover was interrupted. Run rollback.');
    else if (status.canRollback) log('Rollback to the previous installation is available.');
    log(`Updates from: ${status.source}${status.upstream ? ` (${status.upstream})` : ''}`);
    if (status.commitsProblem) log(`New commits: ${status.commitsProblem}`);
    else {
      log(`New commits on ${status.ref}: ${status.newCommits.length || 'none, up to date'}`);
      for (const commit of status.newCommits) log(`  ${commit.sha.slice(0, 7)} ${commit.subject}`);
    }
    const { runningJobs } = activationPreflight(profileDir);
    log(`Running jobs: ${runningJobs.length || 'none'}`);
    for (const job of runningJobs) log(`  ${job.channel} · ${job.requester} · last activity ${job.lastActivityAt}`);
  },
};
export default command;
