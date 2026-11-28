// What the menubar item shows, from the daemon's real status only (spike, UX rules: honest state, no timers).
// Kept free of Electron so it can be tested; `tray.ts` turns it into a Tray and its menu.
import type { BotStatus } from '../../src/contracts.ts';

/** Which brand status icon (`assets/brand/serra-status-<icon>.png`) the menubar shows. */
export type TrayIcon = 'up' | 'needs-you' | 'down';

export interface TrayState {
  status: BotStatus;
  /** Whether the app has a bot profile to manage. Without one there is nothing to restart. */
  profileSelected: boolean;
  /** True while a restart started from the app is in progress. */
  restarting: boolean;
  /** Why the last restart failed, until the next one starts. */
  restartError: string | null;
}

export interface TrayView {
  icon: TrayIcon;
  /** Hover text on the menubar item. */
  tooltip: string;
  /** The first, disabled line of the menu: "Serra is up · Slack connected" or what is wrong. */
  headline: string;
  /** Disabled lines under the headline: job counts while the bot is up, and the last restart failure. */
  details: { kind: 'needs-you' | 'running' | 'error'; label: string }[];
  restart: { label: string; enabled: boolean };
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Menu items are one line. Long errors (a launchctl transcript) are cut so the menu stays readable. */
const MAX_ERROR = 90;
const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR - 1)}…` : line;
};

export const trayView = ({ status, profileSelected, restarting, restartError }: TrayState): TrayView => {
  let icon: TrayIcon = 'down';
  let headline: string;
  const details: TrayView['details'] = [];
  if (!profileSelected) headline = 'No bot profile selected';
  else if (status.state === 'stopped') headline = 'Serra is stopped';
  else {
    headline = `Serra is up · Slack ${status.slackConnected ? 'connected' : 'disconnected'}`;
    const { needsYou, running } = status.counts;
    if (status.slackConnected) icon = needsYou > 0 ? 'needs-you' : 'up';
    details.push({ kind: 'needs-you', label: plural(needsYou, 'needs you', 'need you') });
    details.push({ kind: 'running', label: `${running} running` });
  }
  if (restartError && !restarting) details.push({ kind: 'error', label: `Restart failed: ${oneLine(restartError)}` });
  const counts = details.filter((detail) => detail.kind !== 'error').map((detail) => detail.label);
  return {
    icon,
    tooltip: [headline, ...counts].join(' · '),
    headline,
    details,
    restart: { label: restarting ? 'Restarting…' : 'Restart bot', enabled: profileSelected && !restarting },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Two or more profiles (SB-11): one native row per profile in ⌘ order, and the icon carries the worst state
// ---------------------------------------------------------------------------------------------------------------

/** A dot's colour, as `presence.logic.ts` (the window's status table, UX rule B1) names it. */
export type RowDot = 'up' | 'warn' | 'down' | 'faint' | 'none';

/**
 * A profile's dot and row phrase. The same table as the window's `presence()` (app/renderer/presence.logic.ts), which
 * main can't import; `tests/app-profiles-live.test.ts` checks the two agree for every state.
 */
export const rowPresence = (status: BotStatus | null, setupDone = true): { dot: RowDot; phrase: string } => {
  if (!setupDone) return { dot: 'none', phrase: 'Finish setup' };
  if (!status) return { dot: 'faint', phrase: 'checking' };
  if (status.state === 'stopped') return { dot: 'down', phrase: 'stopped' };
  if (!status.slackConnected) return { dot: 'down', phrase: 'Slack disconnected' };
  const { needsYou, running } = status.counts;
  if (needsYou > 0) return { dot: 'warn', phrase: `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` };
  if (running > 0) return { dot: 'up', phrase: `${running} running` };
  return { dot: 'up', phrase: 'up' };
};

/** An avatar's letters for `name`, given letters already taken. The window's `lettersFor`, checked equal in tests. */
export const avatarLetters = (name: string, taken: ReadonlySet<string>): string => {
  const clean = name.trim().replace(/[^\p{L}\p{N}]/gu, '').match(/[\p{L}\p{N}]/gu) ?? [];
  const one = (clean[0] ?? '?').toUpperCase();
  if (!taken.has(one) || clean.length < 2) return one;
  const two = `${one}${clean[1]!.toLowerCase()}`;
  if (!taken.has(two)) return two;
  for (const next of clean.slice(2)) {
    const pair = `${one}${next.toLowerCase()}`;
    if (!taken.has(pair)) return pair;
  }
  return two;
};

/** A profile as the menubar lists it, in ⌘ order. */
export interface TrayProfile {
  dir: string;
  name: string;
  color: string;
  setupDone: boolean;
  /** The daemon's last report; null before the first one. */
  status: BotStatus | null;
}

interface TrayRow {
  dir: string;
  /** Line 1: the profile's name. */
  label: string;
  /** Line 2 (macOS 14.4+): its phrase. */
  sublabel: string;
  /** Older macOS shows one line: `Scout — 2 running`. */
  oneLine: string;
  avatar: { letters: string; color: string; dot: RowDot };
  /** `⌘2`, shown beside Open in its submenu; null from the tenth. */
  shortcut: string | null;
  open: string;
  newTask: string | null;
  /** Start when stopped, else Restart. Null for a profile left halfway: there is no bot to run yet. */
  restart: { label: string; enabled: boolean } | null;
  stop: { label: string; enabled: boolean } | null;
}

export interface MultiTrayView {
  icon: TrayIcon;
  tooltip: string;
  rows: TrayRow[];
}

/** Worst first (UX rule B6): red, then amber, then green. Stopped-by-you, checking and halfway are neutral. */
export const worstIcon = (dots: readonly RowDot[]): TrayIcon => {
  if (dots.includes('down')) return 'down';
  if (dots.includes('warn')) return 'needs-you';
  if (dots.includes('up')) return 'up';
  // Nothing is up: today's icon for a bot that isn't running.
  return 'down';
};

export const multiTrayView = (profiles: readonly TrayProfile[], busy: ReadonlySet<string> = new Set()): MultiTrayView => {
  const taken = new Set<string>();
  const rows = profiles.map((profile, index): TrayRow => {
    const letters = avatarLetters(profile.name, taken);
    taken.add(letters);
    const { dot, phrase } = rowPresence(profile.status, profile.setupDone);
    const working = busy.has(profile.dir);
    const running = profile.status?.state === 'up';
    return {
      dir: profile.dir,
      label: profile.name,
      sublabel: phrase,
      oneLine: `${profile.name} — ${phrase}`,
      avatar: { letters, color: profile.color, dot },
      shortcut: index < 9 ? `⌘${index + 1}` : null,
      open: `Open ${profile.name}`,
      newTask: profile.setupDone ? `New task in ${profile.name}…` : null,
      restart: profile.setupDone ? { label: working ? 'Restarting…' : running || !profile.status ? 'Restart' : 'Start', enabled: !working } : null,
      stop: profile.setupDone && running ? { label: 'Stop', enabled: !working } : null,
    };
  });
  const icon = worstIcon(rows.map((row) => row.avatar.dot));
  return { icon, tooltip: rows.map((row) => row.oneLine).join('\n'), rows };
};

/** The status feed the controller needs; `StatusSource` in `status.ts` fits. */
export interface TrayStatusFeed {
  current(): BotStatus;
  subscribe(listener: { status(status: BotStatus): void; event(event: unknown): void }): () => void;
}

export interface TrayControllerOptions {
  status: TrayStatusFeed;
  profileSelected(): boolean;
  /** The bridge's `bot.restart`, so the menubar and the window share one restart at a time. */
  restart(): Promise<void>;
  /** Draws the view. Called now and on every change. */
  render(view: TrayView): void;
  log?: (message: string) => void;
}

export interface TrayController {
  /** Restarts the bot (or starts it when stopped). A failure shows in the menu, never throws. */
  restart(): Promise<void>;
  /** Draws again, for example after the profile changed. */
  refresh(): void;
  stop(): void;
}

/** Keeps the menubar in step with the daemon's status and the restarts started from it. */
export const trayController = ({ status, profileSelected, restart, render, log = console.error }: TrayControllerOptions): TrayController => {
  let restarting = false;
  let restartError: string | null = null;
  let stopped = false;
  const draw = (): void => {
    if (stopped) return;
    try { render(trayView({ status: status.current(), profileSelected: profileSelected(), restarting, restartError })); }
    catch (error) { log(`[serra] could not update the menubar: ${String(error)}`); }
  };
  const unsubscribe = status.subscribe({ status: draw, event: () => {} });
  draw();
  return {
    restart: async () => {
      if (restarting) return;
      restarting = true;
      restartError = null;
      draw();
      try { await restart(); }
      catch (error) { restartError = error instanceof Error ? error.message : String(error); }
      finally { restarting = false; draw(); }
    },
    refresh: draw,
    stop: () => { stopped = true; unsubscribe(); },
  };
};
