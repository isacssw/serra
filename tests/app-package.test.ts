import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { toolPath } from '../app/main/tool-path.ts';
import { codeRoot } from '../src/config.ts';
import { PACKAGED_SOURCE, releaseSourceRoot, stageReleaseSource } from '../src/deploy.ts';
import { builderConfig, packaged } from '../scripts/lib/packaged-files.ts';

const config = builderConfig();

test('the packaged app adds Homebrew and ~/.local/bin to launchd\'s short PATH, after what is there', () => {
  assert.equal(toolPath('/usr/bin:/bin:/usr/sbin:/sbin', '/Users/me'), '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin');
  assert.equal(toolPath('/opt/homebrew/bin:/usr/bin', '/Users/me'), '/opt/homebrew/bin:/usr/bin:/usr/local/bin:/Users/me/.local/bin', 'no duplicates');
  assert.equal(toolPath(undefined, '/Users/me'), '/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin');
});

test('the package ships a pristine copy of the daemon code for Updates › Prepare, beside the app folder', (t) => {
  // electron-builder.yml's extraResources entry: `to` is relative to Contents/Resources, where the app folder is.
  const block = config.slice(config.indexOf('extraResources:'));
  assert.match(block, /^\s+- from: app\/out\/release-source$/m);
  assert.match(block, new RegExp(`^\\s+to: ${PACKAGED_SOURCE}$`, 'm'), 'the folder prepare looks in (src/deploy.ts)');
  assert.ok(!packaged('app/out/release-source/src/index.ts'), 'not a second time inside the app folder');

  const resources = mkdtempSync(join(tmpdir(), 'serra-resources-')); t.after(() => rmSync(resources, { recursive: true, force: true }));
  const staged = join(resources, PACKAGED_SOURCE);
  stageReleaseSource(codeRoot, staged);
  for (const name of ['src/index.ts', 'templates/brief.md', 'examples/profile.json', 'pnpm-lock.yaml', 'tsconfig.json', 'docs/configuration.md']) {
    assert.ok(existsSync(join(staged, name)), `release-source has ${name}`);
  }
  assert.equal(readFileSync(join(staged, 'package.json'), 'utf8'), readFileSync(join(codeRoot, 'package.json'), 'utf8'), 'the package.json the lockfile matches');
  assert.ok(!existsSync(join(staged, 'docs/app')), 'the screenshots in docs/app stay out');
  assert.equal(releaseSourceRoot(join(resources, 'app')), staged, 'prepare in the app folder finds it');
});
