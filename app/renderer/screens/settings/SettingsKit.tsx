// What every settings page shares: loading the profile, saving a section, the "applies" badge, the restart banner
// and a card for a section edited as text fields.
import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { RotateCw } from 'lucide-react';
import type { SectionSetting } from '../../../../src/profile-settings.ts';
import type { AppliesWhen, Profile, ProfileSection } from '../../../../src/contracts.ts';
import type { SavedSection } from '../../../main/bridge.ts';
import { serra } from '../../bridge.ts';
import { useBotStatus } from '../../shell/live.ts';
import { Badge, Button, cx, Input, Page, useToast } from '../../ui/index.ts';
import {
  appliesLabel, appliesTone, formChanged, pendingRestart, sectionList, sectionTitles, type FormValues, type RestartSave,
  type SectionForm,
} from './settings.logic.ts';

export type SectionSettings = Record<ProfileSection, SectionSetting>;

// ---------------------------------------------------------------------------------------------------------------
// Saves the running daemon hasn't picked up yet, shared by every settings page for this window's lifetime.
// ---------------------------------------------------------------------------------------------------------------

let restartSaves: RestartSave[] = [];
const restartListeners = new Set<() => void>();
const recordRestartSave = (section: ProfileSection): void => {
  restartSaves = [...restartSaves, { section, savedAt: new Date().toISOString() }];
  for (const listener of restartListeners) listener();
};
const subscribeRestartSaves = (listener: () => void) => { restartListeners.add(listener); return () => { restartListeners.delete(listener); }; };

// ---------------------------------------------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------------------------------------------

export interface SettingsState {
  profile: Profile | null;
  settings: SectionSettings | null;
  /** Why the profile couldn't be read (no profile selected, invalid file, no bridge). */
  error: string | null;
  saveSection(section: ProfileSection, value: unknown): Promise<SavedSection>;
  addPerson(slackUserId: string): Promise<SavedSection>;
  removePerson(slackUserId: string): Promise<SavedSection>;
}

/** The profile and the section table, reloaded when the window regains focus (the CLI may have changed the file). */
export const useSettings = (): SettingsState => {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<SectionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    const bridge = serra();
    if (!bridge) { setError('Settings are only available in the Serra app.'); return; }
    let live = true;
    const load = (): void => {
      Promise.all([bridge.settings.read(), bridge.settings.sections()]).then(
        ([nextProfile, nextSettings]) => { if (live) { setProfile(nextProfile); setSettings(nextSettings); setError(null); } },
        (reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); },
      );
    };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, []);

  const after = useCallback((section: ProfileSection, what: string) => (result: SavedSection): SavedSection => {
    setProfile(result.profile);
    if (!result.changed) toast({ message: `${what}: nothing changed.` });
    else {
      if (result.applies === 'after restart') recordRestartSave(section);
      toast({ message: `${what}. ${appliesLabel(result.applies)}.`, tone: 'success' });
    }
    return result;
  }, [toast]);

  const call = useCallback(async (run: () => Promise<SavedSection> | undefined, section: ProfileSection, what: string) => {
    try {
      const result = await run();
      if (!result) throw new Error('Settings are only available in the Serra app.');
      return after(section, what)(result);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      toast({ message: `Not saved: ${message}`, tone: 'error' });
      throw reason;
    }
  }, [after, toast]);

  return {
    profile, settings, error,
    saveSection: (section, value) => call(() => serra()?.settings.saveSection(section, value ?? null), section, `${sectionTitles[section]} saved`),
    addPerson: (id) => call(() => serra()?.settings.addPerson(id), 'allowedUsers', `Added ${id.trim()}`),
    removePerson: (id) => call(() => serra()?.settings.removePerson(id), 'allowedUsers', `Removed ${id}`),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Page frame, badge and restart banner
// ---------------------------------------------------------------------------------------------------------------

export const AppliesBadge = ({ when }: { when: AppliesWhen }) => (
  <Badge tone={appliesTone(when)}>{appliesLabel(when)}</Badge>
);

/** "Applies now" when every section on the page agrees, otherwise each section says so itself. */
const pageSubtitle = (sections: readonly ProfileSection[], settings: SectionSettings | null): string | undefined => {
  if (!settings) return undefined;
  const whens = [...new Set(sections.map((section) => settings[section].appliesWhen))];
  return whens.length === 1 && whens[0] ? appliesLabel(whens[0]) : 'Each section says when it applies.';
};

const RestartBanner = () => {
  const status = useBotStatus();
  const saves = useSyncExternalStore(subscribeRestartSaves, () => restartSaves);
  const pending = pendingRestart(saves, status);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!pending.length) return null;
  const restart = async (): Promise<void> => {
    setBusy(true);
    try {
      await serra()?.bot.restart();
      toast({ message: 'Restarting the bot.', tone: 'success' });
    } catch (reason) {
      toast({ message: `Couldn't restart: ${reason instanceof Error ? reason.message : String(reason)}`, tone: 'error' });
    } finally { setBusy(false); }
  };
  return (
    <div role="status" className="flex items-center justify-between gap-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
      <span>Saved changes to {sectionList(pending)} apply after the bot restarts.</span>
      <Button variant="primary" size="sm" icon={<RotateCw size={14} />} disabled={busy} onClick={() => { void restart(); }}>Restart bot</Button>
    </div>
  );
};

/** A settings page: title, when it applies, the restart banner, and its sections once the profile has loaded. */
export const SettingsPage = ({ title, sections, state, children }: {
  title: string;
  sections: readonly ProfileSection[];
  state: SettingsState;
  children: (profile: Profile, settings: SectionSettings) => ReactNode;
}) => (
  <Page title={title} subtitle={pageSubtitle(sections, state.settings)}>
    <RestartBanner />
    {state.error
      ? <p role="alert" className="rounded-lg border border-down/40 bg-down/10 px-4 py-3 text-sm">{state.error}</p>
      : state.profile && state.settings ? children(state.profile, state.settings) : <p className="text-sm text-muted">Loading…</p>}
  </Page>
);

// ---------------------------------------------------------------------------------------------------------------
// Section cards
// ---------------------------------------------------------------------------------------------------------------

export const SectionCard = ({ section, settings, description, children, footer }: {
  section: ProfileSection;
  settings: SectionSettings;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) => {
  const setting = settings[section];
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{sectionTitles[section]}</h2>
          <AppliesBadge when={setting.appliesWhen} />
        </div>
        {description && <p className="text-sm text-muted">{description}</p>}
        {setting.note && <p className="text-sm text-warn">{setting.note}</p>}
      </header>
      {children}
      {footer && <div className="flex items-center justify-end gap-2">{footer}</div>}
    </section>
  );
};

export const TextArea = ({ label, error, hint, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string | null; hint?: string }) => {
  const id = useId();
  const note = error || hint;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        className={cx(
          'min-h-20 rounded-md border bg-panel px-3 py-2 text-sm text-ink placeholder:text-muted',
          'focus:outline-2 focus:outline-offset-1 focus:outline-focus',
          error ? 'border-down' : 'border-line',
        )}
        {...rest}
      />
      {note && <p id={`${id}-note`} className={cx('text-xs', error ? 'text-down' : 'text-muted')}>{note}</p>}
    </div>
  );
};

/** Save and Reset for a card. Save stays off while the form is unchanged, invalid or saving. */
export const SaveButtons = ({ changed, valid, saving, onSave, onReset }: { changed: boolean; valid: boolean; saving: boolean; onSave: () => void; onReset: () => void }) => (
  <>
    <Button variant="ghost" disabled={!changed || saving} onClick={onReset}>Reset</Button>
    <Button variant="primary" disabled={!changed || !valid || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</Button>
  </>
);

/** A section edited as text fields, from one of the `SectionForm`s in settings.logic.ts. */
export const FieldsCard = ({ form, profile, settings, state }: { form: SectionForm; profile: Profile; settings: SectionSettings; state: SettingsState }) => {
  const [values, setValues] = useState<FormValues>(() => form.toForm(profile));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A saved section, or one changed outside the app, replaces what the form shows. Reloading an unchanged profile
  // (on window focus) keeps the owner's unsaved edits.
  const current = JSON.stringify((profile as unknown as Record<string, unknown>)[form.section] ?? null);
  useEffect(() => { setValues(form.toForm(profile)); setSaveError(null); }, [form, current]);
  const { value, errors } = form.parse(values);
  const changed = formChanged(form, profile, values);
  const valid = Object.keys(errors).length === 0;
  const save = async (): Promise<void> => {
    if (!changed || !valid) return;
    setSaving(true);
    setSaveError(null);
    try { await state.saveSection(form.section, value ?? null); }
    catch (reason) { setSaveError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SectionCard
        section={form.section}
        settings={settings}
        description={form.description}
        footer={<SaveButtons changed={changed} valid={valid} saving={saving} onSave={() => { void save(); }} onReset={() => setValues(form.toForm(profile))} />}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {form.fields.map((field) => {
            const props = {
              label: field.label,
              placeholder: field.placeholder,
              hint: field.hint,
              value: values[field.key] ?? '',
              error: changed ? errors[field.key] : undefined,
              onChange: (event: { target: { value: string } }) => setValues((current) => ({ ...current, [field.key]: event.target.value })),
            };
            return field.multiline
              ? <TextArea key={field.key} className="sm:col-span-2" {...props} />
              : <Input key={field.key} spellCheck={false} {...props} />;
          })}
        </div>
        {saveError && <p role="alert" className="text-sm text-down">Not saved: {saveError}</p>}
      </SectionCard>
    </form>
  );
};

/**
 * A section edited as a list of rows (other repositories, alert triggers). `parse` turns rows into the section's
 * value (undefined when empty) and problems keyed `<row>.<field>`.
 */
export const useListEditor = <Row,>(
  section: ProfileSection,
  profile: Profile,
  toRows: (profile: Profile) => Row[],
  parse: (rows: readonly Row[]) => { value: unknown; errors: Record<string, string> },
  state: SettingsState,
) => {
  const [rows, setRows] = useState<Row[]>(() => toRows(profile));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const current = JSON.stringify((profile as unknown as Record<string, unknown>)[section] ?? null);
  useEffect(() => { setRows(toRows(profile)); setSaveError(null); }, [current]);
  const { value, errors } = parse(rows);
  const changed = JSON.stringify(value ?? null) !== current;
  const valid = Object.keys(errors).length === 0;
  return {
    rows, errors: changed ? errors : {}, changed, valid, saving, saveError,
    update: (index: number, patch: Partial<Row>) => setRows((list) => list.map((row, i) => (i === index ? { ...row, ...patch } : row))),
    add: (row: Row) => setRows((list) => [...list, row]),
    remove: (index: number) => setRows((list) => list.filter((_, i) => i !== index)),
    reset: () => setRows(toRows(profile)),
    save: async (): Promise<void> => {
      if (!changed || !valid) return;
      setSaving(true);
      setSaveError(null);
      try { await state.saveSection(section, value ?? null); }
      catch (reason) { setSaveError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setSaving(false); }
    },
  };
};
