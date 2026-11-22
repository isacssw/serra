// Keeping the bot on the app's version (SERRA-46). In release mode the bot follows the app: after the app updates,
// the bot is rebuilt from the new app's code and restarted, but only while no job is running. Pure decisions here;
// `ipc/updates.ts` runs them on a timer with the release service.
import { compareVersions, parseVersion } from '../../src/app-updates.ts';
import type { Prepared } from '../../src/deploy.ts';

/** What the Updates screen says about the bot. */
export type BotSync =
  /** Developer mode: the owner builds and switches releases by hand. */
  | { state: 'manual' }
  /** No bot installed for this profile yet (setup isn't finished). */
  | { state: 'not-installed' }
  | { state: 'in-step'; version: string }
  /** The owner stopped the bot: it isn't restarted on its own. `to` is set when Update now would move it to the app's version. */
  | { state: 'stopped'; from: string | null; to: string | null; downgrade: boolean }
  /**
   * The bot runs an older version and waits for running jobs to finish before it restarts. `paused`: new requests are
   * held meanwhile (they start after the restart), so the running jobs are the last ones.
   */
  | { state: 'waiting'; from: string | null; to: string; jobs: number; paused: boolean }
  | { state: 'updating'; from: string | null; to: string }
  | { state: 'failed'; from: string | null; to: string; message: string; stopped: boolean; downgrade: boolean }
  /** The bot runs a newer version than the app (an older Serra was reinstalled). It never moves back on its own. */
  | { state: 'ahead'; from: string; to: string }
  /** The last switch stopped halfway; rollback puts the earlier bot back. */
  | { state: 'interrupted' };

/** `pause`: hold new requests so the running jobs can finish before the restart (intake.ts). */
export type BotSyncAction = 'none' | 'pause' | 'prepare' | 'activate';

export interface BotSyncInput {
  /**
   * The running bot holds new requests while paused. A bot from before alpha.3 doesn't, so the screen mustn't promise
   * that requests wait (SERRA-50 gap 1). Default: true.
   */
  honorsPause?: boolean;
  mode: 'release' | 'developer';
  /** The app is a packaged build whose code the bot can follow. A copy run from source doesn't lead the bot. */
  follows: boolean;
  /** The bot's launchd service is loaded. A bot the owner stopped stays stopped. */
  serviceLoaded: boolean;
  appVersion: string;
  active: Pick<Prepared, 'appVersion' | 'fromApp'> | null;
  /** A prepared release that isn't active yet, and whether it can be activated as it is. */
  prepared: Pick<Prepared, 'appVersion' | 'fromApp'> | null;
  preparedReady: boolean;
  activation: 'switching' | 'active' | 'rolled-back' | null;
  /** Jobs the bot is following now. */
  jobs: number;
  /** An update action this app is running now. */
  running: string | null;
  /** The version the last automatic attempt failed for (in this profile), so it isn't retried in a loop. */
  failed: { version: string; message: string } | null;
  /** New requests are held for an update now (the profile's intake pause is in force). */
  paused: boolean;
  /** A pause may start now: not right after one lapsed with jobs still running (then the update waits for a quiet moment). */
  mayPause: boolean;
}

/**
 * What to show, and what to do next on the timer. The bot restarts only when no job is running: a restart pauses the
 * jobs' replies, so the update waits for a quiet moment instead. A release prepared earlier for this version is
 * activated without preparing again.
 */
export const botSyncDecision = (input: BotSyncInput): { sync: BotSync; action: BotSyncAction } => {
  if (input.mode === 'developer' || !input.follows) return { sync: { state: 'manual' }, action: 'none' };
  // A switch this app is running writes `switching` too; only one nobody is running is interrupted.
  if (input.activation === 'switching' && !input.running) return { sync: { state: 'interrupted' }, action: 'none' };
  if (!input.active) return { sync: { state: 'not-installed' }, action: 'none' };
  const from = input.active.appVersion ?? null;
  const to = input.appVersion;
  // Same version from a checkout (developer mode earlier) isn't the app's build: it moves to the app's own code.
  const inStep = from === to && input.active.fromApp === true;
  /** Moving the bot to `to` would take it back to an older version. */
  const downgrade = Boolean(from && parseVersion(from) && parseVersion(to) && compareVersions(from, to) > 0);
  if (input.running === 'sync' && !inStep) return { sync: { state: 'updating', from, to }, action: 'none' };
  // A failed attempt is shown (with Try again) even for a stopped bot, so the owner sees why Update now didn't work.
  if (input.failed?.version === to && !inStep) return { sync: { state: 'failed', from, to, message: input.failed.message, stopped: !input.serviceLoaded, downgrade }, action: 'none' };
  if (!input.serviceLoaded) return { sync: { state: 'stopped', from, to: inStep ? null : to, downgrade }, action: 'none' };
  if (inStep) return { sync: { state: 'in-step', version: to }, action: 'none' };
  // Its state files may already be in the newer format: moving back is the owner's call.
  if (downgrade && from) return { sync: { state: 'ahead', from, to }, action: 'none' };
  // Running jobs finish first. New requests are held meanwhile, so the wait has an end.
  if (input.jobs > 0) {
    const pause = !input.paused && input.mayPause && !input.running;
    const held = (input.paused || pause) && input.honorsPause !== false;
    return { sync: { state: 'waiting', from, to, jobs: input.jobs, paused: held }, action: pause ? 'pause' : 'none' };
  }
  // Another action (a manual prepare or rollback) is running: wait for it.
  if (input.running) return { sync: { state: 'waiting', from, to, jobs: 0, paused: input.paused && input.honorsPause !== false }, action: 'none' };
  const preparedForApp = input.prepared?.appVersion === to && input.prepared.fromApp === true && input.preparedReady;
  return { sync: { state: 'updating', from, to }, action: preparedForApp ? 'activate' : 'prepare' };
};
