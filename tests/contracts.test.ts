import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as config from '../src/config.ts';
import * as contracts from '../src/contracts.ts';
import type { Job as ContractJob, Profile } from '../src/contracts.ts';
import { runCli, type Command, type CommandTable } from '../src/manage.ts';
import type { Job } from '../src/types.ts';

const profile = (allowedUsers: string[] = []): Profile => ({
  version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
  project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers,
});

const tempProfile = (t: TestContext): string => {
  const directory = mkdtempSync(join(tmpdir(), 'serra-contracts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(profile(), null, 2) + '\n', { mode: 0o600 });
  return directory;
};
const read = (directory: string): string => readFileSync(join(directory, 'profile.json'), 'utf8');
const strays = (directory: string): string[] => readdirSync(directory).filter((name) => name.endsWith('.tmp'));

test('contracts re-export the existing validator, writers and Job instead of copying them', () => {
  assert.equal(contracts.validateProfile, config.validateProfile);
  assert.equal(contracts.writeProfileFile, config.writeProfileFile);
  assert.equal(contracts.writeFileAtomic, config.writeFileAtomic);
  // Compile-time: the contract Job and the stored Job are the same type in both directions.
  const stored = {} as Job; const shared: ContractJob = stored; const back: Job = shared;
  assert.equal(back, stored);
});

test('writeProfileFile replaces profile.json with owner-only permissions and leaves no temp file', (t) => {
  const directory = tempProfile(t);
  const written = contracts.writeProfileFile(directory, profile(['U0000000001']));
  assert.deepEqual(written.allowedUsers, ['U0000000001']);
  assert.deepEqual(contracts.readProfileFile(directory).allowedUsers, ['U0000000001']);
  assert.ok(read(directory).endsWith('}\n'));
  assert.equal(statSync(join(directory, 'profile.json')).mode & 0o777, 0o600);
  assert.deepEqual(strays(directory), []);
});

test('an invalid profile is rejected before anything touches the disk', (t) => {
  const directory = tempProfile(t);
  const before = read(directory);
  assert.throws(() => contracts.writeProfileFile(directory, { ...profile(), allowedUsers: ['not-an-id'] }), /Invalid allowed Slack member ID/);
  assert.equal(read(directory), before);
  assert.deepEqual(strays(directory), []);
});

test('a write that fails part way leaves the old profile.json intact and cleans up', (t) => {
  const directory = tempProfile(t);
  const before = read(directory);
  const halfWrite: config.AtomicWriteIo = {
    writeFileSync: (fd, data) => { writeFileSync(fd, data.slice(0, data.length / 2)); throw new Error('disk full'); },
    renameSync: () => assert.fail('must not rename a partial file'),
  };
  assert.throws(() => contracts.writeProfileFile(directory, profile(['U0000000001']), { io: halfWrite }), /disk full/);
  assert.equal(read(directory), before);
  assert.deepEqual(strays(directory), []);
  const failedRename: config.AtomicWriteIo = { writeFileSync, renameSync: () => { throw new Error('rename failed'); } };
  assert.throws(() => contracts.writeProfileFile(directory, profile(['U0000000001']), { io: failedRename }), /rename failed/);
  assert.equal(read(directory), before);
  assert.deepEqual(strays(directory), []);
});

test('a process killed between writing and renaming leaves the old profile.json intact', (t) => {
  const directory = tempProfile(t);
  const before = read(directory);
  // A real crash: the child writes the new profile to its temp file, then dies with SIGKILL before the rename.
  const script = `
    import { writeFileSync } from 'node:fs';
    import { writeProfileFile } from ${JSON.stringify(new URL('../src/contracts.ts', import.meta.url).href)};
    const next = JSON.parse(process.argv[2]);
    writeProfileFile(process.argv[1], next, { io: { writeFileSync, renameSync: () => process.kill(process.pid, 'SIGKILL') } });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory, JSON.stringify(profile(['U0000000001']))], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(read(directory), before);
  assert.deepEqual(contracts.readProfileFile(directory).allowedUsers, []);
  // The crash leaves its temp file behind; the next write isn't affected by it.
  assert.equal(strays(directory).length, 1);
  contracts.writeProfileFile(directory, profile(['U0000000002']));
  assert.deepEqual(contracts.readProfileFile(directory).allowedUsers, ['U0000000002']);
});

const fake = (summary: string, run: Command['run'] = async () => {}, extra: Partial<Command> = {}) =>
  async () => ({ default: { summary, run, ...extra } satisfies Command });

const cli = async (argv: string[], table: CommandTable, platform: NodeJS.Platform = 'darwin') => {
  const out: string[] = []; const err: string[] = [];
  const code = await runCli(argv, { table, platform, log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('the CLI dispatches through the command table and gives each command its parsed context', async () => {
  let seen: Parameters<Command['run']>[0] | undefined;
  const table = {
    hello: fake('Say hello', async (context) => { seen = context; context.log('hi'); }, { usage: ['pnpm bot hello --profile /p'] }),
    deploy: fake('Mac only', async () => {}, { macOnly: true }),
    broken: fake('Fails', async () => { throw new Error('went wrong'); }),
  };
  const help = await cli(['--help'], table);
  assert.equal(help.code, 0);
  assert.match(help.out, /hello\s+Say hello/); assert.match(help.out, /deploy\s+Mac only \(macOS\)/); assert.match(help.out, /pnpm bot hello --profile \/p/);

  const ok = await cli(['--', 'hello', '--profile', '/Users/you/profile', '--days', '3', '--apply'], table);
  assert.deepEqual([ok.code, ok.out, ok.err], [0, 'hi', '']);
  assert.equal(seen?.profileDir, '/Users/you/profile');
  assert.equal(seen?.option('--days'), '3'); assert.equal(seen?.option('--from'), undefined);
  assert.equal(seen?.flag('--apply'), true); assert.equal(seen?.flag('--dry'), false);
  assert.throws(() => seen?.option('--apply'), /--apply needs a value/);

  assert.deepEqual(await cli(['nope', '--profile', '/p'], table), { code: 1, out: '', err: 'Unknown bot command: nope. Run pnpm bot --help.' });
  assert.match((await cli(['toString', '--profile', '/p'], table)).err, /Unknown bot command/);
  assert.match((await cli(['deploy', '--profile', '/p'], table, 'linux')).err, /supports macOS/);
  assert.equal((await cli(['hello', '--profile', '/p'], table, 'linux')).code, 0);
  const saved = process.env.BOT_PROFILE; delete process.env.BOT_PROFILE;
  try { assert.match((await cli(['hello'], table)).err, /--profile \/absolute\/profile\/folder is required/); }
  finally { if (saved !== undefined) process.env.BOT_PROFILE = saved; }
  assert.deepEqual(await cli(['broken', '--profile', '/p'], table), { code: 1, out: '', err: 'went wrong' });
});

test('pnpm bot cleanup still runs end to end through the table', (t) => {
  const directory = tempProfile(t);
  mkdirSync(join(directory, 'knowledge'));
  writeFileSync(join(directory, 'state.json'), '{}');
  writeFileSync(join(directory, '.env'), 'SLACK_BOT_TOKEN=xoxb-fixture\nSLACK_APP_TOKEN=xapp-fixture\n');
  const manage = new URL('../src/manage.ts', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [manage, 'cleanup', '--profile', directory], { encoding: 'utf8', env: { ...process.env, BOT_PROFILE: '' } });
  assert.match(output, /0 worktree\(s\) would be removed/);
  const bad = spawnSync(process.execPath, [manage, 'cleanup', '--profile', directory, '--days', 'soon'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /--days needs a number of days/);
});

test('pnpm bot still runs when manage.ts is reached through a symlinked folder', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'serra-link-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = join(directory, 'release');
  symlinkSync(new URL('..', import.meta.url).pathname, link);
  const output = execFileSync(process.execPath, [join(link, 'src/manage.ts'), '--help'], { encoding: 'utf8' });
  assert.match(output, /Usage: pnpm bot <command>/);
});
