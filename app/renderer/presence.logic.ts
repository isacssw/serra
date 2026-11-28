// One profile's state in one word set (SB-10, UX rule B1): the dot, the title row's word and the row phrase that the
// switcher, ⌘K and Settings › Profiles all show. Only the daemon's report decides it, never a timer or a guess: with
// no report yet it says `checking`. Pure: imported by `node --test` as well as the renderer.
import type { BotStatus } from '../../src/contracts.ts';

/** The dot's colour token (`--color-up`, `--color-warn`, `--color-down`, `--color-faint`), or none. */
export type Dot = 'up' | 'warn' | 'down' | 'faint' | 'none';

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
export const presence = (status: BotStatus | null, { setupDone = true }: { setupDone?: boolean } = {}): Presence => {
  if (!setupDone) return { dot: 'none', pulse: false, word: status ? presence(status).word : 'checking', phrase: 'Finish setup' };
  if (!status) return { dot: 'faint', pulse: true, word: 'checking', phrase: 'checking' };
  if (status.state === 'stopped') return { dot: 'down', pulse: false, word: 'stopped', phrase: 'stopped' };
  if (!status.slackConnected) return { dot: 'down', pulse: false, word: 'disconnected', phrase: 'Slack disconnected' };
  const { needsYou, running } = status.counts;
  if (needsYou > 0) return { dot: 'warn', pulse: false, word: 'up', phrase: `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` };
  if (running > 0) return { dot: 'up', pulse: false, word: 'up', phrase: `${running} running` };
  return { dot: 'up', pulse: false, word: 'up', phrase: 'up' };
};
