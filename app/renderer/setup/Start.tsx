// Setup's first screen. A first-time owner gets a short welcome and what they'll need. When a profile already exists
// (made by the CLI, an older app, or a setup left halfway) it shows what was found and resumes at the first missing
// step; with several profiles and none chosen, it asks which one.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, FolderOpen, SquareTerminal } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SetupDetection } from '../../main/bridge.ts';
import type { ProfileSummary } from '../../../src/setup.ts';
import { serra } from '../bridge.ts';
import { defaultPath } from '../routes.ts';
import { BrandMark, Button, cx } from '../ui/index.ts';
import serraIcon from '../../../assets/brand/serra-icon.png';
import { Alert, Card, errorText, StateIcon } from './parts.tsx';
import { FLOW, foundLine, hasProfile, pickable, resumePath, shortPath, slackRefused, startView, summaryRows, type StartView } from './setup.logic.ts';
import { setupChanged, useSetup } from './SetupState.tsx';

const Need = ({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) => (
  <li className="flex items-center gap-3.5 px-4 py-3.5">
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-canvas text-ink">{icon}</span>
    <span className="flex min-w-0 flex-col">
      <span className="text-[14px] font-medium">{title}</span>
      <span className="text-[13px] text-muted">{detail}</span>
    </span>
  </li>
);

const Found = ({ summary, home }: { summary: ProfileSummary; home: string }) => {
  // A row with something to fix (a refused token, a bot not connected to Slack) says so, done or not.
  const problem = (id: string): boolean => (id === 'slack' && slackRefused(summary.tokens)) || (id === 'service' && summary.service === 'disconnected');
  return (
  <Card>
    <div className="flex items-baseline justify-between gap-3 border-b border-line-subtle px-4 py-3.5">
      <p className="min-w-0 truncate text-[14px]">Found <span className="font-semibold">{summary.bot?.name}</span></p>
      <p className="shrink-0 text-[13px] text-muted">{foundLine(summary)}</p>
    </div>
    <ul className="flex flex-col py-1.5" aria-label={`What ${summary.bot?.name ?? 'this profile'} has`}>
      {summaryRows(summary).map((row) => (
        <li key={row.id} className="flex items-center gap-3 px-4 py-2" data-found={row.id}>
          {/* Running but not connected to Slack: the step stays done, but the row says something needs a look. */}
          <StateIcon tone={problem(row.id) ? 'problem' : row.done ? 'done' : 'todo'} />
          <span className="w-16 shrink-0 text-[13px] text-muted">{row.label}</span>
          <span className="min-w-0 flex-1 truncate text-[13px]" title={row.value}>{row.value}</span>
          <span className="sr-only">{problem(row.id) ? 'needs a look' : row.done ? 'done' : 'to do'}</span>
        </li>
      ))}
    </ul>
    <p className="truncate border-t border-line-subtle px-4 py-2.5 font-mono text-[11px] text-muted" title={summary.profileDir}>{shortPath(summary.profileDir, home)}</p>
  </Card>
  );
};

const Picker = ({ profiles, chosen, onChoose }: { profiles: ProfileSummary[]; chosen: string | null; onChoose: (dir: string) => void }) => (
  <fieldset className="flex flex-col gap-2">
    <legend className="mb-2 text-[13px] text-muted">Serra found {profiles.length === 1 ? 'a bot' : `${profiles.length} bots`} on this Mac. Which one is this?</legend>
    {profiles.map((profile) => {
      const id = `pick-${profile.bot?.id ?? profile.profileDir}`;
      const selected = chosen === profile.profileDir;
      return (
        <label
          key={profile.profileDir}
          htmlFor={id}
          className={cx(
            'flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors duration-150',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
            selected ? 'border-ink bg-raised' : 'border-line-control bg-panel hover:bg-hover',
          )}
        >
          <input id={id} type="radio" name="profile" className="sr-only" checked={selected} onChange={() => onChoose(profile.profileDir)} />
          <span aria-hidden className={cx('grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]', selected ? 'border-ink' : 'border-line-control')}>
            {selected && <span className="size-2 rounded-full bg-ink" />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[14px] font-medium">{profile.bot?.name}</span>
            <span className="truncate text-[13px] text-muted">{[profile.repo, foundLine(profile)].filter(Boolean).join(' · ')}</span>
          </span>
        </label>
      );
    })}
  </fieldset>
);

export const Start = () => {
  const navigate = useNavigate();
  const { progress, refresh } = useSetup();
  const [detection, setDetection] = useState<SetupDetection | null>(null);
  const [view, setView] = useState<StartView | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setError('The Serra bridge is not available in this window.'); return; }
    try {
      const found = await bridge.setup.detect();
      setDetection(found);
      setView(startView(found));
      setChosen((current) => current ?? pickable(found)[0]?.profileDir ?? null);
    } catch (failure) { setError(errorText(failure)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // The heading waits for detection; if focus had nowhere to go meanwhile (Back from step 1), it lands there now.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!view || document.activeElement !== document.body || !heading.current) return;
    heading.current.tabIndex = -1;
    heading.current.focus({ preventScroll: true });
  }, [view]);

  /** Makes `directory` the app's profile, then goes on from its first missing step. */
  const openProfile = async (directory: string) => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.setup.useProfile(directory);
      setupChanged();
      const progress = await refresh();
      setDetection(next);
      void navigate(resumePath(progress ?? next.selected));
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  const openFolder = async () => {
    try {
      const folder = await serra()?.setup.chooseFolder('profile');
      if (folder) await openProfile(folder);
    } catch (failure) { setError(errorText(failure)); }
  };

  const selected = detection?.selected ?? null;
  const profiles = detection ? pickable(detection) : [];
  // Until detection answers, the profile in use (if any) already says whether this is a return visit.
  const returning = view ? view !== 'fresh' : hasProfile(progress);
  const complete = selected !== null && selected.next === null;

  return (
    <div className="flex flex-1 flex-col justify-center gap-8 py-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <img src={serraIcon} alt="" className="size-14 rounded-[14px] shadow-[0_8px_24px_-8px_rgb(0_0_0/0.35)] motion-safe:animate-[serra-pop_420ms_ease-out]" />
        {/* Until detection answers (several profiles, none chosen), the heading waits rather than change under the reader. */}
        <h1 ref={heading} className={cx('text-[28px] font-semibold tracking-tight', !view && !returning && 'invisible')}>{returning ? 'Welcome back' : 'Welcome to Serra'}</h1>
        <p className="max-w-sm text-[15px] text-muted">Your coding agents, one message away.</p>
      </div>

      {error && <Alert>{error}</Alert>}

      {view === 'fresh' && (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="needs" className="flex flex-col gap-2">
            <h2 id="needs" className="px-1 text-[13px] text-muted">You’ll need</h2>
            <Card>
              <ul className="flex flex-col divide-y divide-line-subtle">
                <Need icon={<BrandMark brand="slack" />} title="A Slack workspace" detail="Where you can add an app" />
                <Need icon={<BrandMark brand="github" />} title="A repository" detail="On this Mac, open in T3 Code" />
                <Need icon={<SquareTerminal size={16} strokeWidth={1.75} />} title="A coding agent" detail="Claude Code or Codex, signed in" />
              </ul>
            </Card>
          </section>
          <div className="flex flex-col items-center gap-3">
            <Button variant="primary" className="h-10 px-5 text-[14px]" onClick={() => void navigate(FLOW[0]!.path)}>
              Get started<ArrowRight size={16} aria-hidden />
            </Button>
            <Button variant="ghost" size="sm" className="text-muted" icon={<FolderOpen size={14} aria-hidden />} onClick={() => void openFolder()} disabled={busy}>
              Open an existing profile…
            </Button>
          </div>
        </div>
      )}

      {view === 'summary' && selected && (
        <div className="flex flex-col gap-6">
          <Found summary={selected} home={detection?.home ?? ''} />
          <div className="flex flex-col items-center gap-3">
            <Button
              variant="primary" className="h-10 px-5 text-[14px]"
              onClick={() => void navigate(complete ? defaultPath : resumePath(selected))}
            >
              {complete ? 'Open Serra' : 'Continue'}<ArrowRight size={16} aria-hidden />
            </Button>
            <div className="flex flex-wrap justify-center gap-1">
              {profiles.length > 1 && !detection?.pinned && (
                <Button variant="ghost" size="sm" className="text-muted" onClick={() => setView('picker')}>Use a different bot</Button>
              )}
              {!detection?.pinned && (
                <Button variant="ghost" size="sm" className="text-muted" icon={<FolderOpen size={14} aria-hidden />} onClick={() => void openFolder()} disabled={busy}>
                  Open another profile…
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {view === 'picker' && (
        <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (chosen) void openProfile(chosen); }}>
          <Picker profiles={profiles} chosen={chosen} onChoose={setChosen} />
          <div className="flex flex-col items-center gap-3">
            <Button type="submit" variant="primary" className="h-10 px-5 text-[14px]" disabled={!chosen || busy}>
              {busy ? 'Opening…' : `Continue with ${profiles.find((p) => p.profileDir === chosen)?.bot?.name ?? 'this bot'}`}<ArrowRight size={16} aria-hidden />
            </Button>
            <div className="flex flex-wrap justify-center gap-1">
              {!selected && <Button variant="ghost" size="sm" className="text-muted" onClick={() => void navigate(FLOW[0]!.path)}>Set up a new bot</Button>}
              <Button variant="ghost" size="sm" className="text-muted" icon={<FolderOpen size={14} aria-hidden />} onClick={() => void openFolder()} disabled={busy}>
                Open another profile…
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
};
