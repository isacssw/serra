// Knowledge → About me (SERRA-41): what every job's brief carries about the owner, exactly as a worker gets it, for
// each audience a reply can have. It's built from the owner's confirmed pages under owner/, so it's edited there.
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Building2, User, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { ABOUT_MAX_CHARS, type AboutMe as AboutMeData, type Visibility } from '../../../src/owner-model.ts';
import { serra } from '../bridge.ts';
import { cx, Page } from '../ui/index.ts';

const AUDIENCES: { value: Visibility; label: string; icon: typeof User; hint: string }[] = [
  { value: 'owner', label: 'You', icon: User, hint: 'Your DMs with the bot and tasks you start in the app.' },
  { value: 'team', label: 'Your team', icon: Users, hint: 'Channels and teammates’ DMs. Pages marked audience: owner are left out.' },
  { value: 'external', label: 'Outside your company', icon: Building2, hint: 'Channels shared with another company. Only pages marked audience: external.' },
];

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A page's Markdown as plain lines: headings, bullets and paragraphs, without the blank lines between them. */
const PageBody = ({ text }: { text: string }) => (
  <div className="flex flex-col gap-1.5 px-4 py-3 text-[13px] leading-6 text-ink">
    {text.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) return <p key={index} className="font-semibold">{heading[1]}</p>;
      const bullet = /^[-*]\s+(.*)$/.exec(line);
      if (bullet) return <p key={index} className="flex gap-2"><span aria-hidden className="text-faint">•</span><span>{bullet[1]}</span></p>;
      return <p key={index} className="text-muted">{line.replace(/^>\s?/, '')}</p>;
    })}
  </div>
);

export const AboutMe = () => {
  const navigate = useNavigate();
  const [visibility, setVisibility] = useState<Visibility>('team');
  const [about, setAbout] = useState<AboutMeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (audience: Visibility) => {
    const bridge = serra();
    if (!bridge) { setError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      setAbout(await bridge.pages.aboutMe(audience));
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

  const edit = (path: string) => navigate(`/knowledge/pages?page=${encodeURIComponent(path)}`);
  const used = about ? Math.min(100, Math.round((100 * about.chars) / ABOUT_MAX_CHARS)) : 0;
  const hint = AUDIENCES.find((option) => option.value === visibility)?.hint;

  return (
    <Page title="About me" subtitle="What every job knows about you, built from your confirmed pages in owner/.">
      {error && <p role="alert" className="text-sm text-down">{error}</p>}
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="Seen by" className="flex flex-wrap gap-1">
          {AUDIENCES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
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
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>

      {about && (
        <div className="flex flex-col gap-6 border-t border-line pt-5 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {about.sections.length === 0 && (
              <p className="text-sm text-muted">
                Nothing for this audience yet. Confirm pages under owner/ (your role, how you work, your voice, what&rsquo;s off-limits)
                and they show here. The interview in Proposals writes them for you.
              </p>
            )}
            {about.sections.map((section) => (
              <section key={section.path} aria-label={section.path} className="rounded-lg border border-line bg-panel">
                <header className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-2.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <h2 className="truncate font-mono text-[13px] font-semibold">{section.path === 'people/' ? 'people/ (one line each)' : section.path}</h2>
                    <span className="shrink-0 text-xs text-muted">confirmed {section.verified}</span>
                  </div>
                  {section.path !== 'people/' && <button
                    type="button"
                    onClick={() => edit(section.path)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    Edit <ArrowUpRight size={13} aria-hidden />
                  </button>}
                </header>
                <PageBody text={section.body} />
              </section>
            ))}
          </div>

          <aside aria-label="Size and pages left out" className="flex w-full shrink-0 flex-col gap-4 lg:w-64">
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4">
              <h2 className="text-sm font-semibold">In every brief</h2>
              <div
                role="meter" aria-label="About me size" aria-valuemin={0} aria-valuemax={ABOUT_MAX_CHARS} aria-valuenow={about.chars}
                className="h-1.5 overflow-hidden rounded-full bg-raised"
              >
                <div className="h-full rounded-full bg-accent" style={{ width: `${used}%` }} />
              </div>
              <p className="text-xs text-muted">
                {about.chars.toLocaleString()} of {ABOUT_MAX_CHARS.toLocaleString()} characters, about {Math.round(about.chars / 4).toLocaleString()} tokens.
                Over the limit, the least important pages are left out whole.
              </p>
            </div>
            {about.left.length > 0 && (
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
            )}
          </aside>
        </div>
      )}
    </Page>
  );
};
