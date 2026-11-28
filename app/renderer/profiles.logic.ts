// How the window shows profiles (SB-10): one profile looks exactly as before ("Serra · up"); from the second, each
// gets an avatar (a unique letter, or two when the first is taken, and a unique colour), a ⌘ number by its place in
// the order, and the window title names the one in use. Pure: imported by `node --test` as well as the renderer.
import type { BotStatus } from '../../src/contracts.ts';
import type { ProfileEntry, ProfilesView, ServerHealth } from '../main/bridge.ts';
import { presence, type Presence } from './presence.logic.ts';

/** How many profiles the paired servers have (SB-33). */
const remoteCount = (servers: readonly ServerHealth[]): number => servers.reduce((sum, server) => sum + server.profiles.length, 0);

/**
 * One profile, or a pinned one: the window looks as it always did. Two or more, counting a paired server's: the
 * switcher. A server with no profiles adds nothing (UX rule D5).
 */
export const showsSwitcher = (view: ProfilesView | null, servers: readonly ServerHealth[] = []): boolean =>
  view !== null && !view.pinned && view.profiles.length + remoteCount(servers) > 1;

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
  /** `⌘1`…`⌘9` by place in the order; null from the tenth, and for a server's profile until moves keep them (phase 7). */
  shortcut: string | null;
  agent: string;
  /** The server it lives on; null on this Mac. A server's profile opens that server's page, not the window. */
  server: { id: string; name: string } | null;
}

/**
 * What the switcher, ⌘K and Settings › Profiles list: this Mac's profiles in ⌘ order, then each paired server's in
 * the order it lists them. The profile in use shows the live status the window follows. A server's profile takes the
 * first colour no one shows, and its phrase ends with its server's name (UX rule B3); a local one never says where.
 */
export const profileRows = (view: ProfilesView | null, live: BotStatus | null, mod = '⌘', servers: readonly ServerHealth[] = []): ProfileRow[] => {
  if (!view) return [];
  const remote = servers.flatMap((server) => server.profiles.map((profile) => ({ server, profile })));
  const taken = new Set(view.profiles.map((profile) => profile.color));
  const free = view.palette.filter((color) => !taken.has(color));
  const colours = remote.map((_, index) => free[index % Math.max(1, free.length)] ?? view.palette[0] ?? '#2b2b30');
  const looks = profileLooks([...view.profiles, ...remote.map(({ profile }, index) => ({ name: profile.name, color: colours[index]! }))]);
  const local = view.profiles.map((profile, index): ProfileRow => ({
    ...looks[index]!,
    ref: profile.ref,
    name: profile.name,
    active: profile.active,
    setupDone: profile.setupDone,
    presence: presence(profile.active ? live : profile.status, { setupDone: profile.setupDone }),
    shortcut: index < 9 ? `${mod}${index + 1}` : null,
    agent: profile.agent,
    server: null,
  }));
  const away = remote.map(({ server, profile }, index): ProfileRow => {
    const own = presence(profile.status, { server });
    return {
      ...looks[view.profiles.length + index]!,
      ref: `${server.id}/${profile.id}`,
      name: profile.name,
      active: false,
      setupDone: true,
      presence: { ...own, phrase: `${own.phrase} · ${server.name}` },
      shortcut: null,
      agent: '',
      server: { id: server.id, name: server.name },
    };
  });
  return [...local, ...away];
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
  // `update needed` is amber too, but it is the server's, not a job waiting (word `outdated`).
  const waiting = rows.filter((row) => !row.active && row.setupDone && row.presence.dot === 'warn' && row.presence.word === 'up');
  return { shown: waiting.slice(0, max), more: Math.max(0, waiting.length - max) };
};

/** The name the window uses for the profile in use: "Serra" while there is one, the profile's name from two. */
const activeName = (view: ProfilesView | null, servers: readonly ServerHealth[]): string =>
  (showsSwitcher(view, servers) ? view?.profiles.find((profile) => profile.active)?.name : null) ?? 'Serra';

/** The window's title: `Scout — Serra` with two or more profiles, else `Serra`. */
export const windowTitle = (view: ProfilesView | null, servers: readonly ServerHealth[] = []): string => {
  const name = activeName(view, servers);
  return name === 'Serra' ? 'Serra' : `${name} — Serra`;
};

/** How a screen reader hears a switcher row: "Scout, 2 running, command 2". */
export const rowLabel = (row: ProfileRow): string =>
  [row.name, row.server ? row.presence.phrase.replace(` · ${row.server.name}`, `, on ${row.server.name}`) : row.presence.phrase,
    row.shortcut ? `command ${row.shortcut.slice(-1)}` : null].filter(Boolean).join(', ');
