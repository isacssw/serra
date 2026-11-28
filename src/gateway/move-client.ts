// A paired server's side of a move or a restore (SB-34), as the Mac runs it: the same steps as this Mac's own
// (`moves/host.ts`), each one a call to the server's gateway, which runs that code there. Files go as their bytes,
// one request each; tokens go in the body of `commit` and `secrets` over the pinned link, and nowhere else.
import { isArrayOf, isBoolean, isNumber, isRecord, isRecordOf, isString, type Guard } from '../lib/guards.ts';
import { isDataPath, type BackupEntry, type DataFile } from '../profile-backup.ts';
import type { MoveHost, MoveSecret, ProfileFacts, TargetCheck } from '../moves/host.ts';
import { isSecretName } from '../secrets.ts';
import type { GatewayClient } from './client.ts';

/** A commit can prepare and start a bot, which takes a while on a small server. */
const LONG_MS = 15 * 60_000;

const isFacts: Guard<ProfileFacts> = (value): value is ProfileFacts =>
  isRecord(value) && isString(value.id) && isString(value.name) && isNumber(value.running) && isNumber(value.waiting) && isNumber(value.bytes)
  && isNumber(value.files) && isArrayOf(isString)(value.links) && isArrayOf(isString)(value.paths);
const isCheck: Guard<TargetCheck> = (value): value is TargetCheck =>
  isRecord(value) && isArrayOf(isString)(value.problems) && isRecordOf(isString)(value.mapped);
const isCounts = (value: unknown): value is { running: number; waiting: number } => isRecord(value) && isNumber(value.running) && isNumber(value.waiting);
const isFile: Guard<DataFile> = (value): value is DataFile =>
  isRecord(value) && isString(value.path) && isDataPath(value.path) && isNumber(value.size) && isString(value.sha256) && /^[0-9a-f]{64}$/.test(value.sha256);
const isSecret: Guard<MoveSecret> = (value): value is MoveSecret =>
  isRecord(value) && isSecretName(value.name)
  && (value.value === undefined || isString(value.value)) && (value.reference === undefined || isString(value.reference));
const isBackup: Guard<BackupEntry> = (value): value is BackupEntry =>
  isRecord(value) && isString(value.id) && isString(value.profile) && (value.kind === 'removed' || value.kind === 'moved' || value.kind === 'restore')
  && isString(value.at) && isNumber(value.files) && (value.detail === null || isString(value.detail));

const expect = <T>(guard: Guard<T>, value: unknown, server: string): T => {
  if (!guard(value)) throw new Error(`${server} sent an answer this app can’t read.`);
  return value;
};

export const remoteMoveHost = (client: GatewayClient, name: string): MoveHost => {
  const call = (op: string, args: unknown[], timeoutMs?: number): Promise<unknown> => client.move(op, args, timeoutMs);
  return {
    name,
    facts: async (profile) => expect(isFacts, await call('facts', [profile]), name),
    check: async (incoming) => expect(isCheck, await call('check', [incoming]), name),
    drain: async (profile) => expect(isCounts, await call('drain', [profile]), name),
    later: async (profile) => { await call('later', [profile]); },
    pause: async (profile, moveId) => { await call('pause', [profile, moveId], LONG_MS); },
    hold: async (profile, moveId, step) => { await call('hold', [profile, moveId, step]); },
    resume: async (profile, moveId) => { await call('resume', [profile, moveId], LONG_MS); },
    backup: async (profile, moveId, note, kind) => expect(isArrayOf(isFile), await call('backup', [profile, moveId, note, kind], LONG_MS), name),
    readFile: (moveId, path) => client.download(moveId, path),
    secrets: async (profile) => expect(isArrayOf(isSecret), await call('secrets', [profile]), name),
    archive: async (profile, moveId) => { await call('archive', [profile, moveId], LONG_MS); },
    receive: async (moveId, profile, files) => expect(isArrayOf(isString), await call('receive', [moveId, profile, files], LONG_MS), name),
    writeFile: (moveId, path, data) => client.upload(moveId, path, data),
    stageBackup: async (moveId, profile, backupId) => { await call('stageBackup', [moveId, profile, backupId], LONG_MS); },
    verify: async (moveId) => { await call('verify', [moveId], LONG_MS); },
    commit: async (moveId, options) => { await call('commit', [moveId, options], LONG_MS); },
    live: async (profile) => expect(isBoolean, await call('live', [profile]), name),
    fail: async (moveId, profile, replace) => { await call('fail', [moveId, profile, replace], LONG_MS); },
    discard: async (moveId) => { await call('discard', [moveId], LONG_MS); },
    backups: async () => expect(isArrayOf(isBackup), await client.backups(), name),
  };
};
