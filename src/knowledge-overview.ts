// Knowledge › Overview: how healthy the owner's knowledge is, how it grew, and what the bot's replies used. Read from
// the files Serra already keeps (the pages, the backups each approval leaves, the usage log); it writes nothing.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createJournal } from './knowledge-journal.ts';
import { latestReview, reviewSettings, type KnowledgeReview } from './knowledge-review-store.ts';
import { compileAboutMe } from './owner-model.ts';
import { AREA_LABELS, confirmHeldBack, pageArea, assessKnowledge, isPage, knowledgeHistory, type Health, type HistoryPoint, type KnowledgeChange, type KnowledgeEvent, type KnowledgeFile } from './knowledge-health.ts';
import { ARCHIVE_DIR, frontmatter, PROPOSALS_DIR } from './knowledge-rules.ts';
import { readKnowledgeUse } from './knowledge-usage.ts';
import { isArrayOf, isRecord, isString, isStringOrNull, isOptional } from './lib/guards.ts';

interface PageUse { path: string; uses: number; last: string; /** The page's description, the name the screen shows. */ title: string }

interface KnowledgeUsage {
  /** Replies in the window that could use knowledge. */
  replies: number;
  /** Of those, how many named at least one page they used. */
  withKnowledge: number;
  /** Pages named, most used first. */
  pages: PageUse[];
  /** Pages no reply named in the window, once there are enough replies to say so. */
  unused: string[];
  /** The window, in days. */
  days: number;
}

/** One request a page answered, and the start of the reply. */
interface PageExample { at: string; request: string; reply: string }

/** What one page did for the bot in the window. */
export interface PageValue {
  path: string;
  title: string;
  area: string;
  uses: number;
  last: string | null;
  /** `earns`: named by 2+ replies; `some`: by one; `carried`: in About me, so in every brief; `idle`: no reply used it
   * in a window with enough replies to tell; `unknown`: too few replies yet. */
  state: 'earns' | 'some' | 'carried' | 'idle' | 'unknown';
  examples: PageExample[];
}

export interface KnowledgeOverview {
  /** Every page, with what it did for the bot, most used first. */
  value: PageValue[];
  /** What replies said they needed and no page had, most asked first. */
  missing: { topic: string; count: number }[];
  /** The latest weekly review, or null before the first. */
  review: KnowledgeReview | null;
  reviewWeekly: boolean;
  /** Stale pages "Still true" isn't offered for: a rule on them disagrees, or a newer page on their topic may have changed them. */
  confirmHeldBack: string[];
  /** Proposals waiting for the owner, by name, so To do can list them beside everything else. */
  proposals: { id: string; title: string }[];
  health: Health;
  /** The score a month ago, or null when there's no history that far back. */
  monthAgo: HistoryPoint | null;
  points: HistoryPoint[];
  /** What changed, newest first. */
  events: KnowledgeEvent[];
  usage: KnowledgeUsage;
  /** Proposals waiting for the owner. */
  waiting: number;
  /** Files changed outside Serra and not reviewed yet: not counted until the owner accepts them in Pages. */
  unreviewed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const missingTopics = (uses: { missing?: string[] }[]): { topic: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const use of uses) for (const topic of use.missing ?? []) counts.set(topic.toLowerCase(), (counts.get(topic.toLowerCase()) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([topic, count]) => ({ topic, count }));
};

/**
 * The review with the suggestions already settled taken out, whatever settled them: an approved or discarded
 * proposal, a retired page, a page confirmed since. So a fix done once never comes back after a restart.
 */
const openSuggestions = (review: KnowledgeReview | null, root: string, now: Date): KnowledgeReview | null => {
  if (!review) return null;
  const today = now.toISOString().slice(0, 10);
  const open = review.suggestions.filter((item) => {
    if (item.kind === 'replace') {
      // A rewrite of a page that changed since the review (an edit, "Keep Thursday" on the page) would undo that
      // change: it leaves To do, and its proposal waits in Proposals to be looked at with the new text beside it.
      if (item.proposal === undefined || !existsSync(join(root, PROPOSALS_DIR, item.proposal))) return false;
      return !item.base || !existsSync(join(root, item.page)) || createHash('sha256').update(readFileSync(join(root, item.page), 'utf8')).digest('hex') === item.base;
    }
    if (!existsSync(join(root, item.page))) return false;
    if (item.kind === 'confirm') {
      const verified = frontmatter(readFileSync(join(root, item.page), 'utf8'))?.get('verified')?.trim() ?? '';
      return verified < review.id && verified !== today;
    }
    return true;
  });
  return { ...review, suggestions: open };
};

const pageAreaOf = (path: string, files: KnowledgeFile[]): string => {
  const type = frontmatter(files.find((file) => file.path === path)?.text ?? '')?.get('type')?.trim() ?? '';
  return AREA_LABELS[pageArea(path, type)];
};
/** The last history worked out, for the profile and day it was for. */
const historyCache = new Map<string, ReturnType<typeof knowledgeHistory>>();
/** Replies before "never used" means anything. */
const UNUSED_AFTER = 10;

/** The index and every page under a knowledge folder, as text: not proposals or retired pages. */
export const listKnowledgeFiles = (root: string, relativeDir = ''): KnowledgeFile[] => {
  const dir = join(root, relativeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return path === PROPOSALS_DIR || path === ARCHIVE_DIR ? [] : listKnowledgeFiles(root, path);
    return entry.isFile() && entry.name.endsWith('.md') ? [{ path, text: readFileSync(join(root, path), 'utf8') }] : [];
  });
};

const isFile = (value: unknown): value is KnowledgeChange['files'][number] =>
  isRecord(value) && isString(value.path) && isStringOrNull(value.before) && isStringOrNull(value.after);
const isChange = (value: unknown): value is KnowledgeChange => isRecord(value) && isString(value.id) && isString(value.action)
  && isString(value.at) && isArrayOf(isFile)(value.files) && isOptional(isString)(value.undoneAt);

/** Every change record under the backups folder. One that doesn't parse is skipped: it can't be replayed. */
const readChanges = (backups: string): KnowledgeChange[] => {
  if (!existsSync(backups)) return [];
  return readdirSync(backups, { withFileTypes: true }).flatMap((entry) => {
    const file = join(backups, entry.name, 'change.json');
    if (!entry.isDirectory() || !existsSync(file)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return isChange(value) ? [value] : [];
    } catch { return []; }
  });
};

/** Every proposal waiting, by its description (or file name), newest first. */
const waitingProposals = (dir: string, relativeDir = ''): { id: string; title: string }[] => {
  if (!existsSync(join(dir, relativeDir))) return [];
  return readdirSync(join(dir, relativeDir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const id = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return waitingProposals(dir, id);
    if (!entry.name.endsWith('.md') || entry.name === 'README.md' || entry.name === 'onboarding-progress.md') return [];
    const description = frontmatter(readFileSync(join(dir, id), 'utf8'))?.get('description')?.trim();
    return [{ id, title: description || entry.name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/[-_]+/g, ' ') }];
  }).sort((a, b) => b.id.localeCompare(a.id));
};

const countProposals = (dir: string): number => {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    if (entry.name.startsWith('.')) return sum;
    if (entry.isDirectory()) return sum + countProposals(join(dir, entry.name));
    return sum + (entry.name.endsWith('.md') && entry.name !== 'README.md' && entry.name !== 'onboarding-progress.md' ? 1 : 0);
  }, 0);
};

export const knowledgeOverview = ({ knowledgeDir, profileDir, backupDir, now = new Date(), days = 30 }: {
  knowledgeDir: string; profileDir: string; backupDir?: string; now?: Date; days?: number;
}): KnowledgeOverview => {
  const root = resolve(knowledgeDir);
  // What the bot reads: the owner's approved copy once there is one. An edit waiting for review isn't knowledge yet.
  const journal = createJournal(root);
  const files = journal.seeded() ? listKnowledgeFiles(journal.approvedRoot) : listKnowledgeFiles(root);
  const { changed, removed } = journal.drift();
  const health = assessKnowledge(files, now);
  const changes = readChanges(resolve(backupDir ?? join(dirname(root), 'backups', 'knowledge')));
  // History only changes with a new change, a new day, or new text: opening Overview again reuses it.
  const key = `${root}|${now.toISOString().slice(0, 10)}|${changes.length}|${changes.map((change) => `${change.id}${change.undoneAt ?? ''}`).sort().at(-1) ?? ''}|${files.map((file) => `${file.path}:${file.text.length}`).join(',')}|${health.score}`;
  const cached = historyCache.get(key);
  const { points, events } = cached ?? knowledgeHistory(files, changes, now);
  if (!cached) {
    historyCache.clear();
    historyCache.set(key, { points, events });
  }
  const cutoff = now.getTime() - days * DAY_MS;
  const monthAgo = [...points].reverse().find((point) => Date.parse(point.at) <= cutoff) ?? null;

  const titles = new Map(files.map((file) => [file.path, frontmatter(file.text)?.get('description')?.trim() ?? '']));
  const uses = readKnowledgeUse(profileDir).filter((use) => Date.parse(use.at) >= cutoff);
  const counts = new Map<string, PageUse>();
  for (const use of uses) {
    for (const path of use.cited) {
      const seen = counts.get(path);
      counts.set(path, { path, uses: (seen?.uses ?? 0) + 1, last: seen && seen.last > use.at ? seen.last : use.at, title: titles.get(path) ?? '' });
    }
  }
  const pages = files.filter((file) => isPage(file.path)).map((file) => file.path);
  // What each page did for the bot: how often replies named it, with real requests it answered. About me pages ride in
  // every brief, so they count as used whether a reply names them or not.
  const carried = new Set(compileAboutMe(files.filter((file) => isPage(file.path)), 'owner', now).included);
  const examples = new Map<string, PageExample[]>();
  for (const use of [...uses].reverse()) {
    for (const path of use.cited) {
      const list = examples.get(path) ?? [];
      if (use.request && list.length < 2 && !list.some((item) => item.request === use.request)) list.push({ at: use.at, request: use.request, reply: use.reply ?? '' });
      examples.set(path, list);
    }
  }
  const value: PageValue[] = pages.map((path) => {
    const count = counts.get(path)?.uses ?? 0;
    const state: PageValue['state'] = count >= 2 ? 'earns' : count === 1 ? 'some' : carried.has(path) ? 'carried' : uses.length >= UNUSED_AFTER ? 'idle' : 'unknown';
    return { path, title: titles.get(path) || path, area: pageAreaOf(path, files), uses: count, last: counts.get(path)?.last ?? null, state, examples: examples.get(path) ?? [] };
  }).sort((a, b) => b.uses - a.uses || a.title.localeCompare(b.title));
  return {
    confirmHeldBack: health.issues.filter((issue) => issue.kind === 'stale').map((issue) => issue.pages[0]!).filter((page) => confirmHeldBack(page, files, health)),
    proposals: waitingProposals(join(root, PROPOSALS_DIR)),
    value, missing: missingTopics(uses), review: openSuggestions(latestReview(profileDir), root, now), reviewWeekly: reviewSettings(profileDir).weekly,
    health, monthAgo, points, events: events.slice(0, 80), waiting: countProposals(join(root, PROPOSALS_DIR)), unreviewed: changed.length + removed.length,
    usage: {
      replies: uses.length, withKnowledge: uses.filter((use) => use.cited.length > 0).length, days,
      pages: [...counts.values()].filter((use) => pages.includes(use.path)).sort((a, b) => b.uses - a.uses || b.last.localeCompare(a.last)),
      unused: uses.length >= UNUSED_AFTER ? pages.filter((path) => !counts.has(path)).sort() : [],
    },
  };
};
