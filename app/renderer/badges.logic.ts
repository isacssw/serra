// The counts next to sidebar items. A count is shown only when it comes from real state: the daemon's live counts
// while it is up, the jobs files while it is stopped, and the proposals folder. Missing data shows no badge.
import type { BotStatus, JobSummary, Proposal } from '../../src/contracts.ts';
import type { BadgeKey } from './routes.ts';

export type BadgeCounts = Partial<Record<BadgeKey, number>>;

export interface BadgeSources {
  /** Null until the first status report. */
  status: BotStatus | null;
  /** Null when the list isn't loaded or failed to load. */
  jobs: readonly JobSummary[] | null;
  proposals: readonly Proposal[] | null;
  /** Pages that don't say who may hear them, so teammates' briefs leave them out (About me's badge). */
  untagged?: readonly unknown[] | null;
  /** Files changed outside Serra, waiting for the owner in Pages (its badge). */
  drift?: readonly unknown[] | null;
}

export const badgeCounts = ({ status, jobs, proposals, untagged, drift }: BadgeSources): BadgeCounts => {
  const counts: BadgeCounts = {};
  if (status?.state === 'up') {
    counts.needsYou = status.counts.needsYou;
    counts.running = status.counts.running;
  } else if (jobs) {
    // With the daemon stopped nothing is running, but questions to the owner are still waiting in the files.
    counts.needsYou = jobs.filter((job) => job.group === 'needs you').length;
  }
  if (proposals) counts.proposals = proposals.length;
  if (untagged) counts.untagged = untagged.length;
  if (drift) counts.drift = drift.length;
  return counts;
};

/** The badge text, or null for no badge (unknown or zero). */
export const badgeText = (count: number | undefined): string | null => {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
};

/** Which badge colour: what needs the owner stands out. */
export const badgeTone = (key: BadgeKey): 'warn' | 'accent' => (key === 'needsYou' || key === 'drift' ? 'warn' : 'accent');
