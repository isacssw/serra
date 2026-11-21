// The first-run wizard (APP-27): profile, Slack app, tokens, owner and the launchd service, replacing `pnpm run setup`
// and the manifest steps. Each step is an owner action in `src/setup.ts` (tokens use the Secrets sources), and the
// step list comes from the profile's files, so the wizard can be left and resumed at any point.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, CircleCheck, Copy, ExternalLink, Lock, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SecretStatus } from '../../../../src/contracts.ts';
import type { ActivationOutcome } from '../../../../src/releases.ts';
import type { SetupProgress, SetupStepId, SlackManifest } from '../../../../src/setup.ts';
import { serra } from '../../bridge.ts';
import { registerActions } from '../../commands/registry.ts';
import { Button, cx, Input, Page, useToast } from '../../ui/index.ts';
import { SecretCard } from '../Secrets.tsx';
import {
  draftErrors, draftRequest, emptyDraft, outcomeText, profileFolder, stepState, STEPS, suggestId, visibleStep, WELCOME_PATH,
  type DraftForm, type StepState,
} from './welcome.logic.ts';

const unregister = registerActions([{
  id: 'setup:open',
  title: 'Setup guide',
  group: 'Actions',
  keywords: ['welcome', 'first run', 'wizard', 'onboard', 'install', 'manifest', 'new bot'],
  button: 'Diagnostics › Setup guide',
  run: (context) => context.navigate(WELCOME_PATH),
}]);
import.meta.hot?.dispose(unregister);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const Alert = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="flex items-start gap-2 rounded-lg border border-down/40 px-4 py-3 text-sm text-down">
    <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
    <span className="break-words">{children}</span>
  </p>
);

const Panel = ({ title, summary, children }: { title: string; summary: string; children: ReactNode }) => (
  <section className="flex min-w-0 flex-1 flex-col gap-5 rounded-lg border border-line bg-panel px-6 py-5" data-setup-panel>
    <header className="flex flex-col gap-1">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted">{summary}</p>
    </header>
    {children}
  </section>
);

const stepIcon = (state: StepState, index: number): ReactNode => {
  if (state === 'done') return <Check size={14} aria-hidden />;
  if (state === 'locked') return <Lock size={12} aria-hidden />;
  return <span className="text-xs tabular-nums">{index + 1}</span>;
};

const StepList = ({ progress, shown, onPick }: { progress: SetupProgress; shown: SetupStepId | 'finished'; onPick: (id: SetupStepId) => void }) => (
  <ol className="flex w-64 shrink-0 flex-col gap-1" aria-label="Setup steps">
    {STEPS.map((step, index) => {
      const state = stepState(progress, step.id);
      const detail = progress.steps.find((item) => item.id === step.id)?.detail;
      return (
        <li key={step.id}>
          <button
            type="button"
            disabled={state === 'locked'}
            onClick={() => onPick(step.id)}
            aria-current={shown === step.id ? 'step' : undefined}
            data-setup-step={step.id}
            data-state={state}
            className={cx(
              'flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left',
              'focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50',
              shown === step.id ? 'bg-raised' : 'hover:bg-raised',
            )}
          >
            <span className={cx(
              'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
              state === 'done' ? 'border-transparent bg-up text-status-ink' : state === 'current' ? 'border-accent text-accent' : 'border-line text-muted',
            )}>
              {stepIcon(state, index)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{step.title}</span>
              {detail && <span className="truncate text-xs text-muted" title={detail}>{detail}</span>}
            </span>
          </button>
        </li>
      );
    })}
  </ol>
);

// ---------------------------------------------------------------------------------------------------------------
// Step 1: profile
// ---------------------------------------------------------------------------------------------------------------

const ProfileStep = ({ progress, onDone }: { progress: SetupProgress; onDone: (next: SetupProgress) => void }) => {
  const [draft, setDraft] = useState<DraftForm>(emptyDraft);
  const [root, setRoot] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const done = progress.steps[0]?.done;

  useEffect(() => {
    const bridge = serra();
    if (!bridge || done) return;
    bridge.setup.defaults().then((defaults) => {
      setRoot(defaults.profileRoot);
      setDraft((current) => (current.githubLogin ? current : { ...current, githubLogin: defaults.githubLogin }));
    }).catch(() => {});
  }, [done]);

  if (done && progress.bot) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p><span className="font-medium">{progress.bot.name}</span> <span className="text-muted">({progress.bot.id})</span></p>
        <p className="font-mono text-xs text-muted break-all">{progress.profileDir}</p>
        <p className="text-muted">Change these later in Settings. To make another bot, start the app with no profile selected.</p>
      </div>
    );
  }

  const errors = touched ? draftErrors(draft) : {};
  const set = (key: keyof DraftForm) => (event: { target: { value: string } }) => { setDraft({ ...draft, [key]: event.target.value }); setError(null); };

  const detect = async () => {
    const bridge = serra();
    if (!bridge || !draft.projectPath.trim().startsWith('/')) return;
    try {
      const found = await bridge.setup.detectProject(draft.projectPath.trim(), draft.remote.trim() || 'origin');
      setRepoNote(found.problem);
      setDraft((current) => ({
        ...current,
        baseRef: current.baseRef || found.baseRef,
        githubRepo: current.githubRepo || found.githubRepo,
      }));
    } catch (failure) { setRepoNote(errorText(failure)); }
  };

  const create = async () => {
    setTouched(true);
    if (Object.keys(draftErrors(draft)).length) return;
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    try { onDone(await bridge.setup.create(draftRequest(draft))); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Bot name" placeholder="Friday" value={draft.botName} onChange={set('botName')} error={errors.botName} autoFocus />
        <Input label="Bot ID" placeholder={suggestId(draft.botName)} value={draft.botId} onChange={set('botId')} error={errors.botId}
          hint="Names the service and job branches. Leave empty to use the suggestion." />
        <Input label="Your name" placeholder="First and last name" value={draft.ownerName} onChange={set('ownerName')} error={errors.ownerName} />
        <Input label="Your Slack member ID" placeholder="U0123456789" inputClassName="font-mono" value={draft.ownerSlackUserId}
          onChange={set('ownerSlackUserId')} error={errors.ownerSlackUserId} hint="Slack › your profile › ⋮ › Copy member ID" />
        <Input label="Your GitHub login" value={draft.githubLogin} onChange={set('githubLogin')} error={errors.githubLogin} />
        <Input label="Git remote" value={draft.remote} onChange={set('remote')} onBlur={() => void detect()} error={errors.remote} />
      </div>
      <Input label="Repository" placeholder="/Users/you/project" inputClassName="font-mono" value={draft.projectPath}
        onChange={set('projectPath')} onBlur={() => void detect()} error={errors.projectPath}
        hint={repoNote ?? 'The absolute path of the repository registered in T3 Code.'} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Base branch" placeholder="origin/main" inputClassName="font-mono" value={draft.baseRef} onChange={set('baseRef')}
          hint="Read from the repository. New worktrees start here." />
        <Input label="GitHub repository" placeholder="acme/project" inputClassName="font-mono" value={draft.githubRepo}
          onChange={set('githubRepo')} error={errors.githubRepo} />
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">More options</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Input label="Profile folder" inputClassName="font-mono" placeholder={root ? profileFolder(draft, root) : ''} value={draft.directory}
            onChange={set('directory')} error={errors.directory} hint="Leave empty for the folder the app looks in." />
          <Input label="T3 CLI" inputClassName="font-mono" placeholder="~/.t3/bin/t3" value={draft.t3Bin} onChange={set('t3Bin')} error={errors.t3Bin} />
        </div>
      </details>
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Creating…' : 'Create profile'}</Button>
        {root && <span className="truncate font-mono text-xs text-muted">{profileFolder(draft, root)}</span>}
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Step 2: Slack app
// ---------------------------------------------------------------------------------------------------------------

const SlackAppStep = ({ onNext }: { onNext: () => void }) => {
  const toast = useToast();
  const [manifest, setManifest] = useState<SlackManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    serra()?.setup.manifest().then(setManifest, (failure) => setError(errorText(failure)));
  }, []);

  const copy = async () => {
    if (!manifest) return;
    try { await navigator.clipboard.writeText(manifest.json); toast({ message: 'Manifest copied.', tone: 'success' }); }
    catch (failure) { toast({ message: `Could not copy: ${errorText(failure)}`, tone: 'error' }); }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <ol className="flex list-decimal flex-col gap-2 pl-5">
        <li><span className="font-medium">Open Slack</span> with the manifest below, pick your workspace and create the app.</li>
        <li>In <span className="font-medium">Install App</span>, install it to the workspace and copy the <span className="font-mono">xoxb-</span> bot token.</li>
        <li>In <span className="font-medium">Basic Information › App-Level Tokens</span>, generate a token with the <span className="font-mono">connections:write</span> scope and copy the <span className="font-mono">xapp-</span> token.</li>
        <li>Invite the bot to a test channel once it is running.</li>
      </ol>
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<ExternalLink size={14} aria-hidden />} disabled={!manifest}
          onClick={() => { if (manifest) serra()?.app.openExternal(manifest.createUrl).catch((failure) => setError(errorText(failure))); }}>
          Open Slack
        </Button>
        <Button icon={<Copy size={14} aria-hidden />} disabled={!manifest} onClick={() => void copy()}>Copy manifest</Button>
        <Button variant="ghost" onClick={onNext}>I have both tokens</Button>
      </div>
      {manifest && (
        <pre className="max-h-64 overflow-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-xs" data-manifest>{manifest.json}</pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Step 3: tokens (APP-15's cards, so the wizard and the Secrets screen behave the same)
// ---------------------------------------------------------------------------------------------------------------

const TokensStep = ({ onChange }: { onChange: () => void }) => {
  const [statuses, setStatuses] = useState<SecretStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  useEffect(() => {
    serra()?.secrets.list().then(setStatuses, (failure) => setError(errorText(failure)));
  }, []);
  const replace = (next: SecretStatus) => {
    setStatuses((list) => list?.map((status) => (status.name === next.name ? next : status)) ?? [next]);
    onChange();
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Keychain stores the value you paste; 1Password keeps it in your vault and the bot reads the reference.
        Save, then press Check: Slack must accept both tokens. Values never come back to this window.
      </p>
      {error && <Alert>{error}</Alert>}
      {statuses?.map((status) => <SecretCard key={status.name} status={status} now={now} onSaved={replace} onChecked={replace} />)}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Step 4: owner
// ---------------------------------------------------------------------------------------------------------------

const OwnerStep = ({ progress, onDone }: { progress: SetupProgress; onDone: () => void }) => {
  const [id, setId] = useState(progress.owner?.slackUserId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try { await bridge.setup.confirmOwner(id.trim()); onDone(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
      {progress.owner?.slackName && (
        <p className="flex items-center gap-2 text-sm"><CircleCheck size={16} className="text-up" aria-hidden />
          Slack knows {progress.owner.slackUserId} as <span className="font-medium">{progress.owner.slackName}</span>.
        </p>
      )}
      <Input label="Owner’s Slack member ID" inputClassName="font-mono" value={id} onChange={(event) => { setId(event.target.value); setError(null); }}
        hint="The bot asks this person when it needs a decision. Add other people later in Settings › People." />
      {error && <Alert>{error}</Alert>}
      <div><Button type="submit" variant="primary" disabled={busy || !id.trim()}>{busy ? 'Checking…' : 'Check in Slack'}</Button></div>
    </form>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Step 5: service
// ---------------------------------------------------------------------------------------------------------------

const ServiceStep = ({ done, onDone }: { done: boolean; onDone: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<ActivationOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => serra()?.on.releaseLog((line) => setLog((lines) => [...lines.slice(-400), line])), []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);

  const install = async () => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setLog([]);
    setOutcome(null);
    setError(null);
    try {
      const result = await bridge.setup.installService();
      setOutcome(result);
      if (result.ok) onDone();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const result = outcome ? outcomeText(outcome) : null;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted">
        Copies this code into a release in the profile, installs its dependencies, runs every Diagnostics check and only
        then starts the bot under launchd. A failing check leaves nothing installed.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => void install()} disabled={busy}>
          {busy ? 'Installing…' : done ? 'Install again' : 'Install and start'}
        </Button>
        {done && !outcome && <span className="flex items-center gap-2"><CircleCheck size={16} className="text-up" aria-hidden /> Installed</span>}
      </div>
      {result && <p role="status" className={cx(result.tone === 'up' ? 'text-up' : 'text-down')}>{result.text}</p>}
      {error && <Alert>{error}</Alert>}
      {log.length > 0 && (
        <pre ref={logRef} className="max-h-64 overflow-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-xs" data-setup-log>{log.join('\n')}</pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------------------------------------------

export const Welcome = () => {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [picked, setPicked] = useState<SetupStepId | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setLoadError('The Serra bridge is not available in this window.'); return; }
    try { setProgress(await bridge.setup.progress()); setLoadError(null); }
    catch (failure) { setLoadError(errorText(failure)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const shown = progress ? visibleStep(progress, picked) : null;
  const info = STEPS.find((step) => step.id === shown);
  const advance = async () => { setPicked(null); await refresh(); };

  return (
    <Page title="Welcome to Serra" subtitle="Set up a bot that brings your coding agents to your chat, in five steps. Slack is the chat channel for now. You can leave and come back; finished steps stay done.">
      {loadError && <Alert>{loadError}</Alert>}
      {progress && shown && (
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <StepList progress={progress} shown={shown} onPick={setPicked} />
          {shown === 'finished' || !info ? (
            <Panel title="Serra is set up" summary="The bot is running. Mention it in a channel it was invited to, or DM it.">
              <p className="text-sm text-muted">
                Next, teach it how you work: the knowledge interview turns your answers into pages it reads on every job.
                Pages and proposals live under Knowledge.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Sparkles size={14} aria-hidden />} onClick={() => void navigate('/jobs/needs-you')}>Open Jobs</Button>
                <Button onClick={() => void navigate('/settings/diagnostics')}>Diagnostics</Button>
              </div>
            </Panel>
          ) : (
            <Panel title={info.title} summary={info.summary}>
              {shown === 'profile' && <ProfileStep progress={progress} onDone={(next) => { setPicked(null); setProgress(next); }} />}
              {shown === 'slackApp' && <SlackAppStep onNext={() => setPicked('tokens')} />}
              {shown === 'tokens' && <TokensStep onChange={() => void refresh()} />}
              {shown === 'owner' && <OwnerStep progress={progress} onDone={() => void advance()} />}
              {shown === 'service' && <ServiceStep done={progress.steps.find((step) => step.id === 'service')?.done === true} onDone={() => void advance()} />}
            </Panel>
          )}
        </div>
      )}
    </Page>
  );
};
