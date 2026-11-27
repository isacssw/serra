// Knowledge → About me (SERRA-41): what every job's brief carries about the owner, exactly as a worker gets it, for
// each audience a reply can have. It's built from the owner's confirmed pages under owner/, so it's edited there.
import { useCallback, useEffect, useState } from 'react';
import { Building2, FileText, Pencil, User, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import {
  ABOUT_MAX_CHARS, OFFLIMITS_PREFACE, PEOPLE_PREFACE, type AboutMe as AboutMeData, type Audience, type Visibility,
} from '../../../src/owner-model.ts';
import { PageBody } from './PageBody.tsx';
import { AudienceChoice } from './AudienceChoice.tsx';
import { aboutCard, leftOutLine, sectionTitle } from './about.logic.ts';
import { serra } from '../bridge.ts';
import { Badge, Button, Dialog, EmptyState, Page, Segmented, useToast } from '../ui/index.ts';

const AUDIENCES = [
  { value: 'owner', label: 'You', icon: <User size={14} />, title: 'Your DMs and tasks you start in the app' },
  { value: 'team', label: 'Team', icon: <Users size={14} />, title: 'Channels and teammates\u2019 DMs' },
  { value: 'external', label: 'External', icon: <Building2 size={14} />, title: 'Channels shared with another company' },
] as const;

const EMPTY: Record<Visibility, string> = { owner: 'Nothing about you yet', team: 'Nothing shared with your team', external: 'Nothing shared outside' };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How much of the brief's room About me takes, as a small meter. */
const Meter = ({ used }: { used: number }) => (
  <span className="flex items-center gap-2" title="How much of the brief\u2019s room About me takes">
    In every brief
    <span aria-hidden className="h-1.5 w-24 overflow-hidden rounded-full bg-line-strong"><span className="block h-full rounded-full bg-muted" style={{ width: `max(6px, ${used}%)` }} /></span>
    <span className="tabular-nums">{used}%</span>
  </span>
);

export const AboutMe = () => {
  const navigate = useNavigate();
  const [visibility, setVisibility] = useState<Visibility>('owner');
  const [about, setAbout] = useState<AboutMeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [untagged, setUntagged] = useState<{ path: string; description: string; offlimits: boolean; preview: string; text: string }[]>([]);
  const [peek, setPeek] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Set<string> | null>(null);
  const [shareTo, setShareTo] = useState<Audience>('team');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const toast = useToast();

  const load = useCallback(async (audience: Visibility) => {
    const bridge = serra();
    if (!bridge) { setError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      const [next, unset] = await Promise.all([bridge.pages.aboutMe(audience), bridge.pages.untagged()]);
      setAbout(next);
      setUntagged(unset);
      setError(null);
    } catch (failure) {
      setError(message(failure));
    }
  }, []);

  useEffect(() => {
    void load(visibility);
    const refresh = () => { void load(visibility); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load, visibility]);

  const edit = (path: string): void => { void navigate(`/knowledge/pages?page=${encodeURIComponent(path)}`); };

  const share = async () => {
    const bridge = serra();
    if (!bridge || !sharing || busy) return;
    setBusy(true);
    try {
      const { shared } = await bridge.pages.share(untagged.filter((page) => sharing.has(page.path)).map(({ path, text }) => ({ path, text })), shareTo);
      setSharing(null);
      const who = shareTo === 'owner' ? 'kept for you only' : shareTo === 'team' ? 'shared with your team' : 'shared with people outside your company';
      toast({
        message: `${shared.length} page${shared.length === 1 ? '' : 's'} ${who}.`,
        tone: 'success',
      });
      await load(visibility);
    } catch (failure) {
      toast({ message: message(failure), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const used = about ? Math.min(100, Math.round((100 * about.chars) / ABOUT_MAX_CHARS)) : 0;
  const leftOut = about ? leftOutLine(about.left) : null;

  return (
    <Page
      title="About me"
      subtitle={about ? <Meter used={used} /> : undefined}
      actions={<Segmented kind="tab" aria-label="Seen by" controls="about-panel" value={visibility} onChange={(next) => { setVisibility(next); setReview(false); }} options={AUDIENCES} />}
    >
      {error && <p role="alert" className="text-sm text-down">{error}</p>}
      {(leftOut || untagged.length > 0) && (
        <div className="-mt-2 flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px] text-muted">
            {leftOut && (
              <span className="inline-flex items-center gap-1">
                {leftOut}
                <span aria-hidden className="text-faint">·</span>
                <button type="button" aria-expanded={review} onClick={() => setReview(!review)} className="rounded-sm font-medium text-ink underline decoration-line-control underline-offset-[3px] hover:decoration-ink focus-visible:outline-2 focus-visible:outline-focus">
                  {review ? 'Hide' : 'Review'}
                </button>
              </span>
            )}
            {leftOut && untagged.length > 0 && <span aria-hidden className="-mx-3 text-faint">·</span>}
            {untagged.length > 0 && (
              <span className="inline-flex items-center gap-1" title="Teammates\u2019 briefs leave these out until you choose">
                {untagged.length === 1 ? '1 page' : `${untagged.length} pages`} {visibility === 'owner' ? 'only you may hear' : 'not shared yet'}
                <span aria-hidden className="text-faint">·</span>
                <button type="button" onClick={() => { setShareTo('team'); setSharing(new Set()); }} className="rounded-sm font-medium text-ink underline decoration-line-control underline-offset-[3px] hover:decoration-ink focus-visible:outline-2 focus-visible:outline-focus">Share…</button>
              </span>
            )}
          </p>
          {review && about && (
            <ul aria-label="Pages left out" className="flex flex-wrap gap-1.5">
              {about.left.map((page) => (
                <li key={page.path}>
                  <button type="button" onClick={() => edit(page.path)} title={page.reason} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-control px-2.5 text-xs text-ink shadow-field hover:border-line-control focus-visible:outline-2 focus-visible:outline-focus">
                    <FileText size={12} aria-hidden className="text-faint" />{sectionTitle(page.path)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {about && (
        <div id="about-panel" role="tabpanel" aria-label={AUDIENCES.find((audience) => audience.value === visibility)!.title} className="flex flex-col gap-3">
          {about.sections.length === 0 && (
            <EmptyState
              icon={<User size={18} />}
              title={EMPTY[visibility]}
              action={visibility === 'owner'
                ? <Button variant="primary" onClick={() => void navigate('/knowledge/proposals?interview=1')}>Start interview</Button>
                : untagged.length > 0 ? <Button onClick={() => { setShareTo(visibility === 'external' ? 'external' : 'team'); setSharing(new Set()); }}>Share pages…</Button> : undefined}
            />
          )}
          {about.sections.map((section) => {
            const card = aboutCard(section.path, section.body, [OFFLIMITS_PREFACE, PEOPLE_PREFACE]);
            const editable = section.path !== 'people/' && section.path !== 'outsiders' && section.path !== 'private topics';
            return (
              <section key={section.path} aria-label={card.title} className="group rounded-xl border border-line bg-panel shadow-card">
                <header className="flex items-center justify-between gap-3 pt-2.5 pr-2.5 pl-5">
                  <h2 className="min-w-0 truncate text-sm font-semibold" title={section.path}>{card.title}</h2>
                  {(section.path === 'outsiders' || section.path === 'private topics') && <Badge title="Serra adds this rule for these replies">Built-in</Badge>}
                  {editable && (
                    <Button size="sm" variant="ghost" icon={<Pencil size={13} aria-hidden />} aria-label={`Edit ${card.title}`} onClick={() => edit(section.path)}>Edit</Button>
                  )}
                </header>
                <div className="-mt-2.5 max-w-[76ch] px-1 pb-1"><PageBody text={card.body} onOpen={(href) => { serra()?.app.openExternal(href).catch((failure: unknown) => toast({ message: message(failure), tone: 'error' })); }} /></div>
              </section>
            );
          })}
        </div>
      )}
      <Dialog
        open={sharing !== null}
        onClose={() => setSharing(null)}
        title="Who may hear these pages?"
        description="Nothing changes until you choose."
        actions={(
          <>
            <Button onClick={() => setSharing(null)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !sharing?.size} onClick={() => void share()}>
              {sharing?.size ? `Set ${sharing.size} page${sharing.size === 1 ? '' : 's'}` : 'Set'}
            </Button>
          </>
        )}
      >
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <AudienceChoice id="share-to" label value={shareTo} disabled={busy} onChange={setShareTo} />
          <button
            type="button"
            onClick={() => setSharing(sharing?.size === untagged.length ? new Set() : new Set(untagged.map((page) => page.path)))}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
          >
            {sharing?.size === untagged.length ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {untagged.map(({ path, description, offlimits, preview }) => (
            <li key={path}>
              <div className="flex items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-hover">
                <label className="flex min-w-0 flex-1 items-start gap-2">
                <input
                  type="checkbox"
                  checked={sharing?.has(path) ?? false}
                  onChange={(event) => setSharing((current) => {
                    const next = new Set(current ?? []);
                    if (event.target.checked) next.add(path); else next.delete(path);
                    return next;
                  })}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] text-ink" title={path}>{description || sectionTitle(path)}</span>
                  {offlimits && shareTo !== 'owner' && <span className="text-xs text-warn">Off-limits: shares its topics too</span>}
                </span>
                </label>
                <button
                  type="button"
                  aria-expanded={peek === path}
                  aria-label={`${peek === path ? 'Hide' : 'Preview'} ${path}`}
                  onClick={() => setPeek(peek === path ? null : path)}
                  className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {peek === path ? 'Hide' : 'Preview'}
                </button>
              </div>
              {peek === path && <pre className="ml-7 mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md bg-raised px-2 py-1.5 font-mono text-[11px] leading-5 text-ink">{preview}</pre>}
            </li>
          ))}
        </ul>
      </Dialog>
    </Page>
  );
};
