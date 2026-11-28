// The sidebar's title row and the profile switcher (SB-10). With one profile the row reads as it always did,
// "Serra · up", and opens a two-item menu: the profile and Add…. From the second profile it shows the avatar, the
// name and the state word on two lines (the word never cuts), and the menu lists every profile with its phrase and
// ⌘ number. Pinned with --profile, the row is plain text again: no menu, no Add.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown, Plus, SlidersHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { BotStatus } from '../../../src/contracts.ts';
import { profileRows, rowLabel, showsSwitcher, type ProfileRow } from '../profiles.logic.ts';
import { statusView, type StatusTone } from '../status.logic.ts';
import { Avatar, cx, useToast } from '../ui/index.ts';
import { ariaMod, isMac, mod } from './keys.ts';
import { useProfiles } from './profiles.tsx';
import { openAdd } from './AddSheet.tsx';
import { serverPath } from '../servers.logic.ts';
import downIcon from '../../../assets/brand/serra-status-down.png';
import needsYouIcon from '../../../assets/brand/serra-status-needs-you.png';
import upIcon from '../../../assets/brand/serra-status-up.png';

// Before the first status report there is no honest colour, so the icon is shown greyed out.
const statusIcons: Record<StatusTone, string> = { up: upIcon, 'needs-you': needsYouIcon, down: downIcon, unknown: downIcon };

const PROFILES_SETTINGS_PATH = '/settings/profiles';

/** macOS draws the traffic lights over the sidebar's first row, except in full screen, where they're hidden. */
const useFullScreen = (): boolean => {
  const check = (): boolean => window.outerWidth === screen.width && window.outerHeight === screen.height;
  const [full, setFull] = useState(check);
  useEffect(() => {
    const update = (): void => setFull(check());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return full;
};

const shortcutLabel = (shortcut: string | null): string | undefined => (shortcut ? shortcut.replace('⌘', `${ariaMod}+`) : undefined);

const itemClass = 'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none data-[active]:bg-selected focus-visible:bg-selected';

/** The menu under the title row: a `role="menu"` popover; ↑↓ move, Enter opens, a letter jumps, Esc closes. */
const Menu = ({ anchor, rows, many, icon, onClose }: {
  anchor: HTMLElement; rows: ProfileRow[]; many: boolean; icon: string; onClose: (refocus: boolean) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { switchTo } = useProfiles();
  const toast = useToast();

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    menu.showPopover();
    const box = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, box.left)}px`;
    menu.style.top = `${box.bottom + 4}px`;
    (menu.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? menu.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
  }, [anchor]);

  const pick = (row: ProfileRow): void => {
    onClose(true);
    // A server's profile opens its server's page; opening it in the window comes with moves (phase 7).
    if (row.server) { void navigate(serverPath(row.server.id)); return; }
    if (row.active) {
      if (!row.setupDone) void navigate('/setup');
      return;
    }
    switchTo(row.ref).catch((failure: unknown) => toast({ message: failure instanceof Error ? failure.message : String(failure), tone: 'error' }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = items.findIndex((item) => item === document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); onClose(true); return; }
    if (event.key === 'Tab') { event.preventDefault(); onClose(true); return; }
    let next = -1;
    if (event.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLowerCase();
      const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
      const found = order.find((item) => (item.dataset.label ?? '').toLowerCase().startsWith(letter));
      next = found ? items.indexOf(found) : -1;
    }
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      popover="auto"
      role="menu"
      aria-label="Profiles"
      onKeyDown={onKeyDown}
      // Light dismiss (a click outside) closes it without pulling focus back.
      onToggle={(event) => { if ('newState' in event && event.newState === 'closed') onClose(false); }}
      className="fixed inset-auto m-0 w-[300px] rounded-xl border-0 bg-overlay p-1.5 text-ink shadow-overlay animate-[serra-pop_120ms_ease-out]"
    >
      {rows.map((row) => (
        <button
          key={row.ref}
          type="button"
          role="menuitemradio"
          aria-checked={row.active}
          aria-label={rowLabel(many ? row : { ...row, name: 'Serra', shortcut: null })}
          aria-keyshortcuts={many ? shortcutLabel(row.shortcut) : undefined}
          data-label={many ? row.name : 'Serra'}
          data-profile-row={row.ref}
          onClick={() => pick(row)}
          className={itemClass}
        >
          {many
            ? <Avatar letters={row.letters} color={row.color} size={28} dot={row.presence.dot} pulse={row.presence.pulse} dashed={!row.setupDone} surface="overlay" />
            : <img src={icon} alt="" className="size-7 rounded-[7px]" />}
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] font-medium">{many ? row.name : 'Serra'}</span>
            <span className="truncate text-xs text-muted">{row.presence.phrase}</span>
          </span>
          {many && row.shortcut && <kbd className="font-sans text-[11px] text-faint" aria-hidden>{row.shortcut.replace('⌘', mod)}</kbd>}
          {many && <Check size={14} aria-hidden className={cx('shrink-0', row.active ? 'text-ink' : 'invisible')} />}
        </button>
      ))}
      <div role="separator" className="mx-1 my-1.5 h-px bg-line" />
      <button
        type="button"
        role="menuitem"
        data-label="Add"
        aria-keyshortcuts={`${ariaMod}+Shift+N`}
        onClick={() => { onClose(false); openAdd(); }}
        className={itemClass}
      >
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-[7px] border border-dashed border-line-strong text-muted"><Plus size={14} /></span>
        <span className="flex-1 text-[13px]">Add…</span>
        <kbd className="font-sans text-[11px] text-faint" aria-hidden>{isMac ? '⌘⇧N' : 'Ctrl+Shift+N'}</kbd>
      </button>
      {many && (
        <button
          type="button"
          role="menuitem"
          data-label="Manage profiles"
          onClick={() => { onClose(false); void navigate(PROFILES_SETTINGS_PATH); }}
          className={itemClass}
        >
          <span aria-hidden className="grid size-7 shrink-0 place-items-center text-muted"><SlidersHorizontal size={15} strokeWidth={1.75} /></span>
          <span className="flex-1 text-[13px]">Manage profiles</span>
        </button>
      )}
    </div>
  );
};

export const TitleRow = ({ status }: { status: BotStatus | null }) => {
  const view = statusView(status);
  const { view: profiles, servers } = useProfiles();
  // Hooks run on every render, in the same order: call them first, then decide.
  const fullScreen = useFullScreen();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const insetLights = isMac && !fullScreen;
  const many = showsSwitcher(profiles, servers);
  const rows = profileRows(profiles, status, '⌘', servers);
  const active = rows.find((row) => row.active);
  // Pinned (or before the list is read): the row as it always was, with nothing to open.
  const menu = profiles !== null && !profiles.pinned && active !== undefined;

  // A click on the title row while the menu is open first closes it (light dismiss); that click mustn't reopen it.
  const closedAt = useRef(0);
  const close = (refocus: boolean): void => {
    closedAt.current = performance.now();
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const single = (
    <>
      <img src={statusIcons[view.tone]} alt="" className={cx('size-[18px] rounded-[5px]', view.tone === 'unknown' && 'opacity-40 grayscale')} />
      <span className="min-w-0 truncate text-[13px]" role="status" aria-label={`Serra: ${view.detail}`} data-status-tone={view.tone}>
        <span className="font-semibold text-ink">Serra</span><span className="text-muted"> · {view.label}</span>
      </span>
    </>
  );

  return (
    <div className={cx('drag flex h-[52px] shrink-0 items-center pr-3', insetLights ? 'pl-[84px]' : 'pl-4')}>
      {/* The title row moves the window, which takes its mouse events; the name keeps its tooltip. */}
      {!menu ? (
        <div className="no-drag flex min-w-0 items-center gap-2" title={view.detail}>{single}</div>
      ) : (
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          title={view.detail}
          data-profile-switcher
          onClick={() => { if (performance.now() - closedAt.current > 250) setOpen((value) => !value); }}
          className="no-drag -ml-1.5 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus aria-expanded:bg-selected"
        >
          {many && active ? (
            <>
              <Avatar letters={active.letters} color={active.color} size={24} dot={active.presence.dot} pulse={active.presence.pulse} dashed={!active.setupDone} />
              <span className="flex min-w-0 flex-col text-left leading-[1.15]" role="status" aria-label={`${active.name}: ${active.presence.phrase}`}>
                <span className="truncate text-[13px] font-semibold text-ink">{active.name}</span>
                <span className="text-xs whitespace-nowrap text-muted">{active.presence.word}</span>
              </span>
              <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" />
            </>
          ) : single}
        </button>
      )}
      {open && button.current && <Menu anchor={button.current} rows={many ? rows : rows.filter((row) => row.active)} many={many} icon={statusIcons[view.tone]} onClose={close} />}
    </div>
  );
};
