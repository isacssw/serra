// Profiles (SB-10): the switcher's list, switching, the order (⌘1…⌘9) and colour in `profiles.json`, Add… › Profile
// and a remove that saves a checked backup first. The window shows one profile at a time: switching re-points the app
// (`selectProfile`), and every other handler reads the profile in use per call, so nothing carries over. Every listed
// profile stays live (SB-11): each list tells main's presence map which daemons to follow.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { agentChoices, readAgentBackend, writeAgentBackend } from '../agent/acp-agents.ts';
import { stopBot, type BotServiceOptions } from '../bot-service.ts';
import { defaultProfileRoot, loadConfig } from '../config.ts';
import { backupProfile } from '../profile-backup.ts';
import { createSetupProfile, setupProgress } from '../setup.ts';
import { toolSearchPath } from '../shell-path.ts';
import type { Handlers, NewProfile, ProfileEntry, ProfilesView } from '../api.ts';
import { agentName, findProfiles, inRoot, probeStatus, profileName, readProfilesFile, setupDone, writeProfilesFile } from '../profiles.ts';
import { isColor, localRef, moveRef, PROFILE_COLORS, resolveColors, withColor, withLooks, withOrder, withoutRef } from '../profile-order.ts';
import { parseDraft } from './setup.ts';
import type { CoreContext } from './context.ts';

export interface ProfilesDeps {
  /** The profiles folder (tests: a temp folder). */
  root?: string;
  /** Where launchd plists live (tests: a temp folder). */
  launchAgentsDir?: string;
  /** launchd, for stopping a profile before it is removed (tests: a fake). */
  service?: BotServiceOptions['driver'];
  /** The PATH agents are looked up on (tests: a fake). */
  searchPath?: () => Promise<string>;
  /** How long to wait for a daemon's status (tests: short). */
  probeMs?: number;
  now?: () => Date;
}

const PINNED = 'Serra was started with a profile given on the command line, so it can’t switch here. Quit and open it without --profile.';

export const profilesHandlers = (context: CoreContext, deps: ProfilesDeps = {}): Handlers<'profiles'> => {
  const root = resolve(deps.root ?? defaultProfileRoot);
  const agents = deps.launchAgentsDir ?? join(homedir(), 'Library/LaunchAgents');
  const changed = (): void => context.push?.('profiles', null);

  const view = async (): Promise<ProfilesView> => {
    const active = context.profileDirOrNull();
    const current = active ? resolve(active) : null;
    const found = findProfiles(root, current);
    const colors = resolveColors(found.map(({ ref }) => ref), readProfilesFile(root));
    const presence = context.presence;
    // Pinned with --profile, the app is about that one bot only: no other profile is followed or notifies.
    const followed = context.profilePinned ? found.filter(({ dir }) => dir === current) : found;
    presence?.follow(followed.map(({ dir }) => ({ dir, name: profileName(dir) })));
    const profiles = await Promise.all(found.map(async ({ ref, dir }): Promise<ProfileEntry> => ({
      ref, dir,
      name: profileName(dir),
      color: colors[ref]!,
      active: dir === current,
      setupDone: setupDone(dir, deps.launchAgentsDir),
      status: dir === current ? null : presence ? presence.status(dir) : await probeStatus(dir, deps.probeMs),
      agent: agentName(dir),
    })));
    return { profiles, pinned: context.profilePinned === true, palette: [...PROFILE_COLORS] };
  };

  const find = (ref: unknown): { ref: string; dir: string } => {
    const found = typeof ref === 'string' ? findProfiles(root, context.profileDirOrNull()).find((entry) => entry.ref === ref) : undefined;
    if (!found) throw new Error('That profile isn’t on this Mac any more.');
    return found;
  };

  /** The refs `profiles.json` can order, as listed now. */
  const listedRefs = (): string[] => findProfiles(root, context.profileDirOrNull()).filter(({ dir }) => inRoot(root, dir)).map(({ ref }) => ref);

  const use = (dir: string | null): void => { context.selectProfile(dir); };

  return {
    list: view,

    switch: async (ref) => {
      const target = find(ref);
      const current = context.profileDirOrNull();
      if (current && resolve(current) === target.dir) return view();
      if (context.profilePinned) throw new Error(PINNED);
      const blocked = context.switchBlocked?.();
      if (blocked) throw new Error(blocked);
      use(target.dir);
      return view();
    },

    move: async (ref, index) => {
      const target = find(ref);
      if (!Number.isInteger(index)) throw new Error('Choose where the profile goes.');
      if (!inRoot(root, target.dir)) throw new Error('This profile lives outside the profiles folder, so it stays last.');
      const file = readProfilesFile(root);
      writeProfilesFile(root, withLooks(withOrder(file, moveRef(listedRefs(), target.ref, index)), listedRefs()));
      changed();
      return view();
    },

    setColor: async (ref, color) => {
      const target = find(ref);
      if (!isColor(color)) throw new Error('Pick one of the colours.');
      if (!inRoot(root, target.dir)) throw new Error('This profile lives outside the profiles folder, so its colour can’t be kept.');
      const file = readProfilesFile(root);
      // The order is written with it, so the ⌘ numbers seen now stay put when a profile is added later.
      writeProfilesFile(root, withLooks(withColor(withOrder(file, listedRefs()), target.ref, color), listedRefs()));
      changed();
      return view();
    },

    create: async (input: NewProfile) => {
      if (context.profilePinned) throw new Error(PINNED);
      if (typeof input !== 'object' || input === null) throw new Error('The new profile must be an object.');
      const color = input.color === null || input.color === undefined ? null : input.color;
      if (color !== null && !isColor(color)) throw new Error('Pick one of the colours.');
      const agent = input.agent ?? null;
      if (agent !== null && (typeof agent !== 'string' || !/^[\w-]{1,40}$/.test(agent))) throw new Error('Pick T3 or an installed agent.');
      if (agent !== null) {
        // Checked before anything is written, so a missing agent leaves no half-made profile.
        const path = await (deps.searchPath ?? toolSearchPath)();
        // Only the agents Serra knows: a custom one lives in another profile's agent-backend.json.
        if (!agentChoices(readAgentBackend(root), path).some((choice) => choice.id === agent && choice.installed && !choice.custom)) throw new Error('That agent isn’t installed on this Mac.');
      }
      const before = listedRefs();
      const directory = await createSetupProfile(parseDraft(input.draft), { root });
      if (inRoot(root, directory)) {
        const ref = localRef(basename(directory));
        // Last in the order: every other profile keeps its ⌘ number.
        // The others' colours are written first, so the new one's default is one none of them shows.
        const others = before.filter((entry) => entry !== ref);
        let file = withLooks(readProfilesFile(root), others);
        file = withOrder(color ? withColor(file, ref, color) : file, [...others, ref]);
        writeProfilesFile(root, withLooks(file, [...others, ref]));
      }
      if (agent !== null) writeAgentBackend(directory, { backend: 'acp', agent });
      context.selectProfile(directory, { setupFinished: true });
      changed();
      return setupProgress(directory, { ...(deps.launchAgentsDir ? { launchAgentsDir: deps.launchAgentsDir } : {}), running: false });
    },

    remove: async (ref) => {
      const target = find(ref);
      const current = context.profileDirOrNull();
      const active = current !== null && resolve(current) === target.dir;
      if (context.profilePinned && active) throw new Error(PINNED);
      const blocked = context.switchBlocked?.();
      if (blocked) throw new Error(blocked);
      if (!context.host.trashItem) throw new Error('Removing a profile needs the Trash, which isn’t available here.');
      const name = profileName(target.dir);
      // 1. Stop it, and take its service out of launchd so it doesn't start again at login.
      let plist: string | null = null;
      try {
        const label = loadConfig({ profileDir: target.dir, env: {} }).serviceLabel;
        const path = join(agents, `${label}.plist`);
        if (existsSync(path)) plist = path;
      } catch { /* A profile.json that doesn't load has no service Serra can name. */ }
      if (plist) {
        if (context.runtime.platform !== 'darwin' && !deps.service) throw new Error('Stopping the bot needs launchd, so removing works on macOS only.');
        context.expectStop?.(target.dir);
        await stopBot(target.dir, { launchAgentsDir: agents, ...(deps.service ? { driver: deps.service } : {}) });
      }
      // 2. A checked backup. If it fails, nothing is removed.
      const backup = backupProfile(target.dir, join(root, 'backups'), { profile: target.ref, name }, deps.now?.());
      // 3. Out of the list first, so the window never shows a profile that is half gone.
      if (active) {
        const next = findProfiles(root, current).find((entry) => entry.dir !== target.dir) ?? null;
        use(next ? next.dir : null);
      }
      // The others keep the colours they show now.
      if (inRoot(root, target.dir)) writeProfilesFile(root, withoutRef(withLooks(withOrder(readProfilesFile(root), listedRefs()), listedRefs()), target.ref));
      if (plist) await context.host.trashItem(plist);
      await context.host.trashItem(target.dir);
      changed();
      return { backup: backup.path, view: await view() };
    },

    showBackup: async (path) => {
      const backups = join(root, 'backups');
      if (typeof path !== 'string' || relative(backups, resolve(path)).startsWith('..') || !resolve(path).startsWith(`${backups}${sep}`)) {
        throw new Error('That isn’t a Serra backup.');
      }
      await context.host.openPath(resolve(path));
    },
  };
};
