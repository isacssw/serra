import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shortError } from '../src/lib/errors.ts';
import { ensureProject, findThreads, run, sendToThread, showThread, startFolderThread, startThread } from '../src/t3.ts';

test('CLI contract preserves custom branches, stdin briefs, follow-ups and run IDs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-t3-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 't3'); const capture = join(root, 'capture.json');
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,input})); console.log(JSON.stringify(args[1]==='start'?{threadId:'new-thread'}:args[1]==='show'?{thread:{threadId:'new-thread',link:'t3://thread',status:'idle',latestRunId:'run-2',activeRunId:null},messages:[{role:'assistant',runId:'run-2',text:'done'}]}:{}));});`, { mode: 0o700 });
  assert.equal(await startThread({ project: '/repo with spaces', baseRef: 'origin/develop', branch: 'friday/task-1', title: 'Friday: task', brief: 'quoted {{REQUEST}}\nsecond line' }, bin), 'new-thread');
  const started = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(started.args, ['thread', 'start', '--worktree', 'origin/develop', '--branch', 'friday/task-1', '--title', 'Friday: task', '--json', '/repo with spaces', '-']);
  assert.equal(started.input, 'quoted {{REQUEST}}\nsecond line');
  await startThread({ project: '/repo', baseRef: 'origin/main', branch: 'friday/task-2', title: 'Friday: task', brief: 'brief', provider: 'claude', model: 'opus' }, bin);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')).args.slice(8, 12), ['--provider', 'claude', '--model', 'opus']);
  await sendToThread('new-thread', 'Alex replied', bin);
  assert.equal(JSON.parse(readFileSync(capture, 'utf8')).input, 'Alex replied');
  assert.equal((await showThread('new-thread', bin)).thread.latestRunId, 'run-2');
});

test('a folder thread runs in the project\'s own folder, with no worktree; a project is added once, then reused', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-t3-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 't3'); const log = join(root, 'calls.jsonl');
  // Like real T3: adding the same folder twice exits 1 with ProjectAlreadyExistsError on stdout, and nothing on stderr.
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,input})+'\\n'); if(args[0]==='project'){ const seen=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter((l)=>l.includes('"project","add"')).length; if(seen>1){ console.log('ProjectAlreadyExistsError: An active project already exists for /Users/you/runs'); process.exit(1);} console.log('Added project p1'); return;} console.log(JSON.stringify({threadId:'run-thread'}));});`, { mode: 0o700 });
  await ensureProject('/Users/you/runs', 'Serra meetings', bin);
  await ensureProject('/Users/you/runs', 'Serra meetings', bin);
  assert.equal(await startFolderThread({ project: '/Users/you/runs', title: 'Serra meeting: pick out decisions', brief: 'read-only brief', provider: 'cursor', model: 'composer-2' }, bin), 'run-thread');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; input: string });
  assert.deepEqual(calls[0]!.args, ['project', 'add', '--title', 'Serra meetings', '/Users/you/runs']);
  assert.deepEqual(calls[2]!.args, ['thread', 'start', '--title', 'Serra meeting: pick out decisions', '--provider', 'cursor', '--model', 'composer-2', '--json', '/Users/you/runs', '-']);
  assert.equal(calls[2]!.input, 'read-only brief');
  // Any other failure to add the project is an error.
  writeFileSync(bin, `#!${process.execPath}\nconsole.error('T3 is not running'); process.exit(1);`, { mode: 0o700 });
  await assert.rejects(ensureProject('/Users/you/runs', 'Serra meetings', bin), /not running/);
});

test('a hung CLI command fails within its timeout', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }), /timed out/);
});

test('[INTAKE-010] findThreads reads T3\'s thread list: same title, made since the attempt, newest first; other output is an error', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-t3-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 't3'); const out = join(root, 'out.txt'); const args = join(root, 'args.json');
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('fs'); fs.writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(fs.readFileSync(${JSON.stringify(out)}, 'utf8'));`, { mode: 0o700 });
  // The shape \`t3 thread list --json\` prints: a bare array, newest first, with more fields than these.
  const thread = (threadId: string, title: string, createdAt: string) => ({ threadId, projectId: 'p1', title, link: `https://app.t3.codes/threads/${threadId}`, status: 'idle', createdAt, updatedAt: createdAt });
  writeFileSync(out, JSON.stringify([
    thread('newer', 'Friday: deploy staging', '2026-11-20T10:00:30.000Z'),
    thread('other', 'Friday: something else', '2026-11-20T10:00:20.000Z'),
    thread('older', 'Friday: deploy staging', '2026-11-20T10:00:10.000Z'),
    thread('stale', 'Friday: deploy staging', '2026-11-19T09:00:00.000Z'),
  ]));
  assert.deepEqual(await findThreads('/repo', 'Friday: deploy staging', '2026-11-20T10:00:00.000Z', bin), ['newer', 'older']);
  assert.deepEqual(JSON.parse(readFileSync(args, 'utf8')), ['thread', 'list', '--json', '--project', '/repo']);
  writeFileSync(out, '[]');
  assert.deepEqual(await findThreads('/repo', 'Friday: deploy staging', '2026-11-20T10:00:00.000Z', bin), []);
  writeFileSync(out, 'Not signed in.');
  await assert.rejects(findThreads('/repo', 'x', '2026-11-20T10:00:00.000Z', bin), /Unexpected t3 thread list output/);
});

test('a failed command never has a blank reason: T3 prints its errors to stdout, and that is what the error carries', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-t3-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 't3');
  writeFileSync(bin, `#!${process.execPath}\nconsole.log('SomeT3Error: the thread is archived'); process.exit(1);`, { mode: 0o700 });
  await assert.rejects(sendToThread('thread-1', 'hi', bin), (error: Error) => {
    assert.equal(error.message, 't3 thread send exited 1: SomeT3Error: the thread is archived');
    assert.doesNotMatch(error.message, new RegExp(root), 'the command is named, not its path');
    return true;
  });
  writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);`, { mode: 0o700 });
  await assert.rejects(sendToThread('thread-1', 'hi', bin), /t3 thread send exited 3: \(no output\)/);
});

test('a failed t3 call reads as a short sentence: never blank, never a path or raw output', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-t3-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 't3');
  const failWith = (out: string) => writeFileSync(bin, `#!${process.execPath}\nconsole.log(${JSON.stringify(out)}); process.exit(1);`, { mode: 0o700 });
  const reason = async (call: Promise<unknown>): Promise<string> => { try { await call; } catch (error) { return shortError(error); } throw new Error('expected a failure'); };

  failWith('Error: connect ECONNREFUSED /Users/you/.t3/server.sock');
  assert.equal(await reason(sendToThread('thread-1', 'hi', bin)), 'T3 Code isn’t running. Open it, then try again.');
  failWith('Error: something odd at /Users/you/.t3/state.db');
  const odd = await reason(sendToThread('thread-1', 'hi', bin));
  assert.equal(odd, 'T3 Code couldn’t run `t3 thread send`. Check that T3 Code is open and up to date.');
  assert.equal(await reason(sendToThread('thread-1', 'hi', join(root, 'nowhere', 't3'))), 'Serra can’t find T3 Code’s `t3` command. Install T3 Code and open it once.');
  // Serra's own sentences pass through, with any local path cut to its last part.
  assert.equal(shortError(new Error('Could not read /Users/you/project/notes.md')), 'Could not read notes.md');
  assert.equal(shortError(new Error('')), 'Something went wrong.');
});
