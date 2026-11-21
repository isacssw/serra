// Updates (APP-19, SERRA-46). Two parts:
// - the app: checking GitHub Releases, downloading, verifying and installing (`context.appUpdater`, app-updater.ts);
// - the bot, on APP-18's release service in src/releases.ts. In release mode it follows the app's version on its own
//   (bot-sync.ts), restarting only while no job runs. In developer mode (`updates.source` set) the owner builds and
//   switches releases by hand, as before.
// Bot actions run one at a time; their log lines go to the window and are kept so the screen shows them again after
// navigating away. Everything reads and writes the profile's files and launchd directly, so it works while the
// daemon is stopped.
import { delimiter, dirname } from 'node:path';
import {
  activateRelease, findNode, prepareNextRelease, releaseStatus, rollbackRelease, runningJobs,
  type StatusOptions,
} from '../../../src/releases.ts';
import { preparedProblems, type DeployOptions, type PrepareOptions } from '../../../src/deploy.ts';
import type { Handlers } from '../bridge.ts';
import { botSyncDecision, type BotSync } from '../bot-sync.ts';
import type { HandlerContext } from './context.ts';

export type UpdateAction = 'prepare' | 'activate' | 'rollback' | 'sync';

export interface UpdatesDeps {
  /** Finds the real Node binary for the release (APP-18's `findNode`). Tests pass a fake. */
  findNode?: (profileDir: string) => Promise<string>;
  /** Extra prepare options (tests: `root`, `install: false`). `node` and `log` are always set here. */
  prepare?: Omit<PrepareOptions, 'node' | 'log'>;
  /** Extra activate/rollback options (tests: a fake launchd driver). `log` is always set here. */
  deploy?: Omit<DeployOptions, 'log'>;
  /** Extra status options (tests: the code checkout to count commits in). */
  status?: Omit<StatusOptions, 'fetch'>;
  /** Where the log lines go besides the window (default: the main process's console). */
  echo?: (line: string) => void;
}

/** The most lines kept for the screen; `pnpm install` can be chatty. */
const MAX_LOG_LINES = 500;
/** How often the bot's version is compared with the app's, after a first look shortly after launch. */
const SYNC_EVERY_MS = 60_000;
const SYNC_FIRST_MS = 20_000;

/** Puts the Node binary's folder first on PATH, as the service plist does, so `pnpm` beside it is found from Finder. */
const nodeOnPath = (node: string): void => {
  const folder = dirname(node);
  const path = process.env.PATH ?? '';
  if (!path.split(delimiter).includes(folder)) process.env.PATH = path ? `${folder}${delimiter}${path}` : folder;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const updatesService = (context: HandlerContext, deps: UpdatesDeps = {}) => {
  const find = deps.findNode ?? ((profileDir: string) => findNode(profileDir));
  const echo = deps.echo ?? ((line: string) => console.log(`[serra] ${line}`));
  let running: UpdateAction | null = null;
  let log: string[] = [];
  /** The app version the last automatic bot update failed for; not retried until the owner asks or the app restarts. */
  let failed: { version: string; message: string } | null = null;

  const line = (text: string): void => {
    for (const part of text.split('\n')) {
      log.push(part);
      if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
      echo(part);
      context.push?.('releaseLog', part);
    }
  };

  /** Runs one action at a time: a second one while the first runs is refused before anything changes. */
  const exclusive = async <T>(action: UpdateAction, work: (profileDir: string) => Promise<T>): Promise<T> => {
    if (running) throw new Error(`${running === 'sync' ? 'The bot update' : `${running[0]!.toUpperCase()}${running.slice(1)}`} is still running. Wait for it to finish.`);
    const profileDir = context.profileDir();
    running = action;
    log = [];
    try { return await work(profileDir); }
    finally { running = null; }
  };

  const prepareWithNode = async (profileDir: string) => {
    line('Looking for Node');
    const node = await find(profileDir);
    line(`Using ${node}`);
    nodeOnPath(node);
    return prepareNextRelease(profileDir, { ...deps.prepare, node, log: line });
  };

  /** Where the bot stands against the app, and what the timer should do. Null without a profile. */
  const decide = (profileDir: string | null, status?: Awaited<ReturnType<typeof releaseStatus>>) => {
    if (!profileDir || !status) return null;
    let jobs = 0;
    try { jobs = runningJobs(profileDir).length; } catch { /* no state yet */ }
    let preparedReady = false;
    try { preparedReady = status.prepared !== null && preparedProblems(profileDir).length === 0; } catch { /* not ready */ }
    return botSyncDecision({
      mode: status.mode, appVersion: context.runtime.version, active: status.active, prepared: status.prepared, preparedReady,
      activation: status.activation, jobs, running, failed,
    });
  };

  /** Brings the bot to the app's version: prepare (unless done already), then activate if still no job is running. */
  const syncBot = (force: boolean) => exclusive('sync', async (profileDir) => {
    const target = context.runtime.version;
    try {
      const status = await releaseStatus(profileDir);
      const ready = status.prepared?.appVersion === target && preparedProblems(profileDir).length === 0;
      if (!ready) {
        line(`Updating the bot to ${target}`);
        await prepareWithNode(profileDir);
      }
      // Preparing can take a minute; a job may have started meanwhile. Then the activation waits for the next tick.
      if (!force && runningJobs(profileDir).length > 0) {
        line('A job started while preparing. The bot restarts when no job is running.');
        return { ok: true as const, waiting: true };
      }
      context.expectStop?.();
      const outcome = await activateRelease(profileDir, { ...deps.deploy, log: line });
      if (!outcome.ok) {
        failed = { version: target, message: outcome.error };
        line(`The bot couldn't start on ${target}: ${outcome.error}`);
        return { ok: false as const, error: outcome.error };
      }
      // The app's code and the app disagree on the version (a build mix-up): stop here rather than restart every minute.
      const now = (await releaseStatus(profileDir)).active?.appVersion;
      if (now !== target) {
        failed = { version: target, message: `The bot's code is version ${now ?? 'unknown'}, not ${target}. Reinstall Serra.` };
        line(failed.message);
        return { ok: false as const, error: failed.message };
      }
      failed = null;
      return { ok: true as const, waiting: false };
    } catch (error) {
      failed = { version: target, message: errorText(error) };
      line(`The bot update failed: ${errorText(error)}`);
      return { ok: false as const, error: errorText(error) };
    }
  });

  /** One look by the timer: starts the bot update when it is due. Never throws. */
  const tick = async (): Promise<void> => {
    const profileDir = context.profileDirOrNull();
    if (!profileDir || running) return;
    try {
      const decision = decide(profileDir, await releaseStatus(profileDir));
      if (decision && decision.action !== 'none') await syncBot(false);
    } catch (error) { echo(`bot update check failed: ${errorText(error)}`); }
  };
  context.every?.(SYNC_FIRST_MS, SYNC_EVERY_MS, () => { void tick(); });

  const app = () => {
    if (!context.appUpdater) throw new Error('App updates are not available here.');
    return context.appUpdater;
  };

  const handlers: Handlers<'updates'> = {
    status: async (options) => {
      const profileDir = context.profileDirOrNull();
      const releases = profileDir ? await releaseStatus(profileDir, { ...deps.status, fetch: options?.fetch === true }) : null;
      const bot: BotSync = decide(profileDir, releases ?? undefined)?.sync ?? { state: 'not-installed' };
      return {
        appVersion: context.runtime.version,
        app: context.appUpdater?.view() ?? null,
        releases,
        bot,
        running,
        log: [...log],
      };
    },
    runningJobs: () => runningJobs(context.profileDir()),
    // Inside Electron `process.execPath` is Electron, so the release always gets the Node `findNode` resolved.
    prepare: () => exclusive('prepare', async (profileDir) => {
      try { return await prepareWithNode(profileDir); }
      catch (error) { line(`Prepare failed: ${errorText(error)}`); throw error; }
    }),
    activate: () => exclusive('activate', async (profileDir) => {
      const outcome = await activateRelease(profileDir, { ...deps.deploy, log: line });
      if (!outcome.ok && outcome.stage === 'checks') line(`Activation refused: ${outcome.error}`);
      return outcome;
    }),
    rollback: () => exclusive('rollback', async (profileDir) => {
      const outcome = await rollbackRelease(profileDir, { ...deps.deploy, log: line });
      if (!outcome.ok) line(`Rollback failed: ${outcome.error}`);
      return outcome;
    }),
    // The owner asked: update now even with jobs running (the confirm dialog names them), and retry after a failure.
    syncBot: () => { failed = null; return syncBot(true); },
    check: () => app().check(),
    download: () => app().download(),
    cancelDownload: () => app().cancel(),
    install: () => app().install(),
    openInstaller: () => app().openInstaller(),
    setPrereleases: (choice) => {
      if (choice !== null && typeof choice !== 'boolean') throw new Error('Pre-releases must be on, off or the default.');
      return app().setPrereleases(choice);
    },
  };
  return { handlers, tick };
};

export const updatesHandlers = (context: HandlerContext, deps: UpdatesDeps = {}): Handlers<'updates'> => updatesService(context, deps).handlers;
