import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from './config.ts';
import type { KnowledgePage, Profile } from './contracts.ts';
import {
  DATE, daysSince, frontmatter, INDEX_MAX_LINES, lineCount, normalizePageText, NOT_PAGES, pageBadge, pageProblems, PROPOSALS_DIR,
  saveProblems, saveRefusal, STALE_DAYS,
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

  /**
   * Reads the whole index for a brief. Throws only when it is missing. An index over the cap is still loaded whole:
   * it can get there outside the app (a hand edit, or a worker adding a row in Slack), and a bot that stops taking
   * jobs or won't start is worse than a slightly longer brief, while cutting rows would hide pages without a word.
   * `checkKnowledge` still reports it, `pnpm knowledge` fails on it, and the daemon logs it at startup.
   */
  const loadIndex = (): string => read('index.md').trim();

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

    const index = read('index.md');
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
  const savePage = (path: string, text: string, { now = new Date(), roots = [] }: CheckOptions = {}): PageSave => {
    if (typeof text !== 'string') throw new Error('A page is text.');
    const page = existingPage(path);
    const after = normalizePageText(text);
    const problems = saveProblems(page, after);
    if (problems.length > 0) throw new Error(saveRefusal(problems));

    const before = read(page);
    let backupId: string | null = null;
    if (before !== after) {
      const slug = page.replace(/\.md$/, '').replace(/[^\w-]+/g, '-');
      backupId = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-edit-${slug}-${randomBytes(3).toString('hex')}`;
      const backup = { id: backupId, action: 'edit', at: now.toISOString(), page, files: [{ path: page, before, after }] };
      mkdirSync(join(backups, backupId), { recursive: true, mode: 0o700 });
      writeFileAtomic(join(backups, backupId, 'change.json'), JSON.stringify(backup, null, 2) + '\n');
      writeFileAtomic(join(root, page), after, { mode: 0o644 });
    }
    return { page: describePage(page, after, readIndexed(), { now, roots }), backupId };
  };

  return { loadIndex, checkKnowledge, listPages, readPage, savePage };
};
