// Updating a server's Serra (SB-34, design §4.7): the Mac asks for the version it runs itself, so the two stay
// compatible. The server checks out that release's tag in its own checkout, installs its dependencies, restarts its
// gateway and checks it answers with the new version. If any of that fails it goes back to the commit it was on, by
// itself, and says so. Bots keep running their own release snapshot (`releases/`), so they don't pause; each moves
// to the new code through its own update, which has its own rollback.
//
// `gateway/update.json` records the update as it goes, the commit to go back to included, so a server that restarts
// part way knows where it was. The updater runs outside the gateway (a transient systemd unit), because restarting
// the gateway would otherwise stop it. It never publishes, tags or pushes anything: it only reads tags from origin.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, parseVersion } from '../app-updates.ts';
import { pnpmCommand } from '../deploy.ts';
import { writeFileAtomic } from '../lib/atomic.ts';
import { isOneOf, isRecord, isString, readJsonOrNull, type Guard } from '../lib/guards.ts';

type UpdateStateName = 'updating' | 'done' | 'rolled-back' | 'failed';

export interface UpdateState {
  state: UpdateStateName;
  /** The commit it was on: where a failed update goes back to. */
  from: string;
  /** The version asked for, as `0.1.0-alpha.10`. */
  to: string;
  at: string;
  /** What went wrong, in a few words. */
  message: string | null;
}

const isUpdateState: Guard<UpdateState> = (value): value is UpdateState =>
  isRecord(value) && isOneOf('updating', 'done', 'rolled-back', 'failed')(value.state) && isString(value.from) && isString(value.to)
  && isString(value.at) && (value.message === null || isString(value.message));

const statePath = (root: string): string => join(root, 'gateway', 'update.json');

export const readUpdateState = (root: string): UpdateState | null => readJsonOrNull(statePath(root), isUpdateState);

const writeState = (root: string, state: UpdateState): void => writeFileAtomic(statePath(root), `${JSON.stringify(state, null, 2)}\n`);

/** Runs a command and returns its stdout. Rejects with a short message when it fails. */
type Exec = (cmd: string, args: string[], options?: { timeoutMs?: number }) => Promise<string>;

/** An update that started more than this long ago and never finished is treated as over. */
const STUCK_MS = 30 * 60_000;

/** A version as the owner asks for one: a release's version, never a branch or a path. */
const isReleaseVersion = (value: unknown): value is string => isString(value) && value.length <= 40 && parseVersion(value) !== null && !value.startsWith('v');

/** Why this server can't update to `version` now, or null when it can. */
export const updateProblem = ({ root, code, current, version, now = Date.now() }: {
  root: string; code: string; current: string; version: string; now?: number;
}): string | null => {
  if (!isReleaseVersion(version)) return 'That isn’t a Serra version.';
  if (!existsSync(join(code, '.git'))) return 'Serra on this server isn’t a git checkout. Update it from its terminal.';
  if (parseVersion(current) && compareVersions(version, current) <= 0) return 'This server already runs that version or a newer one.';
  const known = readUpdateState(root);
  if (known?.state === 'updating' && now - Date.parse(known.at) < STUCK_MS) return 'An update is already running.';
  return null;
};

export interface ServerUpdateOptions {
  root: string;
  /** Serra's checkout on the server. */
  code: string;
  /** The version to go to, as `0.1.0-alpha.10`; its tag is `v0.1.0-alpha.10`. */
  version: string;
  exec: Exec;
  /** Restarts the gateway (`systemctl --user restart dev.serra.gateway`). */
  restart(): Promise<void>;
  /** The version the restarted gateway says it runs, or null when it doesn't answer in time. */
  answers(): Promise<string | null>;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * The update itself, for `serra server update --to <version>`. Resolves with how it ended; never leaves the checkout
 * on a version that didn't start.
 */
export const runServerUpdate = async (options: ServerUpdateOptions): Promise<UpdateState> => {
  const { root, code, version, exec, log = () => {}, now = () => new Date() } = options;
  const git = (...args: string[]): Promise<string> => exec('git', ['-C', code, ...args], { timeoutMs: 120_000 });
  const tag = `v${version}`;
  const from = (await git('rev-parse', 'HEAD')).trim();
  let state: UpdateState = { state: 'updating', from, to: version, at: now().toISOString(), message: null };
  writeState(root, state);
  const end = (next: UpdateStateName, message: string | null): UpdateState => {
    state = { ...state, state: next, message, at: now().toISOString() };
    writeState(root, state);
    log(message ? `${next}: ${message}` : next);
    return state;
  };
  // Nothing changed yet: these end the update as it is.
  try {
    if ((await git('status', '--porcelain', '--untracked-files=no')).trim()) return end('failed', 'Serra’s folder has local changes, so it wasn’t updated.');
    log(`Fetching ${tag}`);
    await git('fetch', '--tags', 'origin');
    const local = (await git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`)).trim();
    // Only a tag origin has: never one made on this computer.
    const remote = (await git('ls-remote', 'origin', `refs/tags/${tag}^{}`, `refs/tags/${tag}`)).split('\n').map((line) => line.split('\t')[0]);
    if (!remote.includes(local)) return end('failed', `${tag} isn’t a release on origin.`);
  } catch (error) {
    return end('failed', `Couldn’t get ${tag}: ${short(error)}`);
  }
  const install = async (): Promise<void> => {
    const pnpm = pnpmCommand();
    await exec(pnpm.cmd, [...pnpm.args, '--dir', code, 'install', '--frozen-lockfile', '--prod'], { timeoutMs: 600_000 });
  };
  try {
    log(`Switching to ${tag}`);
    await git('-c', 'advice.detachedHead=false', 'checkout', '--detach', tag);
    log('Installing');
    await install();
    log('Restarting the gateway');
    await options.restart();
    const answered = await options.answers();
    if (answered !== version) throw new Error(answered ? `it answered as ${answered}` : 'it didn’t answer');
    return end('done', null);
  } catch (error) {
    const why = short(error);
    log(`Going back to ${from.slice(0, 7)}: ${why}`);
    try {
      await git('-c', 'advice.detachedHead=false', 'checkout', '--detach', from);
      await install();
      await options.restart();
      if (!(await options.answers())) throw new Error('the previous version didn’t answer either');
      return end('rolled-back', `The new version didn’t start (${why}), so it went back unchanged.`);
    } catch (again) {
      return end('failed', `The new version didn’t start (${why}), and going back failed too: ${short(again)}. Run serra server update on the server.`);
    }
  }
};

/** The first line of an error, without paths that say nothing to the owner. Never a token: none is involved here. */
const short = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
