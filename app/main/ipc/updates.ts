// Updates (APP-19, SERRA-46). Two parts:
// - the app: checking GitHub Releases, downloading, verifying and installing (`context.appUpdater`, app-updater.ts);
// - the bot, on APP-18's release service in src/releases.ts. In release mode it follows the app's version on its own
//   (bot-sync.ts), restarting only while no job runs. In developer mode (`updates.source` set) the owner builds and
//   switches releases by hand, as before.
// Bot actions run one at a time; their log lines go to the window and are kept so the screen shows them again after
// navigating away. Everything reads and writes the profile's files and launchd directly, so it works while the
// daemon is stopped.
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import {
  activateRelease, findNode, prepareNextRelease, releaseStatus, rollbackRelease, runningJobs,
  type StatusOptions,
} from '../../../src/releases.ts';
import { launchd, preparedProblems, type DeployOptions, type PrepareOptions } from '../../../src/deploy.ts';
import { pauseIntake, readAck, readPause, readPauseFile, resumeIntake } from '../../../src/intake.ts';
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
  /** The clock (tests). */
  now?: () => number;
}

/** The most lines kept for the screen; `pnpm install` can be chatty. */
const MAX_LOG_LINES = 500;
/** How often the bot's version is compared with the app's, after a first look shortly after launch. */
const SYNC_EVERY_MS = 60_000;
const SYNC_FIRST_MS = 20_000;
/** After a pause lapsed with jobs still running, new requests flow again for this long; the update waits for a quiet moment. */
const PAUSE_COOLDOWN_MS = 60 * 60_000;

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
  /** The app version the last automatic bot update failed for, per profile; not retried until the owner asks or the app restarts. */
  const failures = new Map<string, { version: string; message: string }>();
  /** The bot switch under way (activate, rollback or the bot update), which quitting the app must not cut short. */
  let cutover: Promise<unknown> | null = null;
  context.guardQuit?.(() => cutover);
  const driver = deps.deploy?.driver ?? launchd;
  /** Pauses this app started, per profile, and when one lapsed with jobs still running (no new pause for a while). */
  const ourPauses = new Set<string>();
  const lapsed = new Map<string, number>();
  const now = deps.now ?? (() => Date.now());

  const line = (text: string): void => {
    for (const part of text.split('\n')) {
      log.push(part);
      if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
      echo(part);
      context.push?.('releaseLog', part);
    }
  };

  /** Runs one action at a time: a second one while the first runs is refused before anything changes. */
  const exclusive = async <T>(action: UpdateAction, work: (profileDir: string) => Promise<T>, profile?: string): Promise<T> => {
    if (running) throw new Error(`${running === 'sync' ? 'The bot update' : `${running[0]!.toUpperCase()}${running.slice(1)}`} is still running. Wait for it to finish.`);
    const profileDir = profile ?? context.profileDir();
    running = action;
    log = [];
    const task = work(profileDir);
    if (action !== 'prepare') cutover = task;
    try { return await task; }
    finally { running = null; cutover = null; }
  };

  const prepareWithNode = async (profileDir: string) => {
    line('Looking for Node');
    const node = await find(profileDir);
    line(`Using ${node}`);
    nodeOnPath(node);
    return prepareNextRelease(profileDir, { ...deps.prepare, node, log: line });
  };

  /** Where the bot stands against the app, and what the timer should do. Null without a profile. */
  const decide = async (profileDir: string | null, status?: Awaited<ReturnType<typeof releaseStatus>>) => {
    if (!profileDir || !status) return null;
    const paused = readPause(profileDir, now()) !== null;
    // A pause that ran out while jobs still ran (this app's, or one left by the app before a restart): let requests flow
    // and wait for a natural quiet moment for a while.
    if (ourPauses.has(profileDir) && !paused) { ourPauses.delete(profileDir); lapsed.set(profileDir, now()); }
    const expired = !paused ? readPauseFile(profileDir) : null;
    if (expired) lapsed.set(profileDir, Math.max(lapsed.get(profileDir) ?? 0, Date.parse(expired.until)));
    const mayPause = now() - (lapsed.get(profileDir) ?? -Infinity) > PAUSE_COOLDOWN_MS;
    let serviceLoaded = false;
    try { serviceLoaded = status.active ? await driver.loaded(status.active.label) : false; } catch { /* launchd didn't answer: treat as stopped */ }
    let jobs = 0;
    try { jobs = runningJobs(profileDir).length; } catch { /* no state yet */ }
    let preparedReady = false;
    try { preparedReady = status.prepared !== null && preparedProblems(profileDir).length === 0; } catch { /* not ready */ }
    return botSyncDecision({
      mode: status.mode, follows: context.botFollowsApp === true, serviceLoaded, appVersion: context.runtime.version,
      active: status.active, prepared: status.prepared, preparedReady,
      activation: status.activation, jobs, running, failed: failures.get(profileDir) ?? null, paused, mayPause,
    });
  };

  const pause = (profileDir: string): void => {
    if (!readPause(profileDir, now())) line('New requests wait until the bot has restarted; running jobs finish first.');
    pauseIntake(profileDir, 'bot-update', { now: now() });
    ourPauses.add(profileDir);
  };
  const resume = (profileDir: string): void => {
    if (readPause(profileDir, now())) line('New requests start again.');
    resumeIntake(profileDir);
    ourPauses.delete(profileDir);
  };

  /** Brings the bot to the app's version: prepare (unless done already), then activate if still no job is running. */
  const syncBot = (force: boolean, profile?: string) => exclusive('sync', async (profileDir) => {
    const target = context.runtime.version;
    const fail = (message: string) => { failures.set(profileDir, { version: target, message }); };
    try {
      const status = await releaseStatus(profileDir);
      const ready = status.prepared?.appVersion === target && status.prepared.fromApp === true && preparedProblems(profileDir).length === 0;
      if (!ready) {
        line(`Updating the bot to ${target}`);
        await prepareWithNode(profileDir);
      }
      // Preparing can take a minute; a job may have started meanwhile. Then the activation waits for the next tick,
      // with new requests held so it finishes.
      if (!force && runningJobs(profileDir).length > 0) {
        line('A job started while preparing. New requests wait, and the bot restarts when the job finishes.');
        pause(profileDir);
        return { ok: true as const, waiting: true };
      }
      // No new job may start during the switch itself; held requests start on the new bot.
      pause(profileDir);
      const jobStarted = 'A job started. The bot restarts when no job is running.';
      const stopped = 'The bot was stopped meanwhile, so it stays stopped.';
      const label = (await releaseStatus(profileDir)).prepared?.label;
      const outcome = await activateRelease(profileDir, {
        ...deps.deploy, log: line,
        // The health checks take a few seconds: look again right before the bot stops.
        // Only the app's own build of this version is switched to, as read under the deployment lock.
        expect: (plan) => {
          if (plan.appVersion !== target || plan.fromApp !== true) throw new Error(`The build waiting to run is ${plan.appVersion ?? 'unknown'}, not Serra ${target}'s own. Try again.`);
        },
        beforeStop: async () => {
          // The owner may have stopped the bot while this was building: don't start it again on its own.
          if (!force && label && !await driver.loaded(label)) throw new Error(stopped);
          // Last, as close to the stop as possible: a job that started meanwhile holds the restart, and so does a request
          // the paused daemon let through before the pause and is still starting (it says so in its acknowledgment).
          if (!force && runningJobs(profileDir).length > 0) throw new Error(jobStarted);
          if (!force && (readAck(profileDir, now())?.starting ?? 0) > 0) throw new Error(jobStarted);
          context.expectStop?.();
        },
      });
      if (!outcome.ok && outcome.error === jobStarted) { line(outcome.error); return { ok: true as const, waiting: true }; }
      if (!outcome.ok && outcome.error === stopped) { line(outcome.error); resume(profileDir); return { ok: true as const, waiting: true }; }
      // Switched, or failed with the old bot back: either way new requests flow again (the bot starts the held ones).
      resume(profileDir);
      if (!outcome.ok) {
        fail(outcome.error);
        line(`The bot couldn't start on ${target}: ${outcome.error}`);
        return { ok: false as const, error: outcome.error };
      }
      // The app's code and the app disagree on the version (a build mix-up): stop here rather than restart every minute.
      const running = (await releaseStatus(profileDir)).active?.appVersion;
      if (running !== target) {
        const message = `The bot's code is version ${running ?? 'unknown'}, not ${target}. Reinstall Serra.`;
        fail(message);
        line(message);
        return { ok: false as const, error: message };
      }
      failures.delete(profileDir);
      return { ok: true as const, waiting: false };
    } catch (error) {
      resume(profileDir);
      fail(errorText(error));
      line(`The bot update failed: ${errorText(error)}`);
      return { ok: false as const, error: errorText(error) };
    }
  }, profile);

  /** One look by the timer: starts the bot update when it is due. Never throws. */
  const tick = async (): Promise<void> => {
    const profileDir = context.profileDirOrNull();
    // Not while Serra is quitting to install its own update.
    if (!profileDir || running || context.appUpdater?.view().state === 'installing') return;
    try {
      const decision = await decide(profileDir, await releaseStatus(profileDir));
      if (!decision) return;
      if (decision.action === 'pause') { pause(profileDir); return; }
      if (decision.action !== 'none') { await syncBot(false, profileDir); return; }
      // A pause nothing is waiting on any more (the app update was called off, the bot is in step or stopped): lift it.
      const draining = decision.sync.state === 'waiting' || decision.sync.state === 'updating';
      if (!draining && readPause(profileDir, now())) resume(profileDir);
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
      const bot: BotSync = (await decide(profileDir, releases ?? undefined))?.sync ?? { state: 'not-installed' };
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
      // No new job starts during the switch; requests that arrive meanwhile start on the restarted bot.
      pause(profileDir);
      const outcome = await activateRelease(profileDir, { ...deps.deploy, log: line }).finally(() => resume(profileDir));
      if (!outcome.ok && outcome.stage === 'checks') line(`Activation refused: ${outcome.error}`);
      return outcome;
    }),
    rollback: () => exclusive('rollback', async (profileDir) => {
      pause(profileDir);
      const outcome = await rollbackRelease(profileDir, { ...deps.deploy, log: line }).finally(() => resume(profileDir));
      if (!outcome.ok) line(`Rollback failed: ${outcome.error}`);
      return outcome;
    }),
    // The owner asked: update now even with jobs running (the confirm dialog names them), and retry after a failure.
    syncBot: () => { const profileDir = context.profileDirOrNull(); if (profileDir) failures.delete(profileDir); return syncBot(true); },
    check: () => app().check(),
    download: () => app().download(),
    cancelDownload: () => app().cancel(),
    // Quitting now would cut a bot switch short; the owner waits for it.
    install: () => {
      if (running && running !== 'prepare') throw new Error('The bot is restarting. Restart Serra once it has finished.');
      // The bot follows the new version next: from now on new requests wait, so the running jobs are the last ones on
      // the old bot. The pause lapses on its own if the new version never gets to it.
      // Written before Serra quits; if it can't be, the restart doesn't happen.
      const profileDir = context.profileDirOrNull();
      const leads = profileDir !== null && context.botFollowsApp === true && existsSync(join(profileDir, 'active.json'));
      const before = leads ? readPause(profileDir, now()) : null;
      if (leads) {
        try { pauseIntake(profileDir, 'app-update', { now: now() }); }
        catch (error) { throw new Error(`Serra couldn't hold new requests for the update, so it didn't restart: ${errorText(error)}`); }
      }
      const view = app().install();
      // Not installing after all (nothing ready, a swap already waiting): lift a pause this call started.
      if (leads && view.state !== 'installing' && !before) resumeIntake(profileDir);
      return view;
    },
    openInstaller: () => app().openInstaller(),
    setPrereleases: (choice) => {
      if (choice !== null && typeof choice !== 'boolean') throw new Error('Pre-releases must be on, off or the default.');
      return app().setPrereleases(choice);
    },
  };
  return { handlers, tick };
};

export const updatesHandlers = (context: HandlerContext, deps: UpdatesDeps = {}): Handlers<'updates'> => updatesService(context, deps).handlers;
