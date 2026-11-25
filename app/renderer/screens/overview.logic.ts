// Knowledge › Overview, the pure half: chart geometry, the words for a score and its change, and the timeline
// grouped by day. Tested in tests/knowledge-health.test.ts; Overview.tsx draws it.
import type { EventKind, HistoryPoint, KnowledgeEvent } from '../../../src/knowledge-health.ts';
import type { KnowledgeOverview } from '../../../src/knowledge-overview.ts';
import type { ReviewSuggestion } from '../../../src/knowledge-review-store.ts';

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




/** The button that settles a review suggestion. */
const suggestionAction = (kind: 'replace' | 'retire' | 'confirm'): string => ({ replace: 'Approve', retire: 'Retire', confirm: 'Still true' })[kind];

/** "12 replies · 9 used your notes · 4 new facts": the week in one line. */
export const weekLine = (review: { replies: number; withKnowledge: number; facts: { before: number | null; now: number } }): string => [
  `${review.replies} repl${review.replies === 1 ? 'y' : 'ies'}`,
  `${review.withKnowledge} used your notes`,
  ...(review.facts.before !== null && review.facts.now > review.facts.before ? [`${review.facts.now - review.facts.before} new fact${review.facts.now - review.facts.before === 1 ? '' : 's'}`] : []),
].join(' · ');

/** What a page did, in two words, for the value list. */
export const valueLabel = (state: 'earns' | 'some' | 'carried' | 'idle' | 'unknown', uses: number): string => ({
  earns: `Used in ${uses} replies`, some: 'Used once', carried: 'Always in the brief', idle: 'Not used', unknown: 'Not used yet',
})[state];

/** One row of "To do": what it's about, why, the lines in question, and its one action. */
export interface FixItem {
  id: string;
  title: string;
  why: string;
  lines: string[];
  pages: string[];
  action: string;
  /** Set when the action is one click (a review fix); otherwise the action opens the page. */
  suggestion?: ReviewSuggestion;
  /** A proposal waiting for the owner: the action opens it in Proposals. */
  proposal?: string;
}

const FIX_RANK: Record<string, number> = { replace: 0, proposal: 0.5, conflict: 1, 'index-full': 2, duplicate: 3, overlap: 4, retire: 5, confirm: 6, stale: 7, unindexed: 8, draft: 9, long: 10, unstructured: 11 };

/**
 * Every organising job in one list, worst first: the weekly review's fixes (one click) and what the health check finds
 * now, without repeating a page a review fix already covers. Names pages by their description, not their file.
 */
export const fixItems = (overview: Pick<KnowledgeOverview, 'review' | 'health' | 'value'> & Partial<Pick<KnowledgeOverview, 'confirmHeldBack' | 'proposals'>>): FixItem[] => {
  const title = (path: string): string => overview.value.find((page) => page.path === path)?.title ?? path;
  const fromReview: FixItem[] = (overview.review?.suggestions ?? []).map((suggestion) => ({
    id: suggestion.id, title: suggestion.title, why: suggestion.why, lines: [], pages: [suggestion.page],
    action: suggestionAction(suggestion.kind), suggestion,
  }));
  const covered = new Set(fromReview.map((item) => `${item.suggestion!.kind === 'replace' ? 'conflict' : item.suggestion!.kind === 'confirm' ? 'stale' : 'overlap'}:${item.pages[0]}`));
  const fromHealth: FixItem[] = overview.health.issues.flatMap((issue) => {
    const page = issue.pages[0]!;
    if (covered.has(`${issue.kind === 'duplicate' ? 'conflict' : issue.kind}:${page}`) || issue.pages.some((path) => covered.has(`conflict:${path}`))) return [];
    const why = ({ conflict: 'Two rules disagree', duplicate: 'A rule is written twice', overlap: 'Two pages on one topic', stale: 'Not confirmed in over 60 days', draft: 'Not confirmed yet', unindexed: 'Not in the index, so never used', long: 'Near the page size limit', unstructured: 'Long prose, hard for the bot to scan', 'index-full': 'The index is nearly full' } as const)[issue.kind];
    // "Still true" only where nothing suggests it changed; otherwise the page opens for the owner to look.
    const held = overview.confirmHeldBack?.includes(page) ?? false;
    const stale: ReviewSuggestion | undefined = issue.kind === 'stale' && !held ? { id: `confirm:${page}`, kind: 'confirm', page, title: title(page), why } : undefined;
    return [{
      id: `${issue.kind}:${issue.pages.join(',')}`, title: page === 'index.md' ? 'Knowledge index' : issue.pages.map(title).join(' and '), why, lines: issue.detail ?? [],
      pages: issue.pages, action: stale ? 'Still true' : issue.kind === 'conflict' || issue.kind === 'duplicate' ? 'Settle' : 'Open', ...(stale ? { suggestion: stale } : {}),
      ...(issue.kind === 'stale' && held ? { why: `${why}, and a newer page on its topic may have changed it` } : {}),
    }];
  });
  // Proposals waiting for the owner are in the same list: one place for everything to decide. The review's own
  // rewrites are already above, with their one-click Approve.
  const reviewed = new Set((overview.review?.suggestions ?? []).flatMap((suggestion) => (suggestion.proposal ? [suggestion.proposal] : [])));
  const fromProposals: FixItem[] = (overview.proposals ?? []).filter((proposal) => !reviewed.has(proposal.id)).map((proposal) => ({
    id: `proposal:${proposal.id}`, title: proposal.title, why: 'Waiting for your approval', lines: [], pages: [], action: 'Review', proposal: proposal.id,
  }));
  const kind = (item: FixItem): string => item.suggestion?.kind === 'confirm' && !overview.review?.suggestions.some((suggestion) => suggestion.id === item.id) ? 'stale' : item.suggestion?.kind ?? item.id.split(':')[0]!;
  return [...fromReview, ...fromProposals, ...fromHealth].sort((a, b) => (FIX_RANK[kind(a)] ?? 20) - (FIX_RANK[kind(b)] ?? 20));
};
