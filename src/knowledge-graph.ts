// Knowledge › Graph (SERRA-93): the owner's pages as a graph. Pages are the nodes; the links are the ones Serra can
// already read from its own files: a page naming another page or person (mentions), pages written from the same
// meeting, interview or thread (`sources:`), pages one reply used together (logs/knowledge-usage.jsonl), and rules
// that disagree (knowledge-health's conflicts). Pure: no Node values, so tests and evals build it from plain text.
import { AREA_LABELS, assessKnowledge, isPage, pageArea, type Health, type KnowledgeChange, type KnowledgeFile } from './knowledge-health.ts';
import { DATE, frontmatter, pageBody } from './knowledge-rules.ts';

export type GraphArea = keyof typeof AREA_LABELS;

/** The areas in the Overview's order: every one gets an island, an empty one drawn as a place to grow. */
const GRAPH_AREAS: readonly GraphArea[] = ['identity', 'rules', 'voice', 'limits', 'people', 'processes', 'projects', 'other'];

interface GraphPage {
  /** Path relative to `knowledge/`, like `owner/role.md`. */
  path: string;
  /** A short name for the dot: the page's first heading, else its description, else its file name. */
  label: string;
  description: string;
  area: GraphArea;
  /** When the page was written, `YYYY-MM-DD`: its `written:` header, else the day it was first approved, else null. */
  written: string | null;
  /** Replies that named the page in the last `days` days. */
  uses: number;
}

export type GraphLinkKind = 'mentions' | 'source' | 'cited' | 'disagrees';

interface GraphLink {
  /** Indexes into `pages`. */
  a: number;
  b: number;
  kind: GraphLinkKind;
}

/** Two rules that disagree, with their pages (the same page when both are on one), for "Keep this / Keep that". */
export interface GraphConflict {
  pages: [number, number];
  rules: [{ page: string; text: string }, { page: string; text: string }];
}

export interface KnowledgeGraph {
  pages: GraphPage[];
  links: GraphLink[];
  conflicts: GraphConflict[];
  areas: { area: GraphArea; label: string }[];
  /** The usage window `uses` counts, in days. */
  days: number;
}

/** A reply's record as the graph needs it (src/knowledge-usage.ts KnowledgeUse). */
interface Use { at: string; cited: string[] }

const DAY_MS = 86_400_000;
/** Links of one kind win over another between the same two pages: a disagreement is worth showing above all. */
const RANK: Record<GraphLinkKind, number> = { disagrees: 0, mentions: 1, source: 2, cited: 3 };

/** The `- item` lines under a header's `sources:` key, lowercased, so two pages from one meeting match. */
const sourcesOf = (text: string): string[] => {
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const lines = header.split('\n');
  const start = lines.findIndex((line) => line.startsWith('sources:'));
  if (start === -1) return [];
  const inline = lines[start]!.slice('sources:'.length).trim().replace(/^-\s*/, '');
  const items = inline ? [inline] : [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) break;
    items.push(item[1] ?? '');
  }
  return items.map((item) => item.trim().toLowerCase()).filter(Boolean);
};

const heading = (text: string): string => /^#\s+(.+)$/m.exec(pageBody(text))?.[1]?.trim() ?? '';

const nameFromPath = (path: string): string => {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/, '').replace(/[-_]+/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
};

const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The graph of a knowledge folder's pages. `files` are the pages and index as text (the owner's approved copy),
 * `uses` the replies' usage records, `changes` the backups' change records (for pages with no `written:` date).
 */
export const buildKnowledgeGraph = ({ files, uses = [], changes = [], health, now, days = 30 }: {
  files: KnowledgeFile[]; uses?: Use[]; changes?: KnowledgeChange[]; health?: Pick<Health, 'issues'>; now: Date; days?: number;
}): KnowledgeGraph => {
  const pageFiles = files.filter((file) => isPage(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const index = new Map(pageFiles.map((file, i) => [file.path, i]));
  // The day each page was first approved, for a page whose header has no date.
  const firstSeen = new Map<string, string>();
  for (const change of changes) {
    if (change.undoneAt) continue;
    for (const file of change.files) {
      if (file.before !== null || file.after === null) continue;
      const day = change.at.slice(0, 10);
      if (!firstSeen.has(file.path) || day < firstSeen.get(file.path)!) firstSeen.set(file.path, day);
    }
  }
  const cutoff = now.getTime() - days * DAY_MS;
  const counts = new Map<string, number>();
  for (const use of uses) {
    if (Date.parse(use.at) < cutoff) continue;
    for (const path of new Set(use.cited)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const pages: GraphPage[] = pageFiles.map((file) => {
    const fields = frontmatter(file.text);
    const description = fields?.get('description')?.trim() ?? '';
    const written = fields?.get('written')?.trim() ?? '';
    return {
      path: file.path,
      label: short(heading(file.text) || description || nameFromPath(file.path), 32),
      description,
      area: pageArea(file.path, fields?.get('type')?.trim() ?? ''),
      written: DATE.test(written) ? written : firstSeen.get(file.path) ?? null,
      uses: counts.get(file.path) ?? 0,
    };
  });

  const links = new Map<string, GraphLink>();
  const link = (a: number, b: number, kind: GraphLinkKind): void => {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}-${y}`;
    const seen = links.get(key);
    if (!seen || RANK[kind] < RANK[seen.kind]) links.set(key, { a: x, b: y, kind });
  };

  // Rules that disagree.
  const conflicts: GraphConflict[] = [];
  for (const issue of (health ?? assessKnowledge(files, now)).issues) {
    const [first, second] = issue.facts ?? [];
    if (issue.kind !== 'conflict' || !first || !second) continue;
    const a = index.get(first.page);
    const b = index.get(second.page);
    if (a === undefined || b === undefined) continue;
    conflicts.push({ pages: [a, b], rules: [first, second] });
    link(a, b, 'disagrees');
  }

  // Mentions: a page's own path written in another page (`people/ana-silva.md`, with or without `.md`), or a person's
  // name: the heading of their page, or its first word when no other person shares it.
  const byPath = new Map<string, number>();
  for (const [path, i] of index) { byPath.set(path, i); byPath.set(path.replace(/\.md$/, ''), i); }
  const people = pages.flatMap((page, i) => (page.area === 'people' ? [{ i, name: heading(pageFiles[i]!.text) || nameFromPath(page.path) }] : []));
  const firstNames = new Map<string, number[]>();
  for (const { i, name } of people) {
    const first = name.split(/\s+/)[0] ?? '';
    if (first.length >= 3) firstNames.set(first, [...(firstNames.get(first) ?? []), i]);
  }
  const byName = new Map<string, number>();
  for (const { i, name } of people) byName.set(name, i);
  for (const [first, list] of firstNames) if (list.length === 1 && !byName.has(first)) byName.set(first, list[0]!);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const nameMatch = names.length > 0
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'gu')
    : null;
  pageFiles.forEach((file, i) => {
    const body = pageBody(file.text);
    for (const token of body.match(/[\w@.-]+(?:\/[\w@.-]+)+/g) ?? []) {
      const path = token.replace(/^(\.\.?\/)+/, '');
      const target = byPath.get(path) ?? byPath.get(path.replace(/[.,)]+$/, ''));
      if (target !== undefined) link(i, target, 'mentions');
    }
    if (nameMatch) for (const match of body.matchAll(nameMatch)) link(i, byName.get(match[1]!)!, 'mentions');
  });

  // Pages from the same source, chained oldest first: a meeting's pages hang together without one page at the hub.
  const bySource = new Map<string, number[]>();
  pageFiles.forEach((file, i) => { for (const source of new Set(sourcesOf(file.text))) bySource.set(source, [...(bySource.get(source) ?? []), i]); });
  for (const group of bySource.values()) {
    const ordered = [...group].sort((a, b) => (pages[a]!.written ?? '').localeCompare(pages[b]!.written ?? '') || a - b);
    for (let k = 1; k < ordered.length; k++) link(ordered[k - 1]!, ordered[k]!, 'source');
  }

  // Pages one reply used together.
  for (const use of uses) {
    const cited = [...new Set(use.cited)].flatMap((path) => { const i = index.get(path); return i === undefined ? [] : [i]; });
    for (let x = 0; x < cited.length; x++) for (let y = x + 1; y < cited.length; y++) link(cited[x]!, cited[y]!, 'cited');
  }

  return {
    pages,
    links: [...links.values()].sort((p, q) => p.a - q.a || p.b - q.b),
    conflicts,
    areas: GRAPH_AREAS.filter((area) => area !== 'other' || pages.some((page) => page.area === 'other')).map((area) => ({ area, label: AREA_LABELS[area] })),
    days,
  };
};
