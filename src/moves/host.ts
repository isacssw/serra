// One computer's side of a move or a restore (SB-34): what this Mac, or a server through its gateway, does when a
// profile leaves it, arrives on it, or goes back to a backup in place. The Mac app runs the steps (`run.ts`) over two
// of these: this one for this computer, and `remoteMoveHost` (gateway/move-client.ts) for a server, which calls this
// same code on the server.
//
// Everything a host keeps about a move sits beside the profiles, never inside a profile folder (ux-rules E1):
//
//   moves/hold-<profile>.json   the profile is held for a move: its service is stopped and set aside, and the daemon
//                               refuses to start. Until `step` is `committed` it lapses after 10 minutes without a
//                               refresh, and then this host may start the profile again on its own (E16).
//   .incoming/<moveId>/         a profile arriving: `meta.json` (the files it should have) and `data/` (the files).
//                               Becomes `<profile>/` only at commit, after every file is checked (E2, E3).
//   backups/<profile>@<day>/    the checked copy made before a move or a restore (`profile-backup.ts`).
//
// A profile is live on one host at a time (E4): the source is stopped and held before anything is copied, and the
// target refuses a profile id it already has.
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readEnv } from '../lib/env.ts';
import { writeFileAtomic } from '../lib/atomic.ts';
import { isArrayOf, isNumber, isRecord, isString, readJsonOrNull, type Guard } from '../lib/guards.ts';
import { loadConfig, readProfileFile, type Profile } from '../config.ts';
import type { SecretName } from '../contracts.ts';
import { pauseIntake, readAck, resumeIntake } from '../intake.ts';
import {
  backupProfile, checkBackup, isBackupId, isDataPath, listBackups, profileData, readManifest, sha256File, staysWithHost, type BackupEntry,
  type DataFile,
} from '../profile-backup.ts';
import { serviceHost, type ServiceDriver, type ServiceHost } from '../service.ts';
import { createStore } from '../state.ts';
import { readTasks } from '../tasks.ts';
import { acpRunState } from '../agent/runs-view.ts';
import { holdPath, isHold, type Hold, type HoldStep } from './hold.ts';
import { SECRET_NAMES } from '../secrets.ts';

/** How long a hold lasts without a refresh before this host may start the profile again by itself (E16). */
const HOLD_MS = 10 * 60_000;
/** A move id, made by the Mac: never a path. */
const MOVE_ID = /^m_[a-z0-9]{12}$/;
/** A profile folder name: letters, digits, `.`, `_` and `-`, never a path. */
export const PROFILE_ID = /^[\w][\w.-]{0,63}$/;

/** A token as it travels: its value over the paired link, or a 1Password reference (never a value from there). */
export interface MoveSecret { name: SecretName; value?: string; reference?: string }

/** What the source says about a profile before a move or restore. Nothing secret. */
export interface ProfileFacts {
  id: string;
  name: string;
  /** Jobs with a run going, and jobs that wait for the owner (which block a move: E7). */
  running: number;
  waiting: number;
  /** The data's size in bytes, and its files' count. */
  bytes: number;
  files: number;
  /** Symbolic links in the data: another computer couldn't follow them. */
  links: string[];
  /** The folders the bot works in (project, repositories): they must exist on the target. */
  paths: string[];
}

/** What the target says about a profile it might take. `mapped`: a source path → where it is here, when it differs. */
export interface TargetCheck { problems: string[]; mapped: Record<string, string> }

export interface MoveHost {
  /** `this Mac`, or the server's name. */
  readonly name: string;
  facts(profile: string): Promise<ProfileFacts>;
  check(incoming: { profile: string; bytes: number; paths: string[] }): Promise<TargetCheck>;
  /** Stops new jobs (renewing the pause) and says how many still run, and how many wait for the owner. */
  drain(profile: string): Promise<{ running: number; waiting: number }>;
  /** Lets new jobs start again: the owner chose Move later, or the move stopped before the pause. */
  later(profile: string): Promise<void>;
  /** Holds the profile for the move, then stops its service and sets its service file aside. */
  pause(profile: string, moveId: string): Promise<void>;
  /** Renews the hold, or moves it on to `committed`. Throws when the hold is gone or lapsed: the move must stop. */
  hold(profile: string, moveId: string, step: HoldStep): Promise<void>;
  /** Undoes `pause`: the service file back, the bot started if it ran before, new jobs allowed, the hold gone. */
  resume(profile: string, moveId: string): Promise<void>;
  /** A checked backup for this move (made once; asked again, the same one). Returns its files. */
  backup(profile: string, moveId: string, note: Record<string, string>, kind: 'moved' | 'restore'): Promise<DataFile[]>;
  /** One file of this move's backup. */
  readFile(moveId: string, path: string): Promise<Readable>;
  /** The profile's tokens, for the target's own store. Only ever sent over the paired link (E12). */
  secrets(profile: string): Promise<MoveSecret[]>;
  /** After the target is live: the profile leaves this host (to the Trash), its service file goes, the hold ends. */
  archive(profile: string, moveId: string): Promise<void>;
  /** Opens (or reopens) the staging for an arriving profile. Returns the files still needed. */
  receive(moveId: string, profile: string, files: DataFile[]): Promise<string[]>;
  writeFile(moveId: string, path: string, data: Readable): Promise<void>;
  /** Restore: fills the staging from a backup on this host, checked against its manifest. */
  stageBackup(moveId: string, profile: string, backupId: string): Promise<void>;
  /** Reads every staged file back from disk and checks it against the manifest. */
  verify(moveId: string): Promise<void>;
  /**
   * Makes the staging the profile: a new folder (a move) or in place of today's (a restore, `replace`), with its
   * tokens and paths, then starts it and waits until it is up. Throws when it doesn't start; `fail` then undoes it.
   */
  commit(moveId: string, options: { secrets: MoveSecret[]; mapped: Record<string, string>; replace: boolean }): Promise<void>;
  /** Whether the profile is here and its daemon is up. */
  live(profile: string): Promise<boolean>;
  /** Undoes a commit that didn't start: the arrival goes aside (a restore puts today's copy back). */
  fail(moveId: string, profile: string, replace: boolean): Promise<void>;
  /** Deletes the staging and anything a cancelled arrival left. */
  discard(moveId: string): Promise<void>;
  backups(): Promise<BackupEntry[]>;
}

export interface LocalMoveDeps {
  /** The profiles folder: `~/.local/share/serra`. */
  root: string;
  /** `this Mac`, or the server's name. */
  name: string;
  /** Starts a profile that just arrived: prepare a release and activate it (`installService`). */
  install(profileDir: string): Promise<void>;
  /** Where a profile goes when it leaves: the Trash on a Mac, `backups/.trash` on a server. */
  trash(path: string): Promise<void>;
  /** The tokens' store on this host. */
  secrets: SecretPort;
  /** launchd or systemd (tests: a fake driver and folder). */
  service?: { host?: ServiceHost; driver?: ServiceDriver; dir?: string };
  /** The bot is about to be stopped by the app itself: no "stopped unexpectedly" (the app's presence map). */
  expectStop?(profileDir: string): void;
  now?: () => number;
  /** The home folder that paths are matched under on this host (tests). */
  home?: string;
}

/** Reads and writes a profile's tokens on this host. The default for each platform is in `secret-port.ts`. */
export interface SecretPort {
  read(profileDir: string): Promise<MoveSecret[]>;
  write(profileDir: string, secrets: MoveSecret[]): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------

interface Incoming { moveId: string; profile: string; files: DataFile[]; createdAt: string; replace?: boolean; carried?: string[] }

const isDataFile: Guard<DataFile> = (value): value is DataFile =>
  isRecord(value) && isString(value.path) && isDataPath(value.path) && isNumber(value.size) && isString(value.sha256) && /^[0-9a-f]{64}$/.test(value.sha256);
const isIncoming: Guard<Incoming> = (value): value is Incoming =>
  isRecord(value) && isString(value.moveId) && isString(value.profile) && isArrayOf(isDataFile)(value.files) && isString(value.createdAt);

const checkProfileId = (profile: string): string => {
  if (!PROFILE_ID.test(profile)) throw new Error('That isn’t a profile.');
  return profile;
};
const checkMoveId = (moveId: string): string => {
  if (!MOVE_ID.test(moveId)) throw new Error('That isn’t a move.');
  return moveId;
};

/** Counts from the profile's saved jobs, so they are right while the daemon is stopped too. */
const jobCounts = (profileDir: string): { running: number; waiting: number } => {
  let running = 0;
  let waiting = 0;
  if (!existsSync(join(profileDir, 'state.json'))) return { running, waiting };
  for (const [, job] of createStore(join(profileDir, 'state.json')).allJobs()) {
    if (job.phase.state === 'following') running += 1;
    else if (job.phase.state === 'waiting') waiting += 1;
  }
  return { running, waiting };
};

/**
 * The app's tasks and interviews (`tasks.json`) on an ACP agent that are still going, from their run records. A T3
 * task's state is only known to T3, so it isn't counted here.
 */
const appTaskRuns = (profileDir: string): { running: number; waiting: number } => {
  let running = 0;
  let waiting = 0;
  for (const task of readTasks(profileDir)) {
    if (!task.backend?.startsWith('acp')) continue;
    const state = acpRunState(profileDir, task.threadId);
    if (state?.waiting) waiting += 1;
    else if (state?.running) running += 1;
  }
  return { running, waiting };
};

/** The folders a profile works in, which must be on the computer it runs on. */
const workPaths = (profile: Profile): string[] => [...new Set([profile.project.path, ...(profile.repositories ?? []).map((repo) => repo.path)])];

/** `/Users/you/code/x` from another computer, as it would be under this one's home: `/home/you/code/x`. */
const underHome = (path: string, home: string): string | null => {
  const match = /^(?:\/Users|\/home)\/[^/]+(\/.*)?$/.exec(path);
  return match ? join(home, match[1] ?? '') : null;
};

const fsyncFile = (path: string): void => {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

// ---------------------------------------------------------------------------------------------------------------
// This computer
// ---------------------------------------------------------------------------------------------------------------

export const localMoveHost = (deps: LocalMoveDeps): MoveHost => {
  const root = resolve(deps.root);
  const now = deps.now ?? Date.now;
  const home = deps.home ?? homedir();
  const host = deps.service?.host ?? serviceHost();
  const driver = deps.service?.driver ?? host.driver;
  const serviceDir = deps.service?.dir ?? host.dir;

  const dirOf = (profile: string): string => join(root, checkProfileId(profile));
  const existing = (profile: string): string => {
    const dir = dirOf(profile);
    if (!existsSync(join(dir, 'profile.json'))) throw new Error(`No profile ${profile} on ${deps.name}.`);
    return dir;
  };
  const readHold = (profile: string): Hold | null => readJsonOrNull(holdPath(root, profile), isHold);
  const writeHold = (profile: string, hold: Hold): void => {
    mkdirSync(join(root, 'moves'), { recursive: true, mode: 0o700 });
    writeFileAtomic(holdPath(root, profile), `${JSON.stringify(hold, null, 2)}\n`);
  };
  const holdFor = (profile: string, moveId: string): Hold => {
    const hold = readHold(profile);
    if (!hold || hold.moveId !== moveId) throw new Error(`${profile} isn’t held for this move on ${deps.name}.`);
    return hold;
  };
  const label = (dir: string): string => loadConfig({ profileDir: dir, env: {} }).serviceLabel;
  const serviceFileOf = (dir: string): string => join(serviceDir, host.fileName(label(dir)));

  const incomingDir = (moveId: string): string => join(root, '.incoming', checkMoveId(moveId));
  const readIncoming = (moveId: string): Incoming => {
    const meta = readJsonOrNull(join(incomingDir(moveId), 'meta.json'), isIncoming);
    if (!meta || meta.moveId !== moveId) throw new Error(`Nothing is arriving for this move on ${deps.name}.`);
    return meta;
  };
  const writeIncoming = (meta: Incoming): void => writeFileAtomic(join(incomingDir(meta.moveId), 'meta.json'), JSON.stringify(meta));

  /** Starts the bot from its (restored) service file and waits until it is up. */
  const startService = async (dir: string, file: string): Promise<void> => {
    rmSync(join(dir, 'ready.json'), { force: true });
    await driver.start(file);
    await driver.ready(dir);
  };

  const self: MoveHost = {
    name: deps.name,

    async facts(profile) {
      const dir = existing(profile);
      const config = readProfileFile(dir);
      const { files, links } = profileData(dir);
      return {
        id: profile, name: config.bot.name, ...jobCounts(dir),
        bytes: files.reduce((sum, file) => sum + file.size, 0), files: files.length, links, paths: workPaths(config),
      };
    },

    async check({ profile, bytes, paths }) {
      checkProfileId(profile);
      const problems: string[] = [];
      const mapped: Record<string, string> = {};
      if (existsSync(join(root, profile)) || readHold(profile)) problems.push(`${deps.name} already has a profile called ${profile}.`);
      for (const path of paths) {
        if (existsSync(path)) continue;
        const there = underHome(path, home);
        if (there && existsSync(there)) mapped[path] = there;
        else problems.push(`${basename(path)} isn’t on ${deps.name}. Clone it there first.`);
      }
      // Room for the copy and a backup of it.
      try {
        mkdirSync(root, { recursive: true });
        const fs = statfsSync(root);
        if (fs.bavail * fs.bsize < bytes * 2 + 64 * 1024 * 1024) problems.push(`${deps.name} is short of disk space.`);
      } catch { /* unknown: the copy itself fails cleanly if the disk fills */ }
      return { problems, mapped };
    },

    async drain(profile) {
      const dir = existing(profile);
      // Renewed on every look, so a long drain never outlives it. `bot-update` is the reason every daemon knows.
      pauseIntake(dir, 'bot-update', { now: now() });
      const counts = jobCounts(dir);
      // The app's own tasks and interviews on an ACP agent run outside state.json: wait for them too.
      const runs = appTaskRuns(dir);
      const ack = readAck(dir, now());
      return { running: counts.running + runs.running + (ack?.starting ?? 0), waiting: counts.waiting + runs.waiting };
    },

    async later(profile) {
      const dir = existing(profile);
      resumeIntake(dir);
    },

    async pause(profile, moveId) {
      checkMoveId(moveId);
      const dir = existing(profile);
      const known = readHold(profile);
      if (known && known.moveId !== moveId) throw new Error(`${profile} is already being moved.`);
      if (known) { await self.hold(profile, moveId, known.step); return; }
      const file = serviceFileOf(dir);
      const wasLoaded = await driver.loaded(label(dir));
      // The hold first: from here on the daemon refuses to start, whatever loads it.
      writeHold(profile, { moveId, step: 'paused', until: new Date(now() + HOLD_MS).toISOString(), wasLoaded, serviceFile: existsSync(file) ? file : null, backup: null });
      deps.expectStop?.(dir);
      await driver.stop(label(dir));
      // Set aside, so a login or reboot doesn't load it while the profile is away.
      if (existsSync(file)) renameSync(file, `${file}.held`);
    },

    async hold(profile, moveId, step) {
      const hold = holdFor(profile, moveId);
      if (hold.step === 'paused' && Date.parse(hold.until) <= now()) throw new Error(`The hold on ${profile} lapsed on ${deps.name}, so the move stopped.`);
      writeHold(profile, { ...hold, step: hold.step === 'committed' ? 'committed' : step, until: new Date(now() + HOLD_MS).toISOString() });
    },

    async resume(profile, moveId) {
      const hold = readHold(profile);
      // Never held (stopped while draining), or resumed already: new jobs may start again.
      if (!hold) { if (existsSync(join(dirOf(profile), 'profile.json'))) resumeIntake(dirOf(profile)); return; }
      if (hold.moveId !== moveId) throw new Error(`${profile} is held for another move.`);
      const dir = existing(profile);
      if (hold.serviceFile && existsSync(`${hold.serviceFile}.held`)) renameSync(`${hold.serviceFile}.held`, hold.serviceFile);
      rmSync(holdPath(root, profile), { force: true });
      resumeIntake(dir);
      if (hold.wasLoaded && hold.serviceFile && existsSync(hold.serviceFile) && !(await driver.loaded(label(dir)))) await startService(dir, hold.serviceFile);
    },

    async backup(profile, moveId, note, kind) {
      const hold = holdFor(profile, moveId);
      if (hold.backup && existsSync(hold.backup)) return readManifest(hold.backup);
      const made = backupProfile(existing(profile), join(root, 'backups'), { ...note, profile, move: moveId }, new Date(now()), kind);
      writeHold(profile, { ...holdFor(profile, moveId), backup: made.path });
      return readManifest(made.path);
    },

    async readFile(moveId, path) {
      checkMoveId(moveId);
      if (!isDataPath(path)) throw new Error('That isn’t a file of this move.');
      const holds = existsSync(join(root, 'moves')) ? readdirSync(join(root, 'moves')).filter((name) => name.startsWith('hold-')) : [];
      const hold = holds.map((name) => readJsonOrNull(join(root, 'moves', name), isHold)).find((found) => found?.moveId === moveId);
      if (!hold?.backup) throw new Error('This move has no backup to copy from.');
      const file = join(hold.backup, path);
      if (!readManifest(hold.backup).some((entry) => entry.path === path) || !existsSync(file)) throw new Error('That isn’t a file of this move.');
      return createReadStream(file);
    },

    async secrets(profile) {
      return deps.secrets.read(existing(profile));
    },

    async archive(profile, moveId) {
      const hold = readHold(profile);
      const staging = incomingDir(moveId);
      if (existsSync(join(staging, 'old'))) {
        // A restore that started: today's copy (backed up before) leaves, the hold ends.
        if (!hold || hold.moveId !== moveId || hold.step !== 'committed') throw new Error(`${profile} isn’t restored yet.`);
        await deps.trash(staging);
        rmSync(holdPath(root, profile), { force: true });
        return;
      }
      // Archived already: a resumed move asks again.
      if (!hold && !existsSync(join(root, profile))) return;
      if (!hold || hold.moveId !== moveId || hold.step !== 'committed') throw new Error(`${profile} can only leave ${deps.name} once it runs elsewhere.`);
      const dir = dirOf(profile);
      if (existsSync(dir)) await deps.trash(dir);
      if (hold.serviceFile) {
        rmSync(`${hold.serviceFile}.held`, { force: true });
        rmSync(hold.serviceFile, { force: true });
        await driver.forget?.(hold.serviceFile);
      }
      rmSync(holdPath(root, profile), { force: true });
    },

    async receive(moveId, profile, files) {
      checkProfileId(profile);
      if (!isArrayOf(isDataFile)(files)) throw new Error('The list of files can’t be read.');
      const dir = incomingDir(moveId);
      const known = readJsonOrNull(join(dir, 'meta.json'), isIncoming);
      if (known && (known.profile !== profile || known.moveId !== moveId)) throw new Error('Another arrival uses this move.');
      if (!known) {
        if (existsSync(join(root, profile))) throw new Error(`${deps.name} already has a profile called ${profile}.`);
        mkdirSync(join(dir, 'data'), { recursive: true, mode: 0o700 });
        writeIncoming({ moveId, profile, files, createdAt: new Date(now()).toISOString() });
      }
      // On a retry, a file already here and matching is kept.
      return files.filter((file) => {
        const path = join(dir, 'data', file.path);
        return !(existsSync(path) && statSync(path).size === file.size && sha256File(path) === file.sha256);
      }).map((file) => file.path);
    },

    async writeFile(moveId, path, data) {
      const meta = readIncoming(moveId);
      const expected = meta.files.find((file) => file.path === path);
      if (!expected) { data.resume(); throw new Error('That isn’t a file of this move.'); }
      const to = join(incomingDir(moveId), 'data', path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      const part = `${to}.part`;
      await pipeline(data, createWriteStream(part, { mode: 0o600 }));
      fsyncFile(part);
      if (sha256File(part) !== expected.sha256) { rmSync(part, { force: true }); throw new Error(`${path} arrived changed. Nothing was moved.`); }
      renameSync(part, to);
    },

    async stageBackup(moveId, profile, backupId) {
      existing(profile);
      if (!isBackupId(backupId) || !backupId.startsWith(`${profile}@`)) throw new Error('That isn’t a backup of this profile.');
      const from = join(root, 'backups', backupId);
      const files = checkBackup(from);
      const staging = incomingDir(moveId);
      mkdirSync(join(staging, 'data'), { recursive: true, mode: 0o700 });
      writeIncoming({ moveId, profile, files, createdAt: new Date(now()).toISOString(), replace: true });
      for (const file of files) {
        const to = join(staging, 'data', file.path);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        await pipeline(createReadStream(join(from, file.path)), createWriteStream(to, { mode: 0o600 }));
        fsyncFile(to);
      }
    },

    async verify(moveId) {
      const meta = readIncoming(moveId);
      for (const file of meta.files) {
        const path = join(incomingDir(moveId), 'data', file.path);
        if (!existsSync(path) || sha256File(path) !== file.sha256) throw new Error(`${file.path} didn’t check out on ${deps.name}. Nothing was moved.`);
      }
      if (!meta.files.some((file) => file.path === 'profile.json')) throw new Error('The copy has no profile.json. Nothing was moved.');
    },

    async commit(moveId, { secrets, mapped, replace }) {
      const meta = readIncoming(moveId);
      const staging = incomingDir(moveId);
      const data = join(staging, 'data');
      const dir = dirOf(meta.profile);
      if (!replace) {
        // A resumed commit finds the folder in place already.
        if (existsSync(data)) {
          if (existsSync(dir)) throw new Error(`${deps.name} already has a profile called ${meta.profile}.`);
          renameSync(data, dir);
        }
        fixPaths(dir, mapped);
        await deps.secrets.write(dir, secrets);
        await deps.install(dir);
        // Up. The arrival's record stays until the move ends (`discard`): if this answer is lost, `fail` still knows
        // the folder is this move's arrival and stops it before the source runs again.
        return;
      }
      // A restore: today's folder goes aside with the host's own files (the bot's code, its tokens) carried over.
      if (existsSync(data)) {
        const carried: string[] = [];
        for (const name of readdirSync(dir)) {
          if (!staysWithHost(name) || existsSync(join(data, name))) continue;
          renameSync(join(dir, name), join(data, name));
          carried.push(name);
        }
        writeIncoming({ ...meta, carried });
        renameSync(dir, join(staging, 'old'));
        renameSync(data, dir);
      }
      const hold = readHold(meta.profile);
      const file = hold?.serviceFile ?? null;
      if (file && existsSync(`${file}.held`)) renameSync(`${file}.held`, file);
      if (hold && file && existsSync(file)) {
        // The committed hold stays (archive ends it), but the restored copy itself may start.
        writeHold(meta.profile, { ...hold, starting: true });
        await startService(dir, file);
      }
    },

    async live(profile) {
      const dir = dirOf(profile);
      if (!existsSync(join(dir, 'profile.json')) || !existsSync(join(dir, 'ready.json'))) return false;
      try { return await driver.loaded(label(dir)); } catch { return false; }
    },

    async fail(moveId, profile, replace) {
      checkProfileId(profile);
      const staging = incomingDir(moveId);
      const dir = dirOf(profile);
      const meta = readJsonOrNull(join(staging, 'meta.json'), isIncoming);
      if (!replace) {
        if (!existsSync(dir)) return;
        // Only an arrival of this move is taken back: a profile with that name from before is never touched.
        if (!meta || meta.profile !== profile || existsSync(join(staging, 'data'))) return;
        try { await driver.stop(label(dir)); } catch { /* not running */ }
        try {
          const file = serviceFileOf(dir);
          if (existsSync(file)) { rmSync(file, { force: true }); await driver.forget?.(file); }
        } catch { /* no service to remove */ }
        // Set aside, never deleted: whatever it did in its few seconds stays readable. Its tokens don't stay (E12).
        rmSync(join(dir, '.env'), { force: true });
        mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 });
        renameSync(dir, freeAside(join(root, 'backups'), `${profile}@${new Date(now()).toISOString().slice(0, 10)}-failed-move`));
        rmSync(staging, { recursive: true, force: true });
        return;
      }
      // A restore that didn't start: today's copy goes back, with its own files.
      if (!existsSync(join(staging, 'old'))) return;
      // Held again, so nothing starts the copy that failed; `resume` starts today's copy and ends the hold.
      const held = readHold(profile);
      if (held?.starting) writeHold(profile, { ...held, starting: false });
      try { await driver.stop(label(dir)); } catch { /* not running */ }
      if (existsSync(dir)) renameSync(dir, join(staging, 'failed'));
      for (const name of meta?.carried ?? []) {
        if (existsSync(join(staging, 'failed', name))) renameSync(join(staging, 'failed', name), join(staging, 'old', name));
      }
      renameSync(join(staging, 'old'), dir);
      rmSync(staging, { recursive: true, force: true });
    },

    async discard(moveId) {
      const staging = incomingDir(moveId);
      // A restore mid-swap is never discarded: `fail` puts today's copy back first.
      if (existsSync(join(staging, 'old'))) throw new Error('A restore is part way: it must be undone, not discarded.');
      rmSync(staging, { recursive: true, force: true });
    },

    backups: async () => listBackups(join(root, 'backups')),
  };
  return self;
};

/** A free name for a folder set aside in `dir`. */
const freeAside = (dir: string, name: string): string => {
  if (!existsSync(join(dir, name))) return join(dir, name);
  for (let n = 2; ; n += 1) if (!existsSync(join(dir, `${name}-${n}`))) return join(dir, `${name}-${n}`);
};

/** Points the profile at its folders as they are on this computer. The only change a move makes to the copy. */
const fixPaths = (dir: string, mapped: Record<string, string>): void => {
  if (Object.keys(mapped).length === 0) return;
  const path = join(dir, 'profile.json');
  const profile = readProfileFile(dir);
  const map = (value: string): string => mapped[value] ?? value;
  const next: Profile = {
    ...profile,
    project: { ...profile.project, path: map(profile.project.path) },
    ...(profile.repositories ? { repositories: profile.repositories.map((repo) => ({ ...repo, path: map(repo.path) })) } : {}),
  };
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
};

/** The tokens in a profile's `.env`, for a host without a Keychain. Exported for `secret-port.ts`. */
export const envTokens = (profileDir: string): Partial<Record<SecretName, string>> => {
  const env = readEnv(join(profileDir, '.env'));
  return Object.fromEntries(SECRET_NAMES.flatMap((name) => (env[name]?.trim() ? [[name, env[name]!.trim()]] : [])));
};

/** How long an arrival that was never committed may wait before this host deletes it. */
const STALE_ARRIVAL_MS = 24 * 60 * 60_000;

/**
 * Settles what an absent Mac left on this host (E16): a hold that lapsed before commit starts the profile here again,
 * and an arrival that never got as far as commit is deleted after a day. Returns the profiles started again.
 */
export const settleLapsed = async (host: MoveHost, root: string, now = Date.now()): Promise<string[]> => {
  const resumed: string[] = [];
  const moves = join(root, 'moves');
  for (const name of existsSync(moves) ? readdirSync(moves) : []) {
    const match = /^hold-(.+)\.json$/.exec(name);
    if (!match) continue;
    const hold = readJsonOrNull(join(moves, name), isHold);
    if (!hold || hold.step !== 'paused' || Date.parse(hold.until) > now) continue;
    try { await host.resume(match[1]!, hold.moveId); resumed.push(match[1]!); } catch { /* tried again next time */ }
  }
  const incoming = join(root, '.incoming');
  for (const name of existsSync(incoming) ? readdirSync(incoming) : []) {
    const dir = join(incoming, name);
    const meta = readJsonOrNull(join(dir, 'meta.json'), isIncoming);
    // Only an arrival still in staging: once `data/` became the profile, `fail` needs the record.
    if (!existsSync(join(dir, 'data')) || existsSync(join(dir, 'old'))) continue;
    if (meta && Date.parse(meta.createdAt) > now - STALE_ARRIVAL_MS) continue;
    rmSync(dir, { recursive: true, force: true });
  }
  return resumed;
};
