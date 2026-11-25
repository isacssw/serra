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

/** "+6 since Oct 26", "No change since …", or null without an earlier point. */
export const changeText = (now: number, then: number | null, since: string | null, unit = ''): string | null => {
  if (then === null || since === null) return null;
  const delta = now - then;
  const date = new Date(since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
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

/** A score line over time in a `width` × `height` box with `pad` around it for labels. Scores are 0–100. */
export const scoreChart = (points: HistoryPoint[], width: number, height: number, pad = { left: 28, right: 8, top: 8, bottom: 22 }): ChartGeometry => {
  const inner = { w: width - pad.left - pad.right, h: height - pad.top - pad.bottom };
  const times = points.map((point) => Date.parse(point.at));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const span = Math.max(1, last - first);
  const x = (time: number): number => pad.left + (points.length === 1 ? inner.w : ((time - first) / span) * inner.w);
  const y = (score: number): number => pad.top + (1 - score / 100) * inner.h;
  const dots = points.map((point, at) => ({ x: Math.round(x(times[at]!) * 10) / 10, y: Math.round(y(point.score) * 10) / 10, point }));
  // A step line: the score holds until the next change, which is what happened.
  const line = dots.map((dot, at) => (at === 0 ? `M${dot.x} ${dot.y}` : `H${dot.x} V${dot.y}`)).join(' ');
  const base = y(0);
  const area = dots.length > 0 ? `${line} V${base} H${dots[0]!.x} Z` : '';
  const grid = [0, 50, 100].map((score) => ({ y: y(score), label: String(score) }));
  const format = (time: number): string => new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const count = points.length < 2 ? 1 : 3;
  const ticks = Array.from({ length: count }, (_, at) => {
    const time = count === 1 ? last : first + (span * at) / (count - 1);
    return { x: x(time), label: format(time) };
  });
  return { line, area, dots, grid, ticks };
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
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined, timeZone: 'UTC' });
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
