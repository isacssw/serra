// Setup's progress for the whole window: the shell's gate and "Finish setup" row, and the setup flow itself read it
// from here. It rereads when the window regains focus, when the daemon's state changes, when a call fails for want
// of a profile, and when a setup step says it changed something.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SetupChat, SetupProgress } from '../../../src/setup.ts';
import { serra, SETUP_INCOMPLETE_EVENT } from '../bridge.ts';
import { draftChat, hasProfile } from './setup.logic.ts';

/** A setup step dispatches this on `window` after it changed the profile (created it, checked a token…). */
const SETUP_CHANGED = 'serra:setup-changed';

export const setupChanged = (): void => { window.dispatchEvent(new Event(SETUP_CHANGED)); };

interface SetupState {
  /** Null until the first read (or outside the app). */
  progress: SetupProgress | null;
  refresh(): Promise<SetupProgress | null>;
  /**
   * The chat setup works on: the profile's once it exists, else the one picked on the first screen. Null when none is
   * picked yet; undefined while the saved pick is still being read.
   */
  chat: SetupChat | null | undefined;
  /** Picks the chat on the first screen, kept with the form's draft so quitting loses nothing. */
  chooseChat(chat: SetupChat): Promise<void>;
}

const Context = createContext<SetupState>({ progress: null, refresh: async () => null, chat: null, chooseChat: async () => {} });

export const SetupProvider = ({ initial, children }: { initial: SetupProgress | null; children: ReactNode }) => {
  const [progress, setProgress] = useState<SetupProgress | null>(initial);
  const [picked, setPicked] = useState<SetupChat | null | undefined>(undefined);
  useEffect(() => {
    const bridge = serra();
    if (!bridge) { setPicked(null); return; }
    bridge.app.getPrefs().then((prefs) => setPicked((current) => current ?? draftChat(prefs.setupDraft)), () => setPicked((current) => current ?? null));
  }, []);
  const chooseChat = useCallback(async (chat: SetupChat) => {
    setPicked(chat);
    const bridge = serra();
    if (!bridge) return;
    const prefs = await bridge.app.getPrefs().catch(() => null);
    await bridge.app.setPrefs({ setupDraft: { ...prefs?.setupDraft, chat } }).catch(() => {});
  }, []);
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
  const chat = hasProfile(progress) ? progress!.chat : picked;
  const value = useMemo(() => ({ progress, refresh, chat, chooseChat }), [progress, refresh, chat, chooseChat]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export const useSetup = (): SetupState => useContext(Context);

/** The bot's name for copy ("What should Atlas do?"), or Serra before a profile exists. */
export const useBotName = (): string => useSetup().progress?.bot?.name || 'Serra';
