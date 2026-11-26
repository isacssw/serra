// Settings › Worker › Agent backend: which agent new work runs on, T3 (the default) or an ACP agent found on this Mac,
// that agent's model, and custom ACP harnesses added from the app or `agent-backend.json`. Reloads live when
// `agent-backend.json` changes on disk or when the window regains focus.
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { FileCode2, Plus, Trash2 } from 'lucide-react';
import type { AcpAgentChoice, AgentBackendView } from '../../../../src/agent/acp-agents.ts';
import { serra } from '../../bridge.ts';
import { Badge, Button, Dialog, Input, useToast } from '../../ui/index.ts';
import { customAgents, validateCustomAgentForm } from './agent-backend.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const AgentBackendCard = () => {
  const toast = useToast();
  const addFormId = useId();
  const [view, setView] = useState<AgentBackendView | null>(null);
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftCommand, setDraftCommand] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

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

  const agent = view?.backend === 'acp' ? view.agent : null;
  useEffect(() => { setModel(agent ? view?.models[agent] ?? '' : ''); }, [agent, view]);
  if (!view) return null;

  const value = agent ? `acp:${agent}` : 't3';
  const custom = customAgents(view.agents);
  const form = validateCustomAgentForm({ name: draftName, commandLine: draftCommand }, view.agents);

  const save = async (choice: { backend: 't3' } | { backend: 'acp'; agent: string; model?: string }): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setSaving(true);
    try { setView(await bridge.meetings.setAgentBackend(choice)); } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setSaving(false); }
  };

  const openAdd = (): void => {
    setDraftName('');
    setDraftCommand('');
    setSubmitted(false);
    setAddError(null);
    setAddOpen(true);
  };

  const closeAdd = (): void => {
    if (saving) return;
    setAddOpen(false);
  };

  const submitAdd = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    setAddError(null);
    if (!form.value) return;
    const bridge = serra();
    if (!bridge) return;
    setSaving(true);
    try {
      const next = await bridge.meetings.addAcpAgent(form.value);
      setView(next);
      setAddOpen(false);
      const added = next.agents.find((entry) => entry.id === form.value?.id);
      toast({
        message: added?.installed ? `Added ${form.value.name}.` : `Added ${form.value.name} (command not found on PATH yet).`,
        ...(added?.installed ? { tone: 'success' as const } : {}),
      });
    } catch (failure) {
      setAddError(message(failure));
    } finally {
      setSaving(false);
    }
  };

  const removeAgent = async (entry: AcpAgentChoice): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setSaving(true);
    try {
      setView(await bridge.meetings.removeAcpAgent(entry.id));
      toast({ message: `Removed ${entry.name}.`, tone: 'success' });
    } catch (failure) {
      toast({ message: message(failure), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const openConfig = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    try {
      await bridge.meetings.openAgentBackendConfig();
    } catch (failure) {
      toast({ message: message(failure), tone: 'error' });
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Agent backend</h2>
          <p className="text-sm text-muted">Runs new jobs, tasks, meetings and the weekly review.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Plus size={14} />} disabled={saving} onClick={openAdd}>Add ACP agent</Button>
          <Button variant="ghost" size="sm" icon={<FileCode2 size={14} />} title={view.configPath} onClick={() => void openConfig()}>Config file</Button>
        </div>
      </header>
      {view.configError && (
        <p role="alert" className="rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-ink">
          {view.configError}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="agent-backend">Run on</label>
          <select
            id="agent-backend"
            className="h-9 min-w-52 max-w-full rounded-md border border-line-control bg-panel px-2 text-sm text-ink focus:outline-2 focus:outline-offset-1 focus:outline-focus disabled:opacity-60"
            value={value}
            disabled={saving}
            onChange={(event) => void save(event.target.value === 't3' ? { backend: 't3' } : { backend: 'acp', agent: event.target.value.slice(4) })}
          >
            <option value="t3">T3 (default)</option>
            <optgroup label="ACP agent">
              {view.agents.map((choice) => (
                <option key={choice.id} value={`acp:${choice.id}`} disabled={!choice.installed}>
                  {choice.installed ? choice.name : `${choice.name} (not installed)`}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        {agent && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save({ backend: 'acp', agent, model }); }}>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium" htmlFor="agent-model">Model</label>
              <input
                id="agent-model"
                className="h-9 w-48 max-w-full rounded-md border border-line-control bg-panel px-2 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-offset-1 focus:outline-focus"
                value={model}
                placeholder="Agent default"
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={saving || model === (view.models[agent] ?? '')}>Save</Button>
          </form>
        )}
      </div>
      {agent && <p className="text-[13px] text-muted">No steering mid-turn: a message waits for the turn to end.</p>}
      {custom.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <p className="text-xs font-medium text-muted">Custom ACP agents</p>
          <ul className="flex flex-col gap-2">
            {custom.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{entry.name}</span>
                    <Badge tone={entry.installed ? 'up' : 'neutral'}>{entry.installed ? 'Ready' : 'Not on PATH'}</Badge>
                  </div>
                  <code className="truncate font-mono text-xs text-muted">{entry.command}</code>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${entry.name}`}
                  disabled={saving}
                  icon={<Trash2 size={14} />}
                  onClick={() => void removeAgent(entry)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      <Dialog
        open={addOpen}
        onClose={closeAdd}
        title="Add ACP agent"
        description="Add any CLI that speaks the Agent Client Protocol over stdio (for example Antigravity, Muse, Grok or pi)."
        actions={(
          <>
            <Button variant="ghost" disabled={saving} onClick={closeAdd}>Cancel</Button>
            <Button variant="primary" type="submit" form={addFormId} disabled={saving || (submitted && !form.value)}>
              {saving ? 'Adding…' : 'Add agent'}
            </Button>
          </>
        )}
      >
        <form id={addFormId} className="flex flex-col gap-3" onSubmit={(event) => { void submitAdd(event); }}>
          <Input
            label="Name"
            placeholder="Antigravity"
            data-autofocus
            value={draftName}
            error={submitted || draftName.trim().length > 0 ? form.errors.name : undefined}
            onChange={(event) => setDraftName(event.target.value)}
          />
          <Input
            label="Command"
            placeholder="agy acp"
            spellCheck={false}
            inputClassName="font-mono"
            hint="Command on your PATH (or an absolute path) with its ACP arguments, e.g. agy acp or pi --acp."
            value={draftCommand}
            error={submitted || draftCommand.trim().length > 0 ? form.errors.command : undefined}
            onChange={(event) => setDraftCommand(event.target.value)}
          />
          <p className="text-xs text-muted">
            Saved to <code className="font-mono">agent-backend.json</code> in your profile. For custom environment variables, edit the config file directly.
          </p>
          {addError && <p role="alert" className="text-xs text-down">{addError}</p>}
        </form>
      </Dialog>
    </section>
  );
};
