// Knowledge › Overview, the pure half: chart geometry, the words for a score and its change, and the timeline
// grouped by day. Tested in tests/knowledge-health.test.ts; Overview.tsx draws it.
import type { EventKind, HealthParts, HistoryPoint, IssueKind, KnowledgeEvent } from '../../../src/knowledge-health.ts';

export type Tone = 'up' | 'warn' | 'down' | 'neutral';

/** The score in a word, with its tone: the number alone doesn't say whether to act. */
export const scoreWord = (score: number, pages: number): { word: string; tone: Tone } => {
  if (pages === 0) return { word: 'Nothing yet', tone: 'neutral' };
  if (score >= 85) return { word: 'Healthy', tone: 'up' };
  if (score >= 65) return { word: 'Could use a tidy', tone: 'warn' };
  return { word: 'Needs a tidy', tone: 'down' };
};

/** "Nov 18", the date format the other knowledge screens use. */
export const shortDate = (at: string | number): string => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "+6 since Oct 26", "No change since …", or null without an earlier point. */
export const changeText = (now: number, then: number | null, since: string | null, unit = ''): string | null => {
  if (then === null || since === null) return null;
  const delta = now - then;
  const date = shortDate(since);
  if (delta === 0) return `No change since ${date}`;
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}${unit} since ${date}`;
};

export interface ChartGeometry {
  /** The line through every point, as an SVG path. */
  line: string;
  /** The same, closed down to the baseline, for a faint fill. */
  area: string;
  dots: { x: number; y: number; point: HistoryPoint }[];
  /** Horizontal gridlines with their labels. */
  grid: { y: number; label: string }[];
  /** A few dates along the bottom. */
  ticks: { x: number; label: string }[];
}

/** A step line of `value` over time in a `width` × `height` box, between `min` and `max`, with `pad` for labels. */
const stepChart = (points: HistoryPoint[], value: (point: HistoryPoint) => number, min: number, max: number, width: number, height: number, pad: { left: number; right: number; top: number; bottom: number }, gridAt: number[]): ChartGeometry => {
  const inner = { w: width - pad.left - pad.right, h: height - pad.top - pad.bottom };
  const times = points.map((point) => Date.parse(point.at));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const span = Math.max(1, last - first);
  const x = (time: number): number => pad.left + (points.length === 1 ? inner.w : ((time - first) / span) * inner.w);
  const y = (amount: number): number => pad.top + (1 - (amount - min) / Math.max(1, max - min)) * inner.h;
  const dots = points.map((point, at) => ({ x: Math.round(x(times[at]!) * 10) / 10, y: Math.round(y(value(point)) * 10) / 10, point }));
  // A step line: the value holds until the next change, which is what happened.
  const line = dots.map((dot, at) => (at === 0 ? `M${dot.x} ${dot.y}` : `H${dot.x} V${dot.y}`)).join(' ');
  const area = dots.length > 0 ? `${line} V${y(min)} H${dots[0]!.x} Z` : '';
  const grid = gridAt.map((amount) => ({ y: y(amount), label: String(amount) }));
  const count = points.length < 2 ? 1 : 3;
  const ticks = Array.from({ length: count }, (_, at) => {
    const time = count === 1 ? last : first + (span * at) / (count - 1);
    return { x: x(time), label: shortDate(time) };
  });
  return { line, area, dots, grid, ticks };
};

/** The health score over time. The axis starts a step below the lowest score, so a drop from 91 to 84 shows; gridlines are even. */
export const scoreChart = (points: HistoryPoint[], width: number, height: number, pad = { left: 36, right: 8, top: 10, bottom: 30 }): ChartGeometry => {
  const floor = Math.max(0, Math.floor((Math.min(...points.map((point) => point.score)) - 10) / 20) * 20);
  return stepChart(points, (point) => point.score, floor, 100, width, height, pad, [floor, (floor + 100) / 2, 100]);
};

/** Facts known over time, from zero: whether the bot knows more, which the score alone can hide. */
export const factsChart = (points: HistoryPoint[], width: number, height: number, pad = { left: 36, right: 8, top: 18, bottom: 4 }): ChartGeometry => {
  const top = Math.max(1, ...points.map((point) => point.facts));
  return stepChart(points, (point) => point.facts, 0, top, width, height, pad, [0, top]);
};

export const EVENT_LABELS: Record<EventKind, string> = {
  learned: 'Learned', updated: 'Updated', replaced: 'Replaced', removed: 'Retired', confirmed: 'Confirmed',
};

export interface DayGroup {
  day: string;
  label: string;
  events: KnowledgeEvent[];
  /** Pages only re-confirmed that day, shown as one line. */
  confirmed: string[];
}

/** Events by day, newest first. Re-confirmations fold into one line per day; the rest keep their own row. */
export const groupByDay = (events: KnowledgeEvent[], now: Date, limit = 8): DayGroup[] => {
  const days = new Map<string, DayGroup>();
  for (const event of events) {
    const day = event.at.slice(0, 10);
    const group = days.get(day) ?? { day, label: dayLabel(day, now), events: [], confirmed: [] };
    if (event.kind === 'confirmed') { if (!group.confirmed.includes(event.page)) group.confirmed.push(event.page); }
    else group.events.push(event);
    days.set(day, group);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit);
};

const dayLabel = (day: string, now: Date): string => {
  const today = now.toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined, timeZone: 'UTC' });
};

export const ISSUE_TONES: Record<IssueKind, Tone> = {
  conflict: 'down', 'index-full': 'down', duplicate: 'warn', overlap: 'warn', unindexed: 'warn', stale: 'neutral', draft: 'neutral', long: 'neutral', unstructured: 'neutral',
};

export const ISSUE_LABELS: Record<IssueKind, string> = {
  conflict: 'Conflict', 'index-full': 'Index nearly full', duplicate: 'Repeated', overlap: 'Same topic', unindexed: 'Not indexed',
  stale: 'Stale', draft: 'Draft', long: 'Long page', unstructured: 'Hard to scan',
};

/** The parts of the score, in the words the screen uses. */
export const PART_LABELS: Record<keyof HealthParts, string> = { fresh: 'Recently confirmed', consistent: 'No conflicts', unique: 'No repeats', organised: 'Organised', coverage: 'Areas covered' };
export const PART_ORDER: readonly (keyof HealthParts)[] = ['fresh', 'consistent', 'unique', 'organised', 'coverage'];

/** Share of replies that used knowledge, as a whole percent, or null with no replies. */
export const usedShare = (replies: number, withKnowledge: number): number | null => (replies === 0 ? null : Math.round((withKnowledge / replies) * 100));

/** The button that settles a review suggestion. */
export const suggestionAction = (kind: 'replace' | 'retire' | 'confirm'): string => ({ replace: 'Approve', retire: 'Retire', confirm: 'Still true' })[kind];

/** "12 replies · 9 used your notes · health 72 → 84 · 18 → 22 facts": the week in one line. */
export const weekLine = (review: { replies: number; withKnowledge: number; score: { before: number | null; now: number }; facts: { before: number | null; now: number } }): string => [
  `${review.replies} repl${review.replies === 1 ? 'y' : 'ies'}`,
  `${review.withKnowledge} used your notes`,
  review.score.before === null ? `health ${review.score.now}` : `health ${review.score.before} → ${review.score.now}`,
  review.facts.before === null ? `${review.facts.now} facts` : `${review.facts.before} → ${review.facts.now} facts`,
].join(' · ');

/** What a page did, in two words, for the value list. */
export const valueLabel = (state: 'earns' | 'some' | 'carried' | 'idle' | 'unknown', uses: number): string => ({
  earns: `Used in ${uses} replies`, some: 'Used once', carried: 'Always in the brief', idle: 'Not used', unknown: 'Not used yet',
})[state];
