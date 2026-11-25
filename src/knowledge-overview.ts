// Knowledge › Overview: how healthy the owner's knowledge is, how it grew, and what the bot's replies used. Read from
// the files Serra already keeps (the pages, the backups each approval leaves, the usage log); it writes nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createJournal } from './knowledge-journal.ts';
import { assessKnowledge, isPage, knowledgeHistory, type Health, type HistoryPoint, type KnowledgeChange, type KnowledgeEvent, type KnowledgeFile } from './knowledge-health.ts';
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

export interface KnowledgeOverview {
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
  const { points, events } = knowledgeHistory(files, changes, now);
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
  return {
    health, monthAgo, points, events: events.slice(0, 80), waiting: countProposals(join(root, PROPOSALS_DIR)), unreviewed: changed.length + removed.length,
    usage: {
      replies: uses.length, withKnowledge: uses.filter((use) => use.cited.length > 0).length, days,
      pages: [...counts.values()].filter((use) => pages.includes(use.path)).sort((a, b) => b.uses - a.uses || b.last.localeCompare(a.last)),
      unused: uses.length >= UNUSED_AFTER ? pages.filter((path) => !counts.has(path)).sort() : [],
    },
  };
};
