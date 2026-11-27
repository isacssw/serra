// Appearance (APP-28): the app's theme. An app pref, not part of the bot's profile, so it works with no profile.
import { useState, type ComponentType } from 'react';
import { Monitor, Moon, Sun, type LucideProps } from 'lucide-react';
import type { Theme } from '../../../main/bridge.ts';
import { registerActions } from '../../commands/registry.ts';
import { switchThemeAction, themeLabels, themes } from '../../theme.logic.ts';
import { themeStore, useTheme } from '../../theme.ts';
import { cx, Page, useToast } from '../../ui/index.ts';

const unregister = registerActions([switchThemeAction(themeStore)]);
import.meta.hot?.dispose(unregister);

const icons: Record<Theme, ComponentType<LucideProps>> = { system: Monitor, light: Sun, dark: Moon };

/**
 * System / Light / Dark as one segmented control: a groove set into the card, the chosen segment raised out of it.
 * Native radios, so arrow keys move between them.
 */
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
    <div role="radiogroup" aria-labelledby="theme-label" aria-busy={saving || undefined} className="inline-flex shrink-0 gap-0.5 rounded-[9px] border border-line bg-track p-0.5">
      {themes.map((value) => {
        const Icon = icons[value];
        const checked = theme === value;
        return (
          <label
            key={value}
            className={cx(
              'relative flex h-7 cursor-pointer items-center gap-1.5 rounded-[7px] border px-2.5 text-[13px] font-medium transition-colors duration-150',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus',
              checked ? 'border-line-strong bg-overlay text-ink shadow-field' : 'border-transparent text-muted hover:text-ink',
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
            <Icon size={14} strokeWidth={1.75} aria-hidden />
            {themeLabels[value]}
          </label>
        );
      })}
    </div>
  );
};

export const Appearance = () => (
  <Page title="Appearance">
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-panel px-5 py-4 shadow-card">
      <h2 id="theme-label" className="text-[13px] font-medium">Theme</h2>
      <ThemeControl />
    </section>
  </Page>
);
