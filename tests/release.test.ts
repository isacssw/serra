import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  changelogSection, compareVersions, dateChangelog, isPrerelease, isVersion, setPackageVersion, shouldPublish,
} from '../scripts/release.ts';

test('versions: semver precedence, prereleases before their release', () => {
  const ordered = ['0.0.0', '0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta.1', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) assert.ok(compareVersions(ordered[i - 1]!, ordered[i]!) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(compareVersions('0.1.0-alpha.1', '0.1.0-alpha.1'), 0);
  assert.ok(isVersion('0.1.0-alpha.2') && !isVersion('v0.1.0') && !isVersion('0.1') && !isVersion('01.0.0'));
  assert.ok(isPrerelease('0.1.0-alpha.2') && !isPrerelease('1.0.0'));
});

test('package.json: the version changes and nothing else does', () => {
  const before = '{\n  "name": "serra",\n  "version": "0.0.0",\n  "private": true\n}\n';
  assert.equal(setPackageVersion(before, '0.1.0-alpha.1'), before.replace('0.0.0', '0.1.0-alpha.1'));
  assert.throws(() => setPackageVersion('{\n  "name": "serra"\n}\n', '1.0.0'), /no "version" field/);
});

test('changelog: Unreleased becomes the dated version, a new Unreleased goes above it, and its notes are found', () => {
  const log = '# Changelog\n\nIntro.\n\n## Unreleased\n\n- New thing.\n- Fix.\n\n## 0.1.0-alpha.1 (2026-11-01)\n\n- First.\n';
  const dated = dateChangelog(log, '0.1.0-alpha.2', '2026-11-20');
  assert.equal(dated, '# Changelog\n\nIntro.\n\n## Unreleased\n\n## 0.1.0-alpha.2 (2026-11-20)\n\n- New thing.\n- Fix.\n\n## 0.1.0-alpha.1 (2026-11-01)\n\n- First.\n');
  assert.equal(changelogSection(dated, '0.1.0-alpha.2'), '- New thing.\n- Fix.');
  assert.equal(changelogSection(dated, '0.1.0-alpha.1'), '- First.');
  assert.throws(() => dateChangelog(dated, '0.1.0-alpha.3', '2026-11-21'), /empty: nothing to release/);
  assert.throws(() => dateChangelog(log, '0.1.0-alpha.1', '2026-11-21'), /already has a section/);
  assert.throws(() => dateChangelog('# Changelog\n', '1.0.0', '2026-11-21'), /no "## Unreleased" section/);
  assert.throws(() => changelogSection(log, '9.9.9'), /no section for 9\.9\.9/);
});

test('publish: only a push that raises package.json version publishes', () => {
  assert.equal(shouldPublish('0.0.0', '0.1.0-alpha.1'), true);
  assert.equal(shouldPublish('0.1.0-alpha.1', '0.1.0-alpha.1'), false, 'an ordinary merge');
  assert.equal(shouldPublish(null, '0.0.0'), false, 'the commit that adds the field');
  assert.equal(shouldPublish('0.1.0', '0.1.0-rc.1'), false, 'never backwards');
  assert.equal(shouldPublish('0.1.0', 'banana'), false);
});

test('the repository is set up the way the release workflows expect', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string };
  assert.ok(pkg.version && isVersion(pkg.version), 'package.json has a semver version');
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  assert.match(changelog, /^## Unreleased$/m, 'CHANGELOG.md has an Unreleased section');
  // The app takes its version from package.json; an override in electron-builder.yml would hide the release's.
  assert.doesNotMatch(readFileSync('electron-builder.yml', 'utf8'), /^\s*extraMetadata:[\s\S]*?^\s+version:/m);
});
