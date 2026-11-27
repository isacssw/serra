// Worker (APP-14): the agent new work runs on (T3 or an ACP agent), its provider and model, how task branches are
// named (with a live example), and, under Advanced, the t3 command and the developer checkout Updates builds from.
import { useEffect, useRef, useState } from 'react';
import type { Profile } from '../../../../src/contracts.ts';
import type { T3Providers } from '../../../../src/t3-providers.ts';
import { serra } from '../../bridge.ts';
import { Input, Select } from '../../ui/index.ts';
import { agentMark } from './agent-backend.logic.ts';
import { AddAgentCard, AgentGlyph, AgentPicker, ConfigFileButton, useAgentBackend, type AgentBackend } from './AgentBackend.tsx';
import { BRANCH_TOKENS, branchPatternForm, branchPreview, t3BinForm, updatesForm, workerForm } from './settings.logic.ts';
import { Advanced, FieldsCard, SaveError, SettingsPage, SettingsSection, useSectionForm, useSettings, type SettingsState } from './SettingsKit.tsx';

/** T3's providers, read once per visit; null while loading or when T3's settings can't be read. */
const useT3Providers = (): T3Providers | null | undefined => {
  const [providers, setProviders] = useState<T3Providers | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const bridge = serra();
    if (!bridge) { setProviders(null); return; }
    bridge.settings.t3Providers().then((found) => { if (live) setProviders(found); }, () => { if (live) setProviders(null); });
    return () => { live = false; };
  }, []);
  return providers;
};

/** The provider picker: T3's default, then each provider instance with its mark. A typed id T3 lacks stays listed. */
const providerOptions = (list: T3Providers, current: string) => {
  const named = list.defaultInstance ? list.providers.find((provider) => provider.instanceId === list.defaultInstance)?.label : undefined;
  const options = [
    { value: '', label: named ? `T3 default (${named})` : 'T3 default', icon: <AgentGlyph mark="t3" size={14} /> },
    // Providers turned off in T3 can't run jobs: only the one already chosen stays listed.
    ...list.providers.filter((provider) => provider.enabled || provider.instanceId === current).map((provider) => ({
      value: provider.instanceId,
      label: provider.label,
      icon: <AgentGlyph mark={agentMark(provider.driver)} size={14} />,
      ...(provider.enabled ? {} : { detail: 'Off in T3' }),
    })),
  ];
  if (current && !list.providers.some((provider) => provider.instanceId === current)) {
    options.push({ value: current, label: current, icon: <AgentGlyph mark={agentMark(current)} size={14} />, detail: 'Not in T3' });
  }
  return options;
};

/** Provider and model in one row: T3's when T3 runs jobs, else the ACP agent's model. */
const ModelSection = ({ backend, profile, state }: { backend: AgentBackend; profile: Profile; state: SettingsState }) => {
  const editor = useSectionForm(workerForm, profile, state);
  const providers = useT3Providers();
  const acp = backend.draft.choice !== 't3';
  const agentName = acp ? backend.view?.agents.find((agent) => `acp:${agent.id}` === backend.draft.choice)?.name : undefined;
  return (
    <SettingsSection
      title="Model"
      description={acp ? 'Empty uses the agent’s default.' : workerForm.description}
    >
      {acp ? (
        <div className="grid gap-4">
          <Input
            label={`${agentName ?? 'Agent'} model`}
            placeholder="Default"
            spellCheck={false}
            value={backend.draft.model}
            hint="No steering mid-turn."
            onChange={(event) => backend.setModel(event.target.value)}
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {providers
            ? (
              <Select
                id="worker-provider"
                label="Provider"
                value={editor.values.provider ?? ''}
                options={providerOptions(providers, editor.values.provider ?? '')}
                error={editor.errors.provider}
                onChange={(provider) => editor.set('provider', provider)}
              />
            )
            : <Input spellCheck={false} inputClassName="font-mono" {...editor.field('provider')} placeholder={providers === undefined ? '' : 'claudeAgent'} />}
          <Input spellCheck={false} {...editor.field('model')} />
        </div>
      )}
      <SaveError message={editor.saveError} />
    </SettingsSection>
  );
};

const SAMPLE_SLUG = 'fix-billing-webhook';

/** The branch pattern, its placeholders as chips that insert at the caret, and the branch a job would get. */
const BranchSection = ({ profile, state }: { profile: Profile; state: SettingsState }) => {
  const editor = useSectionForm(branchPatternForm, profile, state);
  const [now] = useState(() => new Date());
  const input = useRef<HTMLInputElement>(null);
  const pattern = editor.values.branchPattern ?? '';
  const insert = (token: string): void => {
    const field = input.current;
    const start = field?.selectionStart ?? pattern.length;
    const end = field?.selectionEnd ?? pattern.length;
    editor.set('branchPattern', pattern.slice(0, start) + token + pattern.slice(end));
    requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(start + token.length, start + token.length); });
  };
  return (
    <SettingsSection title="Branches" description={branchPatternForm.description}>
      <div className="flex flex-col gap-2.5">
        <Input ref={input} spellCheck={false} inputClassName="font-mono" {...editor.field('branchPattern')} />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Insert a placeholder">
          {BRANCH_TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => insert(token)}
              className="h-6 rounded-md border border-line bg-raised px-1.5 font-mono text-[11px] text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            >
              {token}
            </button>
          ))}
        </div>
        <p className="min-w-0 truncate text-xs text-faint" aria-live="polite">
          Example: <span className="font-mono text-muted">{branchPreview(pattern, { id: profile.bot.id, slug: SAMPLE_SLUG, now })}</span>
        </p>
      </div>
      <SaveError message={editor.saveError} />
    </SettingsSection>
  );
};

/** The page's sections. The agent draft lives here, inside the page, so it reaches the page's save bar. */
const WorkerSections = ({ profile, state }: { profile: Profile; state: SettingsState }) => {
  const backend = useAgentBackend();
  return (
    <>
      <SettingsSection title="Agent" description="Runs every new job." action={<ConfigFileButton backend={backend} />}>
        <AgentPicker backend={backend}><AddAgentCard backend={backend} /></AgentPicker>
      </SettingsSection>
      <ModelSection backend={backend} profile={profile} state={state} />
      <BranchSection profile={profile} state={state} />
      <Advanced summary="T3 command, developer checkout">
        <FieldsCard form={t3BinForm} profile={profile} state={state} columns={1} />
        <FieldsCard form={updatesForm} profile={profile} state={state} title="Developer checkout" />
      </Advanced>
    </>
  );
};

export const Worker = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Worker" subtitle="What runs jobs, tasks and the weekly review." state={state}>
      {(profile) => <WorkerSections profile={profile} state={state} />}
    </SettingsPage>
  );
};
