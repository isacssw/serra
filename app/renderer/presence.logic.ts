// One profile's state in one word set (SB-10, UX rule B1): the dot, the title row's word and the row phrase that the
// switcher, ⌘K and Settings › Profiles all show. Only the daemon's report decides it, never a timer or a guess: with
// no report yet it says `checking`. Pure: imported by `node --test` as well as the renderer.
import type { BotStatus } from '../../src/contracts.ts';

/** The dot's colour token (`--color-up`, `--color-warn`, `--color-down`, `--color-faint`), a hollow ring (offline), or none. */
export type Dot = 'up' | 'warn' | 'down' | 'faint' | 'hollow' | 'none';

/** How a profile's server is doing (`ServerHealth`), for a profile that lives on one. */
export interface PresenceServer { state: 'checking' | 'up' | 'offline' | 'unpaired'; skew: 'server' | 'app' | null }

export interface Presence {
  dot: Dot;
  /** The dot pulses while nothing is known yet. */
  pulse: boolean;
  /** Line 2 of the title row: `up`, `stopped`, `disconnected`, `checking`. */
  word: string;
  /** A switcher row's phrase: `up`, `2 running`, `1 needs you`, `stopped`, `Finish setup`. */
  phrase: string;
}

/**
 * `setupDone: false` is a profile left halfway (`Finish setup`, no dot). A stopped bot stays red as today: the
 * daemon's report can't yet tell "you stopped it" from "it stopped", so grey waits for that.
 */
export const presence = (status: BotStatus | null, { setupDone = true, server = null }: { setupDone?: boolean; server?: PresenceServer | null } = {}): Presence => {
  if (!setupDone) return { dot: 'none', pulse: false, word: status ? presence(status).word : 'checking', phrase: 'Finish setup' };
  if (server) {
    // Every profile on a server shares its reachability (UX rule B9). A refused key reads as offline too.
    if (server.state === 'offline' || server.state === 'unpaired') return { dot: 'hollow', pulse: false, word: 'offline', phrase: 'offline' };
    if (server.state === 'checking') return { dot: 'faint', pulse: true, word: 'checking', phrase: 'checking' };
    if (server.skew) return { dot: 'warn', pulse: false, word: 'outdated', phrase: 'update needed' };
  }
  if (!status) return { dot: 'faint', pulse: true, word: 'checking', phrase: 'checking' };
  if (status.state === 'stopped') return { dot: 'down', pulse: false, word: 'stopped', phrase: 'stopped' };
  if (!status.slackConnected) return { dot: 'down', pulse: false, word: 'disconnected', phrase: 'Slack disconnected' };
  const { needsYou, running } = status.counts;
  if (needsYou > 0) return { dot: 'warn', pulse: false, word: 'up', phrase: `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` };
  if (running > 0) return { dot: 'up', pulse: false, word: 'up', phrase: `${running} running` };
  return { dot: 'up', pulse: false, word: 'up', phrase: 'up' };
};
