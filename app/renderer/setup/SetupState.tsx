// Setup's progress for the whole window: the shell's gate and "Finish setup" row, and the setup flow itself read it
// from here. It rereads when the window regains focus, when the daemon's state changes, when a call fails for want
// of a profile, and when a setup step says it changed something.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SetupProgress } from '../../../src/setup.ts';
import { serra, SETUP_INCOMPLETE_EVENT } from '../bridge.ts';

/** A setup step dispatches this on `window` after it changed the profile (created it, checked a token…). */
export const SETUP_CHANGED = 'serra:setup-changed';

export const setupChanged = (): void => { window.dispatchEvent(new Event(SETUP_CHANGED)); };

interface SetupState {
  /** Null until the first read (or outside the app). */
  progress: SetupProgress | null;
  refresh(): Promise<SetupProgress | null>;
}

const Context = createContext<SetupState>({ progress: null, refresh: async () => null });

export const SetupProvider = ({ initial, children }: { initial: SetupProgress | null; children: ReactNode }) => {
  const [progress, setProgress] = useState<SetupProgress | null>(initial);
  const refresh = useCallback(async () => {
    const bridge = serra();
    if (!bridge) return null;
    try {
      const next = await bridge.setup.progress();
      setProgress(next);
      return next;
    } catch { return null; }
  }, []);
  useEffect(() => {
    if (!initial) void refresh();
    const reread = (): void => { void refresh(); };
    const events = ['focus', SETUP_INCOMPLETE_EVENT, SETUP_CHANGED];
    for (const name of events) window.addEventListener(name, reread);
    // Job counts change the status often; setup only cares whether the bot is up and connected.
    let last = '';
    const off = serra()?.on.status((status) => {
      const key = status.state === 'up' ? `up:${status.slackConnected}` : status.state;
      if (key !== last) { last = key; reread(); }
    });
    return () => { for (const name of events) window.removeEventListener(name, reread); off?.(); };
  }, [initial, refresh]);
  const value = useMemo(() => ({ progress, refresh }), [progress, refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export const useSetup = (): SetupState => useContext(Context);
