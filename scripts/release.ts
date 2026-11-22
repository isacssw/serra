// Release helpers for the workflows in .github/workflows/release-*.yml. See docs/releasing.md.
//
//   node scripts/release.ts prepare <version>   set package.json's version and date the changelog's Unreleased section
//   node scripts/release.ts notes <version>     print the GitHub Release body: that version's changelog section and how to upgrade
//   node scripts/release.ts should-publish      print `publish=true|false`, `version=…` and `tag=…` for $GITHUB_OUTPUT,
//                                               from whether HEAD changed package.json's version
//
// package.json's `version` is the last version released (or being released by a release PR). The changelog keeps
// what is merged but not released under `## Unreleased`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const UNRELEASED = '## Unreleased';

export const isVersion = (value: string): boolean => SEMVER.test(value);
export const isPrerelease = (version: string): boolean => version.includes('-');

/** Semver precedence: negative when `a` comes before `b`. Build metadata isn't supported (not used here). */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string) => {
    const m = SEMVER.exec(v);
    if (!m) throw new Error(`Not a version: ${v}`);
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') ?? [] };
  };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release comes after its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
};

/** package.json with `version` replaced. Keeps the file's formatting; refuses a file without a version field. */
export const setPackageVersion = (json: string, version: string): string => {
  const pattern = /^(\s*"version":\s*)"[^"]*"/m;
  if (!pattern.test(json)) throw new Error('package.json has no "version" field');
  return json.replace(pattern, `$1"${version}"`);
};

/** The changelog with `## Unreleased` renamed to the version and date, and a new empty `## Unreleased` above it. */
export const dateChangelog = (changelog: string, version: string, date: string): string => {
  const lines = changelog.split('\n');
  const at = lines.findIndex((line) => line.trim() === UNRELEASED);
  if (at < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  if (lines.some((line) => line.startsWith(`## ${version} `) || line.trim() === `## ${version}`)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const body = changelogSectionAt(lines, at);
  if (!body.trim()) throw new Error(`The "${UNRELEASED}" section in CHANGELOG.md is empty: nothing to release`);
  lines.splice(at, 1, UNRELEASED, '', `## ${version} (${date})`);
  return lines.join('\n');
};

const changelogSectionAt = (lines: string[], heading: number): string => {
  let end = lines.findIndex((line, i) => i > heading && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(heading + 1, end).join('\n').trim();
};

/** The body of a version's changelog section, without its heading. */
export const changelogSection = (changelog: string, version: string): string => {
  const lines = changelog.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`## ${version} `) || line.trim() === `## ${version}`);
  if (at < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return changelogSectionAt(lines, at);
};

/**
 * Ends every release's notes: owners still on a manual install need one last one (README › Updating). The app leaves
 * it out of the notes it shows (`UPGRADE_NOTE_START` in updates.logic.ts). Drop it once alpha.2 is long gone (the beta).
 */
export const UPGRADE_NOTE = 'On alpha.2 or older? Install this version by hand once; from then on Serra updates itself. '
  + 'See [Updating](https://github.com/isacssw/serra#updating).';

/** The GitHub Release body: the changelog section, then how to upgrade. */
export const releaseNotes = (changelog: string, version: string): string => `${changelogSection(changelog, version)}\n\n${UPGRADE_NOTE}`;

/**
 * Whether a push to main should publish a release: only when it changed package.json's version to a newer one,
 * which is what merging a release PR does. A commit that adds the field (or a first commit) never publishes.
 */
export const shouldPublish = (before: string | null, after: string | null): boolean =>
  before !== null && after !== null && isVersion(before) && isVersion(after) && compareVersions(after, before) > 0;

const versionAt = (rev: string): string | null => {
  try {
    const json = JSON.parse(execFileSync('git', ['show', `${rev}:package.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return typeof json.version === 'string' ? json.version : null;
  } catch { return null; }
};

const main = (args: string[]): void => {
  const [command, version] = args;
  const pkgPath = 'package.json';
  const changelogPath = 'CHANGELOG.md';
  if (command === 'prepare') {
    if (!version || !isVersion(version)) throw new Error(`Usage: release.ts prepare <version>, like 0.1.0-alpha.2 (got ${version ?? 'nothing'})`);
    const pkg = readFileSync(pkgPath, 'utf8');
    const current = JSON.parse(pkg).version as string;
    if (compareVersions(version, current) <= 0) throw new Error(`${version} isn't newer than the current version ${current}`);
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(changelogPath, dateChangelog(readFileSync(changelogPath, 'utf8'), version, date));
    writeFileSync(pkgPath, setPackageVersion(pkg, version));
    console.log(`Prepared ${version} (was ${current}).`);
  } else if (command === 'notes') {
    if (!version) throw new Error('Usage: release.ts notes <version>');
    console.log(releaseNotes(readFileSync(changelogPath, 'utf8'), version));
  } else if (command === 'should-publish') {
    const after = versionAt('HEAD');
    const publish = shouldPublish(versionAt('HEAD^'), after);
    console.log(`publish=${publish}`);
    console.log(`version=${after ?? ''}`);
    console.log(`tag=${after ? `v${after}` : ''}`);
    console.log(`prerelease=${after ? isPrerelease(after) : false}`);
  } else {
    throw new Error('Usage: release.ts prepare <version> | notes <version> | should-publish');
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
