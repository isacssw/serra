import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { codeRoot, loadConfig } from './config.ts';
import { assertHealthy } from './doctor.ts';
import {
  isArrayOf, isBoolean, isNonEmptyString, isOneOf, isOptional, isRecord, isString, readJsonFile, readJsonOrNull,
} from './lib/guards.ts';
import { acquireLock, processAlive } from './lock.ts';
import { run } from './t3.ts';

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
const copyPrivate = (from: string, to: string): void => { copyFileSync(from, to); chmodSync(to, 0o600); };
const files = (root: string, prefix = ''): string[] => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
  const name = join(prefix, entry.name);
  return entry.isDirectory() ? files(root, name) : [name];
}).sort();
const digest = (root: string, names: string[]): string => {
  const hash = createHash('sha256');
  for (const name of names) { hash.update(name); hash.update('\0'); hash.update(readFileSync(join(root, name))); hash.update('\0'); }
  return hash.digest('hex');
};

export const xmlEscape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const shellQuote = (value: string): string => `'${value.split("'").join("'\"'\"'")}'`;

/**
 * The Node binary that runs the daemon and the release scripts. Inside the Electron app `process.execPath` is
 * Electron, so callers there must pass the real Node path (see `findNode` in releases.ts) instead of relying on this.
 */
export const defaultNode = (): string => {
  if (process.versions.electron) throw new Error('Running inside Electron: pass the Node binary path explicitly so launchd does not run the bot with Electron.');
  return process.execPath;
};

/** One progress line for the owner, streamed by prepare, activate and rollback. */
export type DeployLog = (line: string) => void;
const quiet: DeployLog = () => {};

/** Run a command and pass each output line to `log` as it arrives. Rejects with the last lines on failure. */
const runLines = (cmd: string, args: string[], log: DeployLog, timeoutMs: number, env?: NodeJS.ProcessEnv, cwd?: string): Promise<void> => new Promise((done, fail) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) });
  const tail: string[] = [];
  const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
  const lines = (stream: NodeJS.ReadableStream): void => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n'); buffer = parts.pop()!;
      for (const line of parts) if (line.trim()) { log(line); tail.push(line); if (tail.length > 5) tail.shift(); }
    });
    stream.on('end', () => { if (buffer.trim()) { log(buffer); tail.push(buffer); } });
  };
  lines(child.stdout!); lines(child.stderr!);
  child.once('error', (error) => { clearTimeout(timer); fail(error); });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (code === 0) done();
    else fail(new Error(`${cmd} ${args.slice(0, 2).join(' ')} exited ${code}: ${tail.join('\n')}`));
  });
});

const isExecutable = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};

/**
 * How to run pnpm for a release: `pnpm` when it is on PATH, otherwise through Corepack. Node 22 and 24 ship
 * `corepack` next to `node`, but there is no `pnpm` command until someone runs `corepack enable`, so an nvm or
 * official Node install would fail with `spawn pnpm ENOENT`. The release's package.json pins pnpm's version.
 */
export const pnpmCommand = (path = process.env.PATH ?? ''): { cmd: string; args: string[] } => {
  const onPath = (name: string): boolean => path.split(delimiter).some((dir) => dir !== '' && isExecutable(join(dir, name)));
  if (onPath('pnpm')) return { cmd: 'pnpm', args: [] };
  if (onPath('corepack')) return { cmd: 'corepack', args: ['pnpm'] };
  throw new Error("Can't install the release's dependencies: neither pnpm nor corepack is on PATH. Install pnpm 10, or run corepack enable for the Node the bot uses.");
};

/** The checked-out commit of the code being released, or nothing when `root` isn't a git checkout (a packaged app). */
const codeCommit = async (root: string): Promise<{ commit?: string; dirty?: boolean }> => {
  try {
    const commit = (await run('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })).trim();
    const changes = (await run('git', ['-C', root, 'status', '--porcelain', '--', ...releasedPaths], { timeoutMs: 10_000 })).trim();
    return { commit, dirty: changes.length > 0 };
  } catch { return {}; }
};
/**
 * What a packaged app's `release-source` says about the code it was built from: `release.json`, written by
 * `pnpm app:build` with the version and commit, since the copy itself has no git. Empty for a checkout.
 */
export const RELEASE_INFO = 'release.json';
const shippedBuild = (root: string): { appVersion?: string; commit?: string; fromApp?: boolean } => {
  const read = (name: string): Record<string, unknown> => readJsonOrNull(join(root, name), isRecord) ?? {};
  const info = read(RELEASE_INFO);
  const version = typeof info.version === 'string' ? info.version : read('package.json').version;
  return {
    ...(typeof version === 'string' ? { appVersion: version } : {}),
    ...(existsSync(join(root, RELEASE_INFO)) ? { fromApp: true } : {}),
    ...(typeof info.commit === 'string' && /^[0-9a-f]{40}$/.test(info.commit) ? { commit: info.commit } : {}),
  };
};
/** The branch Updates follows in the profile's update source when `updates.ref` isn't set. */
export const DEFAULT_UPDATES_REF = 'origin/main';

/** Prepare copies the checkout as it is; say so when that isn't the branch Updates follows. */
const warnIfBehind = async (root: string, commit: string, ref: string, log: DeployLog): Promise<void> => {
  try {
    const target = (await run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeoutMs: 10_000 })).trim();
    if (target && target !== commit) log(`Note: ${root} is at ${commit.slice(0, 12)}, not ${ref} (${target.slice(0, 12)}). Run git pull there to release ${ref}.`);
  } catch { /* no such ref: status reports it */ }
};
export const releasedPaths = ['src', 'templates', 'docs', 'examples', 'README.md', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', RELEASE_INFO];
/** What the daemon can't run without. The rest of `releasedPaths` is copied when it is there. */
const requiredPaths = ['src', 'templates', 'examples', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json'];

/**
 * Where the packaged app keeps the code a release is made from: `Serra.app/Contents/Resources/release-source`, beside
 * the app folder (staged by `stageReleaseSource` in `pnpm app:build`, copied by electron-builder.yml's `extraResources`). The app folder itself only has the bundle and a
 * package.json stripped of devDependencies, which `pnpm install --frozen-lockfile` would refuse, so the release gets
 * its own pristine copy.
 */
export const PACKAGED_SOURCE = 'release-source';

/**
 * The folder prepare copies the release from: `root` itself in a checkout, else the copy a packaged app ships in
 * `PACKAGED_SOURCE` beside `root` (the app folder). Throws, naming what is missing, when neither has the code.
 */
/** Copies what a release needs from the checkout `from` into `to`, for the packaged app. */
export const stageReleaseSource = (from: string, to: string): void => {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of releasedPaths) {
    if (!existsSync(join(from, name))) continue;
    // docs/app is screenshots: megabytes the daemon never reads.
    cpSync(join(from, name), join(to, name), { recursive: true, filter: (path) => relative(join(from, 'docs/app'), path).startsWith('..') });
  }
};

export const releaseSourceRoot = (root: string = codeRoot): string => {
  const complete = (folder: string): boolean => requiredPaths.every((name) => existsSync(join(folder, name)));
  if (complete(root)) return root;
  const shipped = join(dirname(root), PACKAGED_SOURCE);
  if (complete(shipped)) return shipped;
  const missing = requiredPaths.filter((name) => !existsSync(join(existsSync(shipped) ? shipped : root, name)));
  throw new Error(`Can't prepare a release: the Serra code isn't in ${root} or ${shipped} (missing ${missing.join(', ')}). Rebuild the app with pnpm app:package, or prepare from a checkout with pnpm bot prepare.`);
};

export const servicePlist = ({ directory, release, label, node = defaultNode() }: { directory: string; release: string; label: string; node?: string }): string => {
  const s = (value: string): string => `<string>${xmlEscape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${s(label)}
<key>WorkingDirectory</key>${s(release)}
<key>ProgramArguments</key><array>${[node, join(release, 'src/index.ts'), '--profile', directory].map(s).join('')}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key>${s(homedir())}<key>PATH</key>${s(`${dirname(node)}:${process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}`)}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>75</integer>
<key>StandardOutPath</key>${s(join(directory, 'logs/bot.log'))}
<key>StandardErrorPath</key>${s(join(directory, 'logs/bot.log'))}
</dict></plist>\n`;
};

export interface Prepared {
  version: 1;
  release: string;
  releaseHash: string;
  releaseFiles: string[];
  label: string;
  node: string;
  /** When `prepare` made the release, ISO time. Absent on releases made before it was recorded. */
  preparedAt?: string;
  /** The code commit the release was copied from. Absent when the code wasn't a git checkout. */
  commit?: string;
  /** The checkout had uncommitted changes in the copied files, so the release is not exactly `commit`. */
  dirty?: boolean;
  /** The Serra version of the code (its package.json), like `0.1.0-alpha.2`. Absent on releases made before it was recorded. */
  appVersion?: string;
  /** Made from the code a packaged app ships (`release-source`), not from a checkout. The bot follows the app only with these. */
  fromApp?: boolean;
}
interface Activation {
  version: 1;
  phase: 'switching' | 'active' | 'rolled-back';
  backup: string;
  plist: string;
  hadPlist: boolean;
  wasLoaded: boolean;
  profileIsAuthoritative: boolean;
  prepared: Prepared;
  previousActive?: Prepared;
}

/** A `prepared.json` or `active.json` with every field the release code reads. Older files without the optional ones pass. */
export const isPrepared = (value: unknown): value is Prepared =>
  isRecord(value) && value.version === 1 && isNonEmptyString(value.release) && isString(value.releaseHash)
  && isArrayOf(isString)(value.releaseFiles) && isString(value.label) && isString(value.node)
  && isOptional(isString)(value.preparedAt) && isOptional(isString)(value.commit) && isOptional(isBoolean)(value.dirty)
  && isOptional(isString)(value.appVersion) && isOptional(isBoolean)(value.fromApp);

const isActivation = (value: unknown): value is Activation =>
  isRecord(value) && value.version === 1 && isOneOf('switching', 'active', 'rolled-back')(value.phase)
  && isString(value.backup) && isString(value.plist) && isBoolean(value.hadPlist) && isBoolean(value.wasLoaded)
  && isBoolean(value.profileIsAuthoritative) && isPrepared(value.prepared) && isOptional(isPrepared)(value.previousActive);

const isReady = (value: unknown): value is { pid: number } => isRecord(value) && Number.isSafeInteger(value.pid);

/** The release record at `path` (`prepared.json` or `active.json`), or null when it is missing or isn't one. */
export const readPrepared = (path: string): Prepared | null => readJsonOrNull(path, isPrepared);

const ACTIVATION_UNREADABLE = "activation.json can't be read, so it isn't known whether a cutover was interrupted. Check the bot and restore activation.json from backups/ before activating or rolling back.";

export interface PrepareOptions {
  root?: string;
  install?: boolean;
  /** Node binary for the service and the helper scripts. Required inside Electron. */
  node?: string;
  log?: DeployLog;
}

/** Snapshot code and install its dependencies without touching launchd or the live checkout. */
export const prepareRelease = async (directory: string, { root, install = true, node, log = quiet }: PrepareOptions = {}): Promise<Prepared> => {
  directory = resolve(directory);
  node ??= defaultNode();
  const config = loadConfig({ profileDir: directory, env: {} });
  // The profile's update source (a checkout of the Serra repository) wins over the code this runs from.
  const updates = config.profile.updates;
  root = releaseSourceRoot(root ?? updates?.source ?? codeRoot);
  log(`Taking the code from ${root}`);
  const preparedAt = new Date().toISOString();
  const id = preparedAt.replace(/[:.]/g, '-') + `-${process.pid}`;
  const release = join(directory, 'releases', id);
  log(`Copying code into ${release}`);
  mkdirSync(release, { recursive: true, mode: 0o700 });
  // Marks the build as in progress until prepared.json names it, so pruning in another process leaves it alone.
  const building = `${release}${BUILDING}`;
  writeFileSync(building, String(process.pid));
  let prepared: Prepared;
  try {
    for (const name of releasedPaths) {
      // The packaged copy leaves out docs/app (screenshots) and nothing the daemon reads.
      if (!existsSync(join(root, name))) continue;
      cpSync(join(root, name), join(release, name), { recursive: true });
    }
    const source = { ...shippedBuild(root), ...await codeCommit(root) };
    if (source.commit) log(`Code at ${source.commit.slice(0, 12)}${source.dirty ? ' with uncommitted changes' : ''}`);
    if (source.commit && updates) await warnIfBehind(root, source.commit, updates.ref ?? DEFAULT_UPDATES_REF, log);
    writeFileSync(join(release, 'service.plist'), servicePlist({ directory, release, label: config.serviceLabel, node }), { mode: 0o600 });
    const releaseFiles = files(release);
    const releaseHash = digest(release, releaseFiles);
    if (install) {
      log('Installing production dependencies');
      // The release's Node folder is added after PATH: opened from Finder, the app's PATH has no Node, and an nvm or
      // official install keeps pnpm or corepack (a `#!/usr/bin/env node` script) only next to `node`.
      const path = [process.env.PATH, dirname(node)].filter(Boolean).join(delimiter);
      const pnpm = pnpmCommand(path);
      // Corepack would otherwise stop to ask before fetching the pinned pnpm, with no terminal to answer it.
      const env = { ...process.env, PATH: path, ...(pnpm.cmd === 'corepack' ? { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } : {}) };
      // Run from the release: Corepack picks pnpm's version from the package.json in the working directory, not from
      // `--dir`, and the app's working directory is `/`, where it would fetch the newest pnpm, which refuses the pin.
      await runLines(pnpm.cmd, [...pnpm.args, '--dir', release, 'install', '--prod', '--frozen-lockfile', '--ignore-scripts'], log, 60_000, env, release);
    }
    mkdirSync(join(directory, 'logs'), { recursive: true, mode: 0o700 });
    prepared = { version: 1, release, releaseHash, releaseFiles, node, label: config.serviceLabel, preparedAt, ...source };
    writeJson(join(directory, 'prepared.json'), prepared);
  } finally { rmSync(building, { force: true }); }
  for (const action of ['activate', 'rollback', 'status']) {
    writeFileSync(join(directory, `${action}.sh`), `#!/usr/bin/env bash\nset -euo pipefail\nexec ${shellQuote(node)} ${shellQuote(join(release, 'src/manage.ts'))} ${action} --profile ${shellQuote(directory)} "$@"\n`, { mode: 0o700 });
  }
  writeFileSync(join(directory, 'doctor.sh'), `#!/usr/bin/env bash\nset -euo pipefail\nexec ${shellQuote(node)} ${shellQuote(join(release, 'src/doctor.ts'))} --profile ${shellQuote(directory)} "$@"\n`, { mode: 0o700 });
  log(`Prepared ${release}. The live service is unchanged.`);
  return prepared;
};

export interface ServiceDriver {
  loaded(label: string): Promise<boolean>;
  stop(label: string): Promise<void>;
  start(plist: string): Promise<void>;
  ready(directory: string): Promise<void>;
}
const domain = (): string => `gui/${process.getuid!()}`;
const missingService = (error: unknown): boolean => /Could not find service|No such process|Could not find specified service/i.test(String(error));
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The last error the daemon logged while it was starting, so a failed start says why. Older lines are ignored. */
export const startupError = (logPath: string, since: number): string | undefined => {
  try {
    if (statSync(logPath).mtimeMs < since) return undefined;
    const line = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-50).findLast((l) => l.includes('[ERROR]'));
    const at = line ? Date.parse(line.slice(0, line.indexOf(' '))) : NaN;
    return line && !(at < since - 1000) ? line.replace(/^\S+ \[ERROR\] (?:\S+ )?/, '') : undefined;
  } catch { return undefined; }
};

export const launchd: ServiceDriver = {
  async loaded(label) {
    try { await run('launchctl', ['print', `${domain()}/${label}`]); return true; }
    catch (error) { if (missingService(error)) return false; throw error; }
  },
  async stop(label) {
    let info: string;
    try { info = await run('launchctl', ['print', `${domain()}/${label}`]); }
    catch (error) { if (missingService(error)) return; throw error; }
    const pid = Number(/^\s*pid = (\d+)/m.exec(info)?.[1] ?? 0);
    await run('launchctl', ['bootout', `${domain()}/${label}`], { timeoutMs: 90_000 });
    const deadline = Date.now() + 10_000;
    while (pid && processAlive(pid)) {
      if (Date.now() > deadline) throw new Error(`Old PID ${pid} has not stopped. Refusing to start another bot.`);
      await delay(100);
    }
  },
  async start(plist) { await run('launchctl', ['bootstrap', domain(), plist]); },
  async ready(directory) {
    const started = Date.now();
    const deadline = started + 25_000;
    do {
      // A marker that doesn't read yet may still be being written by the daemon.
      const ready = readJsonOrNull(join(directory, 'ready.json'), isReady);
      if (ready && processAlive(ready.pid)) return;
      await delay(250);
    } while (Date.now() < deadline);
    const reason = startupError(join(directory, 'logs/bot.log'), started);
    throw new Error(`Bot did not become ready${reason ? `: ${reason}` : ''}. Check ${join(directory, 'logs/bot.log')}`);
  },
};

export interface DeployOptions {
  driver?: ServiceDriver;
  launchAgentsDir?: string;
  preflight?: (directory: string) => Promise<void>;
  /**
   * The last check before the bot is stopped, after the health checks. Throwing refuses the activation with nothing
   * changed (the bot following the app uses it to recheck that no job started meanwhile).
   */
  beforeStop?: () => void | Promise<void>;
  /** Checks the plan read under the deployment lock (the bot following the app: is it the app's build?). Throwing refuses. */
  expect?: (plan: Prepared) => void;
  log?: DeployLog;
}
const defaults = (options: DeployOptions) => ({
  log: options.log ?? quiet,
  driver: options.driver ?? launchd,
  launchAgentsDir: options.launchAgentsDir ?? join(homedir(), 'Library/LaunchAgents'),
  preflight: options.preflight ?? (async (directory: string) => { await assertHealthy(loadConfig({ profileDir: directory, env: {} })); }),
});

/**
 * Why the prepared release can't be activated, in the order `activate` checks them. Empty when it can.
 * Reads files only: no launchd, no network, no health checks.
 */
export const preparedProblems = (directory: string): string[] => {
  directory = resolve(directory);
  const transaction = readJsonFile(join(directory, 'activation.json'), isActivation);
  if (transaction.state === 'invalid') return [ACTIVATION_UNREADABLE];
  if (transaction.state === 'ok' && transaction.value.phase === 'switching') return ['An interrupted cutover needs rollback first. Run the rollback command.'];
  const prepared = readJsonFile(join(directory, 'prepared.json'), isPrepared);
  if (prepared.state === 'absent') return ['No prepared release. Run prepare first.'];
  if (prepared.state === 'invalid') return ["prepared.json can't be read. Run prepare again."];
  const plan = prepared.value;
  if (loadConfig({ profileDir: directory, env: {} }).serviceLabel !== plan.label) return ['The service label changed. Prepare a new release before activation.'];
  if (!existsSync(plan.release) || digest(plan.release, plan.releaseFiles) !== plan.releaseHash) return ['Prepared release changed. Prepare a new release before activation.'];
  if (!existsSync(join(plan.release, 'node_modules/@slack/bolt'))) return ['Prepared dependencies missing. Run prepare again.'];
  if (readPrepared(join(directory, 'active.json'))?.release === plan.release) return ['This release is already active'];
  return [];
};

/** Where the last cutover stands, from `activation.json`: none yet, interrupted, done, or undone. */
export const activationPhase = (directory: string): Activation['phase'] | null => {
  return readJsonOrNull(join(resolve(directory), 'activation.json'), isActivation)?.phase ?? null;
};

/**
 * Whether rollback has something to do: an interrupted cutover, or an activation with an earlier release to go back
 * to. Undoing the first activation would leave no bot running, so it doesn't count.
 */
export const canRollBack = (directory: string): boolean => {
  const transaction = readJsonOrNull(join(resolve(directory), 'activation.json'), isActivation);
  if (!transaction) return false;
  return transaction.phase === 'switching' || (transaction.phase === 'active' && transaction.previousActive !== undefined);
};

/**
 * A failed cutover. `restored` says whether the previous installation is back. When it isn't, the owner has to run
 * rollback once the cause is fixed.
 */
export class CutoverError extends Error {
  readonly restored: boolean;
  constructor(message: string, restored: boolean) { super(message); this.name = 'CutoverError'; this.restored = restored; }
}

/** This is the only upgrade operation that stops the bot. All downloads and checks happen first. */
export const activate = async (directory: string, options: DeployOptions = {}): Promise<void> => {
  directory = resolve(directory);
  const { driver, launchAgentsDir, preflight, log } = defaults(options);
  const unlock = acquireLock(join(directory, 'deployment.lock'));
  try {
    log('Checking the prepared release');
    const problem = preparedProblems(directory)[0];
    if (problem) throw new Error(problem);
    const plan = readPrepared(join(directory, 'prepared.json'));
    if (!plan) throw new Error("prepared.json can't be read. Run prepare again.");
    options.expect?.(plan);
    const activePath = join(directory, 'active.json');
    // An active.json that can't be read counts as none: the check below then refuses to take over the existing service.
    const previousActive = readPrepared(activePath) ?? undefined;
    log('Running health checks');
    await preflight(directory);
    mkdirSync(launchAgentsDir, { recursive: true });
    const plist = join(launchAgentsDir, `${plan.label}.plist`);
    const hadPlist = existsSync(plist);
    const wasLoaded = await driver.loaded(plan.label);
    // A fresh installation must never take over another profile's existing service.
    if ((hadPlist || wasLoaded) && !previousActive) throw new Error(`Service ${plan.label} already exists. Choose another bot ID.`);
    await options.beforeStop?.();
    const backup = join(directory, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    if (hadPlist) copyPrivate(plist, join(backup, 'service.plist'));
    for (const name of ['profile.json', '.env', 'brief.md']) copyPrivate(join(directory, name), join(backup, name));
    if (existsSync(activePath)) copyPrivate(activePath, join(backup, 'active.json'));
    const transaction: Activation = { version: 1, phase: 'switching', backup, plist, hadPlist, wasLoaded, profileIsAuthoritative: false, prepared: plan, previousActive };
    writeJson(join(directory, 'activation.json'), transaction);
    try {
      log(`Stopping ${plan.label}. The bot hands waiting messages to their workers before it exits.`);
      await driver.stop(plan.label);
      transaction.profileIsAuthoritative = true;
      writeJson(join(directory, 'activation.json'), transaction);
      rmSync(join(directory, 'ready.json'), { force: true });
      copyPrivate(join(plan.release, 'service.plist'), plist);
      log(`Starting ${plan.release}`);
      await driver.start(plist);
      log('Waiting for the bot to connect');
      await driver.ready(directory);
      writeJson(activePath, plan);
      transaction.phase = 'active';
      writeJson(join(directory, 'activation.json'), transaction);
      log('Bot connected. The new release is active.');
      try {
        const removed = pruneReleases(directory);
        if (removed.length) log(`Removed ${removed.length} old ${removed.length === 1 ? 'release' : 'releases'}`);
      } catch (error) { log(`Couldn't remove old releases: ${String(error)}`); }
    } catch (error) {
      log(`Cutover failed: ${String(error)}`);
      log('Restoring the previous installation');
      try { await restore(directory, transaction, driver, log); }
      catch (rollbackError) {
        log(`Automatic rollback failed: ${String(rollbackError)}`);
        throw new CutoverError(`Cutover failed: ${String(error)}. Automatic rollback also failed: ${String(rollbackError)}. Run rollback after resolving the error.`, false);
      }
      throw new CutoverError(`Cutover failed; previous installation restored. ${String(error)}`, true);
    }
  } finally { unlock(); }
};

const restore = async (directory: string, transaction: Activation, driver: ServiceDriver, log: DeployLog): Promise<void> => {
  log(`Stopping ${transaction.prepared.label}`);
  await driver.stop(transaction.prepared.label);
  if (transaction.hadPlist) copyPrivate(join(transaction.backup, 'service.plist'), transaction.plist);
  else rmSync(transaction.plist, { force: true });
  const activePath = join(directory, 'active.json');
  if (transaction.previousActive) writeJson(activePath, transaction.previousActive);
  else rmSync(activePath, { force: true });
  rmSync(join(directory, 'ready.json'), { force: true });
  if (transaction.wasLoaded) { log(`Starting the previous installation${transaction.previousActive ? ` ${transaction.previousActive.release}` : ''}`); await driver.start(transaction.plist); }
  transaction.phase = 'rolled-back';
  writeJson(join(directory, 'activation.json'), transaction);
  log('Previous installation restored.');
};

/** Beside a release folder while prepare is still building it: `<id>.building`, holding prepare's PID. */
const BUILDING = '.building';

/** The `releases/` folder names prepare makes: `2026-11-21T16-08-23-951Z-85116`. */
const RELEASE_ID = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-\d+$/;

/**
 * Removes old release folders, keeping the active one, the one before it (what rollback switches back to) and a
 * prepared one that isn't active yet. Only folders named like a release under `<profile>/releases/` are touched.
 * Returns the folders removed.
 */
export const pruneReleases = (directory: string): string[] => {
  directory = resolve(directory);
  const root = join(directory, 'releases');
  if (!existsSync(root)) return [];
  const keep = new Set<string>();
  const remember = (release: Prepared | undefined | null): void => { if (release?.release) keep.add(resolve(release.release)); };
  const read = (name: string): Prepared | null => readPrepared(join(directory, name));
  remember(read('active.json'));
  remember(read('prepared.json'));
  const transaction = readJsonFile(join(directory, 'activation.json'), isActivation);
  // Without a readable transaction, the releases it names aren't known, so nothing is removed.
  if (transaction.state === 'invalid') return [];
  if (transaction.state === 'ok') {
    remember(transaction.value.prepared);
    remember(transaction.value.previousActive);
  }
  // A folder made after the active release may be a build still in progress (a prepare running in another process
  // writes prepared.json only when it finishes), so only older ones go. Without a readable active.json, none go.
  const activeId = read('active.json')?.release.split('/').pop() ?? '';
  const removed: string[] = [];
  // Markers left by a prepare that crashed (its process is gone) are swept.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(BUILDING)) continue;
    const marker = join(root, entry.name);
    try { if (!processAlive(Number(readFileSync(marker, 'utf8')))) rmSync(marker, { force: true }); } catch { /* gone already */ }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (!entry.isDirectory() || !RELEASE_ID.test(entry.name) || keep.has(path) || entry.name > activeId) continue;
    // A build still in progress (its prepare's process is alive) stays.
    try { if (processAlive(Number(readFileSync(`${path}${BUILDING}`, 'utf8')))) continue; } catch { /* no marker */ }
    // Prepare names its build in prepared.json before removing its marker, so a fresh read catches one just finished.
    if (read('prepared.json')?.release === path) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
};

export const rollback = async (directory: string, options: DeployOptions = {}): Promise<void> => {
  directory = resolve(directory);
  const unlock = acquireLock(join(directory, 'deployment.lock'));
  try {
    const file = readJsonFile(join(directory, 'activation.json'), isActivation);
    if (file.state === 'absent') throw new Error('Nothing to roll back: no release was activated for this profile');
    if (file.state === 'invalid') throw new Error(ACTIVATION_UNREADABLE);
    const transaction = file.value;
    if (transaction.phase === 'rolled-back') throw new Error('Already rolled back');
    // Undoing the first activation would stop the bot and remove its service, leaving nothing running.
    if (transaction.phase === 'active' && !transaction.previousActive) throw new Error('Nothing to roll back to: this is the first release installed for this profile');
    const { driver, log } = defaults(options);
    await restore(directory, transaction, driver, log);
  } finally { unlock(); }
};
