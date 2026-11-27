// Overview › Needs you, the rules part, pure: pairs of lines grouped one row per page ("Same rule, learned again",
// "Really disagree"), the words that changed between two versions of a rule, and "Keep newer for all" worked out on a
// page's text before anything is saved. Tested in tests/kb-conflicts.test.ts; FixList.tsx and RulePairs.tsx draw it.
import type { PairInfo, PairSide } from '../../../src/knowledge-health.ts';
import { currentRules, keepRule, replacedOn } from './pages.logic.ts';

// ---------------------------------------------------------------------------------------------------------------
// Words that changed
// ---------------------------------------------------------------------------------------------------------------

export interface DiffPart { op: 'same' | 'del' | 'add'; text: string }

const tokens = (text: string): string[] => text.match(/[\p{L}\p{N}]+(?:[-'’/_.:][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) ?? [];
const NO_SPACE_BEFORE = /^[,.;:!?)\]]$/;
const NO_SPACE_AFTER = /^[([]$/;

/** Tokens back into a phrase: words with spaces, punctuation against its word. */
const join = (list: string[]): string => list.reduce((out, token, at) => (at === 0 || NO_SPACE_BEFORE.test(token) || NO_SPACE_AFTER.test(list[at - 1]!) ? `${out}${token}` : `${out} ${token}`), '');

/**
 * `before` → `after` word by word: what stayed, what went and what came in, in reading order (each removal before the
 * addition that replaced it). Case is ignored for matching; each part keeps the words as written. A part's `text`
 * starts with a space when it follows a word, so the parts read as one line when joined.
 */
export const wordDiff = (before: string, after: string): DiffPart[] => {
  const [a, b] = [tokens(before), tokens(after)];
  const [x, y] = [a.map((word) => word.toLowerCase()), b.map((word) => word.toLowerCase())];
  // Longest common subsequence, from the end, so the walk below reads front to back.
  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const steps: { op: DiffPart['op']; token: string }[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && x[i] === y[j]) { steps.push({ op: 'same', token: b[j]! }); i += 1; j += 1; }
    else if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) { steps.push({ op: 'del', token: a[i]! }); i += 1; }
    else { steps.push({ op: 'add', token: b[j]! }); j += 1; }
  }
  const parts: { op: DiffPart['op']; list: string[] }[] = [];
  for (const step of steps) {
    const last = parts.at(-1);
    if (last?.op === step.op) last.list.push(step.token);
    else parts.push({ op: step.op, list: [step.token] });
  }
  // Spacing comes from the reading order of every token shown (the removed ones included).
  let previous: string | null = null;
  return parts.map(({ op, list }) => {
    const text = join(list);
    const space = previous !== null && !NO_SPACE_BEFORE.test(list[0]!) && !NO_SPACE_AFTER.test(previous) ? ' ' : '';
    previous = list.at(-1)!;
    return { op, text: `${space}${text}` };
  });
};

const clip = (text: string, words = 4): string => {
  const list = text.trim().split(/\s+/);
  return list.length > words ? `${list.slice(0, words).join(' ')}…` : text.trim();
};

/** Two rules that disagree in a few words: `“3 hours” vs “4 hours”`, `“never” vs “when CI is green…”`. */
export const versus = (older: string, newer: string): string => {
  const parts = wordDiff(older, newer);
  const gone = parts.find((part) => part.op === 'del')?.text;
  const added = parts.find((part) => part.op === 'add')?.text;
  if (gone && added) return `“${clip(gone)}” vs “${clip(added)}”`;
  if (added) return `Newer adds “${clip(added)}”`;
  if (gone) return `Newer drops “${clip(gone)}”`;
  return 'Two rules say different things';
};

// ---------------------------------------------------------------------------------------------------------------
// One row per page
// ---------------------------------------------------------------------------------------------------------------

/** A health issue that is a pair: what the grouping needs of it. */
export interface PairIssue { kind: 'conflict' | 'duplicate'; pages: string[]; pair: PairInfo }

export interface PairGroup {
  /** The pages, joined: one page for most groups, two when the lines sit on different pages. */
  key: string;
  kind: 'repeat' | 'disagree';
  pages: string[];
  pairs: PairInfo[];
  /** Pairs "Keep newer for all" settles: dated, the newer saying everything the older does, both on this one page. */
  safe: PairInfo[];
  /** Pairs whose newer line leaves out something the older one says: asked one by one. */
  dropsDetail: number;
}

/** A pair "Keep newer" can settle without losing a word: the newer is dated later and says all the older says. */
export const isSafe = (pair: PairInfo): boolean => pair.order === 'date' && pair.covers && pair.older.page === pair.newer.page;

/** Pairs as one row per page (or pair of pages), repeats and disagreements apart, biggest group first. */
export const groupPairs = (issues: readonly PairIssue[]): { repeats: PairGroup[]; disagree: PairGroup[] } => {
  const groups = new Map<string, PairGroup>();
  for (const issue of issues) {
    const kind = issue.kind === 'conflict' ? 'disagree' : 'repeat';
    const pages = [...new Set([issue.pair.older.page, issue.pair.newer.page])].sort();
    const key = `${kind}:${pages.join('|')}`;
    const group = groups.get(key) ?? { key, kind, pages, pairs: [], safe: [], dropsDetail: 0 };
    group.pairs.push(issue.pair);
    if (kind === 'repeat' && isSafe(issue.pair)) group.safe.push(issue.pair);
    if (kind === 'repeat' && !issue.pair.covers) group.dropsDetail += 1;
    groups.set(key, group);
  }
  const all = [...groups.values()].sort((a, b) => b.pairs.length - a.pairs.length || a.key.localeCompare(b.key));
  return { repeats: all.filter((group) => group.kind === 'repeat'), disagree: all.filter((group) => group.kind === 'disagree') };
};

/** The row's one line under the page's name: "3 repeat · 1 drops detail", or the words two rules disagree on. */
export const groupLine = (group: PairGroup): string => {
  if (group.kind === 'disagree') {
    return group.pairs.length === 1 ? versus(group.pairs[0]!.older.plain, group.pairs[0]!.newer.plain) : `${group.pairs.length} pairs say different things`;
  }
  const count = group.pairs.length;
  const dated = group.pairs.every((pair) => pair.order === 'date');
  return [`${count} ${count === 1 ? 'line repeats' : 'lines repeat'}${dated ? ' with a newer date' : ''}`, group.dropsDetail > 0 ? `${group.dropsDetail} ${group.dropsDetail === 1 ? 'drops' : 'drop'} detail` : null]
    .filter(Boolean).join(' · ');
};

/** `2026-11-17` as "Nov 17". */
const day = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The two sides' names, older (or shorter) first: ["Nov 16", "Nov 17"], ["Earlier", "Nov 17"], ["Shorter", "Longer"]. */
export const sideNames = (pair: Pick<PairInfo, 'order' | 'older' | 'newer'>): [string, string] => {
  if (pair.order === 'length') return ['Shorter', 'Longer'];
  return [pair.older.learned ? day(pair.older.learned) : 'Earlier', pair.newer.learned ? day(pair.newer.learned) : 'Later'];
};

/** The Keep buttons, older (or shorter) first. */
export const keepNames = (pair: Pick<PairInfo, 'order'>): [string, string] => (pair.order === 'length' ? ['Keep shorter', 'Keep longer'] : ['Keep older', 'Keep newer']);

// ---------------------------------------------------------------------------------------------------------------
// Keep newer for all
// ---------------------------------------------------------------------------------------------------------------

/**
 * The page with the older line of each safe pair moved under "## Replaced", dated the day the newer one was learned.
 * Only lines that are whole lines of this page move, each once; every other line stays exactly as it was. A line
 * moves only when a newer line that says all it says stays (or itself moved for a newer one that stays), so nothing
 * the page says is lost. Returns the text and the lines moved; the text is unchanged when none can move.
 */
export const keepNewerForAll = (text: string, page: string, pairs: readonly PairInfo[], today: string): { text: string; moved: string[] } => {
  const rules = currentRules(text);
  const ready = pairs.filter((pair) => isSafe(pair) && pair.older.page === page && rules.includes(pair.older.text.trim()) && rules.includes(pair.newer.text.trim()));
  // Oldest first, so a chain (Nov 16 → Nov 17 → Nov 18) moves its older lines and keeps the last.
  const byLine = new Map<string, PairSide>();
  for (const pair of [...ready].sort((a, b) => (a.newer.learned ?? '').localeCompare(b.newer.learned ?? ''))) {
    if (!byLine.has(pair.older.text.trim())) byLine.set(pair.older.text.trim(), pair.newer);
  }
  let next = text;
  const moved: string[] = [];
  for (const [line, newer] of byLine) {
    const after = keepRule(next, line, replacedOn(newer.text, today));
    if (after !== next) { next = after; moved.push(line); }
  }
  return { text: next, moved };
};
