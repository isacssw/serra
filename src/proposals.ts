import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from './config.ts';
import type { Proposal, ProposalDiff, ProposalSource } from './contracts.ts';
import { approvalAudience, type Audience } from './owner-model.ts';
import { insideKnowledge, knowledgePagePath, offlimitsBudgetAfter } from './knowledge.ts';
import { createJournal } from './knowledge-journal.ts';
import { withKnowledgeLock } from './knowledge-lock.ts';
import { isArrayOf, isBoolean, isOneOf, isOptional, isRecord, isString, isStringOrNull, readJsonFile, readJsonOrNull } from './lib/guards.ts';
import { alignHeader, DATE, frontmatter, INDEX_MAX_LINES, isOfflimits, lineCount, NOT_PAGES, pageProblems, PROPOSALS_DIR, removeHeaderField, setHeaderField } from './knowledge-rules.ts';

/**
 * The owner's review queue for `knowledge/proposals/`: list, read, promote, merge, discard and undo.
 *
 * Every change first writes a backup (the before and after text of each file it touches) under the profile's
 * `backups/knowledge/`, outside `knowledge/` so `pnpm knowledge` never mistakes a backup for a page. The backup's ID
 * is what `undoProposalChange` takes, so the app's undo toast and the CLI's `undo` share one path.
 *
 * Promotion is an owner action: only the app calls it. `pnpm bot proposals` lists and shows, and workers never promote.
 */

/** Files in `proposals/` that aren't proposals: the folder's README and the onboarding interview's progress notes. */
const NOT_PROPOSALS = new Set(['README.md', 'onboarding-progress.md']);
/** Leading `YYYY-MM-DD-` of a proposal's file name. */
const DATED_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

export type ProposalAction = 'promote' | 'merge' | 'discard';

/** One file a change touched. `null` means the file did not exist (before) or was removed (after). */
export interface FileChange {
  /** Relative to `knowledge/`. */
  path: string;
  before: string | null;
  after: string | null;
}

/** The file Serra writes in a thread's proposals folder to say who started that thread. Not a proposal. */
const PROPOSAL_SOURCE_FILE = '.from.json';

/** The folder under knowledge/proposals/ a Slack thread's worker writes to. */
export const threadProposalsFolder = (channel: string, threadTs: string): string => `from-slack/${channel}-${threadTs.replace(/\D/g, '-')}`;
export const APP_PROPOSALS_FOLDER = 'from-app';
/** Where a meeting's edits wait, one folder per meeting (meeting-store.ts). */
const MEETING_FOLDER = 'from-meeting';

/** Stamp a proposals folder with who started the thread that writes to it. Written by Serra, before the worker starts. */
export const stampProposalsFolder = (knowledgeDir: string, folder: string, source: ProposalSource): void => {
  const dir = join(knowledgeDir, PROPOSALS_DIR, folder);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, PROPOSAL_SOURCE_FILE), JSON.stringify(source, null, 2) + '\n', { mode: 0o600 });
};

/** What a promote, merge or discard did, and everything `undoProposalChange` needs to reverse it. */
export interface ProposalChange {
  /** Backup ID, the folder name under `backups/knowledge/`. */
  id: string;
  action: ProposalAction;
  at: string;
  /** The proposal's ID, relative to `knowledge/proposals/`. */
  proposal: string;
  /** The page the proposal became (promote) or went into (merge), relative to `knowledge/`. Null for discard. */
  page: string | null;
  files: FileChange[];
  /** Set once the change has been undone; a change is undone at most once. */
  undoneAt?: string;
}

const isFileChange = (value: unknown): value is FileChange =>
  isRecord(value) && isString(value.path) && isStringOrNull(value.before) && isStringOrNull(value.after);

/** A backup's `change.json` with everything undo reads. */
const isProposalChange = (value: unknown): value is ProposalChange =>
  isRecord(value) && isString(value.id) && isOneOf('promote', 'merge', 'discard')(value.action) && isString(value.at)
  && isString(value.proposal) && isStringOrNull(value.page) && isArrayOf(isFileChange)(value.files) && isOptional(isString)(value.undoneAt);

/** A folder's `.from.json` stamp. */
const isProposalSource = (value: unknown): value is ProposalSource =>
  isRecord(value) && isString(value.who) && isBoolean(value.owner) && isOneOf('slack', 'app')(value.via) && isOptional(isString)(value.link);

/** What the owner was shown when they approved: the proposal's text, and which page it changes and its text then. */
export interface Reviewed {
  proposal: string;
  /** The page the screen showed, relative to `knowledge/`, or null when it showed none (a new page). */
  path: string | null;
  /** That page's text as shown, or null when it didn't exist. */
  page: string | null;
}

export interface PromoteOptions {
  /** What the owner reviewed. Required: an approval nobody looked at, or one whose files changed since, is refused. */
  reviewed: Reviewed;
  /** Who may hear the page, as the owner chose when approving. Without it, the proposal's own `audience:` stays. */
  audience?: Audience;
  /** Folder under `knowledge/` the page moves into, like `owner` or `product/billing`. */
  folder: string;
  /** File name in that folder. Defaults to the proposal's name without its date, like `deploys.md`. */
  name?: string;
  /** Index column "When the request". Defaults to the page's description. */
  when?: string;
  /** Index column "What it gives you". Defaults to the page's description. */
  gives?: string;
}

export interface MergeOptions {
  /** What the owner reviewed: the proposal, and the page `into` as the merge dialog showed it. */
  reviewed: Reviewed;
  /** Who may hear the merged page, as the owner chose. Without it, the page keeps what the merged text says. */
  audience?: Audience;
  /** Existing page under `knowledge/` the proposal goes into, like `owner/role.md`. */
  into: string;
  /**
   * The page as it should read after the merge, as the owner edited it. Without it, the proposal must be the whole
   * page for `into` (its `target:` names it), and replaces the page. Either way the proposal's sources are added to
   * the page's `sources` and `verified` is set to today. Nothing is appended: a merge never leaves an old rule
   * beside the one that replaced it.
   */
  text?: string;
}

/** Where a proposal can go: folders to promote into and pages to merge into, both relative to `knowledge/`. */
export interface ProposalTargets {
  /** Every folder under `knowledge/` except `proposals/`, sorted. */
  folders: string[];
  /** Every page (a `.md` that isn't an index, log, README or proposal), sorted. */
  pages: string[];
}

export interface ProposalsOptions {
  /** The profile's `knowledge/` folder. */
  knowledgeDir: string;
  /** Where backups go. Defaults to `backups/knowledge/` next to `knowledge/`, in the profile. */
  backupDir?: string;
  /** Clock, for tests. */
  now?: () => Date;
}

const today = (date: Date): string => date.toISOString().slice(0, 10);

/** A table cell: one line, with `|` escaped so it can't add a column. */
const cell = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');


/** The `- item` lines under a header's `sources:` key. */
const sourceItems = (text: string): string[] => {
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const lines = header.split('\n');
  const start = lines.findIndex((line) => line.startsWith('sources:'));
  if (start === -1) return [];
  const inline = lines[start]!.slice('sources:'.length).trim();
  const items = inline ? [inline.replace(/^-\s*/, '')] : [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) break;
    items.push(item[1] ?? '');
  }
  return items.filter(Boolean);
};

/** The page without its `---` header. */
const body = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n/, '');

/**
 * Who may hear the approved page: the owner's pick, else the default `approvalAudience` works out (a proposal can
 * narrow a page but never widen it, and a new page never starts out shared with outsiders).
 */
const withAudience = (text: string, picked: Audience | undefined, proposed: string, current: string | null): string => {
  const { audience, untagged } = approvalAudience(proposed, current);
  const page = picked ? setHeaderField(text, 'audience', picked) : untagged ? removeHeaderField(text, 'audience') : setHeaderField(text, 'audience', audience);
  // Header fields in the page's own order, so the diff the owner reviewed shows only what changes.
  return alignHeader(page, current);
};

/** The page with its header's `sources` list taken out. */
const withoutSources = (text: string): string => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match?.[1]) return text;
  const lines = match[1].split('\n');
  const start = lines.findIndex((line) => line.startsWith('sources:'));
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && /^\s+-/.test(lines[end]!)) end += 1;
  lines.splice(start, end - start);
  return `---\n${lines.join('\n')}\n---\n${text.slice(match[0].length)}`;
};

/** Add `items` to the header's `sources` list, skipping ones already there. */
const addSources = (text: string, items: string[]): string => {
  const existing = sourceItems(text);
  const added = items.filter((item) => !existing.includes(item));
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (added.length === 0 || !match?.[1]) return text;
  const lines = match[1].split('\n');
  const start = lines.findIndex((line) => line.startsWith('sources:'));
  const all = [...existing, ...added].map((item) => `  - ${item}`);
  if (start === -1) {
    lines.push('sources:', ...all);
  } else {
    let end = start + 1;
    while (end < lines.length && /^\s+-/.test(lines[end]!)) end += 1;
    lines.splice(start, end - start, 'sources:', ...all);
  }
  return `---\n${lines.join('\n')}\n---\n${text.slice(match[0].length)}`;
};

export const createProposals = ({ knowledgeDir, backupDir, now = () => new Date() }: ProposalsOptions) => {
  const root = resolve(knowledgeDir);
  const proposalsRoot = join(root, PROPOSALS_DIR);
  const backups = resolve(backupDir ?? join(dirname(root), 'backups', 'knowledge'));

  const inside = (relativePath: string, what: string): string => insideKnowledge(root, relativePath, what);

  const toKnowledgePath = (absolute: string): string => relative(root, absolute).split(sep).join('/');

  const readText = (relativePath: string): string | null => {
    const absolute = inside(relativePath, 'File');
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  };

  /** Check a proposal ID and return its path relative to `knowledge/`. */
  const proposalPath = (id: string): string => {
    if (!id.endsWith('.md')) throw new Error(`A proposal is a .md file under knowledge/proposals/. Got: ${id}`);
    if (NOT_PROPOSALS.has(basename(id))) throw new Error(`${id} is not a proposal.`);
    const path = toKnowledgePath(inside(`${PROPOSALS_DIR}/${id}`, 'Proposal'));
    if (!path.startsWith(`${PROPOSALS_DIR}/`)) throw new Error(`Proposal is outside knowledge/proposals/: ${id}`);
    if (!existsSync(join(root, path))) throw new Error(`No proposal ${id} in knowledge/proposals/.`);
    return path;
  };

  /** Meeting edits have their own approval call, bound to their evidence (meeting-store.ts): never these. */
  const notFromMeeting = (path: string): string => {
    if (path.startsWith(`${PROPOSALS_DIR}/${MEETING_FOLDER}/`)) throw new Error('This is an edit from a meeting. Approve or discard it in the meeting\'s group in Proposals.');
    return path;
  };

  const pagePath = (relativePath: string, what: string): string => knowledgePagePath(root, relativePath, what);

  /** Who started the thread whose worker wrote proposals in `id`'s folder, as Serra stamped it. */
  const sourceOf = (id: string): ProposalSource | undefined => {
    const folder = dirname(id);
    if (folder === '.') return undefined;
    // A meeting's stub names its meeting and item in its header; the meeting screen checks them against the registry.
    if (folder.startsWith(`${MEETING_FOLDER}/`)) {
      const fields = frontmatter(readFileSync(join(proposalsRoot, id), 'utf8'));
      const meeting = fields?.get('meeting')?.trim();
      const item = fields?.get('item')?.trim();
      return meeting && item ? { who: 'a meeting', owner: false, via: 'meeting', meeting: { id: meeting, item } } : { who: 'unknown', owner: false, via: 'meeting' };
    }
    const stamp = readJsonOrNull(join(proposalsRoot, folder, PROPOSAL_SOURCE_FILE), isProposalSource);
    if (!stamp) return undefined;
    return { who: stamp.who, owner: stamp.owner, via: stamp.via, ...(stamp.link !== undefined ? { link: stamp.link } : {}) };
  };

  const describe = (id: string): Proposal => {
    const text = readFileSync(join(proposalsRoot, id), 'utf8');
    const fields = frontmatter(text);
    const date = DATED_NAME.exec(basename(id))?.[1] ?? null;
    let target: string | null = null;
    let folder: string | undefined;
    const named = fields?.get('target')?.trim();
    if (named) {
      try {
        const path = pagePath(named, 'Target');
        if (existsSync(join(root, path))) target = path;
        else if (dirname(path) !== '.') folder = dirname(path);
      } catch { /* A target outside knowledge/ is ignored; the owner picks one when merging. */ }
    }
    const description = fields?.get('description')?.trim();
    const from = sourceOf(id);
    return {
      path: id, date: date && DATE.test(date) ? date : null, ...(description ? { description } : {}), target, ...(folder ? { folder } : {}), ...(from ? { from } : {}),
    };
  };

  const proposalIds = (relativeDir = ''): string[] => {
    const dir = join(proposalsRoot, relativeDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const id = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return proposalIds(id);
      return entry.name.endsWith('.md') && !NOT_PROPOSALS.has(entry.name) ? [id] : [];
    });
  };

  /**
   * Refuse an approval unless the owner saw exactly what it would apply: the proposal's text, and the page it
   * replaces or merges into, as they are now. A worker or an editor that changes either in between makes the owner
   * look again. Approving also never writes over a file that changed outside Serra: that is reviewed in Pages first.
   */
  const checkReviewed: (source: string, reviewed: Reviewed | undefined, page: string | null, current: string | null) => asserts reviewed is Reviewed = (source, reviewed, page, current) => {
    if (!reviewed) throw new Error('Review the proposal in the app before approving it.');
    if (readText(source) !== reviewed.proposal) throw new Error('The proposal changed since you reviewed it. Look at it again, then approve it.');
    // The page the screen showed is the one this approval writes, and it still reads (or is still missing) as shown.
    // A page the owner didn't see must not exist: approving never writes over text nobody reviewed.
    if (reviewed.path === page ? current !== reviewed.page : current !== null) {
      throw new Error(`${page} changed since you reviewed this proposal. Look at the refreshed diff, then approve it again.`);
    }
  };
  const checkNoDrift = (paths: string[]): void => {
    const { changed, removed } = journal.drift();
    const drifted = paths.filter((path) => changed.includes(path) || removed.includes(path));
    if (drifted.length) {
      throw new Error(`${drifted.join(', ')} changed outside Serra. Accept or restore ${drifted.length === 1 ? 'it' : 'them'} in Knowledge › Pages first.`);
    }
  };

  /** Every proposal waiting for the owner, newest date first, undated ones last. */
  const listProposals = (): Proposal[] =>
    proposalIds().map(describe).sort((a, b) =>
      (b.date ?? '').localeCompare(a.date ?? '') || a.path.localeCompare(b.path));

  /** The proposal's text next to the page it would change (its `target`), or null when it is a new page. */
  const readProposal = (id: string): ProposalDiff => {
    const path = proposalPath(id);
    const proposal = describe(id);
    return {
      proposal,
      current: proposal.target ? readText(proposal.target) : null,
      proposed: readFileSync(join(root, path), 'utf8'),
    };
  };

  /**
   * Write the backup, then apply each file change. The backup goes first so an interrupted change can still be
   * inspected; each file is written atomically.
   */
  const apply = (action: ProposalAction, proposal: string, page: string | null, files: FileChange[]): ProposalChange => {
    const at = now();
    const slug = basename(proposal, '.md').replace(/[^\w-]+/g, '-');
    const id = `${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${action}-${slug}-${randomBytes(3).toString('hex')}`;
    const change: ProposalChange = { id, action, at: at.toISOString(), proposal, page, files };
    mkdirSync(join(backups, id), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(backups, id, 'change.json'), JSON.stringify(change, null, 2) + '\n');
    writeFiles(files.map(({ path, after }) => ({ path, text: after })));
    return change;
  };

  const journal = createJournal(root);

  /** Every change here is the owner's, from the app: what it writes becomes the approved copy briefs are built from. */
  const writeFiles = (files: { path: string; text: string | null }[]): void => {
    journal.seed();
    for (const { path, text } of files) {
      const absolute = inside(path, 'File');
      if (text === null) {
        rmSync(absolute, { force: true });
      } else {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileAtomic(absolute, text, { mode: 0o644 });
      }
    }
    journal.record(files.map(({ path, text }) => ({ path, text })));
  };

  const logLine = (date: string, line: string): FileChange => {
    const before = readText('log.md');
    const base = (before ?? '# Knowledge changes\n').trimEnd();
    return { path: 'log.md', before, after: `${base}\n- ${date}: ${line}\n` };
  };

  /**
   * Move a proposal into `folder` as a confirmed page: set `verified` to today, add its row to `index.md` and a line
   * to `log.md`, and remove it from `proposals/`. A proposal whose `target:` names an existing page in `folder` is
   * the whole page as it should now read (templates/interview.md), so it replaces that page and keeps its index row.
   * Refuses a destination outside `knowledge/`, any other existing page (merge into it instead), a page that would
   * fail `pnpm knowledge`, and an index that would go over its cap. The `target:` line is dropped from the page.
   */
  const promoteProposal = (id: string, { folder, name, when, gives, reviewed, audience }: PromoteOptions): ProposalChange => withKnowledgeLock(root, () => {
    const source = notFromMeeting(proposalPath(id));
    const cleanFolder = folder.trim().replace(/\/+$/, '');
    if (!cleanFolder) throw new Error('Pick a folder under knowledge/ to promote into, like owner.');
    const { target } = describe(id);
    const replacing = target !== null && dirname(target) === cleanFolder && (name === undefined || name === basename(target));
    const fileName = replacing ? basename(target) : name ?? (DATED_NAME.exec(basename(id))?.[2] ?? basename(id));
    if (fileName.includes('/') || fileName.includes('\\')) throw new Error(`The page name is a file name, not a path: ${fileName}`);
    const destination = pagePath(`${cleanFolder}/${fileName}`, 'Target');
    const current = readText(destination);
    if (current !== null && destination !== target) {
      throw new Error(`${destination} already exists. Merge the proposal into it instead.`);
    }
    checkReviewed(source, reviewed, destination, current);
    // Reviewed as a change to a page that is gone now: never fall back to creating some other page instead.
    if (reviewed.path !== null && destination !== reviewed.path && readText(reviewed.path) === null) {
      throw new Error(`You reviewed this proposal as a change to ${reviewed.path}, which is gone now. Look at it again.`);
    }

    const at = today(now());
    // The text the owner reviewed, which checkReviewed found unchanged: not a second read that could differ.
    const proposed = reviewed.proposal;
    const verifiedPage = removeHeaderField(setHeaderField(proposed, 'verified', at), 'target');
    // Replacing a page never quietly changes who may hear it: the owner's pick, else the page's own, else (a new page)
    // the proposal's. A proposal can ask for a wider audience, but only the owner grants it.
    const page = withAudience(verifiedPage, audience, proposed, current);
    const fields = frontmatter(page);
    const budget = isOfflimits(destination, fields) ? offlimitsBudgetAfter(root, destination, page) : null;
    const problems = [...pageProblems(destination, page, fields), ...(budget ? [budget] : [])];
    if (problems.length > 0) throw new Error(`Fix the proposal before promoting it:\n${problems.join('\n')}`);

    const description = fields?.get('description')?.trim() ?? '';
    const indexBefore = readText('index.md');
    if (indexBefore === null) throw new Error('knowledge/index.md is missing.');
    const indexed = current !== null && indexBefore.includes(`\`${destination}\``);
    const row = `| ${cell(when ?? description)} | \`${destination}\` | ${cell(gives ?? description)} |`;
    const indexAfter = indexed ? indexBefore : `${indexBefore.trimEnd()}\n${row}\n`;
    if (lineCount(indexAfter) > INDEX_MAX_LINES) {
      throw new Error(`index.md would be ${lineCount(indexAfter)} lines; the cap is ${INDEX_MAX_LINES}. Merge into an existing page instead.`);
    }

    checkNoDrift([destination, ...(indexed ? [] : ['index.md'])]);
    return apply('promote', id, destination, [
      { path: destination, before: current, after: page },
      ...(indexed ? [] : [{ path: 'index.md', before: indexBefore, after: indexAfter }]),
      logLine(at, current === null
        ? `promoted \`${source}\` to \`${destination}\`, confirmed by the owner in the app.`
        : `replaced \`${destination}\` with \`${source}\`, confirmed by the owner in the app.`),
      { path: source, before: proposed, after: null },
    ]);
  });

  /**
   * Fold a proposal into an existing page and remove it from `proposals/`. Refuses a page outside `knowledge/`,
   * a page that doesn't exist (promote instead), and a result that would fail `pnpm knowledge`.
   */
  const mergeProposal = (id: string, { into, text, reviewed, audience }: MergeOptions): ProposalChange => withKnowledgeLock(root, () => {
    const source = notFromMeeting(proposalPath(id));
    const target = pagePath(into, 'Target');
    const current = readText(target);
    if (current === null) throw new Error(`${target} doesn't exist. Promote the proposal to create it.`);

    const at = today(now());
    const { target: named } = describe(id);
    if (text === undefined && named !== target) {
      throw new Error(`The proposal isn't a whole page for ${target}. Edit the page as it should read, then merge.`);
    }
    checkReviewed(source, reviewed, target, current);
    const proposed = reviewed.proposal;
    // The merge dialog's starting text keeps both the old page and the proposal: merging it unchanged is the old append.
    if (text !== undefined && named !== target && text.trim() === `${current.trimEnd()}\n\n${body(proposed).trim()}`.trim()) {
      throw new Error(`Edit ${target} into one page before merging: as it is, it keeps the old text with the proposal below it.`);
    }
    const page = text ?? removeHeaderField(proposed, 'target');
    // The page keeps where every rule came from: the old page's sources, then the new text's and the proposal's.
    const sources = [...new Set([...sourceItems(current), ...sourceItems(page), ...sourceItems(proposed)])];
    const withSources = setHeaderField(addSources(withoutSources(page.endsWith('\n') ? page : `${page}\n`), sources), 'verified', at);
    // A merge never quietly changes who may hear the page: the owner's pick, else the page's own, else the merged text's.
    const merged = withAudience(withSources, audience, proposed, current);
    const budget = isOfflimits(target, frontmatter(merged)) ? offlimitsBudgetAfter(root, target, merged) : null;
    const problems = [...pageProblems(target, merged, frontmatter(merged)), ...(budget ? [budget] : [])];
    if (problems.length > 0) throw new Error(`The merged page would fail the knowledge check:\n${problems.join('\n')}`);

    checkNoDrift([target]);
    return apply('merge', id, target, [
      { path: target, before: current, after: merged },
      logLine(at, `merged \`${source}\` into \`${target}\`, confirmed by the owner in the app.`),
      { path: source, before: proposed, after: null },
    ]);
  });

  /** Remove a proposal without using it. The backup keeps its text for undo. */
  const discardProposal = (id: string): ProposalChange => withKnowledgeLock(root, () => {
    const source = notFromMeeting(proposalPath(id));
    return apply('discard', id, null, [{ path: source, before: readFileSync(join(root, source), 'utf8'), after: null }]);
  });

  const readChange = (changeId: string): ProposalChange => {
    if (!/^[\w.-]+$/.test(changeId)) throw new Error(`Not a backup ID: ${changeId}`);
    const file = join(backups, changeId, 'change.json');
    const change = readJsonFile(file, isProposalChange);
    if (change.state === 'absent') throw new Error(`No backup ${changeId} in ${backups}.`);
    if (change.state === 'invalid') throw new Error(`Backup ${changeId} can't be read: ${file} isn't a change record. Restore by hand from it.`);
    return change.value;
  };

  /**
   * Reverse a promote, merge or discard from its backup: every file goes back to its text from before the change.
   * Refuses when a file has changed since (say the promoted page was edited), so undo never loses newer work.
   */
  const undoProposalChange = (changeId: string): ProposalChange => withKnowledgeLock(root, () => {
    const change = readChange(changeId);
    if (change.undoneAt) throw new Error(`${changeId} was already undone at ${change.undoneAt}.`);
    checkNoDrift(change.files.map(({ path }) => path));
    const changed = change.files.filter(({ path, after }) => readText(path) !== after).map(({ path }) => path);
    if (changed.length > 0) {
      throw new Error(`Can't undo: changed since then: ${changed.join(', ')}. Restore by hand from ${join(backups, changeId, 'change.json')}.`);
    }
    writeFiles([...change.files].reverse().map(({ path, before }) => ({ path, text: before })));
    const undone = { ...change, undoneAt: now().toISOString() };
    writeFileAtomic(join(backups, changeId, 'change.json'), JSON.stringify(undone, null, 2) + '\n');
    return undone;
  });

  /** The folders a proposal can be promoted into and the pages it can be merged into, for the app's pickers. */
  const listTargets = (): ProposalTargets => {
    const folders: string[] = [];
    const pages: string[] = [];
    const walk = (relativeDir: string): void => {
      for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (path === PROPOSALS_DIR) continue;
          folders.push(path);
          walk(path);
        } else if (entry.isFile() && entry.name.endsWith('.md') && !NOT_PAGES.has(path) && entry.name !== 'README.md') {
          pages.push(path);
        }
      }
    };
    if (existsSync(root)) walk('');
    return { folders: folders.sort(), pages: pages.sort() };
  };

  return {
    listProposals, readProposal, listTargets, promoteProposal, mergeProposal, discardProposal, undoProposalChange,
    /** The ticket's name for undo. It reverses merges and discards too. */
    undoPromotion: undoProposalChange,
  };
};
