import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { NOT_PAGES, PROPOSALS_DIR } from './knowledge-rules.ts';

/**
 * The approved copy of the knowledge a worker gets.
 *
 * Every change the owner makes or approves (a page edit, a promote, a merge, an undo, accepting a hand edit) goes
 * through the knowledge and proposals services, and each of them records the files it wrote here, in
 * `backups/knowledge/approved/`. Briefs are built from `knowledge/` only while it matches this copy. A file that
 * changed any other way (a worker editing `index.md` in a thread, a script, an editor) is drift: briefs fall back to
 * the approved copy and say so, until the owner accepts or restores it in the app.
 *
 * What this catches: a worker that was talked into editing knowledge, and the owner's own hand edits, which they
 * accept in one click. What it doesn't: a worker determined to rewrite this copy too. That needs the worker kept out
 * of the profile folder altogether, which Serra can't do yet. Workers open pages from a snapshot of this copy.
 */
export interface KnowledgeDrift {
  /** Tracked files whose text differs from the approved copy, or that the approved copy doesn't have. */
  changed: string[];
  /** Files the approved copy has that are gone from `knowledge/`. */
  removed: string[];
}

/**
 * Next to `knowledge/` in the profile (`.knowledge-approved/`), outside it and outside the backups undo lists. Named
 * after the folder, so two knowledge folders side by side never share one.
 */
export const approvedDir = (knowledgeDir: string): string => {
  const root = resolve(knowledgeDir);
  return join(dirname(root), `.${basename(root)}-approved`);
};

/** Files that shape a brief: the index and every page. Not proposals, the log or READMEs, which workers may write. */
const isTracked = (path: string): boolean => path === 'index.md' || (
  path.endsWith('.md') && !NOT_PAGES.has(path) && !path.endsWith('README.md') && !path.startsWith(`${PROPOSALS_DIR}/`));

const markdown = (root: string, relativeDir = ''): string[] => {
  const dir = join(root, relativeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return path === PROPOSALS_DIR ? [] : markdown(root, path);
    return entry.isFile() && isTracked(path) ? [path] : [];
  });
};

export const createJournal = (knowledgeDir: string) => {
  const root = resolve(knowledgeDir);
  const approved = approvedDir(root);
  const read = (base: string, path: string): string | null => {
    const file = join(base, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };

  /** True once the approved copy exists. */
  const seeded = (): boolean => existsSync(approved);

  /**
   * The first time, today's `knowledge/` becomes the approved copy: a profile from before this existed, or a new
   * one. Returns true when it seeded.
   */
  const seed = (): boolean => {
    if (seeded() || !existsSync(root)) return false;
    mkdirSync(approved, { recursive: true, mode: 0o700 });
    for (const path of markdown(root)) {
      mkdirSync(dirname(join(approved, path)), { recursive: true });
      cpSync(join(root, path), join(approved, path));
    }
    return true;
  };

  /**
   * Record what the owner just approved: each file's exact text as Serra wrote it (null: removed). Never a fresh read,
   * so an editor saving between Serra's write and this record can't slip its text in as approved.
   */
  const record = (files: { path: string; text: string | null }[]): void => {
    seed();
    for (const { path, text } of files.filter(({ path }) => isTracked(path))) {
      const target = join(approved, path);
      if (text === null) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileAtomic(target, text);
      }
    }
  };

  const drift = (): KnowledgeDrift => {
    if (!seeded()) return { changed: [], removed: [] };
    const onDisk = markdown(root);
    const inApproved = markdown(approved);
    return {
      changed: onDisk.filter((path) => read(root, path) !== read(approved, path)).sort(),
      removed: inApproved.filter((path) => !onDisk.includes(path)).sort(),
    };
  };

  /** The approved text of a tracked file, or null when it has none. */
  const approvedText = (path: string): string | null => (seeded() ? read(approved, path) : read(root, path));

  /** Each drifted file with its approved text and its text on disk now (null: not there). */
  const details = (): { path: string; approved: string | null; current: string | null }[] => {
    const { changed, removed } = drift();
    return [...changed, ...removed].sort().map((path) => ({ path, approved: approvedText(path), current: read(root, path) }));
  };

  /** The owner made this change: the file as they reviewed it (`current`) becomes approved. Refused if it moved since. */
  const accept = (path: string, current: string | null): void => {
    const entry = details().find((item) => item.path === path);
    if (!entry) throw new Error(`${path} hasn't changed outside Serra.`);
    if (entry.current !== current) throw new Error(`${path} changed again since you reviewed it. Look at it again.`);
    if (path === 'index.md' && current === null) throw new Error('index.md is required. Restore it instead.');
    // The text the owner reviewed becomes approved, not a fresh read: a save in between stays a change to review.
    const target = join(approved, path);
    if (current === null) rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileAtomic(target, current);
    }
  };

  /** Put the approved copy back over drifted files (all of them, or `only`). Returns what each held before, for undo. */
  const restore = (only?: string[]): { path: string; before: string | null; after: string | null }[] => {
    const { changed, removed } = drift();
    return [...changed, ...removed].filter((path) => !only || only.includes(path)).map((path) => {
      const before = read(root, path);
      const after = read(approved, path);
      const file = join(root, path);
      if (after === null) rmSync(file, { force: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileAtomic(file, after, { mode: 0o644 });
      }
      return { path, before, after };
    });
  };

  return { seed, seeded, record, drift, details, approvedText, accept, restore, approvedRoot: approved };
};
