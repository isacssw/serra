// Live state for the shell: the daemon's status and the sidebar's badge counts.
import { useEffect, useState } from 'react';
import type { BotStatus, JobSummary, Proposal } from '../../../src/contracts.ts';
import { badgeCounts, type BadgeCounts } from '../badges.logic.ts';
import { serra } from '../bridge.ts';
import { REFRESH_COUNTS } from './events.ts';

/** The daemon's status, or null until the first report. Main pushes every change and `stopped` when it's gone. */
export const useBotStatus = (): BotStatus | null => {
  const [status, setStatus] = useState<BotStatus | null>(null);
  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    let live = true;
    const off = bridge.on.status((next) => { if (live) setStatus(next); });
    bridge.bot.status().then((current) => { if (live) setStatus((seen) => seen ?? current); }, () => {});
    return () => { live = false; off(); };
  }, []);
  return status;
};

/** A list from the bridge, or null while it's unavailable (not loaded, failed, or not built yet). */
const loadOrNull = async <T,>(load: () => Promise<T>): Promise<T | null> => {
  try { return await load(); }
  catch { return null; }
};

/** Badge counts from live status plus the jobs and proposals lists, reloaded on daemon events and window focus. */
export const useBadgeCounts = (status: BotStatus | null): BadgeCounts => {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [untagged, setUntagged] = useState<unknown[] | null>(null);
  const [drift, setDrift] = useState<unknown[] | null>(null);
  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    let live = true;
    const reload = (): void => {
      void loadOrNull(() => bridge.jobs.list()).then((list) => { if (live) setJobs(list); });
      void loadOrNull(() => bridge.proposals.list()).then((list) => { if (live) setProposals(list); });
      void loadOrNull(() => bridge.pages.untagged()).then((list) => { if (live) setUntagged(list); });
      void loadOrNull(() => bridge.pages.drift()).then((list) => { if (live) setDrift(list); });
    };
    reload();
    const off = bridge.on.event(reload);
    window.addEventListener('focus', reload);
    window.addEventListener(REFRESH_COUNTS, reload);
    return () => { live = false; off(); window.removeEventListener('focus', reload); window.removeEventListener(REFRESH_COUNTS, reload); };
  }, [status?.state]);
  return badgeCounts({ status, jobs, proposals, untagged, drift });
};
