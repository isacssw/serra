import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { createJournal, type KnowledgeDrift } from './knowledge-journal.ts';
import { AUDIENCES, compileAboutMe, filterIndex, mayUse, pageAudience, type AboutMe, type Audience, type Visibility } from './owner-model.ts';
import type { KnowledgePage, Profile } from './contracts.ts';
import {
  DATE, daysSince, frontmatter, INDEX_MAX_LINES, lineCount, normalizePageText, NOT_PAGES, pageBadge, pageProblems, PROPOSALS_DIR,
  isOfflimits, offlimitsBudgetProblem, pageBody, saveProblems, saveRefusal, setHeaderField, STALE_DAYS,
} from './knowledge-rules.ts';

// The page rules live in knowledge-rules.ts (no Node imports, so the app's editor can use them); re-exported here so
// callers keep one import.
export {
  DATE, frontmatter, INDEX_MAX_LINES, lineCount, NOT_PAGES, PAGE_MAX_LINES, pageProblems, PROPOSALS_DIR, REQUIRED_KEYS, STALE_DAYS,
} from './knowledge-rules.ts';

/** A repository checkout that pages may name paths in, like `apps/api/…` or `webapp/docs/…`. */
export interface KnowledgeRoot {
  name: string;
  path: string;
}

export interface CheckOptions {
  now?: Date;
  /** Checkouts to resolve backticked paths against. Without any, paths aren't checked. */
  roots?: KnowledgeRoot[];
}

/** The checkouts a profile's pages can name paths in: the project, then any extra repositories. */
export const profileRoots = (profile: Pick<Profile, 'project' | 'repositories'>): KnowledgeRoot[] => [
  { name: basename(profile.project.path), path: profile.project.path },
  ...(profile.repositories ?? []).map(({ name, path }) => ({ name, path })),
];

/**
 * Resolve a path relative to the knowledge folder `root` and refuse anything that leaves it: absolute paths, `..`,
 * and symlinked folders that point elsewhere. Returns the absolute path.
 */
export const insideKnowledge = (root: string, relativePath: string, what: string): string => {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error(`${what} must be a path inside knowledge/, like owner/role.md. Got: ${relativePath || '(empty)'}`);
  }
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new Error(`${what} is outside knowledge/: ${relativePath}`);
  // The nearest folder that exists must really be inside knowledge/, so a symlinked folder can't lead out of it.
  let existing = absolute;
  while (!existsSync(existing)) existing = dirname(existing);
  const realRoot = realpathSync(root);
  const real = realpathSync(existing);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`${what} is outside knowledge/: ${relativePath}`);
  return absolute;
};

/** Check that `relativePath` is a page location: inside `knowledge/`, a `.md` file, not a proposal, index, log or README. Returns it relative to `root`. */
export const knowledgePagePath = (root: string, relativePath: string, what: string): string => {
  const path = relative(root, insideKnowledge(root, relativePath, what)).split(sep).join('/');
  if (!path.endsWith('.md')) throw new Error(`${what} must be a .md file: ${relativePath}`);
  if (path === PROPOSALS_DIR || path.startsWith(`${PROPOSALS_DIR}/`)) throw new Error(`${what} can't be inside proposals/: ${relativePath}`);
  if (NOT_PAGES.has(path)) throw new Error(`${what} can't be ${path}; that file is not a page.`);
  return path;
};

/** The knowledge a brief carries for one reply. */
export interface BriefKnowledge {
  index: string;
  aboutMe: AboutMe;
  visibility: Visibility;
  /** Every page this brief let the worker use or open, so a later restriction can be noticed. */
  pages: string[];
  /** The same pages, each with who could hear the version the worker could read. */
  read: Record<string, Audience>;
  /** Where the worker opens pages: a snapshot of the approved pages it may use, which never changes. */
  readDir: string;
}

/** Markdown files under `dir`, relative to it, skipping dot folders. */
/** Where the snapshots workers read are kept, one folder per audience: `.knowledge-owner/`, `.knowledge-team/`, `.knowledge-external/`. */
export const audienceDir = (knowledgeDir: string, visibility: Visibility): string => {
  const root = resolve(knowledgeDir);
  return join(dirname(root), `.${basename(root)}-${visibility}`);
};

/**
 * Snapshots unused for this long are removed when a new one is made. Using one (a new brief with the same knowledge)
 * makes it new again, and a thread whose folder is gone carries on in a fresh session.
 */
const SNAPSHOT_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * A folder under `base` holding exactly `files` (path → text), named after their hash: the same files give the same
 * folder, made once and never changed. Written to a temporary folder first, then renamed into place.
 */
const snapshot = (base: string, files: Map<string, string>, now: Date): string => {
  const hash = createHash('sha256');
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(`${path}\0${text}\0`);
  const dir = join(base, hash.digest('hex').slice(0, 16));
  if (existsSync(dir)) {
    utimesSync(dir, now, now);
    return dir;
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const old = join(base, entry.name);
    if (entry.isDirectory() && now.getTime() - statSync(old).mtimeMs > SNAPSHOT_KEEP_MS) rmSync(old, { recursive: true, force: true });
  }
  const temp = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
  for (const [path, text] of files) {
    mkdirSync(dirname(join(temp, path)), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(temp, path), text, { mode: 0o600 });
  }
  try { renameSync(temp, dir); } catch { rmSync(temp, { recursive: true, force: true }); }
  return dir;
};

const markdownIn = (dir: string, relativeDir = ''): string[] => {
  if (!existsSync(join(dir, relativeDir))) return [];
  return readdirSync(join(dir, relativeDir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return markdownIn(dir, path);
    return entry.name.endsWith('.md') && !NOT_PAGES.has(path) && !path.startsWith(`${PROPOSALS_DIR}/`) ? [path] : [];
  });
};

/** The off-limits budget problem if `page` read `text` (null: removed), with every other page as it is now. */
export const offlimitsBudgetAfter = (knowledgeDir: string, page: string, text: string | null): string | null => {
  const root = resolve(knowledgeDir);
  const others = markdownIn(root).filter((path) => path !== page && path !== 'index.md')
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
  return offlimitsBudgetProblem(text === null ? others : [...others, { path: page, text }]);
};

export interface KnowledgeOptions {
  /** Where page edits keep their backup. Defaults to `backups/knowledge/` next to `knowledge/`, in the profile. */
  backupDir?: string;
}

/** What a page save did: the page as the list now shows it, and the backup holding its text from before. */
export interface PageSave {
  page: KnowledgePage;
  /** Folder name under the backup folder, or null when the text was unchanged and nothing was written. */
  backupId: string | null;
}

/** Absolute path of the knowledge folder, handed to the worker so it can open pages. */
export const createKnowledge = (knowledgeDir: string, { backupDir }: KnowledgeOptions = {}) => {
  const root = resolve(knowledgeDir);
  const backups = resolve(backupDir ?? join(dirname(root), 'backups', 'knowledge'));

  interface KnowledgeReport {
    /** Things that make the folder wrong. A non-empty list fails `pnpm knowledge`. */
    problems: string[];
    pages: string[];
    /** Pages the owner hasn't confirmed. */
    unverified: string[];
    /** Worker-written pages waiting for the owner. */
    proposals: string[];
    /** Things worth a look that don't make the folder wrong: old verifications, paths that no longer exist. Never fail `pnpm knowledge`. */
    warnings: string[];
    /**
     * The index-over-cap message when index.md is longer than the cap, else null. It is also in `problems`; it is
     * separate so `doctor` can show it without failing, since jobs still run on an over-cap index.
     */
    indexOverCap: string | null;
  }

  const read = (relativePath: string): string => readFileSync(join(knowledgeDir, relativePath), 'utf8');

  const markdownFiles = (relativeDir = ''): string[] =>
    readdirSync(join(knowledgeDir, relativeDir), { withFileTypes: true }).flatMap((entry) => {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return markdownFiles(relativePath);
      return entry.name.endsWith('.md') ? [relativePath] : [];
    });

  const indexProblems = (index: string): string[] => {
    const lines = lineCount(index);
    return lines > INDEX_MAX_LINES
      ? [`index.md: ${lines} lines. The cap is ${INDEX_MAX_LINES}, because the index goes into every brief.`]
      : [];
  };

  const journal = createJournal(root);

  /**
   * Reads the whole index for a brief. Throws only when it is missing. An index over the cap is still loaded whole:
   * it can get there outside the app (a hand edit), and a bot that stops taking jobs or won't start is worse than a
   * slightly longer brief, while cutting rows would hide pages without a word. `checkKnowledge` still reports it,
   * `pnpm knowledge` fails on it, and the daemon logs it at startup.
   *
   * The index comes from the owner's approved copy (knowledge-journal.ts). When files changed outside Serra since,
   * the brief gets the approved index and says which pages changed and where their approved text is.
   */
  const loadIndex = (visibility: Visibility = 'owner'): string => briefKnowledge(visibility).index;

  /**
   * What a brief gets from the knowledge for a reply that `visibility` will see: the index rows that audience may
   * open, and About me. Both come from the owner's approved copy; when files changed outside Serra since, the index
   * says which, and where their approved text is.
   */
  const briefKnowledge = (visibility: Visibility, now: Date = new Date()): BriefKnowledge => {
    const { changed, removed } = journal.drift();
    const drifted = changed.length > 0 || removed.length > 0;
    // Once the approved copy exists, briefs read only from it: whatever is on disk, even a save landing a moment after
    // the drift check, waits for the owner. Before it exists (a profile no daemon or Pages has opened yet), disk.
    const fromApproved = journal.seeded() && journal.approvedText('index.md') !== null;
    const indexText = fromApproved ? journal.approvedText('index.md')! : read('index.md');
    const approved = (path: string): string | null => (fromApproved ? journal.approvedText(path) : existsSync(join(root, path)) ? read(path) : null);
    const pages = (fromApproved ? markdownIn(journal.approvedRoot) : pageFiles()).filter((path) => path !== 'index.md')
      .flatMap((path) => { const text = approved(path); return text === null ? [] : [{ path, text }]; });
    const audiences = new Map(pages.map(({ path, text }) => [path, pageAudience(frontmatter(text))]));
    const descriptions = new Map(pages.map(({ path, text }) => [path, frontmatter(text)?.get('description')?.trim() ?? '']));
    const aboutMe = compileAboutMe(pages, visibility, now);
    let index = filterIndex(indexText.trim(), (page) => (audiences.has(page) ? { audience: audiences.get(page)!, description: descriptions.get(page) ?? '' } : null), visibility);
    // Every worker reads a snapshot of approved pages, so an edit waiting for review needs no note for teammates. The
    // owner hears which files are waiting. Before the approved copy exists, nobody opens pages.
    if (drifted && visibility === 'owner') {
      index += `\n\nSome knowledge files changed outside Serra and the owner hasn't approved them yet (unreviewed changes): ${[...changed, ...removed].map((path) => `\`${path}\``).join(', ')}. `
        + `The folder you read has the approved versions; don't use any other copy.`;
    } else if (drifted && !fromApproved) {
      index += `\n\nSome knowledge files changed and the owner hasn't approved them yet. Don't open pages to answer this: use only what this brief says.`;
    }
    const usable = [...audiences].filter(([, audience]) => mayUse(audience, visibility)).map(([path]) => path).sort();
    // Every worker reads a snapshot folder named after its contents, which never changes: a page approved or shared
    // after a thread started never appears in that thread's folder. Anyone but the owner gets only the pages they may
    // hear. `read` records who could hear each version the worker could read, for later checks.
    const texts = new Map(pages.map(({ path, text }) => [path, text]));
    const files = new Map([['index.md', `${index}\n`], ...usable.map((path) => [path, texts.get(path)!] as const)]);
    const readable = Object.fromEntries(usable.map((path) => [path, audiences.get(path)!]));
    return { index, aboutMe, visibility, pages: usable, read: readable, readDir: snapshot(audienceDir(root, visibility), files, now) };
  };

  /**
   * Start keeping the approved copy, from `knowledge/` as it is now, if it isn't kept yet. The daemon does this at
   * start and the app when it shows Pages. Building a brief writes only the snapshot its worker reads.
   */
  const seedApproved = (): boolean => journal.seed();

  /** Files that changed outside Serra since the owner last approved the knowledge. */
  const drift = (): KnowledgeDrift => journal.drift();

  /** Each file that changed outside Serra, with its approved text and its text now, for the owner to review. */
  const driftDetails = () => journal.details();

  /** The owner accepts one file's change as theirs, as they reviewed it. */
  const acceptDrift = (path: string, current: string | null): void => {
    // Accepting is approving: the same page checks and off-limits budget apply as for a save or a proposal.
    if (current !== null && path !== 'index.md') {
      const problems = saveProblems(path, current);
      if (problems.length > 0) throw new Error(`Not accepted. ${saveRefusal(problems)}`);
    }
    const budget = current !== null && isOfflimits(path, frontmatter(current)) ? offlimitsBudgetAfter(root, path, current) : null;
    if (budget) throw new Error(`Not accepted. ${budget}`);
    journal.accept(path, current);
  };

  /** Put back the approved text of `path` (or every changed file), keeping a backup of what was there. */
  const restoreDrift = (path?: string, { now = new Date() }: { now?: Date } = {}): string | null => {
    const { changed, removed } = journal.drift();
    const paths = [...changed, ...removed].filter((item) => !path || item === path);
    if (paths.length === 0) return null;
    const backupId = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-restore-${randomBytes(3).toString('hex')}`;
    const files = paths.map((item) => ({ path: item, before: existsSync(join(root, item)) ? read(item) : null, after: journal.approvedText(item) }));
    mkdirSync(join(backups, backupId), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(backups, backupId, 'change.json'), JSON.stringify({ id: backupId, action: 'restore', at: now.toISOString(), files }, null, 2) + '\n');
    journal.restore(paths);
    return backupId;
  };

  /**
   * The backticked tokens of a page that are repository paths: relative, with a `/`, no spaces, URLs, globs,
   * placeholders or `…` fragments. Fenced code blocks are skipped, since they hold commands, not references.
   * A `:line` or `:symbol` suffix and a trailing `/` are dropped.
   */
  const backtickedPaths = (text: string): string[] => {
    const prose = text.replace(/^```[\s\S]*?^```/gm, '');
    const paths = [...prose.matchAll(/`([^`\n]+)`/g)].flatMap((match) => {
      const token = (match[1] ?? '').trim();
      if (!token.includes('/') || /\s/.test(token)) return [];
      if (/^[a-z]+:\/\//i.test(token) || /^(?:[/~]|\.\.?\/)/.test(token)) return [];
      if (/[*?{}[\]<>$|…]/.test(token) || token.includes('...')) return [];
      const path = token.replace(/:[\w.-]+$/, '').replace(/\/+$/, '');
      // A page of this folder, like `owner/role.md`, is checked by the index rules instead.
      if (existsSync(join(knowledgeDir, path))) return [];
      return /^[\w@().-]+(?:\/[\w@().-]+)+$/.test(path) ? [path] : [];
    });
    return [...new Set(paths)];
  };

  /**
   * Whether a page's path is missing from every repository. A path counts only when it is anchored in one: it starts
   * with a repository name (`webapp/docs/…`), or its first two folders exist there (`apps/api/…`; one folder for
   * `docs/x.md`). Fragments relative to a deeper folder, like `services/billing/common.ts` or `tests/integration/billing/`,
   * can't be placed and are left alone rather than reported.
   */
  const missingPath = (path: string, roots: KnowledgeRoot[]): boolean => {
    const [first = '', ...rest] = path.split('/');
    let anchored = false;
    for (const root of roots) {
      const names = [root.name, basename(root.path)].map((name) => name.toLowerCase());
      if (names.includes(first.toLowerCase()) && rest.length > 0) {
        anchored = true;
        if (existsSync(join(root.path, ...rest))) return false;
      }
      const segments = path.split('/');
      if (!existsSync(join(root.path, ...segments.slice(0, Math.min(2, segments.length - 1))))) continue;
      anchored = true;
      if (existsSync(join(root.path, path))) return false;
    }
    return anchored;
  };

  const pageWarnings = (page: string, text: string, fields: Map<string, string> | null, { now, roots }: Required<CheckOptions>): string[] => {
    const warnings: string[] = [];
    const verified = fields?.get('verified') ?? '';
    if (DATE.test(verified)) {
      const age = daysSince(verified, now);
      if (age > STALE_DAYS) warnings.push(`${page}: verified ${age} days ago (${verified}). Check it still holds, then update \`verified\`.`);
    }
    if (roots.length > 0) {
      for (const path of backtickedPaths(text)) {
        if (missingPath(path, roots)) warnings.push(`${page}: names \`${path}\`, which doesn't exist in ${roots.map((root) => root.name).join(' or ')}.`);
      }
    }
    return warnings;
  };

  const indexedPages = (index: string): Set<string> =>
    new Set([...index.matchAll(/`([^`\s]+\.md)`/g)].flatMap((match) => (match[1] ? [match[1]] : [])));

  /** One page as the app lists it: header fields, badge, and its own problems and warnings. */
  const describePage = (page: string, text: string, indexed: Set<string>, options: Required<CheckOptions>): KnowledgePage => {
    const fields = frontmatter(text);
    const problems = pageProblems(page, text, fields);
    if (!indexed.has(page)) problems.push(`${page}: not in index.md, so no worker will ever open it.`);
    const field = (key: string): string | undefined => fields?.get(key)?.trim() || undefined;
    const verified = field('verified');
    const type = field('type');
    const description = field('description');
    const written = field('written');
    return {
      path: page,
      ...(type ? { type } : {}),
      ...(description ? { description } : {}),
      ...(written ? { written } : {}),
      verified: verified && DATE.test(verified) ? verified : null,
      badge: pageBadge(verified, options.now),
      lines: lineCount(text),
      problems,
      warnings: pageWarnings(page, text, fields, options),
    };
  };

  const pageFiles = (): string[] => markdownFiles().filter((file) => !NOT_PAGES.has(file) && !file.startsWith(`${PROPOSALS_DIR}/`));

  /** Checks the whole folder. Reports and never edits. */
  const checkKnowledge = ({ now = new Date(), roots = [] }: CheckOptions = {}): KnowledgeReport => {
    const files = markdownFiles();
    const pages = pageFiles();
    const proposals = files.filter((file) => file.startsWith(`${PROPOSALS_DIR}/`) && file !== `${PROPOSALS_DIR}/README.md`);

    // A missing index is a problem to report, not a crash: jobs use the approved one meanwhile.
    const index = existsSync(join(root, 'index.md')) ? read('index.md') : '';
    const indexed = indexedPages(index);

    const [indexOverCap = null] = indexProblems(index);
    const problems = indexOverCap ? [indexOverCap] : [];
    const unverified: string[] = [];
    const warnings: string[] = [];
    for (const page of pages) {
      const described = describePage(page, read(page), indexed, { now, roots });
      problems.push(...described.problems);
      warnings.push(...described.warnings);
      if (described.verified === null) unverified.push(page);
    }
    for (const entry of indexed) {
      if (!pages.includes(entry)) problems.push(`index.md: points at \`${entry}\`, which doesn't exist.`);
    }
    const budget = offlimitsBudgetProblem(pages.map((path) => ({ path, text: read(path) })));
    if (budget) warnings.push(budget);
    return { problems, pages, unverified, proposals, warnings, indexOverCap };
  };

  const readIndexed = (): Set<string> => indexedPages(existsSync(join(root, 'index.md')) ? read('index.md') : '');

  /** Every page with its verified, unverified or stale badge (the same rules as `checkKnowledge`), sorted by path. */
  const listPages = ({ now = new Date(), roots = [] }: CheckOptions = {}): KnowledgePage[] => {
    if (!existsSync(root)) return [];
    const indexed = readIndexed();
    return pageFiles().sort().map((page) => describePage(page, read(page), indexed, { now, roots }));
  };

  /** An existing page's path relative to `knowledge/`, checked. */
  const existingPage = (path: string): string => {
    if (!existsSync(root)) throw new Error('This profile has no knowledge/ folder.');
    const page = knowledgePagePath(root, path, 'Page');
    if (!existsSync(join(root, page))) throw new Error(`No page ${page} in knowledge/. New pages come in through Proposals.`);
    return page;
  };

  /** A page's text, for the editor. */
  const readPage = (path: string): string => read(existingPage(path));

  /**
   * Replace an existing page's text. Refuses a path outside `knowledge/` and text that would fail `pnpm knowledge`
   * (missing header field, bad date, over the line cap), with the message the app's editor shows before it lets the
   * owner save. Before writing, the old and new text go to a backup under `backups/knowledge/`; the page itself is
   * written atomically. Saving unchanged text writes nothing.
   */
  const savePage = (path: string, text: string, { now = new Date(), roots = [], expected }: CheckOptions & { expected?: string } = {}): PageSave => {
    if (typeof text !== 'string') throw new Error('A page is text.');
    const page = existingPage(path);
    // The editor's save applies to the version it loaded: a page that moved since (an accepted change, another save)
    // is never overwritten with an older draft.
    if (expected !== undefined && read(page) !== expected) {
      throw new Error(`${page} changed since you opened it. Reopen it to see the current text, then make your edit again.`);
    }
    // Saving a page that changed outside Serra would approve that change along with the owner's edit, unseen.
    const { changed, removed } = journal.drift();
    if (changed.includes(page) || removed.includes(page)) {
      throw new Error(`${page} changed outside Serra. Review it at the top of Pages (accept or restore it) before editing.`);
    }
    const after = normalizePageText(text);
    const budget = offlimitsBudgetAfter(root, page, after);
    const problems = [...saveProblems(page, after), ...(budget && isOfflimits(page, frontmatter(after)) ? [budget] : [])];
    if (problems.length > 0) throw new Error(saveRefusal(problems));

    const before = read(page);
    let backupId: string | null = null;
    if (before !== after) {
      const slug = page.replace(/\.md$/, '').replace(/[^\w-]+/g, '-');
      backupId = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-edit-${slug}-${randomBytes(3).toString('hex')}`;
      const backup = { id: backupId, action: 'edit', at: now.toISOString(), page, files: [{ path: page, before, after }] };
      mkdirSync(join(backups, backupId), { recursive: true, mode: 0o700 });
      writeFileAtomic(join(backups, backupId, 'change.json'), JSON.stringify(backup, null, 2) + '\n');
      journal.seed();
      writeFileAtomic(join(root, page), after, { mode: 0o644 });
      journal.record([{ path: page, text: after }]);
    }
    return { page: describePage(page, after, readIndexed(), { now, roots }), backupId };
  };

  /** Pages whose header doesn't say who may hear them, so only the owner's own replies use them. */
  const untaggedPages = (): string[] => pageFiles().sort().filter((page) => !frontmatter(read(page))?.has('audience'));

  /** The same, with each page's description, for the app's list. */
  const untaggedDetails = (): { path: string; description: string; offlimits: boolean; preview: string; text: string }[] =>
    untaggedPages().map((path) => {
      const text = read(path);
      const fields = frontmatter(text);
      return { path, description: fields?.get('description')?.trim() ?? '', offlimits: isOfflimits(path, fields), preview: pageBody(text), text };
    });

  /**
   * Set who may hear each page, as the owner chose in the app. Each page is saved like an edit, with a backup.
   * All or nothing: a page that changed outside Serra, or since the owner looked, refuses the whole share.
   */
  const shareWith = (pages: string[], audience: Audience, options: CheckOptions & { seen?: Record<string, string> } = {}): { shared: string[] } => {
    if (!AUDIENCES.includes(audience)) throw new Error(`Pick who may hear the pages: ${AUDIENCES.join(', ')}.`);
    const { changed, removed } = journal.drift();
    // Every page is checked before any is saved, so sharing is all or nothing and a refusal names the page.
    const ready = pages.flatMap((path) => {
      const page = existingPage(path);
      if (changed.includes(page) || removed.includes(page)) throw new Error(`Nothing was shared. ${page} changed outside Serra: review it in Pages first.`);
      // Shared as the owner previewed it: a page that changed since is refused, and nothing is shared.
      if (options.seen && options.seen[page] !== read(page)) throw new Error(`Nothing was shared. ${page} changed since you looked at it: open the list again.`);
      const text = setHeaderField(read(page), 'audience', audience);
      const budget = isOfflimits(page, frontmatter(text)) ? offlimitsBudgetAfter(root, page, text) : null;
      const problems = [...saveProblems(page, normalizePageText(text)), ...(budget ? [budget] : [])];
      if (problems.length > 0) throw new Error(`Nothing was shared. ${page} needs fixing first:\n${problems.join('\n')}`);
      return [{ page, text }];
    });
    for (const { page, text } of ready) savePage(page, text, options);
    return { shared: ready.map(({ page }) => page) };
  };

  return { untaggedPages, untaggedDetails, shareWith, loadIndex, briefKnowledge, checkKnowledge, listPages, readPage, savePage, seedApproved, drift, driftDetails, acceptDrift, restoreDrift };
};
