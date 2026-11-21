// The rules a knowledge page must follow, as pure functions with no Node imports. The service (`knowledge.ts`), the
// proposals queue, `pnpm knowledge` and the app's page editor all use these, so the editor blocks a save with exactly
// the message the service would refuse it with.
import type { PageBadge } from './contracts.ts';

/** The index rides in every brief, so its size is a cost every job pays. */
export const INDEX_MAX_LINES = 60;
export const PAGE_MAX_LINES = 120;
export const PROPOSALS_DIR = 'proposals';
/** An off-limits page rides in every brief whole, so it has its own cap. */
export const OFFLIMITS_MAX_CHARS = 1500;
/** Files in `knowledge/` that are not pages. */
export const NOT_PAGES = new Set(['README.md', 'index.md', 'log.md']);
export const REQUIRED_KEYS = ['type', 'description', 'written', 'verified', 'sources'];
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The owner should look at a page again after this long, since the code it describes moves. */
export const STALE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export const lineCount = (text: string): number => text.trimEnd().split('\n').length;

/** The `key: value` lines of a page's header, or null when the page has no header. */
export const frontmatter = (text: string): Map<string, string> | null => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match?.[1]) return null;
  const fields = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (field?.[1]) fields.set(field[1], field[2] ?? '');
  }
  return fields;
};

/** Header and line-cap problems of one page, the rules `pnpm knowledge` fails on. */
export const pageProblems = (page: string, text: string, fields: Map<string, string> | null): string[] => {
  if (!fields) return [`${page}: no header. See README.md for the page format.`];
  const problems = REQUIRED_KEYS.filter((key) => !fields.has(key)).map((key) => `${page}: header is missing \`${key}\`.`);
  const written = fields.get('written');
  if (written !== undefined && !DATE.test(written)) problems.push(`${page}: \`written\` must be a date like 2026-11-16.`);
  const verified = fields.get('verified');
  if (verified !== undefined && verified !== 'no' && !DATE.test(verified)) {
    problems.push(`${page}: \`verified\` must be \`no\` or the date the owner checked it.`);
  }
  const lines = lineCount(text);
  if (lines > PAGE_MAX_LINES) problems.push(`${page}: ${lines} lines. The cap is ${PAGE_MAX_LINES}; split the page.`);
  // Off-limits rules ride in every brief, so they're never cut for size: a page of them has its own, smaller cap.
  if (fields.get('type')?.trim() === 'offlimits' || /off-?limits/.test(page.split('/').pop() ?? '')) {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    if (body.length > OFFLIMITS_MAX_CHARS) problems.push(`${page}: ${body.length} characters. Off-limits rules go into every brief, so keep them under ${OFFLIMITS_MAX_CHARS}.`);
  }
  return problems;
};

/** Line endings as the editor or a pasted file may send them, made `\n`, with one trailing newline. */
export const normalizePageText = (text: string): string => `${text.replace(/\r\n?/g, '\n').trimEnd()}\n`;

/** Why a page's new text can't be saved, or an empty list when it can. The service refuses with this list. */
export const saveProblems = (page: string, text: string): string[] => {
  const normalized = normalizePageText(text);
  return pageProblems(page, normalized, frontmatter(normalized));
};

/** The error message for a refused save: the same text whether the editor or the service says it. */
export const saveRefusal = (problems: string[]): string => `Not saved. Fix the page first:\n${problems.join('\n')}`;

/** Whole days from a `YYYY-MM-DD` date to `now`. */
export const daysSince = (date: string, now: Date): number => Math.floor((now.getTime() - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);

/** Verified (a date in the last 60 days), stale (an older date) or unverified (`no`, missing or not a date). */
export const pageBadge = (verified: string | undefined, now: Date): PageBadge => {
  if (!verified || !DATE.test(verified)) return 'unverified';
  return daysSince(verified, now) > STALE_DAYS ? 'stale' : 'verified';
};

/** Set a header field's value, keeping every other line. Adds the field when the header lacks it. */
/** The page with `key:` taken out of its header, or unchanged when the header has no such field. */
export const removeHeaderField = (text: string, key: string): string => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match?.[1]) return text;
  const lines = match[1].split('\n').filter((line) => !line.startsWith(`${key}:`));
  return `---\n${lines.join('\n')}\n---\n${text.slice(match[0].length)}`;
};

export const setHeaderField = (text: string, key: string, value: string): string => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match?.[1]) return text;
  const lines = match[1].split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) lines.push(`${key}: ${value}`);
  else lines[index] = `${key}: ${value}`;
  return `---\n${lines.join('\n')}\n---\n${text.slice(match[0].length)}`;
};
