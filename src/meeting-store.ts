// What a meeting leaves behind and how the owner approves it (SERRA-62).
//
// - `meeting-registry.json` (profile, 0600): every meeting, its items' status, the pages it touched, the text it
//   derived (a new page's index row), its digest message, and the meetings being forgotten. Written only under the
//   knowledge lock.
// - `meeting-evidence/<id>.json` (profile, outside knowledge/, 0600): each pending item's edit, quote and context
//   turns. Removed item by item as the owner approves or discards, and whole on Discard or Forget meeting, or after
//   30 days.
// - `knowledge/proposals/from-meeting/<id>/<item>.md`: one stub per pending item, so the queue and its badge see it.
//   No `target:` line, so the general proposal screens never diff it against a page; the meeting screen renders the
//   real edit from the evidence, against the page as it is now.
//
// Approval is one call per item, bound to what the owner saw (hashes of the rendered page, the page before, and the
// evidence), with a pending → committed record so a crash mid-approval rolls back before anything reads knowledge.
// Forget meeting removes every line the meeting added from pages, the approved copy, every backup and every
// snapshot, and can't be undone.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { createJournal } from './knowledge-journal.ts';
import { processAlive, withKnowledgeLock } from './knowledge-lock.ts';
import { frontmatter, INDEX_MAX_LINES, lineCount, pageProblems, PROPOSALS_DIR } from './knowledge-rules.ts';
import type { CheckedItem, ReplyLine } from './meeting-digest.ts';
import { applyEdit, audienceLine, decisionBullets, indexRow, MEETING_ID, mentionsMeeting, newDecisionPage, newPageDescription, scrubMeeting, type MeetingStamp } from './meeting-page.ts';
import { hasSecret } from './meeting-transcript.ts';

export const MEETING_PROPOSALS = 'from-meeting';
export const REGISTRY_FILE = 'meeting-registry.json';
export const EVIDENCE_DIR = 'meeting-evidence';
/** Unapproved meeting proposals and their evidence expire: the evidence holds verbatim quotes. */
export const PENDING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MeetingSourceKind = 'upload' | 'paste' | 'granola' | 'google-meet';
export type ItemStatus = 'pending' | 'approved' | 'discarded' | 'expired';

export interface MeetingItemRecord {
  status: ItemStatus;
  target: string;
  /** sha256 of the item's evidence entry, as written. An entry that doesn't match can't be approved. */
  evidence: string;
  /** The page's approved text hash when the meeting was read, or null for a new page. */
  targetAt: string | null;
  /** The backup an approval wrote, for undo. */
  backupId?: string;
  at?: string;
}

export interface MeetingRecord {
  id: string;
  title: string;
  date: string;
  source: MeetingSourceKind;
  createdAt: string;
  /** `forgetting`: Forget started; the digest message still has to be deleted (by the daemon) and nothing may approve. */
  state: 'open' | 'forgetting' | 'forgotten';
  items: Record<string, MeetingItemRecord>;
  /** Pages an approval changed. */
  pages: string[];
  /** Text the meeting's approvals derived (a new page's index row and description), for Forget to scrub. */
  derived: string[];
  /** Serra's digest message in the owner's DM, for Forget to delete. */
  digest?: { channel: string; ts: string };
  /** Speakers as named in the transcript, for the review screen. */
  speakers: string[];
  /** Counts for the review screen and the reply. */
  dropped: Record<string, number>;
}

interface PendingApproval { meeting: string; item: string; backupId: string; pid: number; at: string; stub: string | null }

interface Registry {
  version: 1;
  meetings: Record<string, MeetingRecord>;
  /** Meetings forgotten: their tags must never come back. */
  revoked: string[];
  pending?: PendingApproval;
}

interface EvidenceFile {
  id: string;
  meeting: MeetingStamp;
  items: Record<string, CheckedItem>;
}

/** What the owner reviewed, as hashes: the page after the edit, the page before (null: new), the item's evidence. */
export interface MeetingReviewed { rendered: string; page: string | null; evidence: string }

/** One item as the review screen shows it, rendered from the evidence against the page as it is now. */
export interface MeetingItemView {
  id: string;
  status: ItemStatus;
  kind: CheckedItem['kind'];
  text: string;
  target: string;
  newPage: boolean;
  op: 'add' | 'replace';
  old?: string;
  quote: string;
  context: CheckedItem['context'];
  /** The page now, and after the edit. Null `after` with a `problem` when it can't be applied. */
  before: string | null;
  after: string | null;
  problem: string | null;
  /** The page changed since the meeting was read: the screen says so above the diff. */
  wholePage: boolean;
  reviewed: MeetingReviewed | null;
}

export interface MeetingView {
  id: string;
  title: string;
  date: string;
  source: MeetingSourceKind;
  createdAt: string;
  speakers: string[];
  state: MeetingRecord['state'];
  dropped: Record<string, number>;
  items: MeetingItemView[];
  /** Pages approvals changed, for Forget's confirmation. */
  pages: string[];
}

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface MeetingStoreOptions {
  knowledgeDir: string;
  now?: () => Date;
  backupDir?: string;
}

export const createMeetingStore = ({ knowledgeDir, now = () => new Date(), backupDir }: MeetingStoreOptions) => {
  const root = resolve(knowledgeDir);
  const profile = dirname(root);
  const registryPath = join(profile, REGISTRY_FILE);
  const evidenceDir = join(profile, EVIDENCE_DIR);
  const stubsRoot = join(root, PROPOSALS_DIR, MEETING_PROPOSALS);
  const backups = resolve(backupDir ?? join(profile, 'backups', 'knowledge'));
  const journal = createJournal(root);
  const locked = <T>(work: () => T): T => withKnowledgeLock(root, work);
  const today = (): string => now().toISOString().slice(0, 10);

  const readRegistry = (): Registry => {
    if (!existsSync(registryPath)) return { version: 1, meetings: {}, revoked: [] };
    const value = JSON.parse(readFileSync(registryPath, 'utf8')) as Registry;
    return { version: 1, meetings: value.meetings ?? {}, revoked: value.revoked ?? [], ...(value.pending ? { pending: value.pending } : {}) };
  };
  const writeRegistry = (registry: Registry): void => writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });

  const checkId = (id: string): void => { if (!MEETING_ID.test(id)) throw new Error(`Not a meeting ID: ${id}`); };
  const evidencePath = (id: string): string => { checkId(id); return join(evidenceDir, `${id}.json`); };
  const readEvidence = (id: string): EvidenceFile | null => {
    const path = evidencePath(id);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as EvidenceFile : null;
  };
  const writeEvidence = (evidence: EvidenceFile): void => {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    if (Object.keys(evidence.items).length === 0) rmSync(evidencePath(evidence.id), { force: true });
    else writeFileAtomic(evidencePath(evidence.id), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  };
  const itemHash = (item: CheckedItem): string => sha(JSON.stringify(item));

  const stubPath = (id: string, item: string): string => join(stubsRoot, id, `${item}.md`);
  const stubText = (meeting: MeetingStamp, item: CheckedItem): string => [
    '---',
    'via: meeting',
    `meeting: ${meeting.id}`,
    `item: ${item.id}`,
    `description: ${item.edit.text}`,
    '---',
    item.newPage ? `New page \`${item.target}\`, under Decisions: ${item.edit.text}` : item.edit.op === 'replace'
      ? `In \`${item.target}\`, under Decisions, replace "${item.edit.old}" with: ${item.edit.text}`
      : `Add to \`${item.target}\`, under Decisions: ${item.edit.text}`,
    '',
    `From the meeting "${meeting.title}" on ${meeting.date}. Review it in Knowledge › Proposals.`,
    '',
  ].join('\n');

  const read = (path: string): string | null => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
  const writeFiles = (files: { path: string; text: string | null }[]): void => {
    journal.seed();
    for (const { path, text } of files) {
      const absolute = join(root, path);
      if (text === null) rmSync(absolute, { force: true });
      else { mkdirSync(dirname(absolute), { recursive: true }); writeFileAtomic(absolute, text, { mode: 0o644 }); }
    }
    journal.record(files);
  };

  /**
   * Roll back an approval a crash left half done, from its backup. Runs before anything reads knowledge: at daemon
   * start, and whenever the app opens Pages or Proposals. A live holder's approval is never touched.
   */
  const recover = (): boolean => locked(() => {
    const registry = readRegistry();
    const pending = registry.pending;
    if (!pending || (pending.pid !== process.pid && processAlive(pending.pid))) return false;
    const changePath = join(backups, pending.backupId, 'change.json');
    if (existsSync(changePath)) {
      const change = JSON.parse(readFileSync(changePath, 'utf8')) as { files: { path: string; before: string | null }[] };
      writeFiles(change.files.map(({ path, before }) => ({ path, text: before })));
      rmSync(join(backups, pending.backupId), { recursive: true, force: true });
    }
    if (pending.stub !== null) {
      const stub = stubPath(pending.meeting, pending.item);
      mkdirSync(dirname(stub), { recursive: true });
      writeFileAtomic(stub, pending.stub, { mode: 0o644 });
    }
    delete registry.pending;
    writeRegistry(registry);
    return true;
  });

  /**
   * Record a checked meeting: evidence, one stub per item, and the registry entry. Returns the meeting's record.
   * `pages` are the approved texts the items were checked against, so an approval can tell the page moved since.
   */
  const addMeeting = ({ meeting, items, source, speakers, dropped, pages }: {
    meeting: MeetingStamp; items: CheckedItem[]; source: MeetingSourceKind; speakers: string[]; dropped: Record<string, number>; pages: Map<string, string>;
  }): MeetingRecord => locked(() => {
    checkId(meeting.id);
    const registry = readRegistry();
    if (registry.meetings[meeting.id] || registry.revoked.includes(meeting.id)) throw new Error(`Meeting ${meeting.id} already exists.`);
    const evidence: EvidenceFile = { id: meeting.id, meeting, items: Object.fromEntries(items.map((item) => [item.id, item])) };
    writeEvidence(evidence);
    for (const item of items) {
      mkdirSync(join(stubsRoot, meeting.id), { recursive: true, mode: 0o700 });
      writeFileAtomic(stubPath(meeting.id, item.id), stubText(meeting, item), { mode: 0o644 });
    }
    const record: MeetingRecord = {
      id: meeting.id, title: meeting.title, date: meeting.date, source, createdAt: now().toISOString(), state: 'open',
      items: Object.fromEntries(items.map((item) => [item.id, {
        status: 'pending' as const, target: item.target, evidence: itemHash(item), targetAt: pages.has(item.target) ? sha(pages.get(item.target)!) : null,
      }])),
      pages: [], derived: [], speakers: speakers.slice(0, 12), dropped,
    };
    registry.meetings[meeting.id] = record;
    writeRegistry(registry);
    return record;
  });

  /** Remember the digest message Serra posted for a meeting, so Forget can delete it. */
  const setDigest = (id: string, digest: { channel: string; ts: string }): void => locked(() => {
    const registry = readRegistry();
    const record = registry.meetings[id];
    if (!record) return;
    record.digest = digest;
    writeRegistry(registry);
  });

  /** The page an item edits, and what it would read after, rendered now. */
  const render = (record: MeetingRecord, item: CheckedItem, meeting: MeetingStamp): { before: string | null; after: string | null; problem: string | null; wholePage: boolean } => {
    const { changed, removed } = journal.drift();
    if (changed.includes(item.target) || removed.includes(item.target)) {
      return { before: read(item.target), after: null, problem: `${item.target} changed outside Serra. Accept or restore it in Knowledge › Pages first.`, wholePage: false };
    }
    const before = read(item.target);
    if (before === null) {
      if (!item.newPage) return { before, after: null, problem: `${item.target} is gone. Discard this edit.`, wholePage: false };
      return { before, after: newDecisionPage(item.newPage.topic, { ...item.edit, op: 'add' }, meeting, today()), problem: null, wholePage: false };
    }
    if (audienceLine(before) !== 'team') return { before, after: null, problem: `${item.target} isn't shared with your team any more, so a meeting can't change it. Discard this edit.`, wholePage: false };
    // A page that moved since the meeting was read is still fine to edit: the diff shows the page as it is now.
    const applied = applyEdit(before, item.newPage ? { ...item.edit, op: 'add' } : item.edit, meeting);
    if ('problem' in applied) return { before, after: null, problem: applied.problem, wholePage: false };
    const targetAt = record.items[item.id]?.targetAt ?? null;
    return { before, after: applied.text, problem: null, wholePage: targetAt !== null && targetAt !== sha(before) };
  };

  const view = (record: MeetingRecord, evidence: EvidenceFile | null): MeetingView => ({
    id: record.id, title: record.title, date: record.date, source: record.source, createdAt: record.createdAt, speakers: record.speakers,
    state: record.state, dropped: record.dropped, pages: record.pages,
    items: Object.entries(record.items).flatMap(([itemId, entry]) => {
      const item = evidence?.items[itemId];
      if (!item) return [];
      const rendered = entry.status === 'pending' && record.state === 'open' ? render(record, item, evidence.meeting) : { before: null, after: null, problem: null, wholePage: false };
      const evidenceOk = itemHash(item) === entry.evidence && existsSync(stubPath(record.id, itemId));
      return [{
        id: itemId, status: entry.status, kind: item.kind, text: item.edit.text, target: item.target, newPage: Boolean(item.newPage) && rendered.before === null,
        op: item.edit.op, ...(item.edit.old ? { old: item.edit.old } : {}), quote: item.quote, context: item.context,
        before: rendered.before, after: rendered.after,
        problem: evidenceOk ? rendered.problem : 'This edit was changed outside Serra, so it can only be discarded.',
        wholePage: rendered.wholePage,
        reviewed: rendered.after !== null && evidenceOk ? { rendered: sha(rendered.after), page: rendered.before === null ? null : sha(rendered.before), evidence: entry.evidence } : null,
      }];
    }),
  });

  /** Meetings with something to review, newest first. Recovery runs first. */
  const listMeetings = (): MeetingView[] => {
    recover();
    const registry = readRegistry();
    return Object.values(registry.meetings)
      .filter((record) => record.state === 'open' && Object.values(record.items).some((item) => item.status === 'pending'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => view(record, readEvidence(record.id)));
  };

  /** Every meeting Serra kept anything from, for Forget meeting. */
  const history = (): Pick<MeetingView, 'id' | 'title' | 'date' | 'source' | 'createdAt' | 'pages' | 'state'>[] => {
    const registry = readRegistry();
    return Object.values(registry.meetings).filter((record) => record.state !== 'forgotten')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, title, date, source, createdAt, pages, state }) => ({ id, title, date, source, createdAt, pages, state }));
  };

  const pendingItem = (registry: Registry, id: string, itemId: string): { record: MeetingRecord; entry: MeetingItemRecord } => {
    const record = registry.meetings[id];
    if (!record) throw new Error('Serra has no record of this meeting, so its edits can only be discarded.');
    if (record.state !== 'open') throw new Error('This meeting is being forgotten.');
    const entry = record.items[itemId];
    if (!entry) throw new Error(`No edit ${itemId} in this meeting.`);
    if (entry.status !== 'pending') throw new Error('This edit was already handled.');
    return { record, entry };
  };

  /** Remove one item from the queue: its stub and its evidence. */
  const closeItem = (record: MeetingRecord, itemId: string, status: ItemStatus): void => {
    rmSync(stubPath(record.id, itemId), { force: true });
    record.items[itemId]!.status = status;
    const evidence = readEvidence(record.id);
    if (evidence) { delete evidence.items[itemId]; writeEvidence(evidence); }
    if (!Object.values(record.items).some((item) => item.status === 'pending')) rmSync(join(stubsRoot, record.id), { recursive: true, force: true });
  };

  /**
   * Approve one edit as the owner reviewed it. Under the knowledge lock: refuses an edit whose evidence or stub
   * doesn't match the registry, a page that changed outside Serra, a target that isn't `team` any more, and anything
   * that renders differently from what the owner saw. Writes a backup, marks the approval pending, writes the page
   * (and for a new page, the index row), removes the stub, then marks it committed and drops the item's evidence.
   * Returns the backup ID for undo, which reverts the page and index only.
   */
  const approve = (id: string, itemId: string, reviewed: MeetingReviewed): { undoId: string } => locked(() => {
    recover();
    const registry = readRegistry();
    const { record, entry } = pendingItem(registry, id, itemId);
    const evidence = readEvidence(id);
    const item = evidence?.items[itemId];
    if (!evidence || !item || itemHash(item) !== entry.evidence || item.target !== entry.target || !existsSync(stubPath(id, itemId))) {
      throw new Error('This edit was changed outside Serra, so it can only be discarded.');
    }
    if (!reviewed || reviewed.evidence !== entry.evidence) throw new Error('Review the edit in the app before approving it.');
    const rendered = render(record, item, evidence.meeting);
    if (rendered.problem || rendered.after === null) throw new Error(rendered.problem ?? 'This edit can no longer be applied.');
    if (sha(rendered.after) !== reviewed.rendered || (rendered.before === null ? null : sha(rendered.before)) !== reviewed.page) {
      throw new Error(`${item.target} changed since you looked. Look at the edit again, then approve it.`);
    }
    const after = rendered.after;
    if (hasSecret(item.edit.text)) throw new Error('This edit looks like it holds a secret, so Serra won\'t save it. Discard it.');
    const creating = rendered.before === null;
    const problems = pageProblems(item.target, after, frontmatter(after));
    if (problems.length) throw new Error(`The page would fail the knowledge check:\n${problems.join('\n')}`);
    const files: { path: string; before: string | null; after: string | null }[] = [{ path: item.target, before: rendered.before, after }];
    const derived: string[] = [];
    if (creating) {
      const index = read('index.md');
      if (index === null) throw new Error('knowledge/index.md is missing.');
      const { changed, removed } = journal.drift();
      if (changed.includes('index.md') || removed.includes('index.md')) throw new Error('index.md changed outside Serra. Accept or restore it in Knowledge › Pages first.');
      const row = indexRow(item.target, item.newPage!.topic);
      const indexAfter = index.includes(`\`${item.target}\``) ? index : `${index.trimEnd()}\n${row}\n`;
      if (lineCount(indexAfter) > INDEX_MAX_LINES) throw new Error(`index.md would be over its ${INDEX_MAX_LINES}-line cap. Make room in Pages, then approve.`);
      if (indexAfter !== index) files.push({ path: 'index.md', before: index, after: indexAfter });
      derived.push(row, `description: ${newPageDescription(item.newPage!.topic)}`);
    }
    const log = read('log.md');
    files.push({ path: 'log.md', before: log, after: `${(log ?? '# Knowledge changes\n').trimEnd()}\n- ${today()}: approved meeting ${id} item ${itemId}, confirmed by the owner in the app.\n` });

    const at = now();
    const backupId = `${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-meeting-${id}-${itemId}-${randomBytes(3).toString('hex')}`;
    mkdirSync(join(backups, backupId), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(backups, backupId, 'change.json'), `${JSON.stringify({ id: backupId, action: 'merge', at: at.toISOString(), proposal: `${MEETING_PROPOSALS}/${id}/${itemId}.md`, page: item.target, files }, null, 2)}\n`);
    registry.pending = { meeting: id, item: itemId, backupId, pid: process.pid, at: at.toISOString(), stub: readFileSync(stubPath(id, itemId), 'utf8') };
    writeRegistry(registry);
    writeFiles(files.map(({ path, after: text }) => ({ path, text })));
    closeItem(record, itemId, 'approved');
    entry.backupId = backupId;
    entry.at = at.toISOString();
    if (!record.pages.includes(item.target)) record.pages.push(item.target);
    record.derived.push(...derived.filter((line) => !record.derived.includes(line)));
    delete registry.pending;
    writeRegistry(registry);
    return { undoId: backupId };
  });

  /** Discard one edit: its stub and evidence go, with no backup (the evidence held quotes). */
  const discard = (id: string, itemId: string): void => locked(() => {
    const registry = readRegistry();
    const record = registry.meetings[id];
    // A stub Serra has no record of (written by something else) can still be removed.
    if (!record?.items[itemId]) { checkId(id); rmSync(stubPath(id, itemId), { force: true }); return; }
    if (record.items[itemId]!.status !== 'pending') return;
    closeItem(record, itemId, 'discarded');
    writeRegistry(registry);
  });

  /** Discard every pending edit of a meeting and its evidence. Can't be undone. */
  const discardMeeting = (id: string): void => locked(() => {
    checkId(id);
    const registry = readRegistry();
    const record = registry.meetings[id];
    if (record) {
      for (const [itemId, entry] of Object.entries(record.items)) if (entry.status === 'pending') closeItem(record, itemId, 'discarded');
      writeRegistry(registry);
    }
    rmSync(join(stubsRoot, id), { recursive: true, force: true });
    rmSync(evidencePath(id), { force: true });
  });

  /** Every backup's change.json under the backups folder. */
  const backupFiles = (): string[] => (existsSync(backups) ? readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join(backups, entry.name, 'change.json')).filter((path) => existsSync(path)) : []);

  /** Snapshot folders workers read (`.knowledge-owner/<hash>` and the others) that mention the meeting. */
  const snapshotsWith = (id: string): string[] => {
    const base = dirname(root);
    const name = root.split('/').pop()!;
    const dirs = ['owner', 'team', 'external'].map((audience) => join(base, `.${name}-${audience}`)).filter((dir) => existsSync(dir));
    const mentions = (dir: string): boolean => readdirSync(dir, { withFileTypes: true, recursive: true }).some((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.md')) return false;
      return mentionsMeeting(readFileSync(join(entry.parentPath, entry.name), 'utf8'), id);
    });
    return dirs.flatMap((dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)).filter(mentions));
  };

  /**
   * Forget a meeting: everything it added goes, and can't be undone. First (under the lock) the meeting is marked
   * `forgetting` and its ID revoked, so a crash part way resumes at the next start. Then:
   * - pages: every line tagged with it, under Decisions or Replaced, its `replaced by` notes and `sources:` entries;
   *   a page it created goes with its index row when nothing else is on it;
   * - the approved copy, every backup's before and after text, and every snapshot that mentions it (a running
   *   thread whose snapshot is gone starts fresh on its next turn);
   * - its pending stubs and evidence.
   * The digest message is deleted by the daemon (it holds the bot token); until then the meeting stays `forgetting`.
   */
  const forget = (id: string): { pages: string[]; backups: number; snapshots: number } => locked(() => {
    checkId(id);
    recover();
    const registry = readRegistry();
    const record = registry.meetings[id];
    if (!record) throw new Error(`No meeting ${id}.`);
    if (record.state === 'open') record.state = 'forgetting';
    if (!registry.revoked.includes(id)) registry.revoked.push(id);
    writeRegistry(registry);

    // Pages: scrubbed, or removed with their index row when the meeting created them and nothing else is on them.
    const touched = [...new Set([...record.pages, ...Object.values(record.items).map((item) => item.target)])];
    const changes: { path: string; text: string | null }[] = [];
    let index = read('index.md');
    for (const path of touched) {
      const text = read(path);
      if (text === null || !mentionsMeeting(text, id)) continue;
      const scrubbed = scrubMeeting(text, id, record.derived);
      const created = record.derived.some((line) => line.includes(`\`${path}\``));
      const empty = decisionBullets(scrubbed).length === 0 && !/^##\s+Replaced/m.test(scrubbed) && scrubbed.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^#.*$/gm, '').trim() === '';
      if (created && empty) {
        changes.push({ path, text: null });
        if (index !== null) index = scrubMeeting(index, id, record.derived);
      } else changes.push({ path, text: scrubbed });
    }
    if (index !== null && index !== read('index.md')) changes.push({ path: 'index.md', text: index });
    // Written straight to disk and the approved copy: no backup of what Forget removes.
    if (changes.length) writeFiles(changes);
    // The approved copy of pages it touched that drifted on disk is scrubbed too.
    for (const path of touched) {
      const approved = journal.approvedText(path);
      if (approved !== null && mentionsMeeting(approved, id)) journal.record([{ path, text: scrubMeeting(approved, id, record.derived) }]);
    }

    // Every backup, both formats (page edits and approvals): the before and after text of each file.
    let backupsScrubbed = 0;
    for (const path of backupFiles()) {
      const raw = readFileSync(path, 'utf8');
      if (!raw.includes(id)) continue;
      const change = JSON.parse(raw) as { files?: { path: string; before: string | null; after: string | null }[] };
      if (!Array.isArray(change.files)) continue;
      const scrub = (text: string | null): string | null => (text === null ? null : scrubMeeting(text, id, record.derived));
      change.files = change.files.map((file) => ({ ...file, before: scrub(file.before), after: scrub(file.after) }));
      writeFileAtomic(path, `${JSON.stringify(change, null, 2)}\n`);
      backupsScrubbed += 1;
    }
    const snapshots = snapshotsWith(id);
    for (const dir of snapshots) rmSync(dir, { recursive: true, force: true });
    rmSync(join(stubsRoot, id), { recursive: true, force: true });
    rmSync(evidencePath(id), { force: true });
    for (const entry of Object.values(record.items)) if (entry.status === 'pending') entry.status = 'discarded';
    if (!record.digest) record.state = 'forgotten';
    const pages = changes.map((change) => change.path).filter((path) => path !== 'index.md');
    record.pages = [];
    record.derived = [];
    writeRegistry(registry);
    return { pages, backups: backupsScrubbed, snapshots: snapshots.length };
  });

  /** Meetings whose Forget still has to delete Serra's digest message. The daemon does it, then calls `digestDeleted`. */
  const digestsToDelete = (): { id: string; channel: string; ts: string }[] => Object.values(readRegistry().meetings)
    .filter((record) => record.state === 'forgetting' && record.digest).map((record) => ({ id: record.id, ...record.digest! }));

  const digestDeleted = (id: string): void => locked(() => {
    const registry = readRegistry();
    const record = registry.meetings[id];
    if (!record) return;
    delete record.digest;
    record.state = 'forgotten';
    writeRegistry(registry);
  });

  /** Finish a Forget a crash interrupted: anything still `forgetting` with pages or evidence left is forgotten again. */
  const resumeForgets = (): number => {
    const unfinished = Object.values(readRegistry().meetings).filter((record) => record.state === 'forgetting'
      && (record.pages.length > 0 || existsSync(evidencePath(record.id)) || existsSync(join(stubsRoot, record.id))));
    for (const record of unfinished) forget(record.id);
    return unfinished.length;
  };

  /** Pending edits older than PENDING_DAYS expire with their evidence. Returns the meetings that expired. */
  const expire = (): string[] => locked(() => {
    const registry = readRegistry();
    const cutoff = now().getTime() - PENDING_DAYS * DAY_MS;
    const expired: string[] = [];
    for (const record of Object.values(registry.meetings)) {
      if (record.state !== 'open' || Date.parse(record.createdAt) > cutoff) continue;
      let any = false;
      for (const [itemId, entry] of Object.entries(record.items)) if (entry.status === 'pending') { closeItem(record, itemId, 'expired'); any = true; }
      if (any) expired.push(record.id);
    }
    if (expired.length) writeRegistry(registry);
    return expired;
  });

  /** Whether a meeting ID is free: never used and never revoked. */
  const newId = (): string => {
    const registry = readRegistry();
    for (;;) {
      const id = randomBytes(3).toString('hex');
      if (!registry.meetings[id] && !registry.revoked.includes(id)) return id;
    }
  };

  /** Whether a stub file under `from-meeting/` matches the registry (for the general queue's labels). */
  const known = (id: string, itemId: string): boolean => {
    const record = readRegistry().meetings[id];
    return Boolean(record?.items[itemId] && record.items[itemId]!.status === 'pending');
  };

  /** The modification time of the registry, for tests and the app's refresh. */
  const touchedAt = (): number => (existsSync(registryPath) ? statSync(registryPath).mtimeMs : 0);

  return {
    recover, addMeeting, setDigest, listMeetings, history, approve, discard, discardMeeting, forget, digestsToDelete, digestDeleted,
    resumeForgets, expire, newId, known, touchedAt, readRegistry,
  };
};

export type MeetingStore = ReturnType<typeof createMeetingStore>;

/** The lines a digest reply lists for action items, questions and dated constraints. */
export const replyLines = (reply: ReplyLine[]): string[] => reply.map((line) => {
  const extra = [line.owner, line.due ? `by ${line.due}` : null].filter(Boolean).join(', ');
  const mark = line.kind === 'action' ? '☐' : line.kind === 'question' ? '?' : '⏳';
  return `${mark} ${line.text}${extra ? ` (${extra})` : ''}`;
});
