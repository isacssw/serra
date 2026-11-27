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
 * addition that replaced it). Case is ignored for matching. `show` picks the line it reads as: `both` (removals and
 * additions in one line, the newer's wording for what stayed), `older` (the older line, its removals marked) or
 * `newer` (the newer line, its additions marked). Each part's `text` starts with the space before it, so the parts
 * read as one line when joined.
 */
export const wordDiff = (before: string, after: string, show: 'both' | 'older' | 'newer' = 'both'): DiffPart[] => {
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
    if (i < a.length && j < b.length && x[i] === y[j]) { steps.push({ op: 'same', token: show === 'older' ? a[i]! : b[j]! }); i += 1; j += 1; }
    else if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) { steps.push({ op: 'del', token: a[i]! }); i += 1; }
    else { steps.push({ op: 'add', token: b[j]! }); j += 1; }
  }
  const shown = steps.filter((step) => !(show === 'older' && step.op === 'add') && !(show === 'newer' && step.op === 'del'));
  const parts: { op: DiffPart['op']; list: string[] }[] = [];
  for (const step of shown) {
    const last = parts.at(-1);
    if (last?.op === step.op) last.list.push(step.token);
    else parts.push({ op: step.op, list: [step.token] });
  }
  // Spacing comes from the reading order of the tokens this view shows.
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

/**
 * One rule's versions, as one row: the newest line and every older version it was paired with, oldest first. A rule
 * restated on Nov 16, 17 and 18 makes three pairs and one row, "Nov 16, Nov 17 → Nov 18".
 */
export interface ChainRow {
  /** The newest line's page and text. */
  key: string;
  newer: PairSide;
  olders: PairSide[];
  /** The newest line against each older one. */
  pairs: PairInfo[];
  /** Every pair among the row's lines, the older versions against each other too: what Keep newer and Both hold settle. */
  all: PairInfo[];
  /** The most recent older version against the newest: the change the row shows. */
  latest: PairInfo;
  /** The newest line says everything every older one does. */
  covers: boolean;
  /** The same line pasted twice, word for word: Keep one takes out a copy. */
  twice: boolean;
  order: PairInfo['order'];
}

const sideKey = (side: Pick<PairSide, 'page' | 'text'>): string => `${side.page}\n${side.text.trim()}`;

/**
 * Pairs as rows, one per newest line. A pair whose newer line is itself an older version of a later line is left out
 * when its older line is paired with that later one too: the row for the later line already shows it.
 */
const chainRows = (pairs: readonly PairInfo[]): ChainRow[] => {
  // A line pasted twice word for word pairs with itself: it never hides another pair, and is a row of its own.
  const has = new Set(pairs.map((pair) => `${sideKey(pair.older)}\u0000${sideKey(pair.newer)}`));
  const later = new Map<string, string[]>();
  for (const pair of pairs) {
    if (sideKey(pair.older) !== sideKey(pair.newer)) later.set(sideKey(pair.older), [...(later.get(sideKey(pair.older)) ?? []), sideKey(pair.newer)]);
  }
  const self = (pair: PairInfo): boolean => sideKey(pair.older) === sideKey(pair.newer);
  const shown = pairs.filter((pair) => self(pair) || !(later.get(sideKey(pair.newer)) ?? []).some((next) => has.has(`${sideKey(pair.older)}\u0000${next}`)));
  const rows = new Map<string, PairInfo[]>();
  for (const pair of shown) {
    const key = self(pair) ? `${sideKey(pair.newer)}\u0000twice` : sideKey(pair.newer);
    rows.set(key, [...(rows.get(key) ?? []), pair]);
  }
  const age = (pair: PairInfo): string => pair.older.learned ?? '';
  return [...rows].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => age(a).localeCompare(age(b)));
    const latest = sorted.at(-1)!;
    const lines = new Set([sideKey(latest.newer), ...sorted.map((pair) => sideKey(pair.older))]);
    // A line pasted twice stays out of other rows' sets: Keep newer there moves its own older versions, not a copy.
    const all = list.some(self) ? list : pairs.filter((pair) => !self(pair) && lines.has(sideKey(pair.older)) && lines.has(sideKey(pair.newer)));
    return { key, newer: latest.newer, olders: sorted.map((pair) => pair.older), pairs: sorted, all, latest, covers: sorted.every((pair) => pair.covers), twice: list.some(self), order: latest.order };
  });
};

export interface PairGroup {
  /** The pages, joined: one page for most groups, two when the lines sit on different pages. */
  key: string;
  kind: 'repeat' | 'disagree';
  pages: string[];
  pairs: PairInfo[];
  /** Repeats as rows, one per rule (`chainRows`). */
  rows: ChainRow[];
  /** Pairs "Keep newer for all" settles: those of `safeRows` (dated, on this one page, the newest saying everything). */
  safe: PairInfo[];
  /** Rows "Keep newer for all" settles whole, which is the number its button shows. */
  safeRows: number;
  /** Rows whose newest line leaves out something an older one says: asked one by one. */
  dropsDetail: number;
}

/** A pair "Keep newer" can settle without losing a word: the newer is dated later and says all the older says. */
export const isSafe = (pair: PairInfo): boolean => pair.order === 'date' && pair.covers && pair.older.page === pair.newer.page && pair.older.whole && pair.newer.whole
  // Both days with their year: a year-less note orders only within a year, which a click shouldn't rely on.
  && !(pair.newer.learned ?? '0000').startsWith('0000');

/** Pairs as one row per page (or pair of pages), repeats and disagreements apart, biggest group first. */
export const groupPairs = (issues: readonly PairIssue[]): { repeats: PairGroup[]; disagree: PairGroup[] } => {
  const groups = new Map<string, PairGroup>();
  // A line pasted twice beside a third gives two issues with one id: the pair counts once.
  const seen = new Set<string>();
  for (const issue of issues) {
    if (seen.has(issue.pair.id)) continue;
    seen.add(issue.pair.id);
    const kind = issue.kind === 'conflict' ? 'disagree' : 'repeat';
    const pages = [...new Set([issue.pair.older.page, issue.pair.newer.page])].sort();
    const key = `${kind}:${pages.join('|')}`;
    const group = groups.get(key) ?? { key, kind, pages, pairs: [], rows: [], safe: [], safeRows: 0, dropsDetail: 0 };
    group.pairs.push(issue.pair);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.kind !== 'repeat') continue;
    group.rows = chainRows(group.pairs);
    group.dropsDetail = group.rows.filter((row) => !row.covers).length;
    // Only whole rows: a rule with one version the newest leaves detail out of waits for the owner, all its versions.
    const safeRows = group.rows.filter((row) => row.covers && row.pairs.every(isSafe));
    group.safe = safeRows.flatMap((row) => row.pairs);
    group.safeRows = safeRows.length;
  }
  const all = [...groups.values()].sort((a, b) => b.pairs.length - a.pairs.length || a.key.localeCompare(b.key));
  return { repeats: all.filter((group) => group.kind === 'repeat'), disagree: all.filter((group) => group.kind === 'disagree') };
};

/** The row's one line under the page's name: "3 repeat · 1 drops detail", or the words two rules disagree on. */
export const groupLine = (group: PairGroup): string => {
  if (group.kind === 'disagree') {
    return group.pairs.length === 1 ? versus(group.pairs[0]!.older.plain, group.pairs[0]!.newer.plain) : `${group.pairs.length} pairs say different things`;
  }
  const count = group.rows.length;
  const dated = group.rows.every((row) => row.order === 'date');
  return [`${count} ${count === 1 ? 'rule' : 'rules'} learned again${dated ? '' : ' or written twice'}`, group.dropsDetail > 0 ? `${group.dropsDetail} ${group.dropsDetail === 1 ? 'needs' : 'need'} a look` : null]
    .filter(Boolean).join(' · ');
};

/** `2026-11-17` as "Nov 17". */
const day = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The two sides' names, older (or shorter) first: ["Nov 16", "Nov 17"], ["Earlier", "Nov 17"], ["Shorter", "Longer"]. */
export const sideNames = (pair: Pick<PairInfo, 'order' | 'older' | 'newer'>): [string, string] => {
  if (pair.order === 'length') return ['Shorter', 'Longer'];
  return [pair.older.learned ? day(pair.older.learned) : 'Earlier', pair.newer.learned ? day(pair.newer.learned) : 'Later'];
};

/** A row's versions in a few words: "Nov 16, Nov 17 → Nov 18", "Nov 16 → Nov 17", "Shorter → Longer". */
export const rowNames = (row: Pick<ChainRow, 'order' | 'olders' | 'newer'>): [string, string] => {
  if (row.order === 'length') return ['Shorter', 'Longer'];
  const olders = row.olders.map((side) => (side.learned ? day(side.learned) : 'Earlier'));
  return [olders.length > 2 ? `${olders[0]} … ${olders.at(-1)}` : olders.join(', '), row.newer.learned ? day(row.newer.learned) : 'Later'];
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
