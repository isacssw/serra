// The window's entry point: apply prefs (theme, last screen), then render the app.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { serra } from './bridge.ts';
import { initialPath } from './routes.ts';
import { isSetupPath, SETUP_PATH } from './setup/setup.logic.ts';
import { themeStore } from './theme.ts';
import './styles.css';

const boot = async (): Promise<void> => {
  const prefs = await serra()?.app.getPrefs().catch(() => null);
  if (prefs) themeStore.load(prefs.theme);
  const setup = await serra()?.setup.progress().catch(() => null) ?? null;
  // Open on the saved screen unless the URL already names one (a reload keeps where it was).
  if (!window.location.hash || window.location.hash === '#/') {
    if (prefs?.lastScreen && isSetupPath(prefs.lastScreen)) {
      // Serra › Set Up Serra… with no window open: once, then the saved screen applies again.
      window.location.hash = prefs.lastScreen;
      serra()?.app.setPrefs({ lastScreen: null }).catch(() => {});
    } else {
      // While a setup step is left, open setup (SERRA-51); it resumes where it stopped and can be skipped.
      window.location.hash = setup && setup.next !== null ? SETUP_PATH : initialPath(prefs?.lastScreen);
    }
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('The page has no #root element.');
  createRoot(root).render(<StrictMode><App setup={setup} /></StrictMode>);
};

void boot();
