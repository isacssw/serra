// Step 1: who the bot works for and where it works. Fields Serra can find are filled in (Git name, `gh` login, the
// repository's base branch and GitHub name); the form is saved as it's typed, so quitting halfway loses nothing.
// Once the profile exists, the step shows it instead.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, FolderOpen, UserRound } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { serra } from '../bridge.ts';
import { Button, Input } from '../ui/index.ts';
import { Alert, Card, errorText, StepFooter, StepHeader } from './parts.tsx';
import { holdEveSecret, takeEveSecret } from './eve.logic.ts';
import {
  draftErrors, draftRequest, draftToSave, emptyDraft, FLOW, hasProfile, NEW_PROFILE_PATH, nextPath, profileFolder, restoreDraft, SETUP_PATH, suggestId,
  type DraftForm, type NewProfileChoice,
} from './setup.logic.ts';
import { setupChanged, useSetup } from './SetupState.tsx';

const step = FLOW[0]!;

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <fieldset className="flex flex-col gap-4">
    <legend className="mb-3.5 text-[13px] font-semibold text-ink">{title}</legend>
    {children}
  </fieldset>
);

const Existing = () => {
  const navigate = useNavigate();
  const { progress } = useSetup();
  const [repo, setRepo] = useState<string | null>(null);
  useEffect(() => {
    serra()?.settings.read().then((profile) => setRepo(profile.project.githubRepo || profile.project.path), () => {});
  }, []);
  const rows = [
    ['Bot', progress?.bot ? `${progress.bot.name} · ${progress.bot.id}` : ''],
    ['You', progress?.owner ? `${progress.owner.name} · ${progress.owner.slackUserId}` : ''],
    ['Repository', repo ?? '…'],
  ];
  return (
    <>
      <Card>
        <dl className="flex flex-col divide-y divide-line-subtle">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-3 px-4 py-3 text-[13px]">
              <dt className="w-24 shrink-0 text-muted">{label}</dt>
              <dd className="min-w-0 truncate" title={value}>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="border-t border-line-subtle px-4 py-2.5 text-xs text-faint">Change these in Settings</p>
      </Card>
      <StepFooter back={SETUP_PATH}>
        <Button variant="primary" onClick={() => void navigate(nextPath(progress, step.path))}>Continue</Button>
      </StepFooter>
    </>
  );
};

const ProfileForm = ({ adding }: { adding?: NewProfileChoice }) => {
  const navigate = useNavigate();
  const { refresh } = useSetup();
  const [draft, setDraft] = useState<DraftForm | null>(null);
  const [root, setRoot] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const saved = useRef<string>('');

  // The saved draft first, then what Serra can find for the fields still empty. Adding a profile starts from its name,
  // with you as the profile in use has you: the same person sets up every bot.
  useEffect(() => {
    const bridge = serra();
    if (!bridge) { setDraft(restoreDraft(null)); return; }
    let live = true;
    void (async () => {
      if (adding) {
        const owner = await bridge.settings.read().then((profile) => profile.owner, () => null);
        if (live) {
          setDraft({
            ...emptyDraft(), botName: adding.name,
            ownerName: owner?.name ?? '', ownerSlackUserId: owner?.slackUserId ?? '', githubLogin: owner?.githubLogin ?? '',
          });
        }
      } else {
        const prefs = await bridge.app.getPrefs().catch(() => null);
        const restored = restoreDraft(prefs?.setupDraft);
        saved.current = JSON.stringify(prefs?.setupDraft ?? null);
        if (live) setDraft(restored);
      }
      const defaults = await bridge.setup.defaults().catch(() => null);
      if (!live || !defaults) return;
      setRoot(defaults.profileRoot);
      setDraft((current) => current && ({
        ...current,
        githubLogin: current.githubLogin || defaults.githubLogin,
        ownerName: current.ownerName || defaults.ownerName,
      }));
    })();
    return () => { live = false; };
  }, [adding]);

  // Saves the form a moment after typing stops, and at once when the step closes (Back, Skip, the window going away),
  // so the last edit is never lost. Not after Create: main has cleared the draft for good.
  const latest = useRef<string | null>(null);
  const created = useRef(false);
  const flush = useCallback(() => {
    const text = latest.current;
    // A new profile's form isn't kept: the draft in prefs is first setup's.
    if (adding || created.current || text === null || text === saved.current) return;
    saved.current = text;
    serra()?.app.setPrefs({ setupDraft: JSON.parse(text) as Record<string, string> | null }).catch(() => {});
  }, [adding]);
  useEffect(() => {
    if (!draft) return;
    latest.current = JSON.stringify(draftToSave(draft));
    const timer = setTimeout(flush, 300);
    return () => clearTimeout(timer);
  }, [draft, flush]);
  useEffect(() => {
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, [flush]);

  if (!draft) return <p className="text-[13px] text-muted" role="status">Loading…</p>;

  const errors = touched ? draftErrors(draft) : {};
  const set = (key: keyof DraftForm) => (event: { target: { value: string } }) => {
    setDraft({ ...draft, [key]: event.target.value });
    setError(null);
  };

  const detect = async (path = draft.projectPath) => {
    const bridge = serra();
    if (!bridge || !path.trim().startsWith('/')) return;
    try {
      const found = await bridge.setup.detectProject(path.trim(), draft.remote.trim() || 'origin');
      setRepoNote(found.problem);
      setDraft((current) => current && ({ ...current, baseRef: current.baseRef || found.baseRef, githubRepo: current.githubRepo || found.githubRepo }));
    } catch (failure) { setRepoNote(errorText(failure)); }
  };

  const choose = async () => {
    try {
      const folder = await serra()?.setup.chooseFolder('repository');
      if (!folder) return;
      setDraft((current) => current && ({ ...current, projectPath: folder, baseRef: '', githubRepo: '' }));
      await detect(folder);
    } catch (failure) { setError(errorText(failure)); }
  };

  const create = async () => {
    setTouched(true);
    const problems = draftErrors(draft);
    if (Object.keys(problems).length) {
      // Focus the first field to fix, so keyboard and screen-reader users land on it.
      setTimeout(() => document.querySelector<HTMLElement>('[data-serra-setup] input[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    // eve's bypass secret is taken from memory once, and put back if Create fails so a retry still has it.
    const secret = adding?.eve ? takeEveSecret() : null;
    try {
      created.current = true;
      if (adding) {
        const eve = adding.eve ? { url: adding.eve.url, team: adding.eve.team, secret, accept: adding.eve.host } : null;
        await bridge.profiles.create({ draft: draftRequest(draft), color: adding.color, agent: adding.agent, ...(eve ? { eve } : {}) });
      }
      else await bridge.setup.create(draftRequest(draft));
      setupChanged();
      const progress = await refresh();
      void navigate(nextPath(progress, step.path));
    } catch (failure) { created.current = false; if (adding?.eve) holdEveSecret(secret); setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  return (
    <form className="flex flex-1 flex-col gap-8 pb-10" noValidate onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <Section title="You">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Your name" autoComplete="name" placeholder="Alex Morgan" value={draft.ownerName} onChange={set('ownerName')} error={errors.ownerName} hint="As the bot will call you" />
          <Input label="GitHub login" autoComplete="username" placeholder="octocat" inputClassName="font-mono" value={draft.githubLogin} onChange={set('githubLogin')} error={errors.githubLogin} hint="Your GitHub username" />
        </div>
        <Input label="Slack member ID" placeholder="U0123456789" inputClassName="font-mono" value={draft.ownerSlackUserId}
          onChange={set('ownerSlackUserId')} error={errors.ownerSlackUserId} hint="In Slack: your profile › ⋮ › Copy member ID" spellCheck={false} />
      </Section>

      <Section title="Repository">
        <div className="flex items-start gap-2">
          <Input label="Folder" placeholder="/Users/you/project" inputClassName="font-mono" className="min-w-0 flex-1" value={draft.projectPath}
            onChange={set('projectPath')} onBlur={() => void detect()} error={errors.projectPath}
            hint={repoNote ?? 'The repository you open in T3 Code'} spellCheck={false} />
          {/* Level with the field: its label (16px) and the gap under it (6px). */}
          <Button className="mt-[22px]" icon={<FolderOpen size={14} aria-hidden />} onClick={() => void choose()}>Choose…</Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Base branch (optional)" placeholder="origin/main" inputClassName="font-mono" value={draft.baseRef} onChange={set('baseRef')} spellCheck={false} hint="Where task branches start" />
          <Input label="GitHub repository (optional)" placeholder="owner/repo" inputClassName="font-mono" value={draft.githubRepo}
            onChange={set('githubRepo')} error={errors.githubRepo} spellCheck={false} hint="Found from the Git remote" />
        </div>
      </Section>

      <Section title="Bot">
        <Input label="Name" placeholder="Friday" value={draft.botName} onChange={set('botName')} error={errors.botName ?? errors.botId}
          hint="How it appears in Slack" />
        <details className="group text-[13px]">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-[13px] font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden"><ChevronRight size={13} aria-hidden className="transition-transform group-open:rotate-90" />More options</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Input label="Bot ID" placeholder={suggestId(draft.botName)} inputClassName="font-mono" value={draft.botId} onChange={set('botId')}
              error={errors.botId} hint="Names the service and job branches" spellCheck={false} />
            <Input label="Git remote" inputClassName="font-mono" value={draft.remote} onChange={set('remote')} onBlur={() => void detect()} error={errors.remote} spellCheck={false} />
            <Input label="Profile folder" inputClassName="font-mono" placeholder={root ? profileFolder(draft, root) : ''} value={draft.directory}
              onChange={set('directory')} error={errors.directory} spellCheck={false} />
            <Input label="T3 CLI" inputClassName="font-mono" placeholder="~/.t3/bin/t3" value={draft.t3Bin} onChange={set('t3Bin')} error={errors.t3Bin} spellCheck={false} />
          </div>
        </details>
      </Section>

      {error && <Alert>{error}</Alert>}
      <StepFooter back={adding ? NEW_PROFILE_PATH : SETUP_PATH}>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Creating…' : 'Create profile'}</Button>
      </StepFooter>
    </form>
  );
};

export const YouStep = () => {
  const { progress } = useSetup();
  return (
    <div className="flex flex-1 flex-col gap-8">
      <StepHeader step={step} icon={<UserRound size={18} strokeWidth={1.75} />} summary={hasProfile(progress) ? 'Already set up.' : undefined} />
      {hasProfile(progress) ? <Existing /> : <ProfileForm />}
    </div>
  );
};

/** Add… › Profile's second screen: the same form, for a new profile, with what the first screen picked. */
export const NewProfileForm = () => {
  const choice = useLocation().state as NewProfileChoice | null;
  // Opened without the first screen's choice (a reload): start Add again.
  if (!choice || typeof choice.name !== 'string') return <Navigate to={NEW_PROFILE_PATH} replace />;
  return (
    <div className="flex flex-1 flex-col gap-8">
      <StepHeader step={step} icon={<UserRound size={18} strokeWidth={1.75} />} />
      <ProfileForm adding={choice} />
    </div>
  );
};
