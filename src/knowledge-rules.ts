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

/** Whether a page holds off-limits rules: its `type`, or its file name. */
export const isOfflimits = (page: string, fields: Map<string, string> | null): boolean =>
  fields?.get('type')?.trim() === 'offlimits' || /off-?limits/.test(page.split('/').pop() ?? '');

/** The text of a page without its header, as About me uses it. */
export const pageBody = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

/**
 * Why a change would take all off-limits pages together over their budget, or null. `pages` is every page's text
 * after the change. They ride in every brief, first and never cut, so the budget is for all of them, not each.
 */
export const offlimitsBudgetProblem = (pages: { path: string; text: string }[]): string | null => {
  const total = pages.filter(({ path, text }) => isOfflimits(path, frontmatter(text))).reduce((sum, { text }) => sum + pageBody(text).length, 0);
  return total > OFFLIMITS_MAX_CHARS
    ? `Off-limits pages come to ${total} characters together. They go into every brief, so keep them under ${OFFLIMITS_MAX_CHARS} in all.`
    : null;
};

/** Header and line-cap problems of one page, the rules `pnpm knowledge` fails on. */
export const pageProblems = (page: string, text: string, fields: Map<string, string> | null): string[] => {
  if (!fields) return [`${page}: no header. See README.md for the page format.`];
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const keys = header.split('\n').flatMap((line) => /^([a-z]+):/.exec(line)?.[1] ?? []);
  const repeated = [...new Set(keys.filter((key, at) => keys.indexOf(key) !== at))];
  const duplicates = repeated.map((key) => `${page}: the header has \`${key}\` more than once; keep one.`);
  const problems = [...duplicates, ...REQUIRED_KEYS.filter((key) => !fields.has(key)).map((key) => `${page}: header is missing \`${key}\`.`)];
  const written = fields.get('written');
  if (written !== undefined && !DATE.test(written)) problems.push(`${page}: \`written\` must be a date like 2026-11-16.`);
  const verified = fields.get('verified');
  if (verified !== undefined && verified !== 'no' && !DATE.test(verified)) {
    problems.push(`${page}: \`verified\` must be \`no\` or the date the owner checked it.`);
  }
  const lines = lineCount(text);
  if (lines > PAGE_MAX_LINES) problems.push(`${page}: ${lines} lines. The cap is ${PAGE_MAX_LINES}; split the page.`);
  // Off-limits rules ride in every brief, so they're never cut for size: a page of them has its own, smaller cap.
  if (isOfflimits(page, fields)) {
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

/** A header's fields, each with its continuation lines (a `sources:` list), in order. */
const headerEntries = (header: string): { key: string; lines: string[] }[] => header.split('\n').reduce<{ key: string; lines: string[] }[]>((entries, line) => {
  const key = /^([\w-]+):/.exec(line)?.[1];
  if (key || entries.length === 0) entries.push({ key: key ?? '', lines: [line] });
  else entries.at(-1)!.lines.push(line);
  return entries;
}, []);

/**
 * `text` with its header fields in the order `like` has them; fields `like` lacks keep their order after those. The
 * same text otherwise, so a diff against `like` shows only real changes, not moved lines.
 */
export const alignHeader = (text: string, like: string | null): string => {
  const mine = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const theirs = like ? /^---\n([\s\S]*?)\n---\n/.exec(like) : null;
  if (!mine?.[1] || !theirs?.[1]) return text;
  const order = headerEntries(theirs[1]).map((entry) => entry.key);
  const rank = (key: string): number => (order.includes(key) ? order.indexOf(key) : order.length);
  const sorted = headerEntries(mine[1]).map((entry, at) => ({ entry, at })).sort((a, b) => rank(a.entry.key) - rank(b.entry.key) || a.at - b.at);
  return `---\n${sorted.flatMap(({ entry }) => entry.lines).join('\n')}\n---\n${text.slice(mine[0].length)}`;
};

/** The page template's header order. */
const HEADER_ORDER = ['type', 'description', 'audience', 'written', 'verified', 'expires'];

export const setHeaderField = (text: string, key: string, value: string): string => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match?.[1]) return text;
  // One line per key: every other copy goes, so what is saved is what the parser reads.
  const lines = match[1].split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  const kept = lines.filter((line, at) => at === index || !line.startsWith(`${key}:`));
  if (index === -1) {
    // A new key goes where the page template has it, so a diff against a page that has it shows no moved line.
    const before = HEADER_ORDER.slice(0, Math.max(0, HEADER_ORDER.indexOf(key)));
    const after = kept.reduce((last, line, at) => (before.some((field) => line.startsWith(`${field}:`)) ? at : last), -1);
    kept.splice(HEADER_ORDER.includes(key) && after !== -1 ? after + 1 : kept.length, 0, `${key}: ${value}`);
  } else kept[kept.indexOf(lines[index]!)] = `${key}: ${value}`;
  return `---\n${kept.join('\n')}\n---\n${text.slice(match[0].length)}`;
};
