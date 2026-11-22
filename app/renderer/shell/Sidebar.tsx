// The sidebar: the title-bar row (traffic lights on macOS, then the bot's name and state), New task as the primary
// action, search, then one item per screen. Same colour as the content, set apart by one hairline (styles.css).
import { useEffect, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import {
  Activity, AudioLines, Bell, BookOpen, Box, Cpu, Download, FileText, Inbox, KeyRound, Layers, ScrollText, Search, SquarePen,
  SquareTerminal, SunMoon, UserRound, Users, type LucideProps,
} from 'lucide-react';
import type { BotStatus } from '../../../src/contracts.ts';
import { badgeText, type BadgeCounts } from '../badges.logic.ts';
import { routes, sections, type BadgeKey, type RouteId } from '../routes.ts';
import { statusView, type StatusTone } from '../status.logic.ts';
import { cx } from '../ui/index.ts';
import { OPEN_COMMAND_PALETTE } from './events.ts';
import { ariaMod, isMac, mod } from './keys.ts';
import { focusScreen } from './Shortcuts.tsx';
import { SetupRow } from '../setup/SetupRow.tsx';
import downIcon from '../../../assets/brand/serra-status-down.png';
import needsYouIcon from '../../../assets/brand/serra-status-needs-you.png';
import upIcon from '../../../assets/brand/serra-status-up.png';

const icons: Partial<Record<RouteId, ComponentType<LucideProps>>> = {
  'jobs-needs-you': Inbox,
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
  active ? 'bg-selected font-medium text-ink' : 'text-ink/80 hover:bg-hover hover:text-ink',
);

/**
 * Arrow keys move between the sidebar's links (Tab still goes through them one by one). Enter on a link opens its
 * screen and moves focus there (the composer, or the screen's heading), so the next Tab lands in the content.
 */
const onNavKey = (event: KeyboardEvent<HTMLElement>): void => {
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

export const Sidebar = ({ status, counts }: { status: BotStatus | null; counts: BadgeCounts }) => {
  const { pathname } = useLocation();
  // The Jobs item stands for every Jobs tab; New task has its own button.
  const inJobs = pathname.startsWith('/jobs/') && pathname !== '/jobs/new';
  return (
    <aside data-serra-sidebar className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
      <TitleRow status={status} />
      <nav aria-label="Screens" onKeyDown={onNavKey} className="flex min-h-0 flex-1 flex-col">
        {/* New task and Search stay in view; only the screens below scroll in a short window. */}
        <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-1.5 pb-2">
          <SetupRow />
          <NavLink
            to="/jobs/new"
            data-route="new-task"
            aria-keyshortcuts={`${ariaMod}+N`}
            className={cx(
              'flex h-8 items-center gap-2 rounded-lg bg-accent px-2.5 text-[13px] font-medium text-accent-ink transition-colors duration-150',
              'hover:bg-accent/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            )}
          >
            <SquarePen size={15} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="flex-1">New task</span>
            <kbd className="font-sans text-[11px] font-normal opacity-70" aria-hidden>{mod}N</kbd>
          </NavLink>
          <button
            type="button"
            data-nav
            aria-haspopup="dialog"
            aria-keyshortcuts={`${ariaMod}+K`}
            onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
            className={itemClass(false)}
          >
            <Search size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted group-hover:text-ink" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="font-sans text-[11px] text-muted" aria-hidden>{mod}K</kbd>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
          {sections.map((section) => {
            const items = routes.filter((route) => route.section === section.id && !('nav' in route && route.nav === false));
            if (items.length === 0) return null;
            return (
              <div key={section.id} className="flex flex-col gap-0.5" {...(section.heading ? { role: 'group', 'aria-labelledby': `nav-${section.id}` } : {})}>
                {section.heading && (
                  <h2 id={`nav-${section.id}`} className="flex items-center justify-between px-2 pt-4 pb-1 text-[11px] font-medium text-muted">
                    {section.heading}
                    {section.id === 'settings' && <kbd className="font-sans font-normal" aria-hidden>{mod},</kbd>}
                  </h2>
                )}
                {items.map((route) => {
                  const Icon = icons[route.id] ?? Inbox;
                  const label = 'navLabel' in route ? route.navLabel : route.label;
                  // Jobs shows what needs you; with nothing waiting, what's running.
                  const key: BadgeKey | undefined = route.id === 'jobs-needs-you' ? (counts.needsYou ? 'needsYou' : 'running') : 'badge' in route ? route.badge : undefined;
                  const text = key ? badgeText(counts[key]) : null;
                  const inner = (
                    <>
                      <Icon size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted group-hover:text-ink group-aria-[current=page]:text-ink" />
                      <span className="flex-1 truncate">{label}</span>
                      {key && text && (
                        <span
                          aria-label={countLabels[key](text)}
                          className={cx('min-w-4 text-right text-[11px] tabular-nums', key === 'needsYou' ? 'font-semibold text-warn' : 'text-muted')}
                        >
                          {text}
                        </span>
                      )}
                    </>
                  );
                  // Jobs stands for all its tabs, so it is current on any of them, which NavLink can't express.
                  if (route.id === 'jobs-needs-you') {
                    return (
                      <Link key={route.id} to={route.path} data-route={route.id} className={itemClass(inJobs)} aria-current={inJobs ? 'page' : undefined}>
                        {inner}
                      </Link>
                    );
                  }
                  return (
                    <NavLink key={route.id} to={route.path} data-route={route.id} className={({ isActive }) => itemClass(isActive)}>
                      {inner}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </div>
      </nav>
    </aside>
  );
};
