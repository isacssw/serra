// How healthy the owner's knowledge is, how it got here, and which pages fit a request. Pure functions with no Node
// imports: the app's Overview, the brief's relevance hint and the evals all read the same numbers.
//
// Everything is deterministic and local: words are compared as sets of stems, no model and no embeddings. At Serra's
// scale (tens of pages, capped at 120 lines each) that is enough to catch the two ways a knowledge base rots: the
// same rule written twice, and an old rule left beside the one that replaced it.
import { DATE, daysSince, frontmatter, INDEX_MAX_LINES, lineCount, NOT_PAGES, PAGE_MAX_LINES, PROPOSALS_DIR, STALE_DAYS } from './knowledge-rules.ts';

/** The areas a bot that knows its owner needs, in the order the Overview lists them. */
const AREAS = ['identity', 'rules', 'voice', 'limits', 'people', 'processes', 'projects'] as const;
type Area = (typeof AREAS)[number] | 'other';

export const AREA_LABELS: Record<Area, string> = {
  identity: 'Who you are', rules: 'How you work', voice: 'How you write', limits: 'Off-limits',
  people: 'People', processes: 'Processes', projects: 'Projects', other: 'Other',
};

export interface KnowledgeFile { path: string; text: string }

/** Which area a page belongs to, from its folder, type and name. */
export const pageArea = (path: string, type: string): Area => {
  const name = path.split('/').pop() ?? '';
  const folder = path.includes('/') ? path.split('/')[0]! : '';
  if (type === 'offlimits' || /off-?limits/.test(name)) return 'limits';
  if (folder === 'people' || type === 'person') return 'people';
  if (type === 'voice' || /^voice\b/.test(name)) return 'voice';
  if (folder === 'owner' && (/^(identity|responsibility|role)$/.test(type) || /^role\b/.test(name))) return 'identity';
  if (folder === 'owner') return 'rules';
  if (folder === 'workflows' || /^(process|workflow|runbook)$/.test(type)) return 'processes';
  if (folder === 'product' || folder === 'decisions' || /^(project|product|decisions)$/.test(type)) return 'projects';
  return 'other';
};

// ---------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------

const STOP = new Set(('a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our '
  + 'so that the their them then there these they this to up us was we what when where which who why will with you your '
  + 'about any all also just more most should would could please quick check before after get got need needs make sure '
  + 'every each s t').split(' '));
/** Words that turn a rule around: two lines alike but for one of these say opposite things. */
const NEGATIONS = new Set(['never', 'not', 'no', 'dont', 'don', 'doesnt', 'without', 'stop', 'avoid', 'instead']);
const SLOTS = /\b(always|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekly|daily|monthly|morning|afternoon|evening|\d+(?:[.:]\d+)?%?)\b/g;

/** A rough stem: enough that "releases", "released" and "release" meet. */
const stem = (word: string): string => word
  .replace(/(ies)$/, 'y').replace(/(sses)$/, 'ss').replace(/([^s])s$/, '$1').replace(/(ing|ed)$/, '').replace(/e$/, '');

const words = (text: string): string[] => (text.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) ?? [])
  .filter((word) => !STOP.has(word) && word.length > 1).map(stem).filter((word) => word.length > 1);

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
};

// ---------------------------------------------------------------------------------------------------------------
// Pages and facts
// ---------------------------------------------------------------------------------------------------------------

/** A page's text without its header and without anything under a `## Replaced` heading, which is history. */
export const currentText = (text: string): string => text
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^##\s+Replaced\b[\s\S]*?(?=^##\s|(?![\s\S]))/gim, '')
  .trim();

/** One thing a page says: a bullet, or a sentence of a paragraph. */
export interface Fact { page: string; text: string; words: Set<string> }

export const pageFacts = (path: string, text: string): Fact[] => currentText(text).split('\n').flatMap((line) => {
  const trimmed = line.trim();
  // Headings, tables, code and quoted examples (a voice page's sample message) aren't rules.
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('```') || trimmed.startsWith('>')) return [];
  const body = trimmed.replace(/^([-*]|\d+\.)\s+/, '');
  // A bullet can hold several facts ("Payment records are kept 7 years. Webhook payloads 30 days."): each sentence is one.
  const parts = body.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return parts.flatMap((part) => {
    const set = new Set(words(part));
    return set.size >= 3 ? [{ page: path, text: part.trim(), words: set }] : [];
  });
});

interface PageInfo {
  path: string;
  area: Area;
  type: string;
  description: string;
  verified: string | null;
  written: string | null;
  state: 'fresh' | 'stale' | 'draft';
  lines: number;
  facts: number;
  indexed: boolean;
  /** Headings and bullets make a page something a worker can scan; a wall of prose isn't. */
  structured: boolean;
}

/** The pages of a knowledge folder: `.md` files that aren't the index, the log, a README or a proposal. */
export const isPage = (path: string): boolean => path.endsWith('.md') && !NOT_PAGES.has(path) && !path.endsWith('README.md')
  && !path.startsWith(`${PROPOSALS_DIR}/`) && !path.startsWith('archive/');

const indexedPaths = (index: string): Set<string> => new Set([...index.matchAll(/`([^`\s]+\.md)`/g)].map((match) => match[1]!));

const describePages = (files: KnowledgeFile[], index: string, now: Date): PageInfo[] => {
  const indexed = indexedPaths(index);
  return files.filter((file) => isPage(file.path)).map(({ path, text }) => {
    const fields = frontmatter(text);
    const field = (key: string): string => fields?.get(key)?.trim() ?? '';
    const verified = DATE.test(field('verified')) ? field('verified') : null;
    const body = currentText(text).split('\n').filter((line) => line.trim());
    const shaped = body.filter((line) => /^\s*(#|[-*]\s|\d+\.\s|\|)/.test(line)).length;
    return {
      path, area: pageArea(path, field('type')), type: field('type'), description: field('description'),
      verified, written: DATE.test(field('written')) ? field('written') : null,
      state: verified === null ? 'draft' : daysSince(verified, now) > STALE_DAYS ? 'stale' : 'fresh',
      lines: lineCount(text), facts: pageFacts(path, text).length, indexed: indexed.has(path),
      structured: body.length <= 4 || shaped / body.length >= 0.5,
    };
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Duplicates and conflicts
// ---------------------------------------------------------------------------------------------------------------

export interface FactPair { a: { page: string; text: string }; b: { page: string; text: string }; similarity: number }

const slots = (text: string): Set<string> => new Set(text.toLowerCase().match(SLOTS) ?? []);
const SLOT_WORD = /^(always|alway|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekly|daily|monthly|morning|afternoon|evening|\d+)$/;
/**
 * Words that mark a rule as changed ("now", "since", "moved") or only frame it ("keep", "should stay", "day"), rather
 * than say what it's about: "Release day is Tuesday" and "We now release on Thursday" are one rule.
 */
const CHANGE_WORDS = new Set(['now', 'since', 'currently', 'current', 'change', 'moved', 'updated', 'new', 'as', 'of', 'anymore', 'longer', 'instead',
  'should', 'stay', 'must', 'we', 'is', 'are', 'be', 'keep', 'day', 'always', 'every', 'per', 'theres', 'there'].map((word) => stem(word)));
const topic = (set: Set<string>): Set<string> => new Set([...set].filter((word) => !NEGATIONS.has(word) && !SLOT_WORD.test(word) && !CHANGE_WORDS.has(word)));
const negated = (set: Set<string>): boolean => [...set].some((word) => NEGATIONS.has(word));

/** Above this, two facts say the same thing. */
const DUPLICATE_AT = 0.7;
/** Above this, two facts are about the same thing; if they then differ in a day, a number or a "never", they disagree. */
const CONFLICT_AT = 0.4;

/**
 * Pairs of facts that repeat each other, and pairs that are about the same thing but disagree: one says Tuesday and
 * the other Thursday, one has a number the other changes, or one says "never" where the other doesn't. Only facts
 * sharing a word are compared, so this stays fast on a full knowledge base.
 */
export const findOverlaps = (facts: Fact[], comparable: (a: string, b: string) => boolean = () => true): { duplicates: FactPair[]; conflicts: FactPair[] } => {
  // Everything about one fact is worked out once; pairs are found by counting shared topic words, so no set is built
  // per pair. A knowledge base at its caps (60 pages of 120 lines) stays well under a second.
  const info = facts.map((fact) => {
    const topics = topic(fact.words);
    return { topics, size: topics.size, slots: slots(fact.text), negated: negated(fact.words) };
  });
  const byWord = new Map<string, number[]>();
  info.forEach(({ topics }, at) => {
    for (const word of topics) {
      const list = byWord.get(word);
      if (list) list.push(at); else byWord.set(word, [at]);
    }
  });
  const duplicates: FactPair[] = [];
  const conflicts: FactPair[] = [];
  const shared = new Int32Array(facts.length);
  const touched: number[] = [];
  for (let at = 0; at < facts.length; at += 1) {
    for (const word of info[at]!.topics) {
      for (const other of byWord.get(word)!) {
        if (other <= at) continue;
        if (shared[other] === 0) touched.push(other);
        shared[other] = shared[other]! + 1;
      }
    }
    const fact = facts[at]!;
    const mine = info[at]!;
    for (const other of touched) {
      const common = shared[other]!;
      shared[other] = 0;
      const that = facts[other]!;
      const theirs = info[other]!;
      // The words that can differ between two versions of one rule (a day, a number, a "never") don't count
      // towards whether they're about the same thing.
      const similarity = common / (mine.size + theirs.size - common);
      // One side's words all inside the other's: the same rule, however much longer one says it.
      const onlyMine = mine.size - common;
      const onlyTheirs = theirs.size - common;
      const nestedTopics = onlyMine === 0 || onlyTheirs === 0;
      // Nearly the same subject: most of the shorter rule's words are in the other, and the two don't just swap one
      // subject word each ("webhooks retry 5 times" / "invoices retry 3 times" swap one; "100 requests per second,
      // burst 200" / "the API rate limit is 250 requests per second" don't).
      const nearlyNested = common >= 2 && common / Math.min(mine.size, theirs.size) >= 0.75 && !(onlyMine === 1 && onlyTheirs === 1);
      const sameSubject = nestedTopics;
      if (similarity < CONFLICT_AT && !((nestedTopics || nearlyNested) && Math.min(mine.size, theirs.size) >= 2)) continue;
      if (fact.page !== that.page && !comparable(fact.page, that.page)) continue;
      const pair = { a: { page: fact.page, text: fact.text }, b: { page: that.page, text: that.text }, similarity: Math.round(similarity * 100) / 100 };
      const slotClash = mine.slots.size > 0 && theirs.slots.size > 0 && [...mine.slots].some((slot) => !theirs.slots.has(slot)) && [...theirs.slots].some((slot) => !mine.slots.has(slot));
      const negationClash = mine.negated !== theirs.negated;
      // Two rules about different things ("Retry webhooks 5 times", "Retry invoices 3 times") each have a word the
      // other lacks, so they're never the same subject. "Never Thursday" against "Thursday now" is a conflict too.
      if ((sameSubject && (slotClash || negationClash)) || (nearlyNested && slotClash)) conflicts.push(pair);
      // A repeat about a different subject has to be near word for word.
      // One rule's words all inside another's (three or more), the other adding at most two: it says it again.
      else if ((similarity >= DUPLICATE_AT && (sameSubject || similarity >= 0.85)) || (nestedTopics && Math.min(mine.size, theirs.size) >= 3 && Math.max(onlyMine, onlyTheirs) <= 2)) duplicates.push(pair);
    }
    touched.length = 0;
  }
  const order = (a: FactPair, b: FactPair): number => b.similarity - a.similarity;
  return { duplicates: duplicates.sort(order), conflicts: conflicts.sort(order) };
};

/**
 * Whether two pages can hold the same rule: pages of one area, and for people only cards that look like the same
 * person (`people/priya.md` and `people/priya-nair.md`). "Ana reviews on Monday" and "Bruno reviews on Friday" are two
 * true facts about two people, not a conflict.
 */
const samePageSubject = (a: string, b: string, areaOf: Map<string, Area>): boolean => {
  // A rule can be written in any area ("ship on Tuesday" in owner/ and in workflows/), so areas don't matter. What
  // does is whose it is: a person's card is only compared with cards that look like the same person.
  if (areaOf.get(a) !== 'people' && areaOf.get(b) !== 'people') return true;
  if (areaOf.get(a) !== areaOf.get(b)) return false;
  const name = (path: string): string[] => (path.split('/').pop() ?? '').replace(/\.md$/, '').split(/[-_\s]+/).filter((word) => word.length > 1);
  // The same person when one file's name words are all in the other's: priya and priya-nair, not ana-silva and bruno-silva.
  const [x, y] = [name(a), name(b)];
  return x.length > 0 && y.length > 0 && (x.every((word) => y.includes(word)) || y.every((word) => x.includes(word)));
};

/** Pages whose descriptions say they cover the same thing: two places for one topic. */
const overlappingPages = (pages: PageInfo[], same: (a: string, b: string) => boolean): [string, string][] => {
  const sets = pages.map((page) => ({ path: page.path, words: new Set(words(page.description)) })).filter((page) => page.words.size >= 2);
  const pairs: [string, string][] = [];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      if (same(sets[i]!.path, sets[j]!.path) && jaccard(sets[i]!.words, sets[j]!.words) >= 0.75) pairs.push([sets[i]!.path, sets[j]!.path]);
    }
  }
  return pairs;
};

// ---------------------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------------------

type IssueKind = 'conflict' | 'duplicate' | 'overlap' | 'stale' | 'draft' | 'unstructured' | 'long' | 'unindexed' | 'index-full';

interface Issue {
  kind: IssueKind;
  /** The pages to open, first one first. */
  pages: string[];
  /** One plain sentence for the owner. */
  text: string;
  /** For pairs: the two lines, shortened for a list. */
  detail?: string[];
  /** For pairs: the two lines whole, with their pages, for fixing them. */
  facts?: { page: string; text: string }[];
}

/** The parts the score is made of, each 0–100. */
export interface HealthParts {
  /** Confirmed in the last 60 days. */
  fresh: number;
  /** Headed and bulleted, described, indexed, under the page cap. */
  organised: number;
  /** No rule written twice. */
  unique: number;
  /** No old rule beside the one that replaced it. */
  consistent: number;
  /** Areas with at least one confirmed page. */
  coverage: number;
}

const PART_KEYS: readonly (keyof HealthParts)[] = ['fresh', 'organised', 'unique', 'consistent', 'coverage'];

export const HEALTH_WEIGHTS: Record<keyof HealthParts, number> = { fresh: 0.25, organised: 0.2, unique: 0.15, consistent: 0.25, coverage: 0.15 };

interface AreaSummary { area: Area; label: string; pages: number; confirmed: number; facts: number; latest: string | null; headline: string | null; conflicts: number }

export interface Health {
  score: number;
  parts: HealthParts;
  pages: number;
  facts: number;
  fresh: number;
  stale: number;
  drafts: number;
  indexLines: number;
  areas: AreaSummary[];
  issues: Issue[];
}

const percent = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 100);
const short = (text: string, max = 90): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The health of a knowledge folder as it is: its score, what it's made of, and what needs tidying, worst first. */
/**
 * What history keeps between assessments: each page's facts by its text, and the overlaps of each pair of pages by
 * both texts. One change touches one or two pages, so the next point only compares those again.
 */
interface OverlapCache { facts: Map<string, Fact[]>; pairs: Map<string, ReturnType<typeof findOverlaps>> }

const textKey = (text: string): string => {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at += 1) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619);
  return `${text.length}:${(hash >>> 0).toString(36)}`;
};

/** Every overlap between the pages, built pair by pair from the cache. Same result as one `findOverlaps` over all. */
const cachedOverlaps = (pages: KnowledgeFile[], cache: OverlapCache, comparable: (a: string, b: string) => boolean): ReturnType<typeof findOverlaps> => {
  const keyed = pages.map((file) => {
    const key = `${file.path}#${textKey(file.text)}`;
    const facts = cache.facts.get(key) ?? pageFacts(file.path, file.text);
    cache.facts.set(key, facts);
    return { key, path: file.path, facts };
  });
  const duplicates: FactPair[] = [];
  const conflicts: FactPair[] = [];
  for (let i = 0; i < keyed.length; i += 1) {
    for (let j = i; j < keyed.length; j += 1) {
      const [x, y] = [keyed[i]!, keyed[j]!];
      const key = `${x.key}|${y.key}`;
      let found = cache.pairs.get(key);
      if (!found) {
        const own = (pair: FactPair): boolean => (i === j ? true : pair.a.page !== pair.b.page);
        const all = i === j ? findOverlaps(x.facts, comparable) : comparable(x.path, y.path) ? findOverlaps([...x.facts, ...y.facts], comparable) : { duplicates: [], conflicts: [] };
        found = { duplicates: all.duplicates.filter(own), conflicts: all.conflicts.filter(own) };
        cache.pairs.set(key, found);
      }
      duplicates.push(...found.duplicates);
      conflicts.push(...found.conflicts);
    }
  }
  const order = (a: FactPair, b: FactPair): number => b.similarity - a.similarity;
  return { duplicates: duplicates.sort(order), conflicts: conflicts.sort(order) };
};

export const assessKnowledge = (files: KnowledgeFile[], now: Date, cache?: OverlapCache): Health => {
  const index = files.find((file) => file.path === 'index.md')?.text ?? '';
  const pages = describePages(files, index, now);
  const facts = files.filter((file) => isPage(file.path)).flatMap((file) => {
    if (!cache) return pageFacts(file.path, file.text);
    const key = `${file.path}#${textKey(file.text)}`;
    const found = cache.facts.get(key) ?? pageFacts(file.path, file.text);
    cache.facts.set(key, found);
    return found;
  });
  const areaOf = new Map(pages.map((page) => [page.path, page.area]));
  const same = (a: string, b: string): boolean => samePageSubject(a, b, areaOf);
  const found = cache ? cachedOverlaps(files.filter((file) => isPage(file.path)), cache, same) : findOverlaps(facts, same);
  // A list to work through, not an inventory: the worst 40 of each kind are plenty to act on.
  const conflicts = found.conflicts.slice(0, 40);
  const duplicates = found.duplicates.slice(0, 40);
  const overlaps = overlappingPages(pages, (a, b) => samePageSubject(a, b, areaOf));
  const issues: Issue[] = [];
  for (const pair of conflicts) {
    issues.push({ kind: 'conflict', pages: [...new Set([pair.b.page, pair.a.page])], text: pair.a.page === pair.b.page
      ? `${pair.a.page} has two rules that disagree. Keep the current one and move the other under "Replaced".`
      : `${pair.a.page} and ${pair.b.page} disagree. Keep the current rule on one page.`, detail: [short(pair.a.text), short(pair.b.text)], facts: [pair.a, pair.b] });
  }
  for (const pair of duplicates) {
    issues.push({ kind: 'duplicate', pages: [...new Set([pair.b.page, pair.a.page])], text: pair.a.page === pair.b.page
      ? `${pair.a.page} says the same thing twice.`
      : `${pair.a.page} and ${pair.b.page} say the same thing. One rule lives on one page.`, detail: [short(pair.a.text), short(pair.b.text)], facts: [pair.a, pair.b] });
  }
  for (const [a, b] of overlaps) issues.push({ kind: 'overlap', pages: [a, b], text: `${a} and ${b} cover the same topic. Merge them into one page.` });
  for (const page of pages) {
    if (page.state === 'stale') issues.push({ kind: 'stale', pages: [page.path], text: `${page.path} was last confirmed ${daysSince(page.verified!, now)} days ago. Check it still holds.` });
    if (page.state === 'draft') issues.push({ kind: 'draft', pages: [page.path], text: `${page.path} isn't confirmed, so the bot treats it as a draft.` });
    if (!page.structured) issues.push({ kind: 'unstructured', pages: [page.path], text: `${page.path} is long prose. Bullets under headings are easier for the bot to use.` });
    if (page.lines > PAGE_MAX_LINES * 0.75) issues.push({ kind: 'long', pages: [page.path], text: `${page.path} is ${page.lines} lines, near the ${PAGE_MAX_LINES}-line cap. Split it.` });
    if (!page.indexed) issues.push({ kind: 'unindexed', pages: [page.path], text: `${page.path} isn't in the index, so the bot never opens it.` });
  }
  const indexLines = index ? lineCount(index) : 0;
  if (indexLines > INDEX_MAX_LINES * 0.85) issues.push({ kind: 'index-full', pages: ['index.md'], text: `The index is ${indexLines} of ${INDEX_MAX_LINES} lines. Merge pages before it fills.` });

  const conflicted = new Set(conflicts.flatMap((pair) => [pair.a.page, pair.b.page]));
  const disputed = new Set(conflicts.flatMap((pair) => [pair.a.text, pair.b.text]));
  const duplicated = new Set([...duplicates.flatMap((pair) => [pair.a.page, pair.b.page]), ...overlaps.flat()]);
  const count = Math.max(1, pages.length);
  const organisedPage = (page: PageInfo): number =>
    ((page.structured ? 1 : 0) + (page.description ? 1 : 0) + (page.indexed ? 1 : 0) + (page.lines <= PAGE_MAX_LINES * 0.75 ? 1 : 0)) / 4;
  const fresh = pages.filter((page) => page.state === 'fresh').length;
  const areas: AreaSummary[] = [...AREAS, 'other' as const].map((area) => {
    const mine = pages.filter((page) => page.area === area);
    const confirmed = mine.filter((page) => page.verified !== null);
    const lead = [...confirmed].sort((a, b) => Number(b.facts > 0) - Number(a.facts > 0) || (b.verified ?? '').localeCompare(a.verified ?? ''))[0];
    // A rule that disagrees with another isn't what the bot knows for sure: the area shows a settled one.
    const headline = lead ? facts.find((fact) => fact.page === lead.path && !disputed.has(fact.text))?.text ?? (lead.description || null) : null;
    return {
      area, label: AREA_LABELS[area], pages: mine.length, confirmed: confirmed.length, facts: mine.reduce((sum, page) => sum + page.facts, 0),
      latest: confirmed.map((page) => page.verified!).sort().at(-1) ?? null, headline: headline ? short(headline, 120) : null,
      conflicts: conflicts.filter((pair) => areaOf.get(pair.a.page) === area || areaOf.get(pair.b.page) === area).length,
    };
  }).filter((area) => area.area !== 'other' || area.pages > 0);
  const parts: HealthParts = pages.length === 0
    ? { fresh: 0, organised: 0, unique: 0, consistent: 0, coverage: 0 }
    : {
      fresh: percent(fresh / count),
      organised: percent(pages.reduce((sum, page) => sum + organisedPage(page), 0) / count - (indexLines > INDEX_MAX_LINES ? 0.25 : 0)),
      unique: percent(1 - duplicated.size / count),
      consistent: percent(1 - (conflicted.size * 2) / count),
      coverage: percent(AREAS.filter((area) => pages.some((page) => page.area === area && page.verified !== null)).length / AREAS.length),
    };
  const score = Math.round(PART_KEYS.reduce((sum, key) => sum + parts[key] * HEALTH_WEIGHTS[key], 0));
  const rank: Record<IssueKind, number> = { conflict: 0, 'index-full': 1, duplicate: 2, overlap: 3, unindexed: 4, stale: 5, draft: 6, long: 7, unstructured: 8 };
  return {
    score, parts, pages: pages.length, facts: facts.length, fresh, stale: pages.filter((page) => page.state === 'stale').length,
    drafts: pages.filter((page) => page.state === 'draft').length, indexLines, areas,
    issues: issues.sort((a, b) => rank[a.kind] - rank[b.kind] || a.pages[0]!.localeCompare(b.pages[0]!)),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// History: replayed from the backups every approved change leaves
// ---------------------------------------------------------------------------------------------------------------

/** A backup's `change.json`, as promote, merge, edit, restore and meeting approvals write it. */
export interface KnowledgeChange {
  id: string;
  action: string;
  at: string;
  files: { path: string; before: string | null; after: string | null }[];
  undoneAt?: string;
}

export type EventKind = 'learned' | 'updated' | 'replaced' | 'removed' | 'confirmed';

export interface KnowledgeEvent {
  at: string;
  kind: EventKind;
  page: string;
  area: Area;
  /** Lines the change added that the bot can use, at most three. */
  added: string[];
  /** Lines it took out, at most three. */
  removed: string[];
  /** The page's description, for a change that added no line of its own. */
  description: string;
  /** How the change came in. */
  via: 'proposal' | 'meeting' | 'edit' | 'retire' | 'restore' | 'other';
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface HistoryPoint {
  at: string; score: number; pages: number; facts: number; conflicts: number; duplicates: number;
  /** What changed at this point, like "Learned owner/role.md"; absent for a weekly point with no change. */
  change?: string;
}

export interface KnowledgeHistory { points: HistoryPoint[]; events: KnowledgeEvent[] }

const viaOf = (change: KnowledgeChange): KnowledgeEvent['via'] => {
  if (change.action === 'edit') return 'edit';
  if (change.action === 'retire') return 'retire';
  if (change.action === 'restore') return 'restore';
  if (change.files.some((file) => file.path.includes('from-meeting/') || file.path.startsWith('decisions/')) || change.id.includes('meeting')) return 'meeting';
  if (change.action === 'promote' || change.action === 'merge') return 'proposal';
  return 'other';
};

const eventsOf = (change: KnowledgeChange): KnowledgeEvent[] => change.files.filter((file) => isPage(file.path)).flatMap((file) => {
  const fields = frontmatter(file.after ?? file.before ?? '');
  const type = fields?.get('type')?.trim() ?? '';
  const before = new Map((file.before ? pageFacts(file.path, file.before) : []).map((fact) => [fact.text, fact]));
  const after = new Map((file.after ? pageFacts(file.path, file.after) : []).map((fact) => [fact.text, fact]));
  const added = [...after.keys()].filter((text) => !before.has(text));
  const removed = [...before.keys()].filter((text) => !after.has(text));
  const replacedNow = /^##\s+Replaced\b/im.test(file.after ?? '') && !/^##\s+Replaced\b/im.test(file.before ?? '');
  let kind: EventKind;
  if (file.after === null) kind = 'removed';
  else if (file.before === null) kind = 'learned';
  else if (replacedNow || (added.length > 0 && removed.length > 0)) kind = 'replaced';
  else if (added.length > 0 || removed.length > 0) kind = 'updated';
  else kind = 'confirmed';
  return [{ at: change.at, kind, page: file.path, area: pageArea(file.path, type), added: added.slice(0, 3).map((text) => short(text)), removed: removed.slice(0, 3).map((text) => short(text)), description: fields?.get('description')?.trim() ?? '', via: viaOf(change) }];
});

/**
 * How the knowledge got to where it is: the folder's health after each approved change, oldest first, and what each
 * change taught the bot, newest first. The past is rebuilt by undoing the changes on today's files, newest first, so
 * it needs nothing but the backups Serra already keeps. A change that was undone left nothing behind and is skipped.
 */
const LABEL: Record<EventKind, string> = { learned: 'Learned', updated: 'Updated', replaced: 'Replaced a rule on', removed: 'Retired', confirmed: 'Confirmed' };

/** One line for what a day's changes did: the change itself, or how many pages changed when there were several. */
const dayLabel = (events: KnowledgeEvent[]): string | undefined => {
  const pages = [...new Set(events.map((event) => event.page))];
  if (pages.length === 0) return undefined;
  if (pages.length > 1) return `Changed ${pages.length} pages`;
  const last = events.at(-1)!;
  return `${LABEL[last.kind]} ${last.page}`;
};

export const knowledgeHistory = (files: KnowledgeFile[], changes: KnowledgeChange[], now: Date): KnowledgeHistory => {
  // A restore puts the approved text back over a hand edit: what the bot knows didn't change, so it isn't history.
  const kept = changes.filter((change) => !change.undoneAt && change.action !== 'restore' && change.files.length > 0 && Date.parse(change.at) <= now.getTime())
    .sort((a, b) => b.at.localeCompare(a.at));
  const state = new Map(files.map((file) => [file.path, file.text]));
  const set = (path: string, text: string | null): void => { if (text === null) state.delete(path); else state.set(path, text); };
  const cache: OverlapCache = { facts: new Map(), pairs: new Map() };
  const snapshot = (at: Date): HistoryPoint => {
    const health = assessKnowledge([...state].map(([path, text]) => ({ path, text })), at, cache);
    return {
      at: at.toISOString(), score: health.score, pages: health.pages, facts: health.facts,
      conflicts: health.issues.filter((issue) => issue.kind === 'conflict').length,
      duplicates: health.issues.filter((issue) => issue.kind === 'duplicate' || issue.kind === 'overlap').length,
    };
  };
  // Undone newest first, back to before the first change. Two made in the same second are told apart by which one
  // the files still show.
  const remaining = [...kept];
  const order: KnowledgeChange[] = [];
  while (remaining.length > 0) {
    const newest = remaining[0]!.at;
    const tied = remaining.filter((change) => change.at === newest);
    const next = tied.find((change) => change.files.every((file) => (state.get(file.path) ?? null) === file.after)) ?? tied[0]!;
    remaining.splice(remaining.indexOf(next), 1);
    order.push(next);
    for (const file of next.files) set(file.path, file.before);
  }
  // Then forward again, oldest first: a point after each change, and one a week in between, since pages also age
  // without anyone touching them. One point per day, the day's last.
  const byDay = new Map<string, HistoryPoint>();
  const dayEvents = new Map<string, KnowledgeEvent[]>();
  const add = (point: HistoryPoint): void => { byDay.set(point.at.slice(0, 10), point); };
  let last = order.length > 0 ? Date.parse(order.at(-1)!.at) : now.getTime();
  if (order.length > 0 && [...state.keys()].some(isPage)) add(snapshot(new Date(last - 1000)));
  const weekly = (until: number): void => {
    for (let at = last + WEEK_MS; at < until; at += WEEK_MS) add(snapshot(new Date(at)));
  };
  const forward = [...order].reverse();
  forward.forEach((change, at) => {
    weekly(Date.parse(change.at));
    for (const file of change.files) set(file.path, file.after);
    const day = change.at.slice(0, 10);
    dayEvents.set(day, [...(dayEvents.get(day) ?? []), ...eventsOf(change)]);
    // One point per day: the folder after the day's last change.
    if (forward[at + 1]?.at.slice(0, 10) !== day) {
      const label = dayLabel(dayEvents.get(day)!);
      add({ ...snapshot(new Date(change.at)), ...(label ? { change: label } : {}) });
    }
    last = Date.parse(change.at);
  });
  weekly(now.getTime());
  // Today's point is the folder as it is, whatever the backups know: an edit accepted before Serra recorded those
  // still counts. It keeps what changed today.
  const today = byDay.get(now.toISOString().slice(0, 10))?.change;
  state.clear();
  for (const file of files) state.set(file.path, file.text);
  add({ ...snapshot(now), ...(today ? { change: today } : {}) });
  return { points: [...byDay.values()], events: order.flatMap(eventsOf) };
};

// ---------------------------------------------------------------------------------------------------------------
// Relevance: which pages a request most likely needs
// ---------------------------------------------------------------------------------------------------------------

/** What the ranker knows about a page: its path, the index row's words, its description, headings and current text. */
export interface PageCard { path: string; when: string; description: string; headings: string; body: string }

/** One card per indexed page, from the index rows and the pages' approved text. */
/**
 * The page an index row opens: the cell that is only a backticked path. A note added to another cell (one that quotes
 * another page) doesn't count. Null for headings, notes and rows that open no page or several.
 */
const rowPage = (line: string): string | null => {
  if (!line.trim().startsWith('|')) return null;
  const pages = line.split(/(?<!\\)\|/).map((cell) => /^\s*`([^`\s]+\.md)`\s*$/.exec(cell)?.[1]).filter((path): path is string => path !== undefined);
  return pages.length === 1 ? pages[0]! : null;
};

export const pageCards = (index: string, files: KnowledgeFile[]): PageCard[] => {
  const texts = new Map(files.map((file) => [file.path, file.text]));
  return index.split('\n').flatMap((line) => {
    const page = rowPage(line);
    if (page === null || !texts.has(page)) return [];
    const text = texts.get(page)!;
    const body = currentText(text);
    return [{
      path: page,
      // The row's own words, without the notes Serra adds in brackets.
      when: line.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\|/g, ' '),
      description: frontmatter(text)?.get('description')?.trim() ?? '',
      headings: body.split('\n').filter((row) => row.startsWith('#')).join(' '),
      body,
    }];
  });
};

const FIELD_WEIGHTS: readonly [keyof PageCard, number][] = [['path', 3], ['when', 3], ['description', 2], ['headings', 1.5], ['body', 1]];

/**
 * The pages that best fit `request`, best first, each with a score. BM25 over each page's path, index row,
 * description, headings and text, with the fields that summarise a page counting most. Only pages that share a
 * meaningful word with the request, and score at least `minShare` of the best one, are returned.
 */
export const rankPages = (request: string, cards: PageCard[], { limit = 3, minShare = 0.35, minScore = 4 }: { limit?: number; minShare?: number; minScore?: number } = {}): { path: string; score: number }[] => {
  const query = [...new Set(words(request))];
  if (query.length === 0 || cards.length === 0) return [];
  const docs = cards.map((card) => {
    const counts = new Map<string, number>();
    let length = 0;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const tokens = words(field === 'path' ? card.path.replace(/\.md$/, '').replace(/[/_-]/g, ' ') : card[field]);
      length += tokens.length * weight;
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + weight);
    }
    return { path: card.path, counts, length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((doc) => {
    let score = 0;
    let matched = 0;
    for (const word of query) {
      const tf = doc.counts.get(word) ?? 0;
      if (tf === 0) continue;
      matched += 1;
      const df = docs.filter((other) => other.counts.has(word)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / average)));
    }
    // A hint needs two words shared with the request, or one strong one: a single passing word is no reason to open a page.
    const strong = matched >= 2 || score >= minScore;
    return { path: doc.path, score: strong ? Math.round(score * 100) / 100 : 0 };
  }).filter((doc) => doc.score > 0).sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
  const best = scored[0]?.score ?? 0;
  return scored.filter((doc) => doc.score >= best * minShare).slice(0, limit);
};

/**
 * Existing pages a new proposal looks like, most alike first: where it should probably be merged instead of becoming
 * one more page.
 */
export const similarPages = (proposal: string, files: KnowledgeFile[], { limit = 3 }: { limit?: number } = {}): { path: string; similarity: number; shared: string[]; disagrees: { page: string; proposal: string } | null }[] => {
  const mine = pageFacts('proposal', proposal);
  const description = frontmatter(proposal)?.get('description')?.trim() ?? '';
  const mineWords = new Set([...words(description), ...mine.flatMap((fact) => [...fact.words])]);
  if (mineWords.size === 0) return [];
  const said = new Set(proposal.toLowerCase().match(/[a-z]+/g) ?? []);
  // A person's card is only a match for a proposal that names that person.
  const about = (path: string): boolean => !path.startsWith('people/')
    || (path.split('/').pop() ?? '').replace(/\.md$/, '').split(/[-_\s]+/).filter((word) => word.length > 1).every((word) => said.has(word));
  return files.filter((file) => isPage(file.path) && about(file.path)).map((file) => {
    const facts = pageFacts(file.path, file.text);
    const theirs = new Set([...words(frontmatter(file.text)?.get('description') ?? ''), ...facts.flatMap((fact) => [...fact.words])]);
    const shared = facts.filter((fact) => mine.some((other) => jaccard(topic(fact.words), topic(other.words)) >= CONFLICT_AT)).map((fact) => short(fact.text));
    // A proposal that changes a rule on the page, rather than repeating it: the screen says it disagrees.
    const clash = findOverlaps([...facts, ...mine]).conflicts.find((pair) => (pair.a.page === 'proposal') !== (pair.b.page === 'proposal'));
    const disagrees = clash ? { page: clash.a.page === 'proposal' ? clash.b.text : clash.a.text, proposal: clash.a.page === 'proposal' ? clash.a.text : clash.b.text } : null;
    let overlap = 0;
    for (const word of mineWords) if (theirs.has(word)) overlap += 1;
    return { path: file.path, similarity: Math.round((overlap / mineWords.size) * 100) / 100, shared: shared.slice(0, 3), disagrees };
  }).filter((page) => page.shared.length > 0 || page.similarity >= 0.5)
    .sort((a, b) => Number(b.disagrees !== null) - Number(a.disagrees !== null) || b.shared.length - a.shared.length || b.similarity - a.similarity).slice(0, limit);
};

/**
 * Which of two disagreeing rules is newer: the one saying "now", or "since"/"as of" a date, else the one on the page
 * confirmed later. Null when nothing tells them apart.
 */
const newerOf = (pair: FactPair, confirmed: Map<string, string>): 'a' | 'b' | null => {
  const fresh = (text: string): boolean => /\bnow\b/i.test(text) || /\b(since|as of|starting|from)\s+(\d{4}-\d{2}|\d{1,2}\s+)?(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|\d{4}-\d{2})\b/i.test(text);
  if (fresh(pair.a.text) !== fresh(pair.b.text)) return fresh(pair.a.text) ? 'a' : 'b';
  const [a, b] = [confirmed.get(pair.a.page) ?? '', confirmed.get(pair.b.page) ?? ''];
  if (pair.a.page !== pair.b.page && DATE.test(a) && DATE.test(b) && a !== b) return a > b ? 'a' : 'b';
  return null;
};

/** What a rule says it ended: "moved from Grafana to Datadog", "the changelog is replaced by", "OAuth login was removed". */
const ENDED = [
  /\b(?:moved|migrated|switched|changed)\s+from\s+((?:[\w/-]+\s+){0,2}?[\w/-]+)\s+to\b/gi,
  /((?:[\w/-]+\s+){0,2}[\w/-]+)\s+(?:is|was|are|were|has been|have been)\s+(?:now\s+)?(?:replaced|removed|retired|switched off|turned off|deprecated|dropped|discontinued)\b/gi,
];
/** A word in more facts than this is too common to say which older rule a change ended. */
const ENDED_MAX_FACTS = 3;

/**
 * Pairs of a newer rule that says something ended and an older rule, on a page confirmed earlier, that still names it:
 * "The public changelog is replaced by a monthly digest" against "Every change gets a changelog entry". No day or
 * number differs, so `findOverlaps` can't see these. The older rule is matched on the ended thing's rarest word.
 */
const endedRules = (facts: Fact[], confirmed: Map<string, string>): FactPair[] => {
  const seen = new Map<string, number>();
  for (const fact of facts) for (const word of fact.words) seen.set(word, (seen.get(word) ?? 0) + 1);
  return facts.flatMap((fact) => {
    const date = confirmed.get(fact.page) ?? '';
    if (!DATE.test(date)) return [];
    const keys = new Set(ENDED.flatMap((pattern) => [...fact.text.matchAll(pattern)].flatMap((match) => {
      const terms = words(match[1]!).filter((word) => !CHANGE_WORDS.has(word));
      // A word the rule also says outside the ended part is its subject ("login" in "Dashboard login moved to SSO;
      // OAuth login was removed"); what's left names the ended thing, by its last word ("changelog", not "public").
      const rest = new Set(words(fact.text.replace(match[0], ' ')));
      const own = terms.filter((word) => !rest.has(word));
      const key = (own.length > 0 ? own : terms).at(-1);
      return key !== undefined && (seen.get(key) ?? 0) - 1 <= ENDED_MAX_FACTS ? [key] : [];
    })));
    if (keys.size === 0) return [];
    return facts.filter((old) => old.page !== fact.page && [...keys].some((key) => old.words.has(key))
      && DATE.test(confirmed.get(old.page) ?? '') && confirmed.get(old.page)! < date)
      .map((old) => ({ a: { page: fact.page, text: fact.text }, b: { page: old.page, text: old.text }, similarity: 0 }));
  });
};

/**
 * The index with a note on each row whose page a worker should weigh with care: `(draft: not confirmed)` or
 * `(confirmed 2026-08-01; may be out of date)`. Rows of fresh pages are left as they are.
 */
export const markIndexRows = (index: string, files: KnowledgeFile[], now: Date): string => {
  const notes = new Map<string, string[]>();
  const add = (path: string, note: string): void => { notes.set(path, [...(notes.get(path) ?? []), note]); };
  for (const { path, text } of files) {
    const verified = frontmatter(text)?.get('verified')?.trim() ?? '';
    if (!DATE.test(verified)) add(path, 'draft: not confirmed');
    else if (daysSince(verified, now) > STALE_DAYS) add(path, `confirmed ${verified}; may be out of date`);
  }
  // Two current rules that disagree: the worker is told which, so it says which it followed instead of picking one silently.
  const pages = describePages(files, index, now);
  const areaOf = new Map(pages.map((page) => [page.path, page.area]));
  const facts = files.filter((file) => isPage(file.path)).flatMap((file) => pageFacts(file.path, file.text));
  const { conflicts } = findOverlaps(facts, (a, b) => samePageSubject(a, b, areaOf));
  const confirmed = new Map(files.map((file) => [file.path, frontmatter(file.text)?.get('verified')?.trim() ?? '']));
  // A rule that says what it ended is the current one by its own words.
  const said = new Set(conflicts.map((pair) => [pair.a.text, pair.b.text].sort().join('\n')));
  const ended = endedRules(facts, confirmed).filter((pair) => !said.has([pair.a.text, pair.b.text].sort().join('\n')));
  // Each conflicted row gets a short mark; the two rules and what to do are said once, below the index.
  const listed = [...conflicts, ...ended].slice(0, 16);
  for (const pair of listed) for (const path of new Set([pair.a.page, pair.b.page])) add(path, 'two rules disagree: see below');
  const where = (page: string): string => `\`${page}\`, confirmed ${confirmed.get(page) || 'never'}`;
  const detail = listed.length === 0 ? '' : [
    '', '', 'Rules that disagree. Follow the current one and say the other is out of date; ask the owner only where it says Serra can\'t tell.',
    ...listed.map((pair) => {
      // When the dates or the words settle it, say which rule is current, so the worker doesn't have to weigh it.
      const newer = ended.includes(pair) ? 'a' : newerOf(pair, confirmed);
      if (newer) {
        const [current, old] = newer === 'a' ? [pair.a, pair.b] : [pair.b, pair.a];
        return `- Current: "${short(current.text, 90)}" (${where(current.page)}). It replaces "${short(old.text, 90)}"${old.page === current.page ? ' on the same page' : ` (${where(old.page)})`}.`;
      }
      return `- "${short(pair.a.text, 90)}" (${where(pair.a.page)}) and "${short(pair.b.text, 90)}"${pair.a.page === pair.b.page ? ' (same page)' : ` (${where(pair.b.page)})`}: can't tell which is newer.`;
    }),
  ].join('\n');
  if (notes.size === 0) return index;
  return index.split('\n').map((line) => {
    const page = rowPage(line);
    const note = page === null ? undefined : [...new Set(notes.get(page))].join('; ');
    if (!note) return line;
    const end = line.trimEnd();
    return end.endsWith('|') ? `${end.slice(0, -1).trimEnd()} (${note}) |` : `${end} (${note})`;
  }).join('\n') + detail;
};

/** What the brief adds after the index: the pages that look closest to the request, and how to say which were used. */
export const relevanceNote = (request: string, cards: PageCard[], ignore: string[] = []): string => {
  const cleaned = ignore.reduce((text, word) => (word.trim() ? text.replace(new RegExp(`\\b${word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ') : text), request);
  const ranked = rankPages(cleaned, cards);
  const hint = ranked.length > 0
    ? `Pages that look closest to this request, best first: ${ranked.map((page) => `\`${page.path}\``).join(', ')}. Open them first if their row fits; they are a guess, so check other rows too.\n\n`
    : '';
  return `${hint}If a page here shaped your reply, end the reply with one line naming the pages you used, like <knowledge-used>owner/role.md, people/priya.md</knowledge-used>. If you needed something about the owner, their team or their work that no page says, add one more line naming it in a few words, like <knowledge-missing>who approves refunds over 500 EUR</knowledge-missing>. Serra removes these lines before anyone sees the reply. Leave them out when they don't apply.`;
};

/**
 * Pairs of facts, one on `page` and one on a page confirmed after `verified`, that talk about the same thing: at least
 * two shared words, and half of the shorter one's. The newer one may have changed the older, even where no day or
 * number shows it. Used to hold back "Still true" and to hand the weekly review's model the pairs to look at.
 */
export const topicPairs = (page: string, verified: string, files: KnowledgeFile[]): { mine: Fact; newer: Fact }[] => {
  const mine = pageFacts(page, files.find((file) => file.path === page)?.text ?? '');
  return files.flatMap((file) => {
    if (file.path === page || !isPage(file.path)) return [];
    const date = frontmatter(file.text)?.get('verified')?.trim() ?? '';
    if (!DATE.test(date) || date <= verified) return [];
    return pageFacts(file.path, file.text).flatMap((fact) => mine.flatMap((own) => {
      let shared = 0;
      for (const word of own.words) if (fact.words.has(word)) shared += 1;
      return shared >= 2 && shared >= Math.min(own.words.size, fact.words.size) / 2 ? [{ mine: own, newer: fact }] : [];
    }));
  });
};

const newerOnTopic = (page: string, verified: string, files: KnowledgeFile[]): boolean => topicPairs(page, verified, files).length > 0;


/**
 * Whether "Still true" must not be offered for `page`: it holds a rule that disagrees with or repeats another, or a
 * page confirmed later talks about the same thing and may have changed it. The owner opens such a page instead.
 */
export const confirmHeldBack = (page: string, files: KnowledgeFile[], health: Pick<Health, 'issues'>): boolean => {
  if (health.issues.some((item) => (item.kind === 'conflict' || item.kind === 'duplicate') && item.pages.includes(page))) return true;
  const verified = frontmatter(files.find((file) => file.path === page)?.text ?? '')?.get('verified')?.trim() ?? '';
  return DATE.test(verified) && newerOnTopic(page, verified, files);
};
