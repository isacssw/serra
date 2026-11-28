// Profiles from the keyboard (SB-10): ⌘1…⌘9 switch (from the second profile), ⌘⇧N opens Add…, and ⌘K lists
// "Switch to {profile}" with its phrase and ⌘ number, plus Add… and Add server… (SB-32). Pinned with --profile, none of them exist.
import { useEffect, useRef } from 'react';
import type { BotStatus } from '../../../src/contracts.ts';
import { registerActions, type Action } from '../commands/registry.ts';
import { profileRows, showsSwitcher } from '../profiles.logic.ts';
import { useToast } from '../ui/index.ts';
import { CLOSE_COMMAND_PALETTE } from './events.ts';
import { isMac, mod } from './keys.ts';
import { useProfiles } from './profiles.tsx';
import { profileShortcut } from './shortcuts.logic.ts';
import { openAdd } from './AddSheet.tsx';

export const ProfileShortcuts = ({ status }: { status: BotStatus | null }) => {
  const toast = useToast();
  const { view, switchTo } = useProfiles();
  const rows = profileRows(view, status, mod);
  const many = showsSwitcher(view);
  const pinned = view?.pinned !== false;

  // The latest values, for a key listener registered once.
  const latest = useRef({ rows, many, pinned });
  latest.current = { rows, many, pinned };

  /** Switches, keeping the screen (the shell moves focus to its heading). */
  const switchToRef = useRef<(ref: string) => Promise<void>>(async () => {});
  switchToRef.current = async (ref: string): Promise<void> => {
    try {
      await switchTo(ref);
    } catch (failure) { toast({ message: failure instanceof Error ? failure.message : String(failure), tone: 'error' }); }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const shortcut = profileShortcut(event, isMac);
      const now = latest.current;
      if (!shortcut || now.pinned) return;
      if (shortcut.kind === 'add') {
        event.preventDefault();
        window.dispatchEvent(new Event(CLOSE_COMMAND_PALETTE));
        openAdd();
        return;
      }
      const row = now.many ? now.rows[shortcut.index] : undefined;
      if (!row) return;
      event.preventDefault();
      window.dispatchEvent(new Event(CLOSE_COMMAND_PALETTE));
      if (!row.active) void switchToRef.current(row.ref);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ⌘K rows follow the list: registered again whenever a name, phrase or place changes.
  const key = pinned ? 'pinned' : JSON.stringify(rows.map((row) => [row.ref, row.name, row.presence.phrase, row.shortcut]));
  useEffect(() => {
    if (pinned) return;
    const actions: Action[] = [{
      id: 'profiles:add',
      title: 'Add…',
      group: 'Profiles',
      hint: isMac ? '⌘⇧N' : 'Ctrl+Shift+N',
      keywords: ['add', 'new', 'profile', 'bot', 'another'],
      button: 'Title row › Add…',
      run: () => openAdd(),
    }, {
      id: 'servers:add',
      title: 'Add server…',
      group: 'Profiles',
      keywords: ['add', 'server', 'pair', 'ssh', 'linux', 'remote'],
      button: 'Add… › Server',
      run: () => openAdd('server'),
    }];
    if (many) {
      actions.unshift(...latest.current.rows.map((row): Action => ({
        id: `profiles:switch:${row.ref}`,
        title: `Switch to ${row.name}`,
        group: 'Profiles',
        hint: [row.presence.phrase, row.shortcut].filter(Boolean).join(' · '),
        keywords: ['profile', 'bot', 'switch', row.name],
        button: 'Title row › profile list',
        run: () => { if (!row.active) void switchToRef.current(row.ref); },
      })));
    }
    return registerActions(actions);
    // The rows are read through `latest`; `key` says when they change.
  }, [key, many, pinned]);

  return null;
};
