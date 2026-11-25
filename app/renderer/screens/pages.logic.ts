// The Pages screen's logic: badges, filtering and grouping the list, and what the editor lets the owner save.
// Pure data and functions: imported by `node --test` as well as the renderer. The save rules come from
// src/knowledge-rules.ts, the same functions the service refuses a save with, so the editor's message is the service's.
import type { KnowledgePage, PageBadge } from '../../../src/contracts.ts';
import {
  lineCount, normalizePageText, PAGE_MAX_LINES, saveProblems, saveRefusal, setHeaderField, STALE_DAYS,
} from '../../../src/knowledge-rules.ts';

export type PageFilter = 'all' | PageBadge;
export type BadgeTone = 'up' | 'warn' | 'neutral';

export const badgeLabel = (badge: PageBadge): string =>
  badge === 'verified' ? 'Verified' : badge === 'stale' ? 'Stale' : 'Unverified';

export const badgeTone = (badge: PageBadge): BadgeTone => (badge === 'verified' ? 'up' : badge === 'stale' ? 'warn' : 'neutral');

/** The badge's tooltip: when the owner confirmed the page, or that they never did. */
export const badgeTitle = (page: Pick<KnowledgePage, 'badge' | 'verified'>): string =>
  page.badge === 'unverified' ? 'The owner has not confirmed this page.'
    : page.badge === 'stale' ? `Verified ${page.verified}, more than ${STALE_DAYS} days ago. Check it still holds.`
      : `Verified ${page.verified}.`;

export const badgeCounts = (pages: readonly KnowledgePage[]): Record<PageFilter, number> => {
  const counts: Record<PageFilter, number> = { all: pages.length, verified: 0, unverified: 0, stale: 0 };
  // A page with rules that disagree isn't counted as verified: it shows under All until it's settled.
  for (const page of pages) if (!(page.disputed && page.badge === 'verified')) counts[page.badge] += 1;
  return counts;
};

/** The screen's subtitle, like `12 pages · 9 verified · 2 stale · 1 unverified`. */
export const pagesSummary = (pages: readonly KnowledgePage[]): string => {
  const counts = badgeCounts(pages);
  if (counts.all === 0) return 'No pages yet';
  const settle = pages.filter((page) => page.disputed).length;
  const verified = pages.filter((page) => page.badge === 'verified' && !page.disputed).length;
  const parts = [`${counts.all} ${counts.all === 1 ? 'page' : 'pages'}`, `${verified} verified`];
  if (settle > 0) parts.push(`${settle} to settle`);
  if (counts.stale > 0) parts.push(`${counts.stale} stale`);
  if (counts.unverified > 0) parts.push(`${counts.unverified} unverified`);
  return parts.join(' · ');
};

/** Pages with the chosen badge whose path or description contains `query` (any case). */
export const filterPages = (pages: readonly KnowledgePage[], filter: PageFilter, query = ''): KnowledgePage[] => {
  const needle = query.trim().toLowerCase();
  return pages.filter((page) =>
    (filter === 'all' || (page.badge === filter && !(filter === 'verified' && page.disputed)))
    && (!needle || page.path.toLowerCase().includes(needle) || (page.description ?? '').toLowerCase().includes(needle)));
};

export interface PageFolder {
  /** Folder relative to `knowledge/`, or '' for pages at its top. */
  folder: string;
  pages: KnowledgePage[];
}

/** Pages grouped by folder, top-level pages first, then folders by name. Order inside a folder follows the input. */
export const groupByFolder = (pages: readonly KnowledgePage[]): PageFolder[] => {
  const groups = new Map<string, KnowledgePage[]>();
  for (const page of pages) {
    const folder = page.path.includes('/') ? page.path.slice(0, page.path.lastIndexOf('/')) : '';
    const list = groups.get(folder);
    if (list) list.push(page);
    else groups.set(folder, [page]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({ folder, pages: list }));
};

/** The order the areas come in, the same as Overview's. */
const AREA_ORDER = ['Who you are', 'How you work', 'How you write', 'Off-limits', 'People', 'Processes', 'Projects', 'Other'];

/** Pages grouped by what they're about, not where the file sits: "How you work", "People"… Each sorted by name. */
export const groupByArea = (pages: readonly KnowledgePage[]): { area: string; pages: KnowledgePage[] }[] => {
  const groups = new Map<string, KnowledgePage[]>();
  for (const page of pages) groups.set(page.area ?? 'Other', [...(groups.get(page.area ?? 'Other') ?? []), page]);
  const rank = (area: string): number => (AREA_ORDER.includes(area) ? AREA_ORDER.indexOf(area) : AREA_ORDER.length);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([area, list]) => ({ area, pages: [...list].sort((x, y) => (x.description ?? x.path).localeCompare(y.description ?? y.path)) }));
};

/** The page's file name, as the list shows it under its folder. */
export const pageName = (path: string): string => path.split('/').pop() ?? path;

export interface EditorState {
  /** The draft differs from the saved text (line endings and trailing blank lines don't count). */
  dirty: boolean;
  lines: number;
  /** `87 / 120 lines`. */
  linesLabel: string;
  overCap: boolean;
  /** What stops the save, the same list the service would refuse with. */
  problems: string[];
  /** The message the service would refuse the save with, or null when it would accept it. */
  refusal: string | null;
  canSave: boolean;
}

export const editorState = (path: string, saved: string, draft: string): EditorState => {
  const problems = saveProblems(path, draft);
  const lines = lineCount(normalizePageText(draft));
  const dirty = normalizePageText(draft) !== normalizePageText(saved);
  return {
    dirty,
    lines,
    linesLabel: `${lines} / ${PAGE_MAX_LINES} lines`,
    overCap: lines > PAGE_MAX_LINES,
    problems,
    refusal: problems.length > 0 ? saveRefusal(problems) : null,
    canSave: dirty && problems.length === 0,
  };
};

/** Today's date where the owner is, `YYYY-MM-DD`. */
export const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** The draft with `verified` set to `date`. A draft with no header is returned as it is (the problems list says why). */
export const markVerified = (text: string, date: string): string => setHeaderField(text.replace(/\r\n?/g, '\n'), 'verified', date);

/**
 * The page with `drop` (a rule on it, as Overview quotes it) moved under a `## Replaced` heading at the end, dated
 * `date`, so `keep` is the one current rule. The bot never reads what's under that heading. Unchanged when `drop` isn't
 * a line of the page.
 */
/**
 * The date an old rule stopped holding, for its "Until" line: the date the kept rule gives itself ("since 2026-10-01"),
 * the same one the weekly review writes, else today. A date after today is a plan, not a start, so today wins.
 */
export const replacedOn = (kept: string, today: string): string => {
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(kept)?.[1];
  return date && date <= today ? date : today;
};

export const keepRule = (text: string, drop: string, date: string): string => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((line) => line.trim().replace(/^([-*]|\d+\.)\s+/, '').trim() === drop.trim());
  if (at === -1) return text;
  lines.splice(at, 1);
  const body = lines.join('\n').trimEnd();
  const entry = `- Until ${date}: ${drop.trim()}`;
  return /^##\s+Replaced\b/im.test(body)
    // A function, not a replacement string: a rule like "Refunds over $100" must not be read as `$1`.
    ? `${body.replace(/^(##\s+Replaced\b[^\n]*\n(?:\n)?)/im, (head) => `${head}${entry}\n`)}\n`
    : `${body}\n\n## Replaced\n\n${entry}\n`;
};

/** The page's current rules, one per line, without its header or anything under `## Replaced`. */
export const currentRules = (text: string): string[] => text.replace(/\r\n?/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^##\s+Replaced\b[\s\S]*?(?=^##\s|(?![\s\S]))/gim, '')
  .split('\n').map((line) => line.trim().replace(/^([-*]|\d+\.)\s+/, '').trim()).filter(Boolean);

/**
 * Which of two disagreeing rules reads as the newer one: the one that says "now", or "since", "as of" or "starting"
 * followed by a date or a month ("since 2026-06-15", "as of June"), else neither. A causal "since" ("since on-call is
 * thin") says nothing about time.
 */
export const newerRule = (a: string, b: string): 0 | 1 | null => {
  const MONTH = '(?:\\d{4}-\\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
  const fresh = (text: string): boolean => /\bnow\b/i.test(text) || new RegExp(`\\b(?:since|as of|starting|from)\\s+(?:the\\s+)?(?:\\d{1,2}\\s+)?${MONTH}`, 'i').test(text);
  if (fresh(a) === fresh(b)) return null;
  return fresh(a) ? 0 : 1;
};

/**
 * The Keep button's label: "Keep Thursday", "Keep 300", the word that sets this rule apart from the other, so two
 * buttons never read the same. "Keep this one" when no single word does.
 */
export const keepLabel = (rule: string, other: string): string => {
  const words = (text: string): string[] => text.match(/[\p{L}\p{N}#@][\p{L}\p{N}#@:.%-]*/gu)?.map((word) => word.replace(/[.:]+$/, '')) ?? [];
  const theirs = new Set(words(other).map((word) => word.toLowerCase()));
  const own = words(rule).find((word) => !theirs.has(word.toLowerCase()) && (/\d/.test(word) || /^[A-Z#]/.test(word)));
  return own ? `Keep ${own}` : 'Keep this one';
};

/** Which page to show after the list reloads: the current one if it's still there, else the first. */
export const keepSelection = (pages: readonly KnowledgePage[], current: string | null): string | null =>
  current && pages.some((page) => page.path === current) ? current : (pages[0]?.path ?? null);
