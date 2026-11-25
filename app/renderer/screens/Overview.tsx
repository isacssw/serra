// Knowledge › Overview: whether the bot's knowledge of its owner is growing and staying tidy. The score, its trend,
// what the bot knows per area, what needs tidying, what it learned lately and what replies used. Read-only: every
// fix happens in Pages or Proposals, one click away.
import { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, ArrowUpRight, BookOpen, CircleCheck, CircleDot, Copy, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { KnowledgeOverview } from '../../../src/knowledge-overview.ts';
import { serra } from '../bridge.ts';
import { Button, cx, EmptyState, Page } from '../ui/index.ts';
import {
  changeText, EVENT_LABELS, factsChart, shortDate, groupByDay, ISSUE_LABELS, ISSUE_TONES, PART_LABELS, PART_ORDER, scoreChart, scoreWord, usedShare, type Tone,
} from './overview.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const TONE_TEXT: Record<Tone, string> = { up: 'text-up', warn: 'text-warn', down: 'text-down', neutral: 'text-muted' };

const Section = ({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) => {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        {aside && <div className="text-xs text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
};

const Tile = ({ label, value, unit, note, noteTone = 'neutral' }: { label: string; value: string; unit?: string; note?: string | null; noteTone?: Tone }) => (
  <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-panel px-4 py-3">
    <p className="text-xs text-muted">{label}</p>
    <p className="flex items-baseline gap-1"><span className="text-[28px] leading-8 font-semibold tracking-tight tabular-nums">{value}</span>{unit && <span className="text-sm text-muted">{unit}</span>}</p>
    {note && <p className={cx('text-xs', TONE_TEXT[noteTone])}>{note}</p>}
  </div>
);

/** The score over time: one ink line, no legend (it's one series), a dot per point with the details on hover or focus. */
/** An axis label in HTML over the chart, so it stays a readable size however wide the chart is drawn. */
const Label = ({ x, y, width, height, align, children }: { x: number; y: number; width: number; height: number; align: 'start' | 'middle' | 'end'; children: React.ReactNode }) => (
  <span
    aria-hidden
    className="pointer-events-none absolute whitespace-nowrap text-[11px] leading-none tabular-nums text-muted"
    style={{ left: `${(x / width) * 100}%`, top: `${(y / height) * 100}%`, transform: `translate(${align === 'start' ? '0' : align === 'middle' ? '-50%' : '-100%'}, -50%)` }}
  >
    {children}
  </span>
);

/**
 * Health over time, with facts known drawn underneath on the same dates: the score says whether the knowledge is in
 * good shape, the facts whether the bot knows more. One ink line each, no legend (each is named by its label). Each
 * change is a dot reachable by keyboard; hovering or focusing one says what changed.
 */
const ScoreChart = ({ overview }: { overview: KnowledgeOverview }) => {
  const width = 640;
  const height = 168;
  const factsHeight = 56;
  const chart = scoreChart(overview.points, width, height);
  const facts = factsChart(overview.points, width, factsHeight);
  const [active, setActive] = useState<number | null>(null);
  const shown = active === null ? null : chart.dots[active] ?? null;
  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`Health score over time, from ${overview.points[0]?.score ?? 0} to ${overview.health.score}.`}>
          {chart.grid.map((line) => <line key={line.label} x1={36} x2={width - 8} y1={line.y} y2={line.y} className="stroke-line-subtle" strokeWidth={1} />)}
          <path d={chart.area} className="fill-ink/5" />
          <path d={chart.line} fill="none" className="stroke-ink" strokeWidth={2} strokeLinejoin="round" />
          {shown && <line x1={shown.x} x2={shown.x} y1={8} y2={height - 30} className="stroke-line-strong" strokeWidth={1} />}
          {chart.dots.map((dot, at) => (
            <g
              key={dot.point.at}
              onMouseEnter={() => setActive(at)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(at)}
              onBlur={() => setActive(null)}
              // Each change is a stop for the keyboard, with what changed; the weekly points between are hover only.
              {...(dot.point.change ? { tabIndex: 0, role: 'img', 'aria-label': `${shortDate(dot.point.at)}: health ${dot.point.score}, ${dot.point.facts} facts. ${dot.point.change}.` } : {})}
              className="outline-none focus-visible:[&>circle]:stroke-focus"
            >
              <rect x={dot.x - 6} y={8} width={12} height={height - 38} fill="transparent" />
              {dot.point.change && at !== chart.dots.length - 1 && active !== at && <circle cx={dot.x} cy={dot.y} r={3} className="fill-canvas stroke-ink" strokeWidth={1.5} />}
              {(at === chart.dots.length - 1 || active === at) && <circle cx={dot.x} cy={dot.y} r={4.5} className="fill-ink stroke-canvas" strokeWidth={2} />}
            </g>
          ))}
        </svg>
        {chart.grid.map((line) => <Label key={line.label} x={30} y={line.y} width={width} height={height} align="end">{line.label}</Label>)}
        {chart.ticks.map((tick, at) => (
          <Label key={at} x={tick.x} y={height - 9} width={width} height={height} align={at === 0 ? 'start' : at === chart.ticks.length - 1 ? 'end' : 'middle'}>{tick.label}</Label>
        ))}
        {shown && (
          <div
            className="pointer-events-none absolute top-0 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs shadow-sm"
            style={{ left: `${Math.min(70, Math.max(0, (shown.x / width) * 100 - 10))}%` }}
          >
            <p className="font-medium tabular-nums">{shown.point.score} <span className="font-normal text-muted">· {shortDate(shown.point.at)}</span></p>
            {shown.point.change && <p className="max-w-56 truncate">{shown.point.change}</p>}
            <p className="text-muted">{shown.point.facts} facts · {shown.point.pages} pages</p>
            {(shown.point.conflicts > 0 || shown.point.duplicates > 0) && (
              <p className="text-muted">{[shown.point.conflicts > 0 && `${shown.point.conflicts} conflict${shown.point.conflicts === 1 ? '' : 's'}`, shown.point.duplicates > 0 && `${shown.point.duplicates} repeated`].filter(Boolean).join(' · ')}</p>
            )}
          </div>
        )}
      </div>
      <div className="relative border-t border-line-subtle pt-1">
        <svg viewBox={`0 0 ${width} ${factsHeight}`} className="h-auto w-full" role="img" aria-label={`Facts known over time, from ${overview.points[0]?.facts ?? 0} to ${overview.health.facts}.`}>
          <path d={facts.area} className="fill-ink/5" />
          <path d={facts.line} fill="none" className="stroke-muted" strokeWidth={1.5} strokeLinejoin="round" />
          {shown && <line x1={shown.x} x2={shown.x} y1={4} y2={factsHeight - 4} className="stroke-line-strong" strokeWidth={1} />}
        </svg>
        <Label x={30} y={factsHeight / 2} width={width} height={factsHeight} align="end">Facts</Label>
      </div>
    </div>
  );
};

/** One part of the score as a thin meter with its number. */
const Meter = ({ label, value }: { label: string; value: number }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <div className="flex items-baseline justify-between gap-2 text-xs"><span className="truncate text-muted">{label}</span><span className="tabular-nums text-ink">{value}</span></div>
    <div className="h-1 rounded-full bg-raised" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className="h-1 rounded-full bg-ink" style={{ width: `${value}%` }} />
    </div>
  </div>
);

export const Overview = () => {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allIssues, setAllIssues] = useState(false);

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      setOverview(await bridge.pages.overview());
      setError(null);
    } catch (failure) { setError(message(failure)); }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  const open = (path: string): void => { void navigate(`/knowledge/pages?page=${encodeURIComponent(path)}`); };
  const [now] = useState(() => new Date());

  if (error) return <Page title="Overview"><p role="alert" className="text-sm text-down">{error}</p></Page>;
  if (!overview) return <Page title="Overview" subtitle="Loading…" />;

  const { health, monthAgo, usage } = overview;
  if (health.pages === 0) {
    return (
      <Page title="Overview" subtitle="How well your bot knows you, and how that changes.">
        <EmptyState icon={<Sparkles size={18} />} title="Your bot doesn't know you yet" action={<Button variant="primary" onClick={() => void navigate('/knowledge/proposals?interview=1')}>Start interview</Button>}>
          A short interview writes the first pages: your role, how you work, how you write and who you work with.
        </EmptyState>
      </Page>
    );
  }

  const word = scoreWord(health.score, health.pages);
  const issues = allIssues ? health.issues : health.issues.slice(0, 5);
  const days = groupByDay(overview.events, now);
  const share = usedShare(usage.replies, usage.withKnowledge);
  const topUse = Math.max(1, ...usage.pages.map((page) => page.uses));

  return (
    <Page title="Overview" subtitle="How well your bot knows you, and how that changes.">
      {overview.unreviewed > 0 && (
        <div className="flex items-start gap-2 text-[13px] text-muted">
          <AlertTriangle size={15} aria-hidden className="mt-0.5 shrink-0 text-warn" />
          <p>
            {overview.unreviewed === 1 ? 'A file changed outside Serra isn’t counted until you review it in ' : `${overview.unreviewed} files changed outside Serra aren’t counted until you review them in `}
            <button type="button" onClick={() => void navigate('/knowledge/pages')} className="text-ink underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-focus">Pages</button>.
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Health" value={String(health.score)} unit="/ 100" note={`${word.word}${monthAgo ? ` · ${changeText(health.score, monthAgo.score, monthAgo.at) ?? ''}` : ''}`} noteTone={word.tone} />
        <Tile label="Knows" value={String(health.facts)} unit="facts" note={[`${health.pages} page${health.pages === 1 ? '' : 's'}`, monthAgo ? changeText(health.facts, monthAgo.facts, monthAgo.at, ' facts') : null].filter(Boolean).join(' · ')} />
        <Tile
          label="Used in replies"
          value={share === null ? '–' : `${share}%`}
          note={share === null ? `No replies in the last ${usage.days} days` : `${usage.withKnowledge} of ${usage.replies} replies · last ${usage.days} days`}
        />
      </div>

      {overview.points.length > 1 && (
        <Section title="Health over time" aside={`${health.fresh} of ${health.pages} pages confirmed in the last 60 days`}>
          <div className="rounded-lg border border-line bg-panel px-3 pt-3 pb-1"><ScoreChart overview={overview} /></div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-5">
            {PART_ORDER.map((part) => <Meter key={part} label={PART_LABELS[part]} value={health.parts[part]} />)}
          </div>
        </Section>
      )}

      <Section title="What your bot knows about you">
        <ul className="divide-y divide-line-subtle rounded-lg border border-line bg-panel">
          {health.areas.map((area) => {
            // An area holding rules that disagree isn't settled, whatever else it has.
            const disputed = area.conflicts > 0;
            return (
            <li key={area.area} className="flex items-start gap-3 px-4 py-2.5">
              {disputed
                ? <AlertTriangle size={15} aria-label="Has rules that disagree" className="mt-0.5 shrink-0 text-warn" />
                : area.confirmed > 0
                  ? <CircleCheck size={15} aria-label="Confirmed" className="mt-0.5 shrink-0 text-up" />
                  : <CircleDot size={15} aria-label="Nothing yet" className="mt-0.5 shrink-0 text-faint" />}
              <div className="flex min-w-0 flex-1 flex-col">
                <p className="text-[13px] font-medium">{area.label}</p>
                <p className="truncate text-xs text-muted">{area.headline ?? (area.pages > 0 ? 'Only drafts so far' : 'Nothing yet')}</p>
                {disputed && <p className="text-xs text-warn">{area.conflicts === 1 ? 'Two rules disagree' : `${area.conflicts} pairs of rules disagree`}. See Needs tidying.</p>}
              </div>
              <p className="shrink-0 text-xs tabular-nums text-muted">{area.pages === 0 ? '' : `${area.facts} fact${area.facts === 1 ? '' : 's'} · ${area.pages} page${area.pages === 1 ? '' : 's'}`}</p>
            </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Needs tidying" aside={health.issues.length > 0 ? `${health.issues.length} item${health.issues.length === 1 ? '' : 's'}` : undefined}>
        {health.issues.length === 0
          ? <p className="flex items-center gap-2 rounded-lg border border-line bg-panel px-4 py-3 text-[13px] text-muted"><CircleCheck size={15} aria-hidden className="text-up" />Nothing to tidy. No conflicts, repeats or stale pages.</p>
          : (
            <ul className="divide-y divide-line-subtle rounded-lg border border-line bg-panel">
              {issues.map((issue, at) => (
                <li key={`${issue.kind}-${issue.pages.join()}-${at}`} className="flex items-start gap-3 px-4 py-2.5">
                  {ISSUE_TONES[issue.kind] === 'neutral'
                    ? <CircleDot size={15} aria-hidden className="mt-0.5 shrink-0 text-faint" />
                    : issue.kind === 'duplicate' || issue.kind === 'overlap'
                      ? <Copy size={15} aria-hidden className={cx('mt-0.5 shrink-0', TONE_TEXT[ISSUE_TONES[issue.kind]])} />
                      : <AlertTriangle size={15} aria-hidden className={cx('mt-0.5 shrink-0', TONE_TEXT[ISSUE_TONES[issue.kind]])} />}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-[13px]"><span className="font-medium">{ISSUE_LABELS[issue.kind]}.</span> <span className="text-muted">{issue.text}</span></p>
                    {issue.detail?.map((line) => <p key={line} className="truncate border-l-2 border-line pl-2 text-xs text-muted">{line}</p>)}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    {issue.pages[0] === 'index.md'
                      ? <Button size="sm" variant="ghost" onClick={() => void navigate('/knowledge/pages')} icon={<ArrowUpRight size={13} aria-hidden />}>Pages</Button>
                      : issue.pages.map((page) => (
                        // Each page the item names opens on its own, so a conflict across two pages can be fixed from either.
                        <Button key={page} size="sm" variant="ghost" onClick={() => open(page)} aria-label={`Open ${page}`} icon={<ArrowUpRight size={13} aria-hidden />}>
                          {issue.pages.length > 1 ? (page.split('/').pop() ?? page) : 'Open'}
                        </Button>
                      ))}
                  </div>
                </li>
              ))}
              {health.issues.length > 5 && (
                <li className="px-4 py-2">
                  <button type="button" onClick={() => setAllIssues(!allIssues)} className="text-xs text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
                    {allIssues ? 'Show fewer' : `Show all ${health.issues.length}`}
                  </button>
                </li>
              )}
            </ul>
          )}
      </Section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Recently learned" aside={overview.waiting > 0 ? (
          <button type="button" onClick={() => void navigate('/knowledge/proposals')} className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">{overview.waiting} waiting for you</button>
        ) : undefined}>
          {days.length === 0
            ? <p className="text-[13px] text-muted">No changes recorded yet. Approvals and edits show here.</p>
            : (
              <ol className="flex flex-col gap-4">
                {days.map((day) => (
                  <li key={day.day} className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium text-muted">{day.label}</p>
                    <ul className="flex flex-col gap-1.5 border-l border-line pl-3">
                      {day.events.map((event, at) => (
                        <li key={`${event.page}-${at}`} className="flex min-w-0 flex-col">
                          <p className="text-[13px]">
                            <span className="font-medium">{EVENT_LABELS[event.kind]}</span>{' '}
                            <button type="button" onClick={() => open(event.page)} disabled={event.kind === 'removed'} className="font-mono text-xs text-muted hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus disabled:no-underline">{event.page}</button>
                          </p>
                          {(event.added[0] ?? event.removed[0] ?? event.description) && (
                            <p className="truncate text-xs text-muted">
                              {event.added[0] ? `“${event.added[0]}”` : event.removed[0] ? `Took out “${event.removed[0]}”` : event.description}
                              {event.added.length > 1 ? ` and ${event.added.length - 1} more` : ''}
                            </p>
                          )}
                        </li>
                      ))}
                      {day.confirmed.length > 0 && (
                        <li className="text-[13px]"><span className="font-medium">Confirmed</span> <span className="text-muted">{day.confirmed.length} page{day.confirmed.length === 1 ? '' : 's'} still hold</span></li>
                      )}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
        </Section>

        <Section title="Used in replies" aside={`Named by the bot · last ${usage.days} days`}>
          {usage.pages.length === 0
            ? (
              <p className="flex items-start gap-2 text-[13px] text-muted"><BookOpen size={15} aria-hidden className="mt-0.5 shrink-0" />
                {usage.replies === 0 ? 'Once the bot replies, the pages it says it used show here.' : 'No reply named a page it used yet.'}
              </p>
            )
            : (
              <ul className="flex flex-col gap-2">
                {usage.pages.slice(0, 8).map((page) => (
                  <li key={page.path} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <button type="button" onClick={() => open(page.path)} className="truncate font-mono text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus">{page.path}</button>
                      <span className="shrink-0 tabular-nums text-muted">{page.uses} {page.uses === 1 ? 'reply' : 'replies'}</span>
                    </div>
                    <div className="h-1 rounded-full bg-raised"><div className="h-1 rounded-full bg-ink" style={{ width: `${(page.uses / topUse) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            )}
          {usage.unused.length > 0 && (
            <p className="text-xs text-muted">Not used: {usage.unused.length} page{usage.unused.length === 1 ? '' : 's'}, like <span className="font-mono">{usage.unused[0]}</span>. Retire what no longer helps.</p>
          )}
        </Section>
      </div>
    </Page>
  );
};
