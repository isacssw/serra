import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/install.sh', import.meta.url).pathname;
const pinned = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

test('install.sh explains itself, including what it may install for this user', () => {
  const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-setup/);
  assert.match(help.stdout, /SHA-256 pinned below/);
  assert.match(help.stdout, /no sudo, no service,\s+no open port/);
});

// Node isn't on the system path (/usr/bin:/bin) on a developer Mac or CI, so the script must fetch its own.
const systemNode = ['/usr/bin/node', '/bin/node'].some((path) => existsSync(path));
test('install.sh refuses a Node download that doesn\'t match its pinned checksum, and keeps nothing of it', { skip: systemNode || process.getuid?.() === 0 }, () => {
  const home = mkdtempSync(join(tmpdir(), 'serra-install-'));
  try {
    const mirror = join(home, 'mirror/v24.22.3');
    mkdirSync(mirror, { recursive: true });
    for (const target of pinned) writeFileSync(join(mirror, `node-v24.22.3-${target}.tar.gz`), 'not node');
    const run = spawnSync('bash', [script, '--no-setup'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', SERRA_NODE_MIRROR: `file://${join(home, 'mirror')}`, T3_BIN: join(home, 'none') },
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /Node is missing\. Will install Node 24\.22\.3 for you only/);
    // Without setup, gh and T3 are only noted: the code can be installed first.
    assert.match(run.stdout, /T3 Code CLI not found.*\(needed before setup\)/);
    assert.match(run.stderr, /doesn't match its pinned checksum, so it wasn't installed/);
    assert.deepEqual(readdirSync(join(home, '.local/share/serra/runtime')), []);
    assert.equal(existsSync(join(home, '.local/bin/serra')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
