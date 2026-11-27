// The sidebar: the title-bar row (traffic lights on macOS, then the bot's name and state), New task as the primary
// action, search, Jobs and Knowledge, and Settings as one entry at the foot. Inside Settings the sidebar shows
// Settings' own grouped sub-menu with a way back. Same colour as the content, set apart by one hairline (styles.css).
import { useEffect, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import {
  Gauge, Activity, AudioLines, Bell, BookOpen, Box, ChevronLeft, Cpu, Download, FileText, Inbox, KeyRound, Layers, ScrollText, Search,
  Settings, SquarePen, SquareTerminal, SunMoon, UserRound, Users, Waypoints, type LucideProps,
} from 'lucide-react';
import type { BotStatus } from '../../../src/contracts.ts';
import { badgeText, type BadgeCounts } from '../badges.logic.ts';
import { defaultPath, inSettings, routeForPath, routes, sections, settingsGroups, type BadgeKey, type Route, type RouteId } from '../routes.ts';
import { statusView, type StatusTone } from '../status.logic.ts';
import { cx } from '../ui/index.ts';
import { OPEN_COMMAND_PALETTE } from './events.ts';
import { ariaMod, isMac, mod } from './keys.ts';
import { focusScreen } from './Shortcuts.tsx';
import { SETTINGS_PATH } from './shortcuts.logic.ts';
import { SetupRow } from '../setup/SetupRow.tsx';
import downIcon from '../../../assets/brand/serra-status-down.png';
import needsYouIcon from '../../../assets/brand/serra-status-needs-you.png';
import upIcon from '../../../assets/brand/serra-status-up.png';

/** Each screen's icon, shared with the command palette's Go to rows. */
export const routeIcons: Partial<Record<RouteId, ComponentType<LucideProps>>> = {
  'jobs-needs-you': Inbox,
  'knowledge-overview': Gauge,
  'knowledge-graph': Waypoints,
  'about-me': UserRound,
  proposals: FileText,
  pages: BookOpen,
  brief: ScrollText,
  'settings-bot': Activity,
  'settings-people': Users,
  'settings-repositories': Layers,
  'settings-alerts': Bell,
  'settings-worker': Cpu,
  'settings-meetings': AudioLines,
  secrets: KeyRound,
  tools: Box,
  updates: Download,
  diagnostics: SquareTerminal,
  'settings-appearance': SunMoon,
};

// Before the first status report there is no honest colour, so the icon is shown greyed out.
const statusIcons: Record<StatusTone, string> = { up: upIcon, 'needs-you': needsYouIcon, down: downIcon, unknown: downIcon };

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

const TitleRow = ({ status }: { status: BotStatus | null }) => {
  const view = statusView(status);
  // Hooks run on every render, in the same order: call it first, then decide.
  const fullScreen = useFullScreen();
  const insetLights = isMac && !fullScreen;
  return (
    <div className={cx('drag flex h-[52px] shrink-0 items-center pr-3', insetLights ? 'pl-[84px]' : 'pl-4')}>
      {/* The title row moves the window, which takes its mouse events; the name keeps its tooltip. */}
      <div className="no-drag flex min-w-0 items-center gap-2" title={view.detail}>
      <img src={statusIcons[view.tone]} alt="" className={cx('size-[18px] rounded-[5px]', view.tone === 'unknown' && 'opacity-40 grayscale')} />
      <span className="min-w-0 truncate text-[13px]" role="status" aria-label={`Serra: ${view.detail}`} data-status-tone={view.tone}>
        <span className="font-semibold text-ink">Serra</span><span className="text-muted"> · {view.label}</span>
      </span>
      </div>
    </div>
  );
};

/** What a count means, for screen readers: the number alone says nothing. */
const countLabels: Record<BadgeKey, (n: string) => string> = {
  needsYou: (n) => `${n} need you`,
  running: (n) => `${n} running`,
  proposals: (n) => `${n} to review`,
  untagged: (n) => `${n} only for you`,
  drift: (n) => `${n} changed outside Serra`,
};

const itemClass = (active: boolean): string => cx(
  'group flex h-7 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
  active ? 'bg-selected font-medium text-ink' : 'text-muted hover:bg-hover hover:text-ink',
);

const iconClass = 'shrink-0 text-faint group-hover:text-ink group-aria-[current=page]:text-ink';

/** A group of sidebar items under a small heading. */
const Group = ({ id, heading, kbd, children }: { id: string; heading: string | null; kbd?: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5" {...(heading ? { role: 'group', 'aria-labelledby': `nav-${id}` } : {})}>
    {heading && (
      <h2 id={`nav-${id}`} className="flex items-center justify-between px-2 pt-4 pb-1 text-[11px] font-medium text-faint">
        {heading}
        {kbd && <kbd className="font-sans font-normal" aria-hidden>{kbd}</kbd>}
      </h2>
    )}
    {children}
  </div>
);

/** Where Back in Settings goes, and where the Settings entry reopens: the last screen seen on each side. */
const last = { main: defaultPath, settings: SETTINGS_PATH };

/**
 * Arrow keys move between the sidebar's links (Tab still goes through them one by one). Enter on a link opens its
 * screen and moves focus there (the composer, or the screen's heading), so the next Tab lands in the content.
 */
const onNavKey = (event: KeyboardEvent<HTMLElement>): void => {
  // In Settings, Escape goes back to the app, as the Back item does.
  if (event.key === 'Escape') {
    const back = event.currentTarget.querySelector<HTMLAnchorElement>('a[data-settings-back]');
    if (back) { event.preventDefault(); back.click(); focusScreen(last.main, null); return; }
  }
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-route]');
  if (event.key === 'Enter' && link) {
    const path = link.getAttribute('href')?.replace(/^#/, '') ?? '';
    focusScreen(path, link);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLElement>('a[data-route], [data-nav]')];
  const at = links.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
    : (at + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
  links[next]?.focus();
};

const ScreenLink = ({ route, counts, current }: { route: Route; counts: BadgeCounts; current?: boolean }) => {
  const Icon = routeIcons[route.id as RouteId] ?? Inbox;
  const label = route.navLabel ?? route.label;
  // Jobs shows what needs you; with nothing waiting, what's running.
  const key: BadgeKey | undefined = route.id === 'jobs-needs-you' ? (counts.needsYou ? 'needsYou' : 'running') : route.badge;
  const text = key ? badgeText(counts[key]) : null;
  const inner = (
    <>
      <Icon size={15} strokeWidth={1.75} aria-hidden className={iconClass} />
      <span className="flex-1 truncate">{label}</span>
      {key && text && (
        <span
          aria-label={countLabels[key](text)}
          className={cx('min-w-4 text-right text-[11px] tabular-nums', key === 'needsYou' ? 'font-semibold text-warn' : 'text-faint')}
        >
          {text}
        </span>
      )}
    </>
  );
  // Jobs stands for all its tabs, so it is current on any of them, which NavLink can't express.
  if (current !== undefined) {
    return <Link to={route.path} data-route={route.id} className={itemClass(current)} aria-current={current ? 'page' : undefined}>{inner}</Link>;
  }
  return <NavLink to={route.path} data-route={route.id} className={({ isActive }) => itemClass(isActive)}>{inner}</NavLink>;
};

const inNav = (route: Route): boolean => !('nav' in route && route.nav === false);

export const Sidebar = ({ status, counts }: { status: BotStatus | null; counts: BadgeCounts }) => {
  const { pathname } = useLocation();
  const settingsOpen = inSettings(pathname);
  // Remember the last screen on each side, so Back and the Settings entry return to it.
  useEffect(() => {
    if (!routeForPath(pathname)) return;
    if (settingsOpen) last.settings = pathname;
    else last.main = pathname;
  }, [pathname, settingsOpen]);
  // Escape anywhere in Settings goes back, unless a field, dialog or open list has it.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [data-serra-sidebar]')) return;
      if (document.querySelector('dialog[open], :popover-open')) return;
      event.preventDefault();
      document.querySelector<HTMLAnchorElement>('[data-serra-sidebar] a[data-settings-back]')?.click();
      focusScreen(last.main, null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);
  // The Jobs item stands for every Jobs tab; New task has its own button.
  const inJobs = pathname.startsWith('/jobs/') && pathname !== '/jobs/new';
  const settingsRoutes: readonly Route[] = routes.filter((route) => route.section === 'settings');
  return (
    <aside data-serra-sidebar className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
      <TitleRow status={status} />
      {/* Both menus stay in the page, one hidden, so every screen keeps its link (the smoke run walks them all). */}
      <nav aria-label="Screens" hidden={settingsOpen} onKeyDown={onNavKey} className="flex min-h-0 flex-1 flex-col animate-[serra-fade_140ms_ease-out]">
        {/* New task and Search stay in view; only the screens below scroll in a short window. */}
        <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-1.5 pb-2">
          <SetupRow />
          <NavLink
            to="/jobs/new"
            data-route="new-task"
            aria-keyshortcuts={`${ariaMod}+N`}
            className={({ isActive }) => cx(itemClass(isActive), 'font-medium text-ink')}
          >
            <SquarePen size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink" />
            <span className="flex-1">New task</span>
            <kbd className="font-sans text-[11px] font-normal text-faint" aria-hidden>{mod}N</kbd>
          </NavLink>
          <button
            type="button"
            data-nav
            aria-haspopup="dialog"
            aria-keyshortcuts={`${ariaMod}+K`}
            onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
            className={itemClass(false)}
          >
            <Search size={15} strokeWidth={1.75} aria-hidden className={iconClass} />
            <span className="flex-1 text-left">Search</span>
            <kbd className="font-sans text-[11px] text-faint" aria-hidden>{mod}K</kbd>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
          {sections.filter((section) => section.id !== 'settings').map((section) => {
            const items: readonly Route[] = routes.filter((route) => route.section === section.id && inNav(route));
            if (items.length === 0) return null;
            return (
              <Group key={section.id} id={section.id} heading={section.heading}>
                {items.map((route) => (
                  <ScreenLink key={route.id} route={route} counts={counts} {...(route.id === 'jobs-needs-you' ? { current: inJobs } : {})} />
                ))}
              </Group>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-line px-2 py-2">
          <Link to={last.settings} data-nav aria-keyshortcuts={`${ariaMod}+,`} className={itemClass(false)}>
            <Settings size={15} strokeWidth={1.75} aria-hidden className={iconClass} />
            <span className="flex-1">Settings</span>
            <kbd className="font-sans text-[11px] text-faint" aria-hidden>{mod},</kbd>
          </Link>
        </div>
      </nav>
      <nav aria-label="Settings" hidden={!settingsOpen} onKeyDown={onNavKey} className="flex min-h-0 flex-1 flex-col animate-[serra-fade_140ms_ease-out]">
        <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-1.5 pb-1">
          <Link to={last.main} data-nav data-settings-back aria-keyshortcuts="Escape" className={itemClass(false)}>
            <ChevronLeft size={15} strokeWidth={1.75} aria-hidden className={iconClass} />
            <span className="flex-1">Back</span>
            <kbd className="font-sans text-[11px] text-faint" aria-hidden>Esc</kbd>
          </Link>
          <h2 className="px-2 pt-3 text-[15px] leading-5 font-semibold text-ink">Settings</h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
          {settingsGroups.map((group) => (
            <Group key={group} id={`settings-${group}`} heading={group}>
              {settingsRoutes.filter((route) => route.group === group).map((route) => <ScreenLink key={route.id} route={route} counts={counts} />)}
            </Group>
          ))}
        </div>
      </nav>
    </aside>
  );
};
