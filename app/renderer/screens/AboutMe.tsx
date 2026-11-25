// Knowledge → About me (SERRA-41): what every job's brief carries about the owner, exactly as a worker gets it, for
// each audience a reply can have. It's built from the owner's confirmed pages under owner/, so it's edited there.
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Building2, User, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { ABOUT_MAX_CHARS, type AboutMe as AboutMeData, type Audience, type Visibility } from '../../../src/owner-model.ts';
import { PageBody } from './PageBody.tsx';
import { AudienceChoice } from './AudienceChoice.tsx';
import { serra } from '../bridge.ts';
import { Button, cx, Dialog, Page, useToast } from '../ui/index.ts';

/** A card's title in words: "Working style", not owner/working-style.md. */
const sectionTitle = (path: string): string => {
  const named: Record<string, string> = { 'people/': 'People', outsiders: 'Rules for outsiders', 'private topics': 'Private topics' };
  if (named[path]) return named[path];
  const words = (path.split('/').pop() ?? path).replace(/\.md$/, '').replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const AUDIENCES: { value: Visibility; label: string; icon: typeof User; hint: string }[] = [
  { value: 'owner', label: 'You', icon: User, hint: 'Your DMs with the bot and tasks you start in the app.' },
  { value: 'team', label: 'Your team', icon: Users, hint: 'Channels and teammates’ DMs. Pages only you may hear are left out.' },
  { value: 'external', label: 'Outside your company', icon: Building2, hint: 'Channels shared with another company. Only pages for people outside your company.' },
];

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));



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

  return (
    <Page title="About me" subtitle={about ? `In every brief · ${used}% of the space` : undefined}>
      {error && <p role="alert" className="text-sm text-down">{error}</p>}
      {untagged.length > 0 && (
        <section aria-labelledby="untagged-title" className="flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2.5">
          <Users size={16} aria-hidden className="shrink-0 text-muted" />
          <h2 id="untagged-title" className="min-w-0 flex-1 text-[13px]" title="Teammates' briefs leave these out until you choose.">
            {untagged.length === 1 ? '1 private page' : `${untagged.length} private pages`}
          </h2>
          <Button size="sm" onClick={() => { setShareTo('team'); setSharing(new Set()); }}>Share</Button>
        </section>
      )}
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="Seen by" className="flex flex-wrap gap-1">
          {AUDIENCES.map(({ value, label, icon: Icon, hint }) => (
            <button
              key={value}
              title={hint}
              type="button"
              aria-pressed={visibility === value}
              onClick={() => setVisibility(value)}
              className={cx(
                'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-focus',
                visibility === value ? 'border-line-strong bg-selected text-ink' : 'border-line text-muted hover:bg-raised hover:text-ink',
              )}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      {about && (
        <div className="flex flex-col gap-6 border-t border-line pt-5 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {about.sections.length === 0 && (
              <p className="text-sm text-muted">
                Nothing yet.{' '}
                <button type="button" onClick={() => void navigate('/knowledge/proposals?interview=1')} className="text-ink underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-focus">
                  Start interview
                </button>
              </p>
            )}
            {about.sections.map((section) => (
              <section key={section.path} aria-label={section.path} className="rounded-lg border border-line bg-panel">
                <header className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-2.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <h2 className="min-w-0 text-[13px] font-semibold" title={section.path}>{sectionTitle(section.path)}</h2>
                  </div>
                  {section.path !== 'people/' && section.path !== 'outsiders' && section.path !== 'private topics' && <button
                    type="button"
                    onClick={() => edit(section.path)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    Edit <ArrowUpRight size={13} aria-hidden />
                  </button>}
                </header>
                <PageBody text={section.body} onOpen={(href) => { serra()?.app.openExternal(href).catch((failure: unknown) => toast({ message: message(failure), tone: 'error' })); }} />
              </section>
            ))}
          </div>

          {about.left.length > 0 && (
          <aside aria-label="Pages left out" className="flex w-full shrink-0 flex-col gap-4 lg:w-64">
              <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4">
                <h2 className="text-sm font-semibold">Not included</h2>
                <ul className="flex flex-col gap-2">
                  {about.left.map((page) => (
                    <li key={page.path} className="flex flex-col">
                      <button type="button" onClick={() => edit(page.path)} className="self-start truncate font-mono text-xs text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus">
                        {page.path}
                      </button>
                      <span className="text-xs text-muted">{page.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
          </aside>
          )}
        </div>
      )}
      <Dialog
        open={sharing !== null}
        onClose={() => setSharing(null)}
        title="Choose who may hear these pages"
        description="Nothing is checked until you choose. Keeping a page for you only clears it from this list. You can change a page later in Pages."
        actions={(
          <>
            <Button onClick={() => setSharing(null)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !sharing?.size} onClick={() => void share()}>
              {sharing?.size ? `Set ${sharing.size} page${sharing.size === 1 ? '' : 's'}` : 'Set'}
            </Button>
          </>
        )}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <AudienceChoice id="share-to" value={shareTo} disabled={busy} onChange={setShareTo} />
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
                  className="mt-0.5 size-4 accent-[var(--color-accent)]"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-xs">{path}</span>
                  {description && <span className="text-xs text-muted">{description}</span>}
                  {offlimits && shareTo !== 'owner' && <span className="text-xs text-warn">Off-limits rules: sharing puts their topics in {shareTo === 'team' ? 'teammates\u2019' : 'outsiders\u2019'} briefs.</span>}
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
