// Moves and restores, as the Mac app runs them (SB-34). A move spans this Mac and a paired server, so the app runs it
// itself, like pairing: `src/moves/run.ts` does the steps over this Mac's side (`localMoveHost`) and a server's
// (`remoteMoveHost`, through its gateway). One runs at a time. Its journal is on this Mac, so one left part way by a
// quit or a sleeping server is settled without asking when the app is back, or when that server answers again.
import { join } from 'node:path';
import type { BackupView, MoveBlock, MovePreflight, MoveView } from '../../src/api.ts';
import { SERVER_ID } from '../../src/gateway/client.ts';
import type { ServerHealthFollower } from '../../src/gateway/health.ts';
import { remoteMoveHost } from '../../src/gateway/move-client.ts';
import type { ServerPairing } from '../../src/gateway/pairing.ts';
import { MOVE_PROTOCOL } from '../../src/gateway/state.ts';
import { PROFILE_ID, type MoveHost } from '../../src/moves/host.ts';
import {
  newJournal, readJournal, readJournals, runMove, saveJournal, settle, type MoveControl, type MoveJournal,
} from '../../src/moves/run.ts';
import { readProfilesFile, writeProfilesFile } from '../../src/profiles.ts';
import { isBackupId, type BackupEntry } from '../../src/profile-backup.ts';
import type { Handlers } from './bridge.ts';

/** How fast a copy goes, for the away estimate: a careful guess for Tailscale over home broadband. */
const BYTES_PER_SECOND = 2 * 1024 * 1024;
/** Preparing and starting the bot there, which dominates a small profile's move. */
const START_SECONDS = 60;
/** Ended moves the window hasn't shown stay listed this long. */
const RECENT_MS = 24 * 60 * 60_000;

export interface MovesDeps {
  /** This Mac's profiles folder, where journals live. */
  root: string;
  pairing: ServerPairing;
  health: ServerHealthFollower;
  /** This Mac's side. */
  local: MoveHost;
  /** A server's side (tests: a host over a local gateway). */
  remote?: (serverId: string, name: string) => MoveHost;
  /** Each change of the running move, for the window. */
  push(view: MoveView): void;
  /** Profiles came or went: the lists are read again. `left` is this Mac's folder of a profile that just left it. */
  changed(left: string | null): void;
  pollMs?: number;
}

export interface MovesRunner {
  handlers: Handlers<'moves'>;
  /** Settles every move left part way (app start, a server answering again). */
  settleAll(): Promise<void>;
  /** The run in progress, for tests. */
  idle(): Promise<void>;
}

const view = (journal: MoveJournal): MoveView => ({
  id: journal.id, kind: journal.kind, ref: `${journal.from}/${journal.profile}`, name: journal.name, from: journal.from, to: journal.to,
  fromName: journal.fromName, toName: journal.toName, backup: journal.backup, step: journal.step, state: journal.state,
  startedAt: journal.startedAt, endedAt: journal.endedAt, error: journal.error, running: journal.running, waiting: journal.waiting,
  copied: journal.copied, total: journal.total,
});

const parseRef = (ref: unknown): { host: string; id: string } => {
  const match = typeof ref === 'string' ? /^([^/]+)\/([^/]+)$/.exec(ref) : null;
  if (!match || !PROFILE_ID.test(match[2]!) || (match[1] !== 'local' && !SERVER_ID.test(match[1]!))) throw new Error('Only a profile in Serra’s folder, or on a server, can move.');
  return { host: match[1]!, id: match[2]! };
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const movesRunner = (deps: MovesDeps): MovesRunner => {
  const { root, pairing, health } = deps;
  const remote = deps.remote ?? ((serverId: string, name: string) => remoteMoveHost(pairing.client(serverId), name));
  let active: { journal: MoveJournal; control: MoveControl; done: Promise<unknown> } | null = null;
  let settling: Promise<void> | null = null;

  const serverName = (id: string): string => {
    const server = pairing.list().find((known) => known.id === id);
    if (!server) throw new Error('This Mac isn’t paired with that server any more.');
    return server.name;
  };
  const nameOf = (key: string): string => (key === 'local' ? 'this Mac' : serverName(key));
  const hostFor = (key: string): MoveHost => (key === 'local' ? deps.local : remote(key, serverName(key)));

  /** Why a server can't take part now, if it can't. */
  const serverBlock = (key: string): MoveBlock | null => {
    if (key === 'local') return null;
    const server = health.snapshot().find((known) => known.id === key);
    const name = serverName(key);
    if (!server || server.state !== 'up') return { kind: 'offline', text: `${name} is offline` };
    if (server.protocol === null || server.protocol < MOVE_PROTOCOL) return { kind: 'update', text: `Update ${name} first` };
    return null;
  };

  const busy = (): MoveBlock | null => (active ? { kind: 'busy', text: `${active.journal.name} is ${active.journal.kind === 'move' ? 'moving' : 'being restored'}` } : null);

  const awayMinutes = (bytes: number): number => Math.max(1, Math.round((bytes / BYTES_PER_SECOND + START_SECONDS) / 60));

  const checkMove = async (ref: unknown, to: unknown): Promise<MovePreflight & { id: string; from: string; to: string; mapped: Record<string, string> }> => {
    const { host: from, id } = parseRef(ref);
    if (typeof to !== 'string' || (to !== 'local' && !SERVER_ID.test(to))) throw new Error('Pick where it goes.');
    if (to === from) throw new Error(`It is on ${nameOf(to)} already.`);
    const base = { id, from, to, name: id, fromName: nameOf(from), toName: nameOf(to), awayMinutes: 1, running: 0, mapped: {} };
    const early = [busy(), serverBlock(from), serverBlock(to)].filter((block): block is MoveBlock => block !== null);
    if (early.length) return { ...base, blocks: early };
    const facts = await hostFor(from).facts(id);
    const blocks: MoveBlock[] = [];
    if (facts.waiting) blocks.push({ kind: 'waiting', text: `${plural(facts.waiting, 'job waits', 'jobs wait')} for you` });
    if (facts.links.length) blocks.push({ kind: 'target', text: `${plural(facts.links.length, 'linked file', 'linked files')} can’t move` });
    const check = await hostFor(to).check({ profile: id, bytes: facts.bytes, paths: facts.paths });
    for (const problem of check.problems) blocks.push({ kind: 'target', text: problem.replace(/\.$/, '') });
    return { ...base, name: facts.name, blocks, awayMinutes: awayMinutes(facts.bytes), running: facts.running, mapped: check.mapped };
  };

  const checkRestore = async (ref: unknown, backupId: unknown): Promise<MovePreflight & { id: string; host: string }> => {
    const { host, id } = parseRef(ref);
    if (typeof backupId !== 'string' || !isBackupId(backupId) || !backupId.startsWith(`${id}@`)) throw new Error('That isn’t a backup of this profile.');
    const base = { id, host, name: id, fromName: nameOf(host), toName: nameOf(host), awayMinutes: 1, running: 0 };
    const early = [busy(), serverBlock(host)].filter((block): block is MoveBlock => block !== null);
    if (early.length) return { ...base, blocks: early };
    const there = hostFor(host);
    const [facts, backups] = await Promise.all([there.facts(id), there.backups()]);
    const blocks: MoveBlock[] = [];
    if (!backups.some((backup) => backup.id === backupId)) blocks.push({ kind: 'target', text: `That backup isn’t on ${nameOf(host)}` });
    if (facts.waiting) blocks.push({ kind: 'waiting', text: `${plural(facts.waiting, 'job waits', 'jobs wait')} for you` });
    return { ...base, name: facts.name, blocks, awayMinutes: awayMinutes(facts.bytes), running: facts.running };
  };

  /** A move that ended well: the order keeps the profile where it was, now under its new host (ux-rules G1). */
  const moved = (journal: MoveJournal): void => {
    const before = `${journal.from}/${journal.profile}`;
    const after = `${journal.to}/${journal.profile}`;
    const file = readProfilesFile(root);
    if (!file.order.includes(before) && !file.look[before]) return;
    const look = { ...file.look };
    if (look[before]) { look[after] = look[before]!; delete look[before]; }
    writeProfilesFile(root, { ...file, order: file.order.map((ref) => (ref === before ? after : ref)).filter((ref, index, all) => all.indexOf(ref) === index), look });
  };

  const ended = (journal: MoveJournal): void => {
    if (journal.state === 'done' && journal.kind === 'move') {
      try { moved(journal); } catch (error) { console.error('[serra] could not keep the profile’s place:', error); }
    }
    if (journal.from !== 'local' || journal.to !== 'local') health.retry();
    deps.changed(journal.state === 'done' && journal.kind === 'move' && journal.from === 'local' ? join(root, journal.profile) : null);
  };

  const launch = (journal: MoveJournal, run: (journal: MoveJournal, options: Parameters<typeof runMove>[1]) => { control: MoveControl; done: Promise<MoveJournal> }): MoveView => {
    const from = hostFor(journal.from);
    const to = hostFor(journal.to);
    const started = run(journal, {
      root, from, to, ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
      progress: (next) => { if (active) active.journal = next; deps.push(view(next)); },
    });
    const done = started.done.then((last) => { active = null; deps.push(view(last)); ended(last); });
    active = { journal, control: started.control, done };
    deps.push(view(journal));
    return view(journal);
  };

  const settleOne = async (journal: MoveJournal): Promise<void> => {
    if (active) return;
    let resolved: MoveJournal;
    const from = hostFor(journal.from);
    const to = hostFor(journal.to);
    // Marked active while it settles, so nothing else starts beside it.
    const done = settle(journal, {
      root, from, to, ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
      progress: (next) => { if (active) active.journal = next; deps.push(view(next)); },
    });
    active = { journal, control: { stop: () => false }, done };
    try { resolved = await done; } finally { active = null; }
    deps.push(view(resolved));
    ended(resolved);
  };

  const settleAll = (): Promise<void> => {
    settling ??= (async () => {
      for (const journal of readJournals(root)) {
        if (journal.state !== 'running' && journal.state !== 'interrupted') continue;
        try { await settleOne(journal); } catch (error) { console.error('[serra] could not settle a move:', error instanceof Error ? error.message : error); }
      }
    })().finally(() => { settling = null; });
    return settling;
  };

  const handlers: Handlers<'moves'> = {
    preflight: async (ref, to) => {
      const { id: _id, from: _from, to: _to, mapped: _mapped, ...shown } = await checkMove(ref, to);
      return shown;
    },
    start: async (ref, to) => {
      const checked = await checkMove(ref, to);
      if (checked.blocks.length) throw new Error(checked.blocks[0]!.text);
      const journal = newJournal({
        kind: 'move', profile: checked.id, name: checked.name, from: checked.from, to: checked.to,
        fromName: checked.fromName, toName: checked.toName, mapped: checked.mapped,
      });
      saveJournal(root, journal);
      return launch(journal, runMove);
    },
    restorePreflight: async (ref, backupId) => {
      const { id: _id, host: _host, ...shown } = await checkRestore(ref, backupId);
      return shown;
    },
    restore: async (ref, backupId) => {
      const checked = await checkRestore(ref, backupId);
      if (checked.blocks.length) throw new Error(checked.blocks[0]!.text);
      const journal = newJournal({
        kind: 'restore', profile: checked.id, name: checked.name, from: checked.host, to: checked.host,
        fromName: checked.fromName, toName: checked.toName, backup: String(backupId),
      });
      saveJournal(root, journal);
      return launch(journal, runMove);
    },
    stop: (moveId) => (active && active.journal.id === moveId ? active.control.stop() : false),
    resume: async (moveId) => {
      const journal = typeof moveId === 'string' && /^m_[a-z0-9]{12}$/.test(moveId) ? readJournal(root, moveId) : null;
      if (!journal) throw new Error('That move isn’t on this Mac.');
      if (active) throw new Error('Another move is running.');
      await settleOne(journal);
      return view(readJournal(root, journal.id) ?? journal);
    },
    list: () => {
      const now = Date.now();
      return readJournals(root)
        .map((journal) => (active?.journal.id === journal.id ? active.journal : journal))
        .filter((journal) => !journal.seen && (journal.state === 'running' || journal.state === 'interrupted' || now - Date.parse(journal.endedAt ?? journal.startedAt) < RECENT_MS))
        .map(view);
    },
    dismiss: (moveId) => {
      const journal = typeof moveId === 'string' && /^m_[a-z0-9]{12}$/.test(moveId) ? readJournal(root, moveId) : null;
      if (journal && journal.state !== 'running' && journal.state !== 'interrupted') saveJournal(root, { ...journal, seen: true });
    },
    backups: async (ref) => {
      const { host: current, id } = parseRef(ref);
      const currentName = nameOf(current);
      const currentBlock = serverBlock(current);
      const hosts: { key: string; name: string; list: Promise<BackupEntry[]> }[] = [{ key: 'local', name: 'this Mac', list: deps.local.backups() }];
      for (const server of health.snapshot()) {
        if (server.state !== 'up' || server.protocol === null || server.protocol < MOVE_PROTOCOL) continue;
        hosts.push({ key: server.id, name: server.name, list: remote(server.id, server.name).backups() });
      }
      const found: BackupView[] = [];
      for (const host of hosts) {
        let list: BackupEntry[];
        try { list = await host.list; } catch { continue; }
        for (const backup of list) {
          if (backup.profile !== id) continue;
          const blocked = host.key !== current ? `Live on ${currentName}` : currentBlock ? currentBlock.text : null;
          found.push({ id: backup.id, host: host.key, hostName: host.name, kind: backup.kind, at: backup.at, detail: backup.detail, blocked });
        }
      }
      return found.sort((a, b) => b.at.localeCompare(a.at));
    },
  };

  return { handlers, settleAll, idle: async () => { await active?.done; await settling; } };
};
