// What every settings page shares: loading the profile, saving a section, the "applies" badge, the restart banner,
// a card for a section edited as text fields, and the page's one save bar: every section's form registers with it, so
// a page has one Save and one Reset however many sections it holds, and says once when its changes apply.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import type { SectionSetting } from '../../../../src/profile-settings.ts';
import type { AppliesWhen, Profile, ProfileSection } from '../../../../src/contracts.ts';
import type { SavedSection } from '../../../main/bridge.ts';
import { serra } from '../../bridge.ts';
import { useBotStatus } from '../../shell/live.ts';
import { Button, Input, Page, TextArea, useToast } from '../../ui/index.ts';
import { isMac } from '../../shell/keys.ts';
import {
  appliesLabel, formChanged, pendingRestart, sectionList, sectionTitles, type FormValues, type RestartSave,
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
    <div role="status" className="flex items-center justify-between gap-4 rounded-xl border border-warn/30 bg-warn/8 px-4 py-2.5 text-[13px]">
      <span>Saved changes to {sectionList(pending)} apply after the bot restarts.</span>
      <Button variant="primary" size="sm" icon={<RotateCw size={14} />} disabled={busy} onClick={() => { void restart(); }}>Restart bot</Button>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The save bar
// ---------------------------------------------------------------------------------------------------------------

/** One section's unsaved form, as the page's save bar sees it. */
interface PendingSection {
  changed: boolean;
  valid: boolean;
  saving: boolean;
  save(): Promise<void>;
  reset(): void;
  /** Shows every problem, including those on rows not typed in yet. */
  reveal(): void;
}

type RegisterSection = (section: ProfileSection, entry: PendingSection | null) => void;
const SaveBarContext = createContext<RegisterSection | null>(null);

/** Puts a section's form in the page's save bar for as long as it is on screen. */
const useSaveBarSection = (section: ProfileSection, entry: PendingSection): void => {
  const register = useContext(SaveBarContext);
  const latest = useRef(entry);
  latest.current = entry;
  const { changed, valid, saving } = entry;
  useEffect(() => {
    register?.(section, { changed, valid, saving, save: () => latest.current.save(), reset: () => latest.current.reset(), reveal: () => latest.current.reveal() });
  }, [register, section, changed, valid, saving]);
  useEffect(() => () => register?.(section, null), [register, section]);
};

/**
 * A page's one Save and Reset, floating at the bottom of the screen while something is unsaved. `note` says once
 * when the changes apply (after a restart, on the next job). ⌘S saves.
 */
const SaveBar = ({ changed, count = 1, valid, saving, note, onSave, onReset, onReveal }: {
  changed: boolean;
  /** How many sections have unsaved changes. */
  count?: number;
  valid: boolean;
  saving: boolean;
  note?: string | null;
  onSave: () => void;
  onReset: () => void;
  /** Shows the problems that stop a save and focuses the first. */
  onReveal: () => void;
}) => {
  const canSave = changed && valid && !saving;
  const reveal = (): void => {
    onReveal();
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-serra-main] [aria-invalid="true"]')?.focus());
  };
  const save = useRef(canSave ? onSave : reveal);
  save.current = canSave ? onSave : reveal;
  useEffect(() => {
    if (!changed || saving) return;
    const onKey = (event: KeyboardEvent): void => {
      const command = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!command || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      save.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changed, saving]);
  if (!changed) return null;
  return (
    <div role="region" aria-label="Unsaved changes" data-save-bar className="pointer-events-none sticky bottom-0 z-10 mt-auto -mb-10 -mx-2 px-2 pt-12 pb-5 bg-linear-to-t from-canvas from-45% to-transparent animate-[serra-rise_160ms_ease-out]">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl bg-overlay py-2 pr-2 pl-4 shadow-overlay">
        <span aria-hidden className={valid ? 'size-1.5 shrink-0 rounded-full bg-warn' : 'size-1.5 shrink-0 rounded-full bg-down'} />
        <p role="status" className="min-w-0 flex-1 truncate text-[13px]">
          {valid
            ? <span className="font-medium text-ink">{count > 1 ? `Unsaved changes in ${count} sections` : 'Unsaved changes'}</span>
            : <span className="font-medium text-ink">Some fields need attention</span>}
          {valid && note && <span className="text-muted"> · {note}</span>}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" disabled={saving} onClick={onReset}>Reset</Button>
        {!valid && <Button onClick={reveal}>Show</Button>}
        <Button variant="primary" disabled={!canSave} onClick={onSave} aria-keyshortcuts={isMac ? 'Meta+S' : 'Control+S'}>
          {saving ? 'Saving…' : 'Save'}
          {canSave && <kbd aria-hidden className="font-sans text-[11px] font-normal text-current opacity-60">{isMac ? '⌘S' : 'Ctrl+S'}</kbd>}
        </Button>
        </div>
      </div>
    </div>
  );
};

/** The save bar for every section form on a settings page. */
const PageSaveBar = ({ entries, settings }: { entries: Partial<Record<ProfileSection, PendingSection>>; settings: SectionSettings | null }) => {
  const pending = Object.entries(entries).flatMap(([section, entry]) => (entry?.changed ? [{ section, entry }] : []));
  const latest = (when: AppliesWhen): number => ['now', 'next job', 'after restart'].indexOf(when);
  const applies = pending.reduce<AppliesWhen>((when, { section }) => {
    const next = settings?.[section as ProfileSection]?.appliesWhen ?? 'now';
    return latest(next) > latest(when) ? next : when;
  }, 'now');
  return (
    <SaveBar
      changed={pending.length > 0}
      count={pending.length}
      valid={pending.every(({ entry }) => entry.valid)}
      saving={pending.some(({ entry }) => entry.saving)}
      note={applies === 'now' ? null : appliesLabel(applies)}
      onSave={() => { void (async () => { for (const { entry } of pending) await entry.save(); })(); }}
      onReset={() => { for (const { entry } of pending) entry.reset(); }}
      onReveal={() => { for (const { entry } of pending) entry.reveal(); }}
    />
  );
};

/** A settings page: title, the restart banner, its sections once the profile has loaded, and the save bar. */
export const SettingsPage = ({ title, state, children }: {
  title: string;
  state: SettingsState;
  children: (profile: Profile, settings: SectionSettings) => ReactNode;
}) => {
  const [entries, setEntries] = useState<Partial<Record<ProfileSection, PendingSection>>>({});
  const register = useCallback<RegisterSection>((section, entry) => setEntries((current) => {
    const next = { ...current };
    if (entry) next[section] = entry;
    else delete next[section];
    return next;
  }), []);
  return (
    <SaveBarContext.Provider value={register}>
      <Page title={title} width="narrow">
        <RestartBanner />
        {state.error
          ? <p role="alert" className="rounded-xl border border-down/30 bg-down/8 px-4 py-2.5 text-[13px]">{state.error}</p>
          : state.profile && state.settings ? children(state.profile, state.settings) : <p className="text-[13px] text-muted">Loading…</p>}
        <PageSaveBar entries={entries} settings={state.settings} />
      </Page>
    </SaveBarContext.Provider>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Section cards
// ---------------------------------------------------------------------------------------------------------------

export const SectionCard = ({ section, description, children }: {
  section: ProfileSection;
  settings: SectionSettings;
  description?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5 shadow-card">
    <header className="flex flex-col gap-1">
      <h2 className="text-[15px] leading-5 font-semibold">{sectionTitles[section]}</h2>
      {description && <p className="text-[13px] text-muted">{description}</p>}
    </header>
    {children}
  </section>
);

/** A section edited as text fields, from one of the `SectionForm`s in settings.logic.ts. */
export const FieldsCard = ({ form, profile, settings, state }: { form: SectionForm; profile: Profile; settings: SectionSettings; state: SettingsState }) => {
  const [values, setValues] = useState<FormValues>(() => form.toForm(profile));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A saved section, or one changed outside the app, replaces what the form shows. Reloading an unchanged profile
  // (on window focus) keeps the owner's unsaved edits.
  const current = JSON.stringify((profile as unknown as Record<string, unknown>)[form.section] ?? null);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the section's content: a reload of the same profile must keep unsaved edits.
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
  useSaveBarSection(form.section, { changed, valid, saving, save, reset: () => setValues(form.toForm(profile)), reveal: () => {} });
  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SectionCard section={form.section} settings={settings} description={form.description}>
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
export const useListEditor = <Row extends object,>(
  section: ProfileSection,
  profile: Profile,
  toRows: (profile: Profile) => Row[],
  parse: (rows: readonly Row[]) => { value: unknown; errors: Record<string, string> },
  state: SettingsState,
) => {
  const [rows, setRows] = useState<Row[]>(() => toRows(profile));
  // Rows just added and not yet typed in: their empty fields aren't marked as errors until the owner gets to them.
  const [fresh] = useState(() => new WeakSet<Row>());
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const current = JSON.stringify((profile as unknown as Record<string, unknown>)[section] ?? null);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the section's content: a reload of the same profile must keep unsaved edits.
  useEffect(() => { setRows(toRows(profile)); setSaveError(null); }, [current]);
  const { value, errors } = parse(rows);
  const changed = JSON.stringify(value ?? null) !== current;
  const valid = Object.keys(errors).length === 0;
  const save = async (): Promise<void> => {
    if (!changed || !valid) return;
    setSaving(true);
    setSaveError(null);
    try { await state.saveSection(section, value ?? null); }
    catch (reason) { setSaveError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const reset = (): void => { setRevealed(false); setRows(toRows(profile)); };
  useSaveBarSection(section, { changed, valid, saving, save, reset, reveal: () => setRevealed(true) });
  return {
    rows, changed, valid, saving, saveError,
    errors: changed ? Object.fromEntries(Object.entries(errors).filter(([key]) => { const row = rows[Number(key.split('.')[0])]; return revealed || !row || !fresh.has(row); })) : {},
    update: (index: number, patch: Partial<Row>) => setRows((list) => list.map((row, i) => (i === index ? { ...row, ...patch } : row))),
    add: (row: Row) => { fresh.add(row); setRows((list) => [...list, row]); },
    remove: (index: number) => setRows((list) => list.filter((_, i) => i !== index)),
    reset,
    save,
  };
};
