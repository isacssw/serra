// The Updates screen's logic: release labels, the new-commits heading, which buttons can run, the confirm dialogs
// and what to tell the owner after an action. Pure data and functions: imported by `node --test` as well as the renderer.
import type { Prepared } from '../../../src/deploy.ts';
import type { ActivationOutcome, RollbackOutcome } from '../../../src/releases.ts';
import type { SerraApi } from '../../main/bridge.ts';

export type UpdatesStatus = ReturnType<SerraApi['updates']['status']>;
export type UpdateAction = NonNullable<UpdatesStatus['running']>;
type Labelled = Pick<Prepared, 'release' | 'commit' | 'dirty'>;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** A release's short name: its commit (with `+ changes` for uncommitted edits), else its folder name. */
export const releaseLabel = (release: Labelled | null): string => {
  if (!release) return 'None';
  if (release.commit) return `${release.commit.slice(0, 7)}${release.dirty ? ' + changes' : ''}`;
  return release.release.split('/').filter(Boolean).pop() ?? release.release;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When a release was prepared, like `prepared Nov 19, 14:05`, in the owner's time zone. Empty when unknown. */
export const preparedLabel = (release: Pick<Prepared, 'preparedAt'> | null): string => {
  const at = release?.preparedAt ? new Date(release.preparedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `prepared ${MONTHS[at.getMonth()]} ${at.getDate()}, ${time}`;
};

/** The branch name for headings: `origin/main` → `main`. */
const branch = (ref: string | null): string => (ref ?? 'main').replace(/^origin\//, '');

/** The heading above the commits list: `4 new commits on main`, `Up to date with main`, or why it can't say. */
export const commitsHeading = (status: Pick<UpdatesStatus, 'newCommits' | 'commitsProblem' | 'ref'>): string => {
  if (status.commitsProblem) return 'New commits unknown';
  if (!status.newCommits.length) return `Up to date with ${branch(status.ref)}`;
  return `${plural(status.newCommits.length, 'new commit', 'new commits')} on ${branch(status.ref)}`;
};

/** `git@github.com:owner/serra.git` or `https://github.com/owner/serra` → `owner/serra`; other URLs as they are. */
export const repositoryName = (url: string): string => {
  const github = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return github ? github[1]! : url;
};

/** Where updates come from, under the heading: `From isacssw/serra main, in /path/to/checkout`. */
export const sourceLabel = (status: Pick<UpdatesStatus, 'ref' | 'source' | 'upstream'>): string =>
  status.upstream && status.ref
    ? `From ${repositoryName(status.upstream)} ${status.ref.replace(/^[^/]+\//, '')}, in ${status.source}`
    : `From ${status.source}`;

export interface ActionState { enabled: boolean; reason?: string }

const BUSY: Record<UpdateAction, string> = { prepare: 'Preparing…', activate: 'Activating…', rollback: 'Rolling back…' };

/** Whether each button can run now, and why not (shown as its tooltip). One action runs at a time. */
export const actionStates = (status: UpdatesStatus): Record<UpdateAction, ActionState> => {
  if (status.running) {
    const reason = `${BUSY[status.running]} Wait for it to finish.`;
    return { prepare: { enabled: false, reason }, activate: { enabled: false, reason }, rollback: { enabled: false, reason } };
  }
  const blocked = status.activateProblems[0];
  return {
    prepare: { enabled: true },
    activate: blocked ? { enabled: false, reason: blocked } : { enabled: true },
    rollback: status.canRollback ? { enabled: true } : { enabled: false, reason: 'Nothing to roll back: no activation to undo.' },
  };
};

export const busyLabel = (action: UpdateAction): string => BUSY[action];

/** The text of the Activate confirm dialog, for 0, 1 or N running jobs. */
export const activateDialog = (prepared: Labelled | null, runningJobs: number): { title: string; body: string } => ({
  title: `Activate ${releaseLabel(prepared)}?`,
  body: runningJobs === 0
    ? 'No jobs are running. Activating restarts the bot.'
    : runningJobs === 1
      ? '1 job is running. Activating restarts the bot; the job continues after restart.'
      : `${runningJobs} jobs are running. Activating restarts the bot; the jobs continue after restart.`,
});

/** The text of the Roll back confirm dialog. Rollback restarts the bot too, so it names the running jobs the same way. */
export const rollbackDialog = (runningJobs: number): { title: string; body: string } => ({
  title: 'Roll back to the previous release?',
  body: runningJobs === 0
    ? 'No jobs are running. Rolling back restarts the bot on the release before the last activation.'
    : `${plural(runningJobs, 'job is', 'jobs are')} running. Rolling back restarts the bot on the release before the last activation; ${runningJobs === 1 ? 'the job continues' : 'the jobs continue'} after restart.`,
});

export interface Notice {
  tone: 'success' | 'error';
  message: string;
  /** Offer Roll back next to the message: the cutover failed and the automatic restore didn't finish. */
  offerRollback: boolean;
}

/** The label of the release at `path`, using `active`'s commit when it is that release. */
const labelOf = (path: string, active: Labelled | null): string => releaseLabel(active?.release === path ? active : { release: path });

/** What to tell the owner after Activate. `active` is the status reread afterwards, for the release's commit. */
export const activationNotice = (outcome: ActivationOutcome, active: Labelled | null = null): Notice => {
  if (outcome.ok) return { tone: 'success', message: `Activated ${labelOf(outcome.release, active)}. The bot is running the new release.`, offerRollback: false };
  if (outcome.stage === 'checks') return { tone: 'error', message: `Activation refused; nothing changed. ${outcome.error}`, offerRollback: false };
  if (outcome.restored) return { tone: 'error', message: `The new release didn't start, so the previous one is running again. ${outcome.error}`, offerRollback: false };
  return {
    tone: 'error',
    message: `The new release didn't start and the previous one couldn't be restored automatically. Fix the cause, then roll back. ${outcome.error}`,
    offerRollback: outcome.rollbackAvailable,
  };
};

/** What to tell the owner after Roll back. `active` is the status reread afterwards, for the release's commit. */
export const rollbackNotice = (outcome: RollbackOutcome, active: Labelled | null = null): Notice => outcome.ok
  ? { tone: 'success', message: outcome.release ? `Rolled back to ${labelOf(outcome.release, active)}.` : 'Rolled back. No release is active now.', offerRollback: false }
  : { tone: 'error', message: `Rollback failed. ${outcome.error}`, offerRollback: false };
