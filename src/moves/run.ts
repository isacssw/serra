// Running a move or a restore (SB-34), from the Mac, over two hosts (`host.ts`): this Mac and a paired server, either
// way round, or one host twice for a restore ("a move in place", ux-rules E17). Every step is written to the journal
// `moves/<moveId>.json` on this Mac before it runs, so a quit, a crash or a sleeping Mac is settled when the app is
// back (`settle`):
//
//   drain    no new job starts; running jobs finish (never killed). A job waiting for the owner stops the clock.
//   pause    the source is held and stopped: from here only one of the two can run.
//   backup   a checked copy on the source. A move copies from it, so nothing changes under the copy.
//   copy     every file to the target's staging, then read back there and checked (a restore: the backup, checked).
//   start    the source's hold becomes `committed` (it can no longer lapse), then the target makes the staging the
//            profile, with its tokens, and starts it. If it doesn't come up, it goes aside and the source runs again.
//   archive  the source's copy leaves its host (the backup stays).
//
// Any failure before `start` resumes the source exactly as it was and deletes the target's staging (E3). Once `start`
// began, the move only goes forward, or back through `fail` + `resume` when the target doesn't come up.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic.ts';
import { isNumber, isOneOf, isRecord, isRecordOf, isString, readJsonOrNull, type Guard } from '../lib/guards.ts';
import type { MoveHost } from './host.ts';

const MOVE_STEPS = ['drain', 'pause', 'backup', 'copy', 'start', 'archive'] as const;
type MoveStep = (typeof MOVE_STEPS)[number];

type MoveState = 'running' | 'done' | 'stopped' | 'later' | 'interrupted';

/** A move or restore as the journal keeps it, and as the window shows it. No secret is ever in it. */
export interface MoveJournal {
  version: 1;
  id: string;
  kind: 'move' | 'restore';
  /** The profile's folder name, and its name as shown. */
  profile: string;
  name: string;
  /** Hosts: `local` or a server id; and their names as shown (`this Mac`, `t480`). A restore has one host twice. */
  from: string;
  to: string;
  fromName: string;
  toName: string;
  /** Restore: the backup it goes back to. */
  backup: string | null;
  /** Source paths → where they are on the target, from the preflight. */
  mapped: Record<string, string>;
  /** The step running now (or last). */
  step: MoveStep;
  state: MoveState;
  startedAt: string;
  endedAt: string | null;
  /** What went wrong, in a few words. Never a token. */
  error: string | null;
  /** While draining: jobs still running, and jobs waiting for the owner (the clock stops while there are any). */
  running: number;
  waiting: number;
  /** While copying: files copied and the total. */
  copied: number;
  total: number;
  /** The window showed how it ended. */
  seen?: boolean;
}

const isJournal: Guard<MoveJournal> = (value): value is MoveJournal =>
  isRecord(value) && value.version === 1 && isString(value.id) && isOneOf('move', 'restore')(value.kind) && isString(value.profile)
  && isString(value.name) && isString(value.from) && isString(value.to) && isString(value.fromName) && isString(value.toName)
  && (value.backup === null || isString(value.backup)) && isRecordOf(isString)(value.mapped) && isOneOf(...MOVE_STEPS)(value.step)
  && isOneOf('running', 'done', 'stopped', 'later', 'interrupted')(value.state) && isString(value.startedAt)
  && (value.endedAt === null || isString(value.endedAt)) && (value.error === null || isString(value.error))
  && isNumber(value.running) && isNumber(value.waiting) && isNumber(value.copied) && isNumber(value.total);

const newMoveId = (): string => `m_${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12)}`;

const journalDir = (root: string): string => join(root, 'moves');
const journalPath = (root: string, id: string): string => join(journalDir(root), `${id}.json`);

export const readJournal = (root: string, id: string): MoveJournal | null => readJsonOrNull(journalPath(root, id), isJournal);

/** Every journal on this Mac, newest first. */
export const readJournals = (root: string): MoveJournal[] => {
  const dir = journalDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^m_[a-z0-9]{12}\.json$/.test(name))
    .map((name) => readJsonOrNull(join(dir, name), isJournal)).filter((found): found is MoveJournal => found !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};

export const saveJournal = (root: string, journal: MoveJournal): void => {
  mkdirSync(journalDir(root), { recursive: true, mode: 0o700 });
  writeFileAtomic(journalPath(root, journal.id), `${JSON.stringify(journal, null, 2)}\n`);
};

export interface MovePlan {
  kind: 'move' | 'restore';
  profile: string;
  name: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  backup?: string | null;
  mapped?: Record<string, string>;
}

export const newJournal = (plan: MovePlan, now = new Date()): MoveJournal => ({
  version: 1, id: newMoveId(), kind: plan.kind, profile: plan.profile, name: plan.name, from: plan.from, to: plan.to,
  fromName: plan.fromName, toName: plan.toName, backup: plan.backup ?? null, mapped: plan.mapped ?? {}, step: 'drain', state: 'running',
  startedAt: now.toISOString(), endedAt: null, error: null, running: 0, waiting: 0, copied: 0, total: 0,
});

export interface RunOptions {
  /** This Mac's profiles folder, where the journal lives. */
  root: string;
  from: MoveHost;
  to: MoveHost;
  /** Every change of the journal, for the window. */
  progress?: (journal: MoveJournal) => void;
  /** How often the drain looks again. */
  pollMs?: number;
  now?: () => Date;
}

/** A running move's handle: the owner can stop it while that is still safe. */
export interface MoveControl {
  /** Move later (while jobs finish) or Cancel (until start). False once it can only go forward. */
  stop(): boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs (or, from `settle`, finishes) a move. Resolves with the journal as it ended. Never throws. */
export const runMove = (journal: MoveJournal, options: RunOptions): { control: MoveControl; done: Promise<MoveJournal> } => {
  const { root, from, to, pollMs = 3000, now = () => new Date() } = options;
  let stopping = false;
  let current = journal;
  const update = (patch: Partial<MoveJournal>): void => {
    current = { ...current, ...patch };
    saveJournal(root, current);
    options.progress?.(current);
  };
  const restore = current.kind === 'restore';
  const stopped = (): boolean => stopping;

  /** Before `start`: the source as it was, the target's staging gone. */
  const rollBack = async (state: MoveState, error: string | null): Promise<MoveJournal> => {
    const problems: string[] = [];
    try { await to.discard(current.id); } catch (caught) { problems.push(errorText(caught)); }
    if (current.step === 'drain') {
      try { await from.later(current.profile); } catch (caught) { problems.push(errorText(caught)); }
    } else {
      try { await from.resume(current.profile, current.id); } catch (caught) { problems.push(errorText(caught)); }
    }
    // A host that couldn't be reached keeps its part for next time: the journal says so.
    if (problems.length) { update({ state: 'interrupted', error: error ?? problems[0]! }); return current; }
    update({ state, error, endedAt: now().toISOString() });
    return current;
  };

  const drain = async (): Promise<boolean> => {
    for (;;) {
      const counts = await from.drain(current.profile);
      update({ running: counts.running, waiting: counts.waiting });
      if (counts.running === 0 && counts.waiting === 0) return true;
      if (stopped()) return false;
      await sleep(pollMs);
      if (stopped()) return false;
    }
  };

  const copy = async (): Promise<void> => {
    if (restore) {
      if (!current.backup) throw new Error('No backup was picked.');
      await to.stageBackup(current.id, current.profile, current.backup);
    } else {
      const files = await from.backup(current.profile, current.id, {}, 'moved');
      const needed = await to.receive(current.id, current.profile, files);
      update({ total: files.length, copied: files.length - needed.length });
      let lastHold = Date.now();
      for (const path of needed) {
        if (stopped()) throw new Error('cancelled');
        await to.writeFile(current.id, path, await from.readFile(current.id, path));
        update({ copied: current.copied + 1 });
        // A long copy keeps the hold fresh, so the source never starts again behind it.
        if (Date.now() - lastHold > 60_000) { await from.hold(current.profile, current.id, 'paused'); lastHold = Date.now(); }
      }
    }
    await to.verify(current.id);
  };

  const start = async (): Promise<MoveJournal> => {
    update({ step: 'start' });
    // From here the source's hold can't lapse: it may only start again through `fail` below.
    await from.hold(current.profile, current.id, 'committed');
    const secrets = restore ? [] : await from.secrets(current.profile);
    try {
      await to.commit(current.id, { secrets, mapped: current.mapped, replace: restore });
    } catch (error) {
      const why = errorText(error);
      try {
        await to.fail(current.id, current.profile, restore);
        await from.resume(current.profile, current.id);
      } catch (caught) { update({ state: 'interrupted', error: errorText(caught) }); return current; }
      update({ state: 'stopped', error: why, endedAt: now().toISOString() });
      return current;
    }
    return archive();
  };

  const archive = async (): Promise<MoveJournal> => {
    update({ step: 'archive' });
    try { await from.archive(current.profile, current.id); }
    catch (error) { update({ state: 'interrupted', error: errorText(error) }); return current; }
    // A move resumed after its commit may have left the target's arrival record: it isn't needed now.
    if (!restore) { try { await to.discard(current.id); } catch { /* best effort */ } }
    update({ state: 'done', error: null, endedAt: now().toISOString() });
    return current;
  };

  const go = async (): Promise<MoveJournal> => {
    try {
      if (current.step === 'start') {
        // Resumed after commit began: if the target is up, finish; otherwise try the start again (it may undo itself).
        if (await to.live(current.profile)) return archive();
        return start();
      }
      if (current.step === 'archive') return archive();
      update({ state: 'running', error: null });
      if (current.step === 'drain') {
        if (!(await drain())) return rollBack('later', null);
        update({ step: 'pause' });
      }
      if (stopped()) return rollBack('stopped', null);
      if (current.step === 'pause') {
        await from.pause(current.profile, current.id);
        update({ step: 'backup' });
      }
      if (current.step === 'backup') {
        if (restore) await from.backup(current.profile, current.id, { restoring: current.backup ?? '' }, 'restore');
        else await from.backup(current.profile, current.id, { to: current.toName }, 'moved');
        update({ step: 'copy' });
      }
      if (stopped()) return rollBack('stopped', null);
      await copy();
      if (stopped()) return rollBack('stopped', null);
      return start();
    } catch (error) {
      if (current.step === 'start' || current.step === 'archive') { update({ state: 'interrupted', error: errorText(error) }); return current; }
      return rollBack('stopped', stopping ? null : errorText(error));
    }
  };

  const done = go().catch((error: unknown) => { update({ state: 'interrupted', error: errorText(error) }); return current; });
  return {
    control: { stop: () => { if (current.step === 'start' || current.step === 'archive' || current.state !== 'running') return false; stopping = true; return true; } },
    done,
  };
};

/**
 * A journal left `running` or `interrupted` (the app quit, a host was away): settled without asking (council). Before
 * `start` the source comes back as it was; from `start` on, the move finishes, or undoes itself if the target won't
 * come up. A host that still can't be reached leaves it `interrupted`, tried again next time.
 */
export const settle = (journal: MoveJournal, options: RunOptions): Promise<MoveJournal> => {
  if (journal.state !== 'running' && journal.state !== 'interrupted') return Promise.resolve(journal);
  if (journal.step === 'start' || journal.step === 'archive') return runMove({ ...journal, state: 'running' }, options).done;
  // Before start: never go on with a copy the owner may have given up on; put the source back.
  const run = runMove({ ...journal, state: 'running' }, options);
  run.control.stop();
  return run.done;
};
