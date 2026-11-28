// How the window shows profiles (SB-10): one profile looks exactly as before ("Serra · up"); from the second, each
// gets an avatar (a unique letter, or two when the first is taken, and a unique colour), a ⌘ number by its place in
// the order, and the window title names the one in use. Pure: imported by `node --test` as well as the renderer.
import type { BotStatus } from '../../src/contracts.ts';
import type { ProfileEntry, ProfilesView } from '../main/bridge.ts';
import { presence, type Presence } from './presence.logic.ts';

/** One profile, or a pinned one: the window looks as it always did. Two or more: the switcher. */
export const showsSwitcher = (view: ProfilesView | null): boolean => view !== null && !view.pinned && view.profiles.length > 1;

/** An avatar's letters for `name`, given letters already taken: the first letter, else the first two ("Sc"). */
export const lettersFor = (name: string, taken: ReadonlySet<string>): string => {
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

export interface ProfileLook { letters: string; color: string }

/** Every profile's letters, in list order (earlier profiles keep theirs, later ones avoid them), with its colour. */
export const profileLooks = (profiles: readonly Pick<ProfileEntry, 'name' | 'color'>[]): ProfileLook[] => {
  const letters = new Set<string>();
  return profiles.map((profile) => {
    const mine = lettersFor(profile.name, letters);
    letters.add(mine);
    return { letters: mine, color: profile.color };
  });
};

/** The colours other profiles show, which a profile can't take (shown crossed out). */
export const takenColors = (profiles: readonly Pick<ProfileEntry, 'color' | 'ref'>[], ref: string | null): Set<string> =>
  new Set(profiles.flatMap((profile) => (profile.ref === ref ? [] : [profile.color])));

/** A new profile's look: its letters and the first colour no one has. */
export const newProfileLook = (view: Pick<ProfilesView, 'profiles' | 'palette'> | null, name: string): ProfileLook => {
  const profiles = view?.profiles ?? [];
  const taken = takenColors(profiles, null);
  const letters = new Set(profileLooks(profiles).map((look) => look.letters));
  const palette = view?.palette ?? [];
  return {
    letters: lettersFor(name || 'New', letters),
    color: palette.find((color) => !taken.has(color)) ?? palette[0] ?? '#2b2b30',
  };
};

export interface ProfileRow extends ProfileLook {
  ref: string;
  name: string;
  active: boolean;
  setupDone: boolean;
  presence: Presence;
  /** `⌘1`…`⌘9` by place in the order; null from the tenth. */
  shortcut: string | null;
  agent: string;
}

/** What the switcher, ⌘K and Settings › Profiles list. The profile in use shows the live status the window follows. */
export const profileRows = (view: ProfilesView | null, live: BotStatus | null, mod = '⌘'): ProfileRow[] => {
  if (!view) return [];
  const looks = profileLooks(view.profiles);
  return view.profiles.map((profile, index) => ({
    ...looks[index]!,
    ref: profile.ref,
    name: profile.name,
    active: profile.active,
    setupDone: profile.setupDone,
    presence: presence(profile.active ? live : profile.status, { setupDone: profile.setupDone }),
    shortcut: index < 9 ? `${mod}${index + 1}` : null,
    agent: profile.agent,
  }));
};

/**
 * The view with the live statuses main pushed (SB-11), by folder. The profile in use keeps null: the window follows
 * it itself. A profile the push doesn't name keeps what it had. Unchanged statuses keep the same view object.
 */
export const withPresence = (view: ProfilesView | null, statuses: Readonly<Record<string, BotStatus | null>>): ProfilesView | null => {
  if (!view) return view;
  let changed = false;
  const profiles = view.profiles.map((profile) => {
    if (profile.active || !(profile.dir in statuses)) return profile;
    const status = statuses[profile.dir] ?? null;
    if (JSON.stringify(status) === JSON.stringify(profile.status)) return profile;
    changed = true;
    return { ...profile, status };
  });
  return changed ? { ...view, profiles } : view;
};

/** Other profiles that need you, for the quiet line at the top of Jobs (UX rule C5): at most `max`, then how many more. */
export const othersNeedingYou = (rows: readonly ProfileRow[], max = 3): { shown: ProfileRow[]; more: number } => {
  const waiting = rows.filter((row) => !row.active && row.setupDone && row.presence.dot === 'warn');
  return { shown: waiting.slice(0, max), more: Math.max(0, waiting.length - max) };
};

/** The name the window uses for the profile in use: "Serra" while there is one, the profile's name from two. */
const activeName = (view: ProfilesView | null): string =>
  (showsSwitcher(view) ? view?.profiles.find((profile) => profile.active)?.name : null) ?? 'Serra';

/** The window's title: `Scout — Serra` with two or more profiles, else `Serra`. */
export const windowTitle = (view: ProfilesView | null): string => {
  const name = activeName(view);
  return name === 'Serra' ? 'Serra' : `${name} — Serra`;
};

/** How a screen reader hears a switcher row: "Scout, 2 running, command 2". */
export const rowLabel = (row: ProfileRow): string =>
  [row.name, row.presence.phrase, row.shortcut ? `command ${row.shortcut.slice(-1)}` : null].filter(Boolean).join(', ');
