// The profiles the window knows (SB-10): the list in ⌘ order, which one is in use, and switching. It rereads when
// main says the profiles changed, and when the window regains focus. Every other profile's status comes live from
// main's presence map (SB-11) and is merged in as it changes.
// Each switch bumps `generation`, which the shell uses as its key: every screen mounts again on the new profile, so
// no list, draft or cache from the old one is shown under the new name.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProfilesView } from '../../main/bridge.ts';
import { serra } from '../bridge.ts';
import { withPresence, windowTitle } from '../profiles.logic.ts';
import { setupChanged } from '../setup/SetupState.tsx';
import { PROFILE_SWITCHED } from './events.ts';

interface ProfilesState {
  /** Null until the first read (or outside the app). */
  view: ProfilesView | null;
  /** Goes up by one each time another profile is in use. */
  generation: number;
  refresh(): Promise<ProfilesView | null>;
  /** Switches to the profile; throws with main's message when it can't (pinned, a bot update under way). */
  switchTo(ref: string): Promise<void>;
}

const Context = createContext<ProfilesState>({ view: null, generation: 0, refresh: async () => null, switchTo: async () => {} });

const activeDir = (view: ProfilesView | null): string | null => view?.profiles.find((profile) => profile.active)?.dir ?? null;

export const ProfilesProvider = ({ children }: { children: ReactNode }) => {
  const [view, setView] = useState<ProfilesView | null>(null);
  const [generation, setGeneration] = useState(0);
  // The profile last seen in use: a change from one known profile to another is a switch.
  const seen = useRef<string | null | undefined>(undefined);
  const latest = useRef(0);

  const take = useCallback((next: ProfilesView) => {
    const dir = activeDir(next);
    if (seen.current !== undefined && seen.current !== dir) {
      setGeneration((value) => value + 1);
      window.dispatchEvent(new Event(PROFILE_SWITCHED));
      setupChanged();
    }
    seen.current = dir;
    setView(next);
  }, []);

  const refresh = useCallback(async () => {
    const bridge = serra();
    if (!bridge) return null;
    const ask = ++latest.current;
    try {
      const next = await bridge.profiles.list();
      // Only the newest answer lands: a slow older one must not undo a switch.
      if (ask === latest.current) take(next);
      return next;
    } catch { return null; }
  }, [take]);

  const switchTo = useCallback(async (ref: string) => {
    const bridge = serra();
    if (!bridge) return;
    const ask = ++latest.current;
    const next = await bridge.profiles.switch(ref);
    if (ask === latest.current) take(next);
  }, [take]);

  useEffect(() => {
    void refresh();
    const reread = (): void => { void refresh(); };
    window.addEventListener('focus', reread);
    const off = serra()?.on.profiles(reread);
    const offPresence = serra()?.on.presence((statuses) => setView((seen) => withPresence(seen, statuses)));
    return () => { window.removeEventListener('focus', reread); off?.(); offPresence?.(); };
  }, [refresh]);

  // The window's title names the profile once there are two (UX rule G5).
  useEffect(() => { document.title = windowTitle(view); }, [view]);

  const value = useMemo(() => ({ view, generation, refresh, switchTo }), [view, generation, refresh, switchTo]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export const useProfiles = (): ProfilesState => useContext(Context);
