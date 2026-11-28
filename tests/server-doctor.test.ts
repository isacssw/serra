import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Exec, ExecResult } from '../src/exec.ts';
import { diagnoseHost, formatHostChecks } from '../src/server-doctor.ts';

/** A home folder with stand-in `gh`, `t3` and `claude` on its path, and a fake runner that answers per command. */
const host = (t: TestContext, answers: Record<string, Partial<ExecResult>> = {}, tools = ['gh', 'claude']) => {
  const home = mkdtempSync(join(tmpdir(), 'serra-host-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  mkdirSync(join(home, '.t3/bin'), { recursive: true });
  mkdirSync(bin);
  for (const name of tools) { writeFileSync(join(bin, name), '#!/bin/sh\n'); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(home, '.t3/bin/t3'), '#!/bin/sh\n'); chmodSync(join(home, '.t3/bin/t3'), 0o755);
  const calls: string[] = [];
  const run: Exec = async (command, args) => {
    const key = [command.split('/').pop(), ...args].join(' ');
    calls.push(key);
    const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1] ?? {};
    return { code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...answer };
  };
  const base = { run, home, path: bin, nodeVersion: '24.22.3', uid: 1000, user: 'you', freeBytes: () => 50 * 1024 ** 3, t3Bin: join(home, '.t3/bin/t3') };
  return { base, calls };
};

const byName = (checks: Awaited<ReturnType<typeof diagnoseHost>>) => Object.fromEntries(checks.map((check) => [check.name, check]));

test('a ready Linux server passes every check, and lingering means the bot starts at boot', async (t) => {
  const { base } = host(t, { 'git --version': { stdout: 'git version 2.43.0\n' }, 'loginctl show-user you': { stdout: 'yes\n' } });
  const checks = await diagnoseHost({ ...base, platform: 'linux' });
  assert.deepEqual(checks.filter((check) => check.state !== 'ok'), []);
  assert.equal(byName(checks).Git?.detail, '2.43.0');
  assert.equal(byName(checks)['Background service']?.detail, 'systemd, starts at boot');
  assert.match(formatHostChecks(checks), /^PASS User: you$/m);
});

test('without lingering the server works but says how to keep the bot up after logout, with sudo as the owner’s step', async (t) => {
  const { base, calls } = host(t, { 'loginctl show-user you': { stdout: 'no\n' } });
  const service = byName(await diagnoseHost({ ...base, platform: 'linux' }))['Background service'];
  assert.equal(service?.state, 'warn');
  assert.match(service?.detail ?? '', /stops when you log out.*sudo loginctl enable-linger you/);
  // Doctor only reads: it never runs sudo or changes lingering itself.
  assert.equal(calls.some((call) => /sudo|enable-linger/.test(call)), false);
});

test('missing tools, an old Node, root, a full disk and no systemd fail or warn with the fix', async (t) => {
  const { base } = host(t, { 'systemctl --user': { code: 1, stderr: 'Failed to connect to bus' }, 'gh auth status': { code: 1 } }, ['gh']);
  const checks = byName(await diagnoseHost({ ...base, platform: 'linux', nodeVersion: '20.11.0', uid: 0, freeBytes: () => 1024 ** 3 }));
  assert.deepEqual([checks.User?.state, checks.Node?.state, checks['GitHub CLI']?.state, checks.Disk?.state], ['fail', 'fail', 'fail', 'fail']);
  assert.match(checks.User?.detail ?? '', /root. Run Serra as your own user/);
  assert.match(checks.Node?.detail ?? '', /20\.11\.0.*Node 24/);
  assert.match(checks['GitHub CLI']?.detail ?? '', /gh auth login/);
  assert.match(checks.Disk?.detail ?? '', /1\.0 GB free\. Free at least 2 GB/);
  assert.equal(checks['Coding agents']?.state, 'warn');
  assert.equal(checks['Background service']?.state, 'warn');
  assert.match(checks['Background service']?.detail ?? '', /foreground only/);
});

test('macOS uses launchd and never asks systemd', async (t) => {
  const { base, calls } = host(t);
  const checks = byName(await diagnoseHost({ ...base, platform: 'darwin' }));
  assert.equal(checks['Background service']?.detail, 'launchd');
  assert.equal(calls.some((call) => call.startsWith('systemctl') || call.startsWith('loginctl')), false);
});
