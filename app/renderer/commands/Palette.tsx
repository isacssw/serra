// The command palette (⌘K): a search over the action registry, opened from any screen by the shortcut or the
// sidebar's hint. An action that needs a value (Add allowed user) asks for it as a second step.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, CornerDownLeft, LoaderCircle, Search } from 'lucide-react';
import { serra } from '../bridge.ts';
import { CLOSE_COMMAND_PALETTE, OPEN_COMMAND_PALETTE } from '../shell/events.ts';
import { Button, cx, useToast } from '../ui/index.ts';
import { builtinActions } from './builtin.ts';
import { highlightRuns, isPaletteShortcut, moveSelection } from './palette.logic.ts';
import { actionRegistry, registerActions, searchActions, searchChoices, type Action, type ActionContext, type Choice } from './registry.ts';

const unregisterBuiltins = registerActions(builtinActions);
import.meta.hot?.dispose(unregisterBuiltins);

/** The second step of an action that takes a value. `choices` is set when the action offers a list. */
interface Step {
  action: Action;
  choices: Choice[] | null;
  loading: boolean;
}

interface Row {
  key: string;
  label: string;
  indices: number[];
  hint?: string;
  /** A group heading shown above this row. */
  heading?: string;
  pick: () => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const Label = ({ text, indices }: { text: string; indices: number[] }) => (
  <span className="flex-1 truncate">
    {highlightRuns(text, indices).map((run, i) => (run.match ? <mark key={i} className="bg-transparent font-semibold text-ink">{run.text}</mark> : <span key={i}>{run.text}</span>))}
  </span>
);

export const CommandPalette = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const listId = useId();
  const navigate = useNavigate();
  const toast = useToast();
  const context = useMemo<ActionContext>(() => ({ bridge: serra(), navigate: (path) => { void navigate(path); }, toast }), [navigate, toast]);

  const resetTo = (next: Step | null): void => { setStep(next); setQuery(''); setSelected(0); setError(null); setBusy(false); };
  const show = useCallback(() => { resetTo(null); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);

  // ⌘K from anywhere toggles the palette; the sidebar's hint opens it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      if (event.repeat) return;
      if (openRef.current) close();
      else show();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, show);
    window.addEventListener(CLOSE_COMMAND_PALETTE, close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, show);
      window.removeEventListener(CLOSE_COMMAND_PALETTE, close);
    };
  }, [show, close]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open, step]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, listId]);

  const run = async (action: Action): Promise<void> => {
    close();
    try { await action.run(context); }
    catch (failure) { toast({ message: `${action.title}: ${messageOf(failure)}`, tone: 'error' }); }
  };

  const submit = async (action: Action, value: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action.run(context, value);
      close();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const choose = (action: Action): void => {
    const load = action.argument?.choices;
    if (!action.argument) { void run(action); return; }
    resetTo({ action, choices: load ? [] : null, loading: Boolean(load) });
    if (!load) return;
    load(context).then(
      (choices) => setStep((current) => (current?.action === action ? { action, choices, loading: false } : current)),
      (failure) => {
        setStep((current) => (current?.action === action ? { ...current, loading: false } : current));
        setError(messageOf(failure));
      },
    );
  };

  const back = (): void => { if (step) resetTo(null); else close(); };

  let rows: Row[] = [];
  if (open && !step) {
    let lastGroup: string | null = null;
    rows = searchActions(actionRegistry.list(), query).map(({ action, indices }) => {
      const heading = query.trim() === '' && action.group !== lastGroup ? action.group : undefined;
      lastGroup = action.group;
      return { key: action.id, label: action.title, indices, ...(action.hint ? { hint: action.hint } : {}), ...(heading ? { heading } : {}), pick: () => choose(action) };
    });
  } else if (open && step?.choices) {
    const action = step.action;
    rows = searchChoices(step.choices, query).map((choice) => ({
      key: choice.value, label: choice.label, indices: choice.indices, ...(choice.detail ? { hint: choice.detail } : {}),
      pick: () => { void submit(action, choice.value); },
    }));
  }
  const freeText = step !== null && step.choices === null;
  const active = rows.length > 0 ? Math.min(selected, rows.length - 1) : -1;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); return; }
    if (event.key === 'Backspace' && step && query === '') { event.preventDefault(); back(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(moveSelection(active, event.key === 'ArrowDown' ? 1 : -1, rows.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (busy) return;
      if (freeText && step) void submit(step.action, query);
      else rows[active]?.pick();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      data-command-palette
      aria-label="Command palette"
      // Escape is handled in the field (it steps back first); this only covers focus being elsewhere.
      onCancel={(event) => { event.preventDefault(); if (document.activeElement !== inputRef.current) close(); }}
      // `close` arrives a task (or, when frames are slow, several) after the dialog shut, so it can land after ⌘K
      // reopened it. Only a dialog that is still shut means the palette closed.
      onClose={() => { if (!dialogRef.current?.open) setOpen(false); }}
      onClick={(event) => { if (event.target === dialogRef.current) close(); }}
      className="mx-auto mt-[12vh] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-panel p-0 text-ink shadow-[0_24px_64px_-12px_rgb(0_0_0/0.45)] backdrop:bg-black/40"
    >
      {open && (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3">
            {step ? (
              <>
                <Button variant="ghost" size="sm" aria-label="Back" onClick={back} icon={<ArrowLeft size={14} />} />
                <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-xs font-medium">{step.action.title}</span>
              </>
            ) : <Search size={16} aria-hidden className="shrink-0 text-muted" />}
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls={listId}
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              aria-label={step ? step.action.argument?.placeholder : 'Search commands and screens'}
              aria-invalid={error ? true : undefined}
              value={query}
              readOnly={busy}
              onChange={(event) => { setQuery(event.target.value); setSelected(0); setError(null); }}
              onKeyDown={onKeyDown}
              placeholder={step ? step.action.argument?.placeholder : 'Type a command or a screen'}
              spellCheck={false}
              autoComplete="off"
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
            />
            {busy && <LoaderCircle size={16} aria-label="Working" className="shrink-0 animate-spin text-muted" />}
          </div>
          {error && <p role="alert" className="border-b border-line px-4 py-2 text-xs text-down">{error}</p>}
          {freeText && step && (
            <div className="flex items-center justify-between gap-4 px-4 py-3 text-xs text-muted">
              <span>{step.action.argument?.hint}</span>
              <span className="flex shrink-0 items-center gap-1">Enter to {step.action.title.toLowerCase()} <CornerDownLeft size={12} aria-hidden /></span>
            </div>
          )}
          {step?.loading && <p className="px-4 py-6 text-center text-sm text-muted">Loading…</p>}
          {!freeText && !step?.loading && rows.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted">{query ? `Nothing matches “${query}”.` : 'Nothing to pick.'}</p>
          )}
          {rows.length > 0 && (
            <ul id={listId} role="listbox" aria-label={step ? step.action.title : 'Commands'} className="max-h-80 overflow-y-auto p-1.5">
              {rows.map((row, index) => (
                <li key={row.key} role="presentation">
                  {row.heading && <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted">{row.heading}</div>}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    data-action={row.key}
                    onMouseMove={() => { if (index !== active) setSelected(index); }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={row.pick}
                    className={cx('flex h-9 cursor-default items-center gap-3 rounded-md px-2.5 text-sm', index === active && 'bg-selected')}
                  >
                    <Label text={row.label} indices={row.indices} />
                    {row.hint && <span className="shrink-0 text-xs text-muted">{row.hint}</span>}
                    {index === active && <CornerDownLeft size={14} aria-hidden className="shrink-0 text-muted" />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </dialog>
  );
};
