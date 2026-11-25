// Knowledge › Overview, read in five seconds: how many replies the notes shaped, one request answered with and without
// them, and To do when there is something to do. Everything else (each page's use, health over time, areas, what it
// learned lately, the weekly review's settings) is under Details.
import { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, ChevronRight, CircleCheck, CircleDot, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { KnowledgeOverview } from '../../../src/knowledge-overview.ts';
import { serra } from '../bridge.ts';
import { FixList } from './overview/FixList.tsx';
import { ValueList } from './overview/ValueList.tsx';
import { Proof, ReviewControls } from './overview/WeekDigest.tsx';
import { Button, cx, EmptyState, Page } from '../ui/index.ts';
import {
  changeText, EVENT_LABELS, factsChart, shortDate, groupByDay, headline, scoreChart, scoreWord,
} from './overview.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));


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
  const growthLine = [
    `Health ${health.score} · ${word.word.toLowerCase()}${monthAgo ? ` (${changeText(health.score, monthAgo.score, monthAgo.at) ?? ''})` : ''}`,
    `${health.facts} facts${monthAgo ? ` (${changeText(health.facts, monthAgo.facts, monthAgo.at) ?? ''})` : ''}`,
  ].join(' · ');
  const days = groupByDay(overview.events, now, 5);
  const head = headline(overview, now);
  const example = overview.review?.examples[0];

  return (
    <Page title="Overview">
      <section aria-label="What your notes did" className="flex flex-col gap-4 rounded-lg border border-line bg-panel px-5 py-4">
        {head
          ? (
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-4xl font-semibold tracking-tight tabular-nums">{head.used}<span className="text-2xl font-normal text-muted"> / {head.replies}</span></span>
              <span className="text-sm text-muted">replies used your notes {head.period}</span>
            </p>
          )
          : <p className="text-sm text-muted">No replies yet.</p>}
        {example && <Proof example={example} />}
        {!overview.review && <ReviewControls weekly={overview.reviewWeekly} first onChanged={() => void load()} />}
      </section>

      <FixList overview={overview} onOpen={open} onChanged={() => void load()} />

      <details className="group flex flex-col">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} aria-hidden className="transition-transform group-open:rotate-90" />Details
        </summary>
        <div className="mt-4 flex flex-col gap-8">
          {overview.review && (
            <Section title="Weekly review" aside={`${shortDate(`${overview.review.from}T00:00:00Z`)} – ${shortDate(`${overview.review.to}T00:00:00Z`)}`}>
              <p className="text-[13px] leading-5 text-muted">{overview.review.summary}</p>
              {overview.review.examples.slice(1).map((more) => <Proof key={more.page} example={more} />)}
              {overview.review.error && <p className="text-xs text-warn">The model part didn’t run: {overview.review.error}</p>}
              <ReviewControls weekly={overview.reviewWeekly} first={false} onChanged={() => void load()} />
            </Section>
          )}

          <ValueList value={overview.value} days={usage.days} replies={usage.replies} onOpen={open} onChanged={() => void load()} />

          <Section title="Growth" aside={growthLine}>
            {overview.points.length > 1 && <div className="rounded-lg border border-line bg-panel px-3 pt-3 pb-1"><ScoreChart overview={overview} /></div>}
            <ul className="flex flex-wrap gap-1.5" aria-label="What your bot knows about you, by area">
              {health.areas.map((area) => (
                <li key={area.area} title={area.headline ?? undefined} className={cx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', area.conflicts > 0 ? 'border-warn/40 text-ink' : 'border-line text-ink')}>
                  {area.conflicts > 0
                    ? <AlertTriangle size={12} aria-label="Has rules that disagree" className="text-warn" />
                    : area.confirmed > 0 ? <CircleCheck size={12} aria-label="Covered" className="text-up" /> : <CircleDot size={12} aria-label="Nothing yet" className="text-faint" />}
                  {area.label}
                  <span className="tabular-nums text-muted">{area.facts}</span>
                </li>
              ))}
            </ul>
          </Section>

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
