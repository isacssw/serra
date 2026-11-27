// Knowledge › Overview, read in five seconds: four numbers (pages, replies they shaped, health, what needs you), the
// To do list beside what the bot knows by area and how its health moved. Each page's use, the weekly review's summary
// and what it learned lately are under Details.
import { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, ChevronRight, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { KnowledgeOverview } from '../../../src/knowledge-overview.ts';
import { serra } from '../bridge.ts';
import { FixList } from './overview/FixList.tsx';
import { ValueList } from './overview/ValueList.tsx';
import { Proof, ReviewControls } from './overview/WeekDigest.tsx';
import { Button, cx, EmptyState, Page } from '../ui/index.ts';
import {
  EVENT_LABELS, factsChart, fixItems, shortDate, groupByDay, headline, scoreChart, scoreWord, todoSummary,
} from './overview.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));


const Section = ({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) => {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        {aside && <div className="text-xs text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
};


/** One number on the stat strip: a label, the figure, and a short note under it. */
const Stat = ({ label, value, unit, note }: { label: string; value: number; unit?: string; note: string }) => (
  <div className="flex min-w-0 flex-col gap-1 border-line px-5 py-4 not-first:border-l max-sm:nth-3:border-l-0 max-sm:nth-[n+3]:border-t">
    <p className="text-xs font-medium text-muted">{label}</p>
    <p className="text-[28px] leading-8 font-semibold tracking-[-0.02em] tabular-nums text-ink">{value}{unit && <span className="text-base font-medium text-faint">{unit}</span>}</p>
    <p className="text-xs leading-4 text-faint" title={note}>
      {note.split(' · ').map((part, at) => <span key={part} className="whitespace-nowrap">{at > 0 && <span aria-hidden> · </span>}{part}</span>)}
    </p>
  </div>
);

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
  const factsHeight = 64;
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
        {facts.dots.length > 1 && (
          // The count where it started and where it is, so the line reads as numbers, not just a direction.
          <>
            <Label x={facts.dots[0]!.x + 4} y={8} width={width} height={factsHeight} align="start">{facts.dots[0]!.point.facts}</Label>
            <Label x={facts.dots.at(-1)!.x} y={8} width={width} height={factsHeight} align="end">{facts.dots.at(-1)!.point.facts}</Label>
          </>
        )}
        {shown && <Label x={Math.min(shown.x + 4, width - 40)} y={factsHeight - 12} width={width} height={factsHeight} align="start">{chart.dots[active!]!.point.facts} facts</Label>}
      </div>
    </div>
  );
};


export const Overview = () => {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  if (!overview) return <Page title="Overview" />;

  const { health, monthAgo, usage } = overview;
  if (health.pages === 0) {
    return (
      <Page title="Overview">
        <EmptyState icon={<Sparkles size={18} />} title="Your bot doesn't know you yet" action={<Button variant="primary" onClick={() => void navigate('/knowledge/proposals?interview=1')}>Start interview</Button>} />
      </Page>
    );
  }

  const word = scoreWord(health.score, health.pages);
  const days = groupByDay(overview.events, now, 5);
  const head = headline(overview, now);
  const example = overview.review?.examples[0];
  const todo = fixItems(overview);
  const grown = monthAgo ? health.pages - monthAgo.pages : null;
  const conflicts = health.issues.filter((issue) => issue.kind === 'conflict').length;
  const most = Math.max(1, ...health.areas.map((area) => area.pages));

  return (
    <Page
      title="Overview"
      actions={(
        <>
          {overview.review && <span className="text-xs text-faint">Reviewed {shortDate(`${overview.review.to}T00:00:00Z`)}</span>}
          <ReviewControls weekly={overview.reviewWeekly} ran={overview.review !== null} onChanged={() => void load()} />
        </>
      )}
    >
      <section aria-label="At a glance" className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-panel shadow-card sm:grid-cols-4">
        <Stat label="Pages" value={health.pages} note={grown === null ? `${health.facts} facts` : grown > 0 ? `+${grown} in 30 days` : `${health.facts} facts`} />
        <Stat label="Used in replies" value={head?.used ?? 0} note={head ? `of ${head.replies} ${head.period}` : 'No replies yet'} />
        <Stat label="Health" value={health.score} unit="%" note={conflicts > 0 ? `${word.word} · ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : word.word} />
        <Stat label="To review" value={todo.length} note={todoSummary(todo)} />
      </section>

      {example && (
        <section aria-label="This week" className="rounded-xl border border-line bg-panel px-5 py-4 shadow-card"><Proof example={example} /></section>
      )}

      <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]">
        <FixList overview={overview} onOpen={open} onChanged={() => void load()} />
        <div className="flex min-w-0 flex-col gap-8">
          <Section title="Coverage" aside={`${health.areas.length} areas`}>
            <ul className="flex flex-col gap-2.5 border-t border-line pt-3" aria-label="Pages by area">
              {health.areas.map((area) => (
                <li key={area.area} title={area.headline ?? undefined} className="grid grid-cols-[7.5rem_minmax(0,1fr)_1.5rem] items-center gap-3 text-[13px]">
                  <span className="flex min-w-0 items-center gap-1 truncate text-muted">
                    {area.label}
                    {area.conflicts > 0 && <AlertTriangle size={12} aria-label="Has rules that disagree" className="shrink-0 text-warn" />}
                  </span>
                  <span aria-hidden className={cx('h-1.5 overflow-hidden rounded-full', area.pages ? 'bg-selected' : 'border border-dashed border-line-strong')}>
                    <span className="block h-full rounded-full bg-muted" style={{ width: `${(100 * area.pages) / most}%` }} />
                  </span>
                  <span className="text-right text-xs tabular-nums text-faint">{area.pages}</span>
                </li>
              ))}
            </ul>
          </Section>
          {overview.points.length > 1 && (
            <Section title="Growth" aside={`${health.facts} facts`}>
              <div className="border-t border-line pt-3"><ScoreChart overview={overview} /></div>
            </Section>
          )}
        </div>
      </div>

      <details className="group flex flex-col border-t border-line pt-4">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[13px] font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} aria-hidden className="transition-transform group-open:rotate-90" />Details
        </summary>
        <div className="mt-5 flex flex-col gap-8">
          {overview.review && (
            <Section title="Weekly review" aside={`${shortDate(`${overview.review.from}T00:00:00Z`)} – ${shortDate(`${overview.review.to}T00:00:00Z`)}`}>
              <p className="text-[13px] leading-5 text-muted">{overview.review.summary}</p>
              {overview.review.examples.slice(1).map((more) => <Proof key={more.page} example={more} />)}
              {overview.review.error && <p className="text-xs text-warn">The model part didn’t run: {overview.review.error}</p>}
            </Section>
          )}

          <ValueList value={overview.value} days={usage.days} replies={usage.replies} onOpen={open} onChanged={() => void load()} />

          {days.length > 0 && (
            <Section title="Recently learned">
              <ol className="flex flex-col gap-4">
                {days.map((day) => (
                  <li key={day.day} className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium text-muted">{day.label}</p>
                    <ul className="flex flex-col gap-1.5 border-l border-line pl-3">
                      {day.events.map((event, at) => (
                        <li key={`${event.page}-${at}`} className="flex min-w-0 flex-col">
                          <p className="text-[13px]">
                            <span className="font-medium">{EVENT_LABELS[event.kind]}</span>{' '}
                            <button type="button" onClick={() => open(event.page)} disabled={event.kind === 'removed'} title={event.page} className="text-muted hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus disabled:no-underline">{event.description || event.page}</button>
                          </p>
                          {(event.added[0] ?? event.removed[0]) && (
                            <p className="truncate text-xs text-muted">
                              {event.added[0] ? `“${event.added[0]}”` : event.removed[0] ? `Took out “${event.removed[0]}”` : ''}
                              {event.added.length > 1 ? ` and ${event.added.length - 1} more` : ''}
                            </p>
                          )}
                        </li>
                      ))}
                      {day.confirmed.length > 0 && (
                        <li className="text-[13px]"><span className="font-medium">Confirmed</span> <span className="text-muted">{day.confirmed.length} page{day.confirmed.length === 1 ? '' : 's'}</span></li>
                      )}
                    </ul>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </div>
      </details>
    </Page>
  );
};
