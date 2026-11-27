// What every settings page shares: loading the profile, saving a section, the restart banner, the section layout (a
// title on the left, its fields on the right, sections split by hairlines instead of boxed in cards), the closed
// Advanced disclosure, and the page's one save bar: every section's form registers with it, so a page has one Save and
// one Reset however many sections it holds, and says once when its changes apply.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronRight, RotateCw } from 'lucide-react';
import type { SectionSetting } from '../../../../src/profile-settings.ts';
import type { AppliesWhen, Profile, ProfileSection } from '../../../../src/contracts.ts';
import type { SavedSection } from '../../../main/bridge.ts';
import { serra } from '../../bridge.ts';
import { useBotStatus } from '../../shell/live.ts';
import { Button, Input, Page, TextArea, cx, useToast } from '../../ui/index.ts';
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
// The restart banner
// ---------------------------------------------------------------------------------------------------------------

/** After a save the running bot hasn't picked up: one quiet line and Restart, until the bot restarts. */
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
    <div role="status" className="flex items-center gap-3 rounded-xl bg-raised py-2 pr-2 pl-4 text-[13px]">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
      <span className="min-w-0 flex-1"><span className="font-medium text-ink">Restart to apply</span><span className="text-muted"> · {sectionList(pending)}</span></span>
      <Button size="sm" icon={<RotateCw size={13} />} disabled={busy} onClick={() => { void restart(); }}>Restart bot</Button>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The save bar
// ---------------------------------------------------------------------------------------------------------------

/** One form's unsaved changes, as the page's save bar sees it. */
interface PendingSection {
  changed: boolean;
  valid: boolean;
  saving: boolean;
  /** When the change applies, for a form that isn't a profile section (the agent backend). */
  applies?: AppliesWhen;
  save(): Promise<void>;
  reset(): void;
  /** Shows every problem, including those on rows not typed in yet. */
  reveal(): void;
}

/** A profile section, or another form on a settings page (the agent backend), by a key of its own. */
export type SaveBarKey = ProfileSection | 'agentBackend';

type RegisterSection = (key: SaveBarKey, entry: PendingSection | null) => void;
const SaveBarContext = createContext<RegisterSection | null>(null);

/** Puts a form in the page's save bar for as long as it is on screen. */
export const useSaveBarSection = (key: SaveBarKey, entry: PendingSection): void => {
  const register = useContext(SaveBarContext);
  const latest = useRef(entry);
  latest.current = entry;
  const { changed, valid, saving, applies } = entry;
  useEffect(() => {
    register?.(key, {
      changed, valid, saving, ...(applies ? { applies } : {}),
      save: () => latest.current.save(), reset: () => latest.current.reset(), reveal: () => latest.current.reveal(),
    });
  }, [register, key, changed, valid, saving, applies]);
  useEffect(() => () => register?.(key, null), [register, key]);
};

/**
 * A page's one Save and Reset, floating at the bottom of the screen while something is unsaved. `note` says once
 * when the changes apply (after a restart, on the next job). ⌘S saves.
 */
export const SaveBar = ({ changed, count = 1, valid, saving, note, onSave, onReset, onReveal }: {
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
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLElement>('[data-serra-main] [aria-invalid="true"]');
      // A problem inside a closed Advanced section opens it first, so focus lands on something visible.
      const closed = field?.closest('details');
      if (closed && !closed.open) closed.open = true;
      field?.focus();
    });
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
          {canSave && <kbd aria-hidden className="font-sans text-[11px] font-normal text-current opacity-75">{isMac ? '⌘S' : 'Ctrl+S'}</kbd>}
        </Button>
        </div>
      </div>
    </div>
  );
};

const APPLIES_ORDER: readonly AppliesWhen[] = ['now', 'next job', 'after restart'];

/** The save bar for every form on a settings page. */
const PageSaveBar = ({ entries, settings }: { entries: Partial<Record<SaveBarKey, PendingSection>>; settings: SectionSettings | null }) => {
  const pending = Object.entries(entries).flatMap(([key, entry]) => (entry?.changed ? [{ key, entry }] : []));
  const applies = pending.reduce<AppliesWhen>((when, { key, entry }) => {
    const next = entry.applies ?? settings?.[key as ProfileSection]?.appliesWhen ?? 'now';
    return APPLIES_ORDER.indexOf(next) > APPLIES_ORDER.indexOf(when) ? next : when;
  }, 'now');
  return (
    <SaveBar
      changed={pending.length > 0}
      count={pending.length}
      valid={pending.every(({ entry }) => entry.valid)}
      saving={pending.some(({ entry }) => entry.saving)}
      note={appliesLabel(applies)}
      onSave={() => { void (async () => { for (const { entry } of pending) await entry.save(); })(); }}
      onReset={() => { for (const { entry } of pending) entry.reset(); }}
      onReveal={() => { for (const { entry } of pending) entry.reveal(); }}
    />
  );
};

/** A settings page: title, the restart banner, its sections once the profile has loaded, and the save bar. */
export const SettingsPage = ({ title, subtitle, state, children }: {
  title: string;
  subtitle?: ReactNode;
  state: SettingsState;
  children: (profile: Profile, settings: SectionSettings) => ReactNode;
}) => {
  const [entries, setEntries] = useState<Partial<Record<SaveBarKey, PendingSection>>>({});
  const register = useCallback<RegisterSection>((key, entry) => setEntries((current) => {
    const next = { ...current };
    if (entry) next[key] = entry;
    else delete next[key];
    return next;
  }), []);
  return (
    <SaveBarContext.Provider value={register}>
      <Page title={title} subtitle={subtitle} width="narrow">
        <RestartBanner />
        {state.error
          ? <p role="alert" className="rounded-xl border border-down/30 bg-down/8 px-4 py-2.5 text-[13px]">{state.error}</p>
          : state.profile && state.settings
            ? <Sections>{children(state.profile, state.settings)}</Sections>
            : <p className="text-[13px] text-muted">Loading…</p>}
        <PageSaveBar entries={entries} settings={state.settings} />
      </Page>
    </SaveBarContext.Provider>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Section layout
// ---------------------------------------------------------------------------------------------------------------

/** A page's sections, one under another, split by hairlines. The first sits right under the page title. */
const Sections = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col divide-y divide-line [&>*]:py-7 [&>*:first-child]:pt-1 [&>*:last-child]:pb-2">{children}</div>
);

/**
 * One section: its title and a short line on the left, its fields on the right. On a narrow window the two stack.
 * `action` sits under the description (Add ACP agent, Add repository).
 */
export const SettingsSection = ({ title, description, action, children, id }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) => (
  <section aria-labelledby={id} className="grid gap-x-10 gap-y-4 md:grid-cols-[11.5rem_minmax(0,1fr)]">
    <header className="flex flex-col gap-1">
      <h2 id={id} className="text-sm leading-5 font-semibold text-ink">{title}</h2>
      {description && <p className="text-[13px] leading-5 text-muted">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </header>
    <div className="flex min-w-0 flex-col gap-4">{children}</div>
  </section>
);

/** Rarely changed sections, behind a closed disclosure. `summary` names what is inside. */
export const Advanced = ({ summary, children }: { summary: string; children: ReactNode }) => (
  <details className="group">
    <summary className={cx(
      'flex w-fit cursor-pointer list-none items-center gap-2 rounded-md py-1 pr-2 text-[13px] select-none [&::-webkit-details-marker]:hidden',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    )}>
      <ChevronRight size={15} aria-hidden className="text-muted transition-transform duration-150 group-open:rotate-90" />
      <span className="font-medium text-ink">Advanced</span>
      <span className="text-faint">{summary}</span>
    </summary>
    <div className="mt-5 flex flex-col divide-y divide-line-subtle [&>*]:py-6 [&>*:first-child]:pt-1 [&>*:last-child]:pb-0">{children}</div>
  </details>
);

// ---------------------------------------------------------------------------------------------------------------
// Forms made of text fields
// ---------------------------------------------------------------------------------------------------------------

/**
 * One section's text fields from a `SectionForm`: the values, their problems (once something changed), and a
 * save-bar entry. `field(key)` gives an Input's props for one field, for pages that lay their fields out by hand.
 */
export const useSectionForm = (form: SectionForm, profile: Profile, state: SettingsState) => {
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
  const set = (key: string, text: string): void => setValues((now) => ({ ...now, [key]: text }));
  const shown = changed ? errors : {};
  return {
    values, set, changed, saveError, errors: shown,
    field: (key: string) => {
      const spec = form.fields.find((entry) => entry.key === key);
      return {
        ...(spec?.label ? { label: spec.label } : {}),
        ...(spec?.placeholder ? { placeholder: spec.placeholder } : {}),
        ...(spec?.hint ? { hint: spec.hint } : {}),
        value: values[key] ?? '', error: shown[key] ?? null,
        onChange: (event: { target: { value: string } }) => set(key, event.target.value),
      };
    },
  };
};

/** A save that failed in main, under the section it belongs to. */
export const SaveError = ({ message }: { message: string | null }) =>
  message ? <p role="alert" className="text-[13px] text-down">Not saved: {message}</p> : null;

/** A section edited as text fields, from one of the `SectionForm`s in settings.logic.ts. */
export const FieldsCard = ({ form, profile, state, title, description, columns = 2 }: {
  form: SectionForm;
  profile: Profile;
  state: SettingsState;
  /** Overrides the section's title from `sectionTitles`. */
  title?: string;
  /** Overrides the form's own description. */
  description?: ReactNode;
  columns?: 1 | 2;
}) => {
  const editor = useSectionForm(form, profile, state);
  return (
    <form onSubmit={(event) => { event.preventDefault(); }}>
      <SettingsSection title={title ?? sectionTitles[form.section]} description={description ?? (form.description || undefined)}>
        <div className={cx('grid gap-4', columns === 2 && 'sm:grid-cols-2')}>
          {form.fields.map((field) => {
            const props = editor.field(field.key);
            return field.multiline
              ? <TextArea key={field.key} className="sm:col-span-2" {...props} label={field.label} />
              : <Input key={field.key} spellCheck={false} inputClassName={field.mono ? 'font-mono' : undefined} {...props} />;
          })}
        </div>
        <SaveError message={editor.saveError} />
      </SettingsSection>
    </form>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Forms made of rows
// ---------------------------------------------------------------------------------------------------------------

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
    /** Replaces one row, or adds it at the end when `index` is null. */
    put: (index: number | null, row: Row) => setRows((list) => (index === null ? [...list, row] : list.map((old, i) => (i === index ? row : old)))),
    add: (row: Row) => { fresh.add(row); setRows((list) => [...list, row]); },
    remove: (index: number) => setRows((list) => list.filter((_, i) => i !== index)),
    reset,
    save,
  };
};
