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

/** Pages with the chosen badge whose path, name or description contains `query` (any case). */
export const filterPages = (pages: readonly KnowledgePage[], filter: PageFilter, query = ''): KnowledgePage[] => {
  const needle = query.trim().toLowerCase();
  return pages.filter((page) =>
    (filter === 'all' || (page.badge === filter && !(filter === 'verified' && page.disputed)))
    && (!needle || page.path.toLowerCase().includes(needle) || (page.description ?? '').toLowerCase().includes(needle) || (page.title ?? '').toLowerCase().includes(needle)));
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
    .map(([area, list]) => ({ area, pages: [...list].sort((x, y) => pageLabel(x).localeCompare(pageLabel(y))) }));
};

/** The page's file name, as the list shows it under its folder. */
const pageName = (path: string): string => path.split('/').pop() ?? path;

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
 * the same one the weekly review writes, else today. A date after today is a plan, not a start, so today wins. So does
 * a date before the one the `dropped` line gives: keeping the older of two rules ends the newer one today, not before
 * it was learned.
 */
export const replacedOn = (kept: string, today: string, dropped = ''): string => {
  const dateIn = (line: string): string | undefined => /\b(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1];
  const date = dateIn(kept);
  const since = dateIn(dropped);
  return date && date <= today && !(since && since > date) ? date : today;
};

export const keepRule = (text: string, drop: string, date: string): string => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Only a current rule moves: never a line of the header, a code block or the "Replaced" section itself.
  let [header, fence, replaced] = [lines[0] === '---', false, false];
  const at = lines.findIndex((line, index) => {
    if (header) { if (index > 0 && line === '---') header = false; return false; }
    if (/^\s*```/.test(line)) { fence = !fence; return false; }
    if (fence) return false;
    if (/^##\s/.test(line)) replaced = /^##\s+Replaced\b/i.test(line);
    return !replaced && line.trim().replace(/^([-*]|\d+\.)\s+/, '').trim() === drop.trim();
  });
  if (at === -1) return text;
  // A bullet with sub-bullets can't move alone: they would end up under the bullet above. The page opens instead.
  const indent = (line: string): number => /^\s*/.exec(line)![0].length;
  const next = lines[at + 1];
  if (next !== undefined && /^\s*([-*]|\d+\.)\s/.test(next) && indent(next) > indent(lines[at]!)) return text;
  lines.splice(at, 1);
  const entry = `- Until ${date}: ${drop.trim()}`;
  // The page's own "Replaced" heading, never one shown in a code block or the header.
  let [inHeader, inFence] = [lines[0] === '---', false];
  const heading = lines.findIndex((line, index) => {
    if (inHeader) { if (index > 0 && line === '---') inHeader = false; return false; }
    if (/^\s*```/.test(line)) { inFence = !inFence; return false; }
    return !inFence && /^##\s+Replaced\b/i.test(line);
  });
  if (heading === -1) return `${lines.join('\n').trimEnd()}\n\n## Replaced\n\n${entry}\n`;
  // Under the heading, newest first; the heading may be the page's last line, with nothing under it yet.
  const rest = lines.slice(heading + 1);
  while (rest.length > 0 && rest[0]!.trim() === '') rest.shift();
  return `${[...lines.slice(0, heading + 1), '', entry, ...rest].join('\n').trimEnd()}\n`;
};

/** The page's current rules, one per line, without its header or anything under `## Replaced`. */
export const currentRules = (text: string): string[] => text.replace(/\r\n?/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^##\s+Replaced\b[\s\S]*?(?=^##\s|(?![\s\S]))/gim, '')
  // A code block shows an example, not a rule.
  .replace(/^\s*```[^\n]*\n[\s\S]*?(?:^\s*```[^\n]*$|(?![\s\S]))/gm, '')
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

/** Which page to show after the list reloads: the current one if it's still there, else the first. */
export const keepSelection = (pages: readonly KnowledgePage[], current: string | null): string | null =>
  current && pages.some((page) => page.path === current) ? current : (pages[0]?.path ?? null);

/** What a page is called in the list and its header: its own heading ("Tom Reyes"), else its description. */
export const pageLabel = (page: Pick<KnowledgePage, 'path' | 'title' | 'description'>): string => page.title ?? page.description ?? pageName(page.path);

/** The muted line under a page's name: its description, when it says something the name doesn't. */
export const pageDetail = (page: Pick<KnowledgePage, 'path' | 'title' | 'description'>): string | null =>
  page.description && page.description.toLowerCase() !== pageLabel(page).toLowerCase() ? page.description : null;

/** `2026-11-03` as "Nov 3". */
const dayName = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A page's one meta line: "Processes · written Nov 3". Whether and when it was verified is the badge's (and its tooltip's). */
export const pageMeta = (page: Pick<KnowledgePage, 'area' | 'written'>): string => [
  page.area,
  page.written && /^\d{4}-\d{2}-\d{2}$/.test(page.written) ? `written ${dayName(page.written)}` : null,
].filter(Boolean).join(' · ');

/** A page's text as its header (the lines between the `---` fences) and its body, so the editor can fold the header away. */
export const splitHeader = (text: string): { header: string | null; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  return match ? { header: match[1]!, body: match[2]! } : { header: null, body: text };
};

/** The page again from its header and body: `splitHeader`'s inverse. */
export const joinHeader = (header: string | null, body: string): string => (header === null ? body : `---\n${header}\n---\n${body}`);
