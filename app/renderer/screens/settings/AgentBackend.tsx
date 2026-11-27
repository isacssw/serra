// Settings › Worker › Agent: which agent new work runs on, T3 (the default) or an ACP agent found on this Mac, picked
// from cards with each agent's mark; that agent's model; and custom ACP harnesses added from the app or
// `agent-backend.json`. The choice is a draft saved by the page's save bar. Reloads live when `agent-backend.json`
// changes on disk or when the window regains focus.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Code2, FileCode2, Layers, MousePointer2, Plus, Rocket, Sparkle, SquareTerminal, Terminal, X } from 'lucide-react';
import type { AgentBackendView } from '../../../../src/agent/acp-agents.ts';
import { serra } from '../../bridge.ts';
import { BrandMark, Button, cx, Dialog, Input, useToast } from '../../ui/index.ts';
import {
  agentChoice, agentDraftChanged, agentOptions, savedAgentDraft, validateCustomAgentForm, type AgentDraft, type AgentMark,
  type AgentOption,
} from './agent-backend.logic.ts';
import { useSaveBarSection } from './SettingsKit.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** An agent's or a T3 provider's mark: Claude's brand mark, a lucide glyph for the rest. Decorative. */
export const AgentGlyph = ({ mark, size = 16 }: { mark: AgentMark; size?: number }) => {
  const props = { size, strokeWidth: 1.75, 'aria-hidden': true } as const;
  const glyphs: Record<AgentMark, ReactNode> = {
    t3: <Layers {...props} />,
    claude: <BrandMark brand="claude" size={size - 1} />,
    codex: <Code2 {...props} />,
    opencode: <SquareTerminal {...props} />,
    gemini: <Sparkle {...props} />,
    cursor: <MousePointer2 {...props} />,
    antigravity: <Rocket {...props} />,
    custom: <Terminal {...props} />,
  };
  return glyphs[mark];
};

/**
 * The agent backend as the Worker page edits it: the view from main, the draft choice and model, and the save-bar
 * entry that sends them. Adding and removing a custom agent writes at once (they are their own dialogs and buttons).
 */
export const useAgentBackend = () => {
  const toast = useToast();
  const [view, setView] = useState<AgentBackendView | null>(null);
  const [draft, setDraft] = useState<AgentDraft>({ choice: 't3', model: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback((silent = false) => {
    const bridge = serra();
    if (!bridge) return;
    bridge.meetings.agentBackend().then(setView, (failure: unknown) => {
      if (!silent) toast({ message: message(failure), tone: 'error' });
    });
  }, [toast]);

  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    load(false);
    const refresh = (): void => load(true);
    const off = bridge.on.agentBackend(refresh);
    window.addEventListener('focus', refresh);
    return () => { off(); window.removeEventListener('focus', refresh); };
  }, [load]);

  // What is saved replaces the draft whenever it changes (a save, or an edit on disk).
  const saved = view ? savedAgentDraft(view) : { choice: 't3', model: '' };
  const savedKey = `${saved.choice}\n${saved.model}`;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on what is saved, so a reload that changes nothing keeps the draft.
  useEffect(() => { setDraft(saved); }, [savedKey]);

  const changed = view !== null && agentDraftChanged(saved, draft);
  const save = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge || !changed) return;
    setSaving(true);
    try {
      setView(await bridge.meetings.setAgentBackend(agentChoice(draft)));
      toast({ message: 'Agent saved. Applies on the next job.', tone: 'success' });
    } catch (failure) { toast({ message: `Not saved: ${message(failure)}`, tone: 'error' }); }
    finally { setSaving(false); }
  };
  useSaveBarSection('agentBackend', { changed, valid: true, saving, applies: 'next job', save, reset: () => setDraft(saved), reveal: () => {} });

  return {
    view, setView, draft, saving,
    /** Picks an option; an ACP agent brings back the model saved for it. */
    pick: (choice: string) => setDraft({ choice, model: choice === 't3' ? '' : view?.models[choice.slice(4)] ?? '' }),
    setModel: (model: string) => setDraft((current) => ({ ...current, model })),
  };
};

export type AgentBackend = ReturnType<typeof useAgentBackend>;

/** One card: the mark, the name and what it is, and a radio dot. */
const AgentCard = ({ option, checked, focusable, onPick, onKeyDown, onRemove, busy }: {
  option: AgentOption;
  checked: boolean;
  focusable: boolean;
  onPick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onRemove?: () => void;
  busy: boolean;
}) => (
  <div className="group/card relative">
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={option.disabled || undefined}
      data-value={option.value}
      tabIndex={focusable ? 0 : -1}
      onClick={() => { if (!option.disabled) onPick(); }}
      onKeyDown={onKeyDown}
      className={cx(
        'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring',
        option.disabled
          ? 'cursor-not-allowed border-line bg-transparent'
          : checked
            ? 'border-ink bg-raised shadow-field'
            : 'border-line-control bg-panel shadow-field hover:border-faint hover:bg-raised',
        onRemove && 'pr-16',
      )}
    >
      <span aria-hidden className={cx(
        'grid size-8 shrink-0 place-items-center rounded-lg border',
        option.disabled ? 'border-line-subtle text-faint' : 'border-line bg-canvas text-ink',
      )}>
        <AgentGlyph mark={option.mark} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cx('truncate text-[13px] leading-5 font-medium', option.disabled ? 'text-faint' : 'text-ink')}>{option.name}</span>
        <span className="truncate text-xs leading-4 text-faint">{option.detail}</span>
      </span>
      {!option.disabled && (
        <span aria-hidden className={cx(
          'grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-150',
          checked ? 'border-ink bg-ink' : 'border-line-control',
        )}>
          {checked && <span className="size-1.5 rounded-full bg-canvas" />}
        </span>
      )}
    </button>
    {onRemove && (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Remove ${option.name}`}
        title={`Remove ${option.name}`}
        disabled={busy}
        icon={<X size={14} />}
        className="absolute top-1/2 right-9 w-7 -translate-y-1/2 px-0!"
        onClick={onRemove}
      />
    )}
  </div>
);

/** T3 and every ACP agent as cards, a radio group: arrows move and pick, Tab leaves. Custom agents can be removed. */
export const AgentPicker = ({ backend, children }: { backend: AgentBackend; children?: ReactNode }) => {
  const toast = useToast();
  const { view, draft, pick, setView } = backend;
  const [busy, setBusy] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  if (!view) return <p className="text-[13px] text-muted">Looking for agents…</p>;
  const options = agentOptions(view.agents);
  const enabled = options.filter((option) => !option.disabled);
  const checkedIndex = options.findIndex((option) => option.value === draft.choice);
  const focusValue = checkedIndex >= 0 && !options[checkedIndex]!.disabled ? draft.choice : enabled[0]?.value;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = enabled.findIndex((option) => option.value === draft.choice);
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = enabled[(Math.max(at, 0) + step + enabled.length) % enabled.length];
    if (!next) return;
    pick(next.value);
    requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus());
  };

  const remove = async (option: AgentOption): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    try {
      setView(await bridge.meetings.removeAcpAgent(option.value.slice(4)));
      toast({ message: `Removed ${option.name}.`, tone: 'success' });
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <>
      {view.configError && (
        <p role="alert" className="rounded-lg border border-down/30 bg-down/8 px-3 py-2 text-xs text-ink">{view.configError}</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
      <div ref={group} id="agent-backend" role="radiogroup" aria-label="Agent" className="contents">
        {options.map((option) => (
          <AgentCard
            key={option.value}
            option={option}
            checked={option.value === draft.choice}
            focusable={option.value === focusValue}
            onPick={() => pick(option.value)}
            onKeyDown={onKeyDown}
            busy={busy || backend.saving}
            {...(option.custom ? { onRemove: () => { void remove(option); } } : {})}
          />
        ))}
      </div>
      {children}
      </div>
    </>
  );
};

/** Opens `agent-backend.json` outside the app, for agents with their own environment. */
export const ConfigFileButton = ({ backend }: { backend: AgentBackend }) => {
  const toast = useToast();
  if (!backend.view) return null;
  const openConfig = async (): Promise<void> => {
    try { await serra()?.meetings.openAgentBackendConfig(); } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
  };
  return (
    <Button icon={<FileCode2 size={14} />} title={backend.view.configPath} onClick={() => void openConfig()}>Open agent-backend.json</Button>
  );
};

/** The last card in the Agent grid: adds a custom ACP agent through a dialog. */
export const AddAgentCard = ({ backend }: { backend: AgentBackend }) => {
  const toast = useToast();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { view, setView } = backend;
  if (!view) return null;
  const form = validateCustomAgentForm({ name, commandLine: command }, view.agents);

  const openAdd = (): void => { setName(''); setCommand(''); setSubmitted(false); setError(null); setOpen(true); };
  const close = (): void => { if (!adding) setOpen(false); };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    const bridge = serra();
    if (!form.value || !bridge) return;
    setAdding(true);
    try {
      const next = await bridge.meetings.addAcpAgent(form.value);
      setView(next);
      setOpen(false);
      const added = next.agents.find((entry) => entry.id === form.value?.id);
      toast({
        message: added?.installed ? `Added ${form.value.name}.` : `Added ${form.value.name}. Command not on PATH yet.`,
        ...(added?.installed ? { tone: 'success' as const } : {}),
      });
    } catch (failure) { setError(message(failure)); }
    finally { setAdding(false); }
  };
  return (
    <>
      <button
        type="button"
        onClick={openAdd}
        className={cx(
          'flex min-h-[3.75rem] items-center gap-3 rounded-xl border border-dashed border-line-control px-3 py-2.5 text-left text-[13px] font-medium text-ink',
          'transition-colors duration-150 hover:border-line-control hover:bg-hover hover:text-ink',
          'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring',
        )}
      >
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-muted"><Plus size={15} strokeWidth={1.75} /></span>
        Add ACP agent
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Add ACP agent"
        description="Any command that speaks ACP over stdio."
        actions={(
          <>
            <Button variant="ghost" disabled={adding} onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} disabled={adding || (submitted && !form.value)}>
              {adding ? 'Adding…' : 'Add agent'}
            </Button>
          </>
        )}
      >
        <form id={formId} className="flex flex-col gap-3" onSubmit={(event) => { void submit(event); }}>
          <Input
            label="Name"
            placeholder="My agent"
            data-autofocus
            value={name}
            error={submitted || name.trim().length > 0 ? form.errors.name : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label="Command"
            placeholder="my-agent acp"
            spellCheck={false}
            inputClassName="font-mono"
            value={command}
            error={submitted || command.trim().length > 0 ? form.errors.command : undefined}
            onChange={(event) => setCommand(event.target.value)}
          />
          {error && <p role="alert" className="text-xs text-down">{error}</p>}
        </form>
      </Dialog>
    </>
  );
};
