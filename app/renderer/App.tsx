// The window's router: setup as its own full-window mode (setup/), and the shell with the sidebar, a route per
// screen, last-screen memory and toasts. Each screen lives in its own file under screens/; a screen that needs a
// profile shows the shared setup state until there is one (the route's `needs`).
import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { serra } from './bridge.ts';
import { CommandPalette } from './commands/Palette.tsx';
import { defaultPath, routeForPath, routes, type RouteId } from './routes.ts';
import type { SetupProgress } from '../../src/setup.ts';
import './setup/commands.ts';
import { SETUP_PATH } from './setup/setup.logic.ts';
import { SetupFlow } from './setup/SetupFlow.tsx';
import { SetupGate } from './setup/SetupRequired.tsx';
import { SetupProvider } from './setup/SetupState.tsx';
import { BriefPolicy } from './screens/BriefPolicy.tsx';
import { Diagnostics } from './screens/Diagnostics.tsx';
import { Jobs } from './screens/Jobs.tsx';
import { AboutMe } from './screens/AboutMe.tsx';
import { NewTask } from './screens/NewTask.tsx';
import { Pages } from './screens/Pages.tsx';
import { Proposals } from './screens/Proposals.tsx';
import { Secrets } from './screens/Secrets.tsx';
import { Alerts } from './screens/settings/Alerts.tsx';
import { Appearance } from './screens/settings/Appearance.tsx';
import { BotSlack } from './screens/settings/BotSlack.tsx';
import { People } from './screens/settings/People.tsx';
import { Repositories } from './screens/settings/Repositories.tsx';
import { Worker } from './screens/settings/Worker.tsx';
import { Tools } from './screens/Tools.tsx';
import { Updates } from './screens/Updates.tsx';
import { useBadgeCounts, useBotStatus } from './shell/live.ts';
import { FollowNavigation } from './shell/navigate.ts';
import { focusScreen, Shortcuts } from './shell/Shortcuts.tsx';
import { Sidebar } from './shell/Sidebar.tsx';
import { StarPrompt } from './shell/StarPrompt.tsx';
import { ToastProvider } from './ui/index.ts';

/** The screen for each route. The type makes a route without a screen fail the type check. */
const screens: Record<RouteId, ReactElement> = {
  'jobs-needs-you': <Jobs group="needs you" />,
  'jobs-running': <Jobs group="running" />,
  'jobs-done': <Jobs group="done" />,
  'new-task': <NewTask />,
  'about-me': <AboutMe />,
  proposals: <Proposals />,
  pages: <Pages />,
  brief: <BriefPolicy />,
  'settings-bot': <BotSlack />,
  'settings-people': <People />,
  'settings-repositories': <Repositories />,
  'settings-alerts': <Alerts />,
  'settings-worker': <Worker />,
  secrets: <Secrets />,
  tools: <Tools />,
  updates: <Updates />,
  diagnostics: <Diagnostics />,
  'settings-appearance': <Appearance />,
};

/** Saves the screen in prefs when the owner moves to another one, so the next launch opens there. */
const RememberScreen = () => {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    // The first screen is the one just restored (or the default); saving it again would only race other writers.
    if (first.current) { first.current = false; return; }
    if (!routeForPath(pathname)) return;
    serra()?.app.setPrefs({ lastScreen: pathname }).catch(() => {});
  }, [pathname]);
  return null;
};

/** Tells the main process the window drew its first screen: an update that just installed is confirmed by this. */
const Rendered = () => {
  useEffect(() => { serra()?.app.rendered().catch(() => {}); }, []);
  return null;
};

/** Every screen (and every Jobs tab) opens at its top, not at the last screen's scroll position. */
const ScrollToTop = () => {
  const { pathname } = useLocation();
  useLayoutEffect(() => { document.querySelector('[data-serra-main]')?.scrollTo({ top: 0 }); }, [pathname]);
  return null;
};

const Shell = () => {
  const { pathname } = useLocation();
  const status = useBotStatus();
  const { counts, currentJobs } = useBadgeCounts(status);
  return (
    <div className="flex h-full">
      <button
        type="button"
        onClick={(event) => focusScreen(pathname, event.currentTarget)}
        className="fixed top-2 left-[252px] z-50 -translate-y-20 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Skip to content
      </button>
      <Sidebar status={status} counts={counts} />
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* The title bar's height across the content side: it moves the window, and screens start below it. */}
        <div className="drag h-10 shrink-0" aria-hidden />
        <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" data-serra-main data-path={pathname}>
          <Routes>
            {routes.map((route) => <Route key={route.id} path={route.path} element={<SetupGate route={route}>{screens[route.id]}</SetupGate>} />)}
            <Route path="*" element={<Navigate to={defaultPath} replace />} />
          </Routes>
        </main>
      </div>
      <RememberScreen />
      <CommandPalette />
      <Shortcuts />
      <ScrollToTop />
      <StarPrompt status={status} jobs={currentJobs} />
    </div>
  );
};

// A hash router: the built page loads from a file: URL, where path-based URLs don't resolve.
export const App = ({ setup }: { setup: SetupProgress | null }) => (
  <HashRouter>
    <ToastProvider>
      <SetupProvider initial={setup}>
        <Routes>
          <Route path={`${SETUP_PATH}/*`} element={<SetupFlow />} />
          {/* The old first-run wizard's address (APP-27), from a saved link or an older notification. */}
          <Route path="/welcome" element={<Navigate to={SETUP_PATH} replace />} />
          <Route path="*" element={<Shell />} />
        </Routes>
        <FollowNavigation />
        <Rendered />
      </SetupProvider>
    </ToastProvider>
  </HashRouter>
);
