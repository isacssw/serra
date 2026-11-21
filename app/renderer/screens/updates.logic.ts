// The Updates screen's logic: what the app card and the bot line say in each state, release notes as plain lines,
// and, in developer mode, release labels, the new-commits heading, which buttons can run, the confirm dialogs and what
// to tell the owner after an action. Pure data and functions: imported by `node --test` as well as the renderer.
import type { Prepared } from '../../../src/deploy.ts';
import type { ActivationOutcome, ReleaseOverview, RollbackOutcome } from '../../../src/releases.ts';
import type { AppUpdateView } from '../../main/app-updater.ts';
import type { BotSync } from '../../main/bot-sync.ts';
import type { SerraApi } from '../../main/bridge.ts';

export type UpdatesStatus = ReturnType<SerraApi['updates']['status']>;
export type UpdateAction = NonNullable<UpdatesStatus['running']>;
type Labelled = Pick<Prepared, 'release' | 'commit' | 'dirty'> & Partial<Pick<Prepared, 'appVersion'>>;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Nov 21` (and the year when it isn't this year's), in the owner's time zone. Empty when unknown. */
export const shortDate = (iso: string | null | undefined, now = new Date()): string => {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return `${MONTHS[at.getMonth()]} ${at.getDate()}${at.getFullYear() === now.getFullYear() ? '' : `, ${at.getFullYear()}`}`;
};

/** `just now`, `5 min ago`, `3 h ago`, else the date. */
export const checkedLabel = (iso: string, now = new Date()): string => {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} min ago`;
  if (minutes < 24 * 60) return `Checked ${Math.floor(minutes / 60)} h ago`;
  return `Checked ${shortDate(iso, now)}`;
};

/** `76 of 122 MB` while downloading; `76 MB` when the size is unknown. */
export const progressLabel = (received: number, total: number | null): string => {
  const mb = (bytes: number): string => String(Math.round(bytes / 1_000_000));
  return total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`;
};

export const progressPercent = (received: number, total: number | null): number | null =>
  total ? Math.min(100, Math.floor((received / total) * 100)) : null;

// ---------------------------------------------------------------------------------------------------------------
// The app card (release mode and developer mode alike)
// ---------------------------------------------------------------------------------------------------------------

export type CardTone = 'neutral' | 'up' | 'busy' | 'new' | 'down';
export type CardAction = 'check' | 'download' | 'cancel' | 'install' | 'openInstaller';

export interface AppCard {
  tone: CardTone;
  title: string;
  /** One or two short sentences under the title. */
  body: string;
  /** Small text at the right of the title: when it was checked, or the installed version. */
  meta: string;
  primary: { action: CardAction; label: string } | null;
  secondary: { action: CardAction; label: string } | null;
  /** The release page, for notes and other builds. */
  link: string | null;
}

const ERROR_TITLES: Record<Extract<AppUpdateView, { state: 'error' }>['stage'], string> = {
  check: "Couldn't check for updates",
  download: "The download didn't finish",
  verify: "The download didn't pass its checks",
  install: "The update didn't install",
};

/** What the app card says and offers in each state. */
export const appCard = (view: AppUpdateView, now = new Date()): AppCard => {
  const base = { meta: '', primary: null, secondary: null, link: null } as const;
  const name = `Serra ${view.current}`;
  switch (view.state) {
    case 'unavailable': return { ...base, tone: 'neutral', title: name, body: view.reason };
    case 'idle': return { ...base, tone: 'neutral', title: name, body: "Serra hasn't checked for a newer version yet.", primary: { action: 'check', label: 'Check now' } };
    case 'checking': return { ...base, tone: 'busy', title: name, body: 'Checking for a newer version…' };
    case 'up-to-date': return { ...base, tone: 'up', title: name, body: "You're on the latest version.", meta: checkedLabel(view.checkedAt, now) };
    case 'no-build': return {
      ...base, tone: 'neutral', title: name, meta: checkedLabel(view.checkedAt, now), link: view.url,
      body: `Serra ${view.version} is out, but it has no build for this Mac yet.`,
    };
    case 'available': return {
      ...base, tone: 'new', title: `Serra ${view.release.version} is available`, meta: `You have ${view.current}`, link: view.release.url,
      body: [view.release.prerelease ? 'Pre-release' : '', shortDate(view.release.publishedAt, now)].filter(Boolean).join(' · '),
      primary: { action: 'download', label: 'Download' },
    };
    case 'downloading': return {
      ...base, tone: 'busy', title: `Downloading Serra ${view.release.version}`, meta: `You have ${view.current}`,
      body: progressLabel(view.received, view.total), secondary: { action: 'cancel', label: 'Cancel' },
    };
    case 'verifying': return { ...base, tone: 'busy', title: `Checking Serra ${view.release.version}`, meta: `You have ${view.current}`, body: 'Comparing the download with its published checksum…' };
    case 'ready': return view.install.kind === 'replace'
      ? {
        ...base, tone: 'new', title: `Serra ${view.release.version} is ready`, meta: `You have ${view.current}`,
        body: 'Serra closes, installs the new version and opens again. The bot keeps running.',
        primary: { action: 'install', label: 'Restart to update' },
      }
      : {
        ...base, tone: 'new', title: `Serra ${view.release.version} is ready`, meta: `You have ${view.current}`,
        body: `${view.install.reason} Open the installer, then drag Serra to Applications and replace the old copy.`,
        primary: { action: 'openInstaller', label: 'Open installer' },
      };
    case 'installing': return { ...base, tone: 'busy', title: `Installing Serra ${view.release.version}`, meta: `You have ${view.current}`, body: 'Serra is closing and will open again in a moment.' };
    case 'error': return {
      ...base, tone: 'down', title: ERROR_TITLES[view.stage], meta: name, body: view.message, link: view.release?.url ?? null,
      primary: view.release && view.stage !== 'install' ? { action: 'download', label: 'Try again' } : { action: 'check', label: 'Try again' },
    };
  }
};

/** Whether the header's Check for updates button can run now. */
export const canCheck = (view: AppUpdateView | null): boolean =>
  view !== null && !['unavailable', 'checking', 'downloading', 'verifying', 'installing', 'ready'].includes(view.state);

/** Release notes are Markdown; the card shows them as plain lines: headings, list items and paragraphs. */
export type NoteLine = { kind: 'heading' | 'item' | 'text'; text: string };

export const noteLines = (markdown: string): NoteLine[] => {
  const plain = (text: string): string => text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  const lines: NoteLine[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (heading) lines.push({ kind: 'heading', text: plain(heading[1]!) });
    else if (item) lines.push({ kind: 'item', text: plain(item[1]!) });
    else lines.push({ kind: 'text', text: plain(line) });
  }
  return lines.filter((note) => note.text);
};

// ---------------------------------------------------------------------------------------------------------------
// The bot line (release mode)
// ---------------------------------------------------------------------------------------------------------------

export interface BotLine {
  tone: CardTone;
  text: string;
  /** The error or extra detail, shown smaller. */
  detail: string;
  action: { kind: 'sync' | 'rollback' | 'setup'; label: string } | null;
}

const was = (from: string | null): string => from ? `version ${from}` : 'an earlier version';

/** What the Updates screen says about the bot in release mode. */
export const botLine = (sync: BotSync): BotLine | null => {
  switch (sync.state) {
    case 'manual': return null;
    case 'not-installed': return { tone: 'neutral', text: "The bot isn't installed yet.", detail: 'Finish setup to install it. It then follows the app’s version.', action: { kind: 'setup', label: 'Open setup' } };
    case 'in-step': return { tone: 'up', text: `The bot runs version ${sync.version}.`, detail: '', action: null };
    case 'updating': return { tone: 'busy', text: `Moving the bot to version ${sync.to}…`, detail: 'It restarts once the new version is installed. Running jobs continue after the restart.', action: null };
    case 'waiting': return sync.jobs > 0
      ? {
        tone: 'neutral', text: `The bot still runs ${was(sync.from)}.`,
        detail: `It moves to ${sync.to} when ${sync.jobs === 1 ? 'the running job finishes' : `the ${sync.jobs} running jobs finish`}.`,
        action: { kind: 'sync', label: 'Update now' },
      }
      : { tone: 'busy', text: `The bot still runs ${was(sync.from)}.`, detail: `It moves to ${sync.to} after the current action.`, action: null };
    case 'failed': return {
      tone: 'down', text: `The bot couldn't move to ${sync.to}, so it still runs ${was(sync.from)}.`, detail: sync.message,
      action: { kind: 'sync', label: 'Try again' },
    };
    case 'interrupted': return {
      tone: 'down', text: "The last bot restart didn't finish.", detail: 'Roll back to start the earlier version again.',
      action: { kind: 'rollback', label: 'Roll back' },
    };
  }
};

/** The confirm dialog for updating the bot now, while jobs run. */
export const syncDialog = (to: string, runningJobs: number): { title: string; body: string } => ({
  title: `Move the bot to ${to} now?`,
  body: runningJobs === 0
    ? 'No jobs are running. The bot restarts on the new version.'
    : `${plural(runningJobs, 'job is', 'jobs are')} running. The bot restarts on the new version; ${runningJobs === 1 ? 'the job continues' : 'the jobs continue'} after the restart, and replies wait until then.`,
});

// ---------------------------------------------------------------------------------------------------------------
// Developer mode: builds from a Serra checkout, switched by hand
// ---------------------------------------------------------------------------------------------------------------

/** A release's short name: its commit (with `+ changes` for uncommitted edits), else its version, else its folder name. */
export const releaseLabel = (release: Labelled | null): string => {
  if (!release) return 'None';
  if (release.commit) return `${release.commit.slice(0, 7)}${release.dirty ? ' + changes' : ''}`;
  if (release.appVersion) return release.appVersion;
  return release.release.split('/').filter(Boolean).pop() ?? release.release;
};

/** When a release was built, like `built Nov 19, 14:05`, in the owner's time zone. Empty when unknown. */
export const preparedLabel = (release: Pick<Prepared, 'preparedAt'> | null): string => {
  const at = release?.preparedAt ? new Date(release.preparedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `built ${MONTHS[at.getMonth()]} ${at.getDate()}, ${time}`;
};

/** The branch name for headings: `origin/main` → `main`. */
export const branch = (ref: string | null): string => (ref ?? 'main').replace(/^[^/]+\//, '');

/** The heading above the commits list: `4 new commits on main`, `Up to date with main`, or why it can't say. */
export const commitsHeading = (status: Pick<ReleaseOverview, 'newCommits' | 'commitsProblem' | 'ref'>): string => {
  if (status.commitsProblem) return "Can't list new commits";
  if (!status.newCommits.length) return `Up to date with ${branch(status.ref)}`;
  return `${plural(status.newCommits.length, 'new commit', 'new commits')} on ${branch(status.ref)}`;
};

/** `git@github.com:owner/serra.git` or `https://github.com/owner/serra` → `owner/serra`; other URLs as they are. */
export const repositoryName = (url: string): string => {
  const github = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return github ? github[1]! : url;
};

/** `/Users/you/git/serra` → `~/git/serra`, given the home folder. */
export const tildePath = (path: string, home: string | null): string =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/** The home folder from a path under `/Users/<name>`, the only place a profile lives on a Mac. */
export const homeOf = (path: string | null): string | null => (path ? /^\/Users\/[^/]+/.exec(path)?.[0] ?? null : null);

/** Where developer mode builds from: `acme/serra main, in ~/git/serra`. */
export const sourceLabel = (status: Pick<ReleaseOverview, 'ref' | 'source' | 'upstream'>, home: string | null = null): string => {
  const where = tildePath(status.source, home);
  return status.upstream && status.ref ? `${repositoryName(status.upstream)} ${branch(status.ref)}, in ${where}` : where;
};

export interface ActionState { enabled: boolean; reason?: string }
type DeveloperAction = 'prepare' | 'activate' | 'rollback';

const BUSY: Record<UpdateAction, string> = { prepare: 'Building…', activate: 'Restarting the bot…', rollback: 'Undoing…', sync: 'Updating the bot…' };

/** Whether each developer-mode button can run now, and why not (shown as its tooltip). One action runs at a time. */
export const actionStates = (status: Pick<ReleaseOverview, 'activateProblems' | 'canRollback'> & { running: UpdateAction | null }): Record<DeveloperAction, ActionState> => {
  if (status.running) {
    const reason = `${BUSY[status.running]} Wait for it to finish.`;
    return { prepare: { enabled: false, reason }, activate: { enabled: false, reason }, rollback: { enabled: false, reason } };
  }
  const blocked = status.activateProblems[0];
  return {
    prepare: { enabled: true },
    activate: blocked ? { enabled: false, reason: blocked } : { enabled: true },
    rollback: status.canRollback ? { enabled: true } : { enabled: false, reason: 'Nothing to undo: there is no earlier bot to go back to.' },
  };
};

export const busyLabel = (action: UpdateAction): string => BUSY[action];

/** The text of the Restart bot on it dialog, for 0, 1 or N running jobs. */
export const activateDialog = (prepared: Labelled | null, runningJobs: number): { title: string; body: string } => ({
  title: `Restart the bot on ${releaseLabel(prepared)}?`,
  body: runningJobs === 0
    ? 'No jobs are running. The bot restarts on this build.'
    : runningJobs === 1
      ? '1 job is running. The bot restarts on this build; the job continues after the restart.'
      : `${runningJobs} jobs are running. The bot restarts on this build; the jobs continue after the restart.`,
});

/** The text of the Undo last switch dialog. It restarts the bot too, so it names the running jobs the same way. */
export const rollbackDialog = (runningJobs: number): { title: string; body: string } => ({
  title: 'Go back to the previous bot?',
  body: runningJobs === 0
    ? 'No jobs are running. The bot restarts on the build it ran before the last switch.'
    : `${plural(runningJobs, 'job is', 'jobs are')} running. The bot restarts on the build it ran before the last switch; ${runningJobs === 1 ? 'the job continues' : 'the jobs continue'} after the restart.`,
});

export interface Notice {
  tone: 'success' | 'error';
  message: string;
  /** Offer Undo next to the message: the switch failed and the automatic restore didn't finish. */
  offerRollback: boolean;
}

/** The label of the release at `path`, using `active`'s commit when it is that release. */
const labelOf = (path: string, active: Labelled | null): string => releaseLabel(active?.release === path ? active : { release: path });

/** What to tell the owner after Restart bot on it. `active` is the status reread afterwards, for the release's commit. */
export const activationNotice = (outcome: ActivationOutcome, active: Labelled | null = null): Notice => {
  if (outcome.ok) return { tone: 'success', message: `The bot runs ${labelOf(outcome.release, active)} now.`, offerRollback: false };
  if (outcome.stage === 'checks') return { tone: 'error', message: `The bot wasn't restarted; nothing changed. ${outcome.error}`, offerRollback: false };
  if (outcome.restored) return { tone: 'error', message: `The new build didn't start, so the previous one is running again. ${outcome.error}`, offerRollback: false };
  return {
    tone: 'error',
    message: `The new build didn't start and the previous one couldn't be restored automatically. Fix the cause, then undo the switch. ${outcome.error}`,
    offerRollback: outcome.rollbackAvailable,
  };
};

/** What to tell the owner after Undo. `active` is the status reread afterwards, for the release's commit. */
export const rollbackNotice = (outcome: RollbackOutcome, active: Labelled | null = null): Notice => outcome.ok
  ? { tone: 'success', message: outcome.release ? `The bot runs ${labelOf(outcome.release, active)} again.` : 'Undone. No bot is installed now.', offerRollback: false }
  : { tone: 'error', message: `Couldn't undo the switch. ${outcome.error}`, offerRollback: false };
