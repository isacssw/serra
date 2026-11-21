// Appearance (APP-28): the app's theme. An app pref, not part of the bot's profile, so it works with no profile.
import { useState, type ComponentType } from 'react';
import { Monitor, Moon, Sun, type LucideProps } from 'lucide-react';
import type { Theme } from '../../../main/bridge.ts';
import { registerActions } from '../../commands/registry.ts';
import { switchThemeAction, themeLabels, themes } from '../../theme.logic.ts';
import { themeStore, useTheme } from '../../theme.ts';
import { cx, Page, useToast } from '../../ui/index.ts';
import { AppliesBadge } from './SettingsKit.tsx';

const unregister = registerActions([switchThemeAction(themeStore)]);
import.meta.hot?.dispose(unregister);

const icons: Record<Theme, ComponentType<LucideProps>> = { system: Monitor, light: Sun, dark: Moon };

/** System / Light / Dark as one segmented control. Native radios, so arrow keys move between them. */
const ThemeControl = () => {
  const theme = useTheme();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const pick = async (next: Theme): Promise<void> => {
    setSaving(true);
    try { await themeStore.set(next); }
    catch (reason) { toast({ message: `Theme not saved: ${reason instanceof Error ? reason.message : String(reason)}`, tone: 'error' }); }
    finally { setSaving(false); }
  };
  return (
    <div role="radiogroup" aria-label="Theme" aria-busy={saving || undefined} className="inline-flex self-start rounded-md border border-line bg-raised p-0.5">
      {themes.map((value) => {
        const Icon = icons[value];
        const checked = theme === value;
        return (
          <label
            key={value}
            className={cx(
              'relative flex h-8 cursor-pointer items-center gap-1.5 rounded px-3 text-sm font-medium',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus',
              checked ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink',
            )}
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={checked}
              data-theme-option={value}
              onChange={() => { void pick(value); }}
              className="sr-only"
            />
            <Icon size={15} aria-hidden />
            {themeLabels[value]}
          </label>
        );
      })}
    </div>
  );
};

export const Appearance = () => (
  <Page title="Appearance" subtitle="Saved for this app on this Mac, not in the bot's profile.">
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Theme</h2>
          <AppliesBadge when="now" />
        </div>
        <p className="text-sm text-muted">
          System follows macOS. Light and Dark keep Serra that way, including its menus, dialogs and scrollbars.
          Also in ⌘K: Switch theme.
        </p>
      </header>
      <ThemeControl />
    </section>
  </Page>
);
