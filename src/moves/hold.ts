// A profile held for a move or a restore (SB-34, ux-rules E4, E16): `moves/hold-<profile>.json` beside the profile
// folders, never inside one, so a copy never carries it. While a hold counts, the daemon refuses to start. A hold
// that never reached `committed` stops counting 10 minutes after its last refresh, so a Mac that went away can't keep
// a profile down; the host then starts it again by itself (`settleLapsed`). Kept small: the daemon reads it at start.
import { basename, dirname, join, resolve } from 'node:path';
import { isBoolean, isOneOf, isRecord, isString, readJsonOrNull, type Guard } from '../lib/guards.ts';

export type HoldStep = 'paused' | 'committed';

export const holdPath = (root: string, profile: string): string => join(root, 'moves', `hold-${profile}.json`);

export interface Hold {
  moveId: string;
  step: HoldStep;
  /** The hold lapses at this time unless renewed; `committed` never lapses. */
  until: string;
  /** Whether the service was loaded when the move began: a resume starts it only then. */
  wasLoaded: boolean;
  /** The service file, set aside as `<file>.held` while held. */
  serviceFile: string | null;
  /** This move's backup folder, once made. */
  backup: string | null;
}

export const isHold: Guard<Hold> = (value): value is Hold =>
  isRecord(value) && isString(value.moveId) && isOneOf('paused', 'committed')(value.step) && isString(value.until) && isBoolean(value.wasLoaded)
  && (value.serviceFile === null || isString(value.serviceFile)) && (value.backup === null || isString(value.backup));

/** True while the profile in `profileDir` is held for a move or a restore: its daemon must not start. */
export const heldForMove = (profileDir: string, now = Date.now()): boolean => {
  const hold = readJsonOrNull(holdPath(dirname(resolve(profileDir)), basename(profileDir)), isHold);
  return hold !== null && (hold.step === 'committed' || Date.parse(hold.until) > now);
};
