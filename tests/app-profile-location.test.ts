import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { profileToRemember, startupProfile } from '../app/main/profile-location.ts';
import { profilesUnder } from '../src/profiles.ts';

test('--profile or BOT_PROFILE wins over the saved folder and discovery', () => {
  assert.equal(startupProfile({ argument: '/p/arg', saved: '/p/saved', discovered: ['/p/one'] }), '/p/arg');
  assert.equal(startupProfile({ argument: 'relative/p', saved: null, discovered: [] }), resolve('relative/p'));
});

test('a launch from Finder uses the saved folder, then the only profile in the default location', () => {
  assert.equal(startupProfile({ saved: '/p/saved', discovered: ['/p/one'] }), '/p/saved');
  assert.equal(startupProfile({ saved: null, discovered: ['/p/one'] }), '/p/one');
  assert.equal(startupProfile({ saved: null, discovered: ['/p/one', '/p/two'] }), null, 'two profiles: the owner picks one');
  assert.equal(startupProfile({ saved: null, discovered: [] }), null);
});

test('the startup profile is remembered for the next launch when it is new', () => {
  assert.equal(profileToRemember('/p/arg', null), '/p/arg');
  assert.equal(profileToRemember('/p/arg', '/p/saved'), '/p/arg');
  assert.equal(profileToRemember('/p/saved', '/p/saved'), null);
  assert.equal(profileToRemember(null, '/p/saved'), null);
});

test('discovery lists only folders with a profile.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'serra-profiles-'));
  try {
    for (const id of ['beta', 'alpha', 'empty']) mkdirSync(join(root, id));
    writeFileSync(join(root, 'alpha/profile.json'), '{}');
    writeFileSync(join(root, 'beta/profile.json'), '{}');
    writeFileSync(join(root, 'stray.json'), '{}');
    assert.deepEqual(profilesUnder(root), [join(root, 'alpha'), join(root, 'beta')]);
    assert.deepEqual(profilesUnder(join(root, 'missing')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
