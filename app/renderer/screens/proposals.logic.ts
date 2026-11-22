// The Proposals screen's logic: grouping the queue by date, titles, and the side-by-side diff line model.
// Pure data and functions: imported by `node --test` as well as the renderer.
import type { Proposal } from '../../../src/contracts.ts';
import type { Action } from '../commands/registry.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-19` → `Nov 19`, read as a calendar date (no time zone shift). Null or malformed → `Undated`. */
export const dateLabel = (date: string | null): string => {
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[3])}` : 'Undated';
};

export interface ProposalGroup {
  /** `YYYY-MM-DD`, or null for proposals without a date in their name. */
  date: string | null;
  label: string;
  proposals: Proposal[];
}

/** The queue grouped by date, newest first, undated last. Order inside a group follows the input. */
export const groupByDate = (proposals: readonly Proposal[]): ProposalGroup[] => {
  const groups = new Map<string | null, Proposal[]>();
  for (const proposal of proposals) {
    const list = groups.get(proposal.date);
    if (list) list.push(proposal);
    else groups.set(proposal.date, [proposal]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b.localeCompare(a)))
    .map(([date, list]) => ({ date, label: dateLabel(date), proposals: list }));
};

/** A proposal's title: its file name without folder, date and `.md`, in words (`2026-11-19-ci-rerun.md` → `Ci rerun`). */
export const proposalTitle = (proposal: Pick<Proposal, 'path'>): string => {
  const name = (proposal.path.split('/').pop() ?? proposal.path)
    .replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/[-_]+/g, ' ').trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : proposal.path;
};

export const pendingLabel = (count: number): string => (count === 0 ? 'Nothing waiting' : `${count} pending`);

/** The folder a page lives in, or null for a page at the top of `knowledge/`. */
export const folderOf = (page: string): string | null => {
  const slash = page.lastIndexOf('/');
  return slash > 0 ? page.slice(0, slash) : null;
};

/** `runbooks/ci` → `Runbooks / ci`, for the folder picker. */
export const folderLabel = (folder: string): string =>
  folder.split('/').map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join(' / ');

/**
 * The folder the picker starts on: the target page's folder when it has one and it exists, then the folder a new
 * page's `target:` names (APP-26), else the first folder.
 */
export const defaultFolder = (proposal: Pick<Proposal, 'target' | 'folder'>, folders: readonly string[]): string | null => {
  const own = proposal.target ? folderOf(proposal.target) : null;
  if (own && folders.includes(own)) return own;
  if (proposal.folder) return proposal.folder;
  return folders[0] ?? null;
};

/** The picker's folders: the existing ones plus the new folder a proposal names, which promoting creates. */
export const folderChoices = (proposal: Pick<Proposal, 'folder'>, folders: readonly string[]): string[] =>
  proposal.folder && !folders.includes(proposal.folder) ? [...folders, proposal.folder].sort() : [...folders];

/** Which proposal to show after one leaves the queue: the next one in order, else the one before, else none. */
export const nextSelection = (proposals: readonly Proposal[], removed: string): string | null => {
  const index = proposals.findIndex((proposal) => proposal.path === removed);
  const rest = proposals.filter((proposal) => proposal.path !== removed);
  if (rest.length === 0) return null;
  return (rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? rest[0]!).path;
};

// ---------------------------------------------------------------------------------------------------------------
// Diff line model
// ---------------------------------------------------------------------------------------------------------------

type DiffKind = 'same' | 'removed' | 'added';

/** One side of a diff row: a line number (1-based in its own text), the line and whether it changed. */
export interface DiffCell { number: number; text: string; kind: DiffKind }

/** One row of the side-by-side view. A side is null where the other side has a line with no counterpart. */
export interface DiffRow { current: DiffCell | null; proposed: DiffCell | null }

/** Above this many line pairs the diff gives up on matching and shows every line as changed, to stay fast. */
const MAX_CELLS = 4_000_000;

const splitLines = (text: string | null): string[] => {
  if (text === null) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

type Op = { kind: DiffKind; line: string };

/** A line-level diff from the longest common subsequence. Removals come before additions in each changed run. */
const diffOps = (a: string[], b: string[]): Op[] => {
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((line) => ({ kind: 'removed' as const, line })), ...b.map((line) => ({ kind: 'added' as const, line }))];
  }
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', line: a[i]! }); i += 1; j += 1; }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) { ops.push({ kind: 'removed', line: a[i]! }); i += 1; }
    else { ops.push({ kind: 'added', line: b[j]! }); j += 1; }
  }
  while (i < a.length) ops.push({ kind: 'removed', line: a[i++]! });
  while (j < b.length) ops.push({ kind: 'added', line: b[j++]! });
  return ops;
};

/**
 * The side-by-side rows for the current page (null when the proposal is a new page) and the proposed text.
 * Unchanged lines sit on one row; in a changed run the removed and added lines are paired up row by row, and the
 * longer side continues with the other side empty.
 */
export const diffRows = (current: string | null, proposed: string): DiffRow[] => {
  const ops = diffOps(splitLines(current), splitLines(proposed));
  const rows: DiffRow[] = [];
  let left = 0;
  let right = 0;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.kind === 'same') {
      left += 1; right += 1;
      rows.push({ current: { number: left, text: op.line, kind: 'same' }, proposed: { number: right, text: op.line, kind: 'same' } });
      k += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (k < ops.length && ops[k]!.kind === 'removed') removed.push(ops[k++]!.line);
    while (k < ops.length && ops[k]!.kind === 'added') added.push(ops[k++]!.line);
    for (let n = 0; n < Math.max(removed.length, added.length); n += 1) {
      const was = removed[n];
      const now = added[n];
      rows.push({
        current: was === undefined ? null : { number: ++left, text: was, kind: 'removed' },
        proposed: now === undefined ? null : { number: ++right, text: now, kind: 'added' },
      });
    }
  }
  return rows;
};

/** How many lines each side changed, for the diff header. */
export const diffStats = (rows: readonly DiffRow[]): { removed: number; added: number } => ({
  removed: rows.filter((row) => row.current?.kind === 'removed').length,
  added: rows.filter((row) => row.proposed?.kind === 'added').length,
});

/** The toast once the knowledge interview started (APP-26). */
export const interviewStartedText = (task: { branch: string }): string =>
  `Interview started in T3 on ${task.branch}. What you confirm there shows up here.`;

// ---------------------------------------------------------------------------------------------------------------
// ⌘K (APP-16): the screen's own action, registered by Proposals.tsx
// ---------------------------------------------------------------------------------------------------------------

/** `?proposal=<path>` on the Proposals route selects that proposal. */
export const PROPOSAL_PARAM = 'proposal';
const PROPOSALS_PATH = '/knowledge/proposals';

/**
 * Picks a waiting proposal and opens it on the Proposals screen, where its diff shows next to Promote. The palette
 * is a shortcut to that button, so it never promotes a page the owner hasn't seen.
 */
export const promoteProposalAction: Action = {
  id: 'proposals:promote',
  title: 'Promote proposal…',
  group: 'Actions',
  keywords: ['knowledge', 'proposal', 'review', 'merge', 'discard', 'page'],
  button: 'Knowledge › Proposals › Promote',
  argument: {
    placeholder: 'Proposal to review',
    hint: 'Opens it on Proposals with its changes, ready to promote.',
    choices: async (context) => {
      if (!context.bridge) return [];
      return (await context.bridge.proposals.list()).map((proposal) => ({
        value: proposal.path,
        label: proposalTitle(proposal),
        detail: proposal.target ? `changes ${proposal.target}` : dateLabel(proposal.date),
      }));
    },
  },
  run: (context, value = '') => {
    if (!value.trim()) throw new Error('Pick a proposal.');
    context.navigate(`${PROPOSALS_PATH}?${PROPOSAL_PARAM}=${encodeURIComponent(value)}`);
  },
};

/** A proposal as the page it would become: its `target:` line is for the queue, not the page. */
export const withoutTarget = (text: string): string => text.replace(/^(---\n[\s\S]*?)^target:.*\n([\s\S]*?\n---\n)/m, '$1$2');

/** A proposal's text without its header, to place under a page the owner is merging it into. */
export const proposalBody = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
