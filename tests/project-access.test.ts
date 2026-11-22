import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProjectAccess } from '../src/project-access.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'serra-access-'));

test('checkProjectAccess passes for a readable repository', async () => {
  const repo = temp();
  execFileSync('git', ['init', '-q', repo]);
  await checkProjectAccess([repo, repo]);
});

test('checkProjectAccess names the repository and the macOS setting when git cannot read it', async () => {
  const missing = join(temp(), 'gone');
  await assert.rejects(checkProjectAccess([missing]), (error: Error) => {
    assert.match(error.message, new RegExp(`Can't read the repository ${missing}`));
    assert.match(error.message, /Privacy & Security › Files and Folders/);
    return true;
  });
});

// Under launchd, git in ~/Documents waits on the macOS permission prompt. The daemon must not hang on it.
test('checkProjectAccess gives up on a git that hangs, with the same guidance', async () => {
  const dir = temp();
  const git = join(dir, 'git');
  writeFileSync(git, '#!/bin/sh\nsleep 30\n');
  chmodSync(git, 0o755);
  const started = Date.now();
  await assert.rejects(checkProjectAccess([dir], { git, timeoutMs: 300 }), /timed out after 300ms.*Files and Folders/s);
  assert.ok(Date.now() - started < 5_000);
});
