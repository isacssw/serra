// Every screen the window can show, in sidebar order. The router (App.tsx) and the sidebar both read this table,
// so a sidebar item can't exist without a route. Screen tickets replace their own `screens/<Screen>.tsx` and don't
// edit this file or the router.
// Pure data and functions: imported by `node --test` as well as the renderer.

export type SidebarSection = 'jobs' | 'knowledge' | 'brief' | 'settings';

/** The live counts a sidebar item can show (see badges.logic.ts). */
export type BadgeKey = 'needsYou' | 'running' | 'proposals' | 'untagged' | 'drift';

export interface Route {
  id: string;
  path: string;
  /** The sidebar label and the screen's title. */
  label: string;
  section: SidebarSection;
  badge?: BadgeKey;
  /** The sidebar's name for the item when it differs from the screen's (Needs you is the sidebar's Jobs). */
  navLabel?: string;
  /** False for a screen reached from inside another (a Jobs tab, New task's button), not from its own sidebar item. */
  nav?: false;
  /** The ticket that builds the screen, shown on its placeholder. */
  ticket: string;
}

export const routes = [
  { id: 'jobs-needs-you', path: '/jobs/needs-you', label: 'Needs you', navLabel: 'Jobs', section: 'jobs', badge: 'needsYou', ticket: 'APP-12' },
  { id: 'jobs-running', path: '/jobs/running', label: 'Running', section: 'jobs', badge: 'running', nav: false, ticket: 'APP-12' },
  { id: 'jobs-done', path: '/jobs/done', label: 'Done today', section: 'jobs', nav: false, ticket: 'APP-12' },
  { id: 'new-task', path: '/jobs/new', label: 'New task', section: 'jobs', nav: false, ticket: 'APP-25' },
  { id: 'about-me', path: '/knowledge/about', label: 'About me', section: 'knowledge', badge: 'untagged', ticket: 'SERRA-41' },
  { id: 'proposals', path: '/knowledge/proposals', label: 'Proposals', section: 'knowledge', badge: 'proposals', ticket: 'APP-13' },
  { id: 'pages', path: '/knowledge/pages', label: 'Pages', section: 'knowledge', badge: 'drift', ticket: 'APP-20' },
  { id: 'brief', path: '/brief', label: 'Brief & policy', section: 'brief', ticket: 'APP-21' },
  { id: 'settings-bot', path: '/settings/bot', label: 'Bot & Slack', section: 'settings', ticket: 'APP-14' },
  { id: 'settings-people', path: '/settings/people', label: 'People', section: 'settings', ticket: 'APP-14' },
  { id: 'settings-repositories', path: '/settings/repositories', label: 'Repositories', section: 'settings', ticket: 'APP-14' },
  { id: 'settings-alerts', path: '/settings/alerts', label: 'Alerts', section: 'settings', ticket: 'APP-14' },
  { id: 'settings-worker', path: '/settings/worker', label: 'Worker', section: 'settings', ticket: 'APP-14' },
  { id: 'secrets', path: '/settings/secrets', label: 'Secrets', section: 'settings', ticket: 'APP-15' },
  { id: 'tools', path: '/settings/tools', label: 'Tools', section: 'settings', ticket: 'APP-23' },
  { id: 'updates', path: '/settings/updates', label: 'Updates', section: 'settings', ticket: 'APP-19' },
  { id: 'diagnostics', path: '/settings/diagnostics', label: 'Diagnostics', section: 'settings', ticket: 'APP-22' },
  { id: 'settings-appearance', path: '/settings/appearance', label: 'Appearance', section: 'settings', ticket: 'APP-28' },
] as const satisfies readonly Route[];

export type RouteId = (typeof routes)[number]['id'];

/** Sidebar group headings, in order. Jobs is a single item under New task; `brief` sits with Knowledge. */
export const sections: readonly { id: SidebarSection; heading: string | null }[] = [
  { id: 'jobs', heading: null },
  { id: 'knowledge', heading: 'Knowledge' },
  { id: 'brief', heading: null },
  { id: 'settings', heading: 'Settings' },
];

/** What the window opens on when it has no saved screen: the jobs that need the owner. */
export const defaultPath = '/jobs/needs-you';

export const routeForPath = (path: string): Route | undefined => routes.find((route) => route.path === path);

/** Where to start: the screen saved in prefs if it still exists, otherwise the default. */
export const initialPath = (lastScreen: string | null | undefined): string =>
  lastScreen && routeForPath(lastScreen) ? lastScreen : defaultPath;
