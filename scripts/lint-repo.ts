// `pnpm lint:repo`: rules about the repository itself (config, templates, packaging, styles) that a type checker or
// oxlint can't express. Each check is named for the rule it holds. These were tests that read source instead of
// running behaviour (SERRA-57 audit); here they say what they are. Runs in `pnpm lint` and so in CI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { missingRuntimeFiles, runtimeFiles } from '../app/main/runtime-files.ts';
import { windowOptions } from '../app/main/window-options.ts';
import { defaultPrefs } from '../app/main/prefs.ts';
import { codeRoot } from '../src/config.ts';
import { commands } from '../src/manage.ts';
import { builderConfig, packaged } from './lib/packaged-files.ts';
import { isVersion } from './release.ts';

const read = (path: string): string => readFileSync(join(codeRoot, path), 'utf8');
const filesUnder = (folder: string, match: (file: string) => boolean): string[] =>
  readdirSync(join(codeRoot, folder), { recursive: true, encoding: 'utf8' }).filter(match).map((file) => join(folder, file));

const checks: [name: string, run: () => void | Promise<void>][] = [];
const check = (name: string, run: () => void | Promise<void>): void => { checks.push([name, run]); };

// --- Release -------------------------------------------------------------------------------------------------------

check('release: package.json has a semver version, CHANGELOG.md an Unreleased section, and electron-builder no version override', () => {
  const pkg = JSON.parse(read('package.json')) as { version?: unknown };
  assert.ok(typeof pkg.version === 'string' && isVersion(pkg.version), 'package.json has a semver version');
  assert.match(read('CHANGELOG.md'), /^## Unreleased$/m, 'CHANGELOG.md has an Unreleased section');
  // The app takes its version from package.json; an override in electron-builder.yml would hide the release's.
  assert.doesNotMatch(builderConfig(), /^\s*extraMetadata:[\s\S]*?^\s+version:/m);
});

// --- Templates (what a new profile is seeded with, and what a worker reads) ----------------------------------------

check('templates/brief.md: workers propose knowledge and never approve it, and replace an old rule instead of adding beside it', () => {
  const brief = read('templates/brief.md');
  const text = brief.replace(/\s+/g, ' ');
  assert.doesNotMatch(brief, /promote it:/i);
  assert.doesNotMatch(brief, /a row in `index\.md`/);
  assert.match(text, /Never promote, merge or undo a proposal, and never edit `index\.md`, `log\.md` or a page outside `proposals\/` yourself/);
  assert.match(text, /check the index for a page on the same topic\. If there is one, add `target: <that page>`/);
  assert.match(text, /write the whole page as it should now read/);
  assert.match(text, /keep the old one under a `Replaced` heading .* with the date it stopped applying\. Never leave both as current rules\./);
  assert.match(read('templates/knowledge/proposals/README.md'), /`Replaced` heading with the date it stopped applying/);
});

check('templates carry no personal name, Slack ID or home folder: the owner comes from the profile', () => {
  const files = ['templates/brief.md', 'templates/interview.md', 'templates/manifest.json', ...filesUnder('templates/knowledge', (file) => file.endsWith('.md'))];
  for (const file of files) assert.doesNotMatch(read(file), /Sam Rivera|\b[UWCDG]0[A-Z0-9]{8,}\b|\/Users\/(?!you\b)/, file);
});

// --- CLI -----------------------------------------------------------------------------------------------------------

check('src/commands: every file has exactly one line in the command table, and every line loads a command', async () => {
  const files = readdirSync(join(codeRoot, 'src/commands')).filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -3)).sort();
  assert.deepEqual(Object.keys(commands).sort(), files);
  for (const [name, load] of Object.entries(commands)) {
    const command = (await load()).default;
    assert.ok(command.summary.trim(), `${name} needs a summary`);
    assert.equal(typeof command.run, 'function', name);
  }
  for (const name of ['prepare', 'activate', 'rollback', 'status', 'stop', 'start', 'cleanup']) assert.ok(name in commands, name);
  for (const name of ['activate', 'rollback', 'status', 'stop', 'start']) assert.equal((await commands[name]!()).default.macOnly, true, name);
});

// --- App security and packaging ------------------------------------------------------------------------------------

check('app window: context isolation, sandbox, no Node integration, preload only', () => {
  const options = windowOptions('/Users/you/serra/app/out/preload.cjs', defaultPrefs.window);
  assert.equal(options.title, 'Serra');
  assert.deepEqual(options.webPreferences, {
    preload: '/Users/you/serra/app/out/preload.cjs',
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  });
});

check('app preload: bundles only itself, the bridge, its pure setup error and electron', async () => {
  const result = await build({
    entryPoints: [join(codeRoot, 'app/preload.ts')], absWorkingDir: codeRoot,
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false, metafile: true, logLevel: 'silent',
  });
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(), ['app/main/bridge.ts', 'app/preload.ts', 'src/setup-incomplete.ts']);
  const required = [...(result.outputFiles[0]?.text ?? '').matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(required)], ['electron']);
});

check('app package: carries every file the code reads at run time, at the same relative path', () => {
  assert.deepEqual(runtimeFiles.filter((path) => !packaged(path)), [], 'electron-builder.yml files must cover these');
});

check('app package: templates, examples and the menubar icons exist in the checkout', () => {
  // app/out/ only exists after `pnpm app:build`; the packaged smoke test checks the build output.
  assert.deepEqual(missingRuntimeFiles(codeRoot).filter((path) => !path.startsWith('app/out/')), []);
});

check('app package: ad-hoc signature only, output git-ignored, no source maps and no src/ inside', () => {
  const config = builderConfig();
  assert.match(config, /^\s+identity: "-"$/m, 'ad-hoc signature only, no Developer ID');
  assert.match(config, /^\s+output: release$/m);
  const ignored = read('.gitignore').split('\n');
  for (const folder of ['release/', 'out/']) assert.ok(ignored.includes(folder), `${folder} is git-ignored`);
  assert.ok(!packaged('app/out/main/index.mjs.map', config), 'source maps stay out of the package');
  assert.ok(!packaged('src/config.ts', config), 'the bundle replaces src/');
});

// --- Renderer styles (the renderer's no-Node rule is in .oxlintrc.json) --------------------------------------------

check('renderer: the page is titled Serra', () => {
  assert.match(read('app/renderer/index.html'), /<title>Serra<\/title>/);
});

check('renderer styles: data-theme overrides color-scheme, and every colour token is a light-dark() pair', () => {
  const css = read('app/renderer/styles.css');
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  const tokens = [...css.matchAll(/^\s*--color-[a-z-]+:\s*(.+);$/gm)].map((match) => match[1] ?? '');
  assert.ok(tokens.length >= 12, 'the colour tokens are found');
  for (const value of tokens) assert.match(value, /^light-dark\(#[0-9a-f]{6}(?:[0-9a-f]{2})?, #[0-9a-f]{6}(?:[0-9a-f]{2})?\)$/);
});

check('renderer: no hard-coded white or black text, fills or borders that ignore the theme', () => {
  for (const file of filesUnder('app/renderer', (name) => name.endsWith('.tsx'))) {
    // Backdrops dim whatever is behind a dialog, in both themes.
    const raw = read(file).match(/(?<!backdrop:)\b(?:text|bg|border|fill|stroke)-(?:white|black)\b/g) ?? [];
    assert.deepEqual(raw, [], `${file} uses ${raw.join(', ')}`);
  }
});

// --- Lint configuration and repository hygiene -------------------------------------------------------------------

/** Files git tracks or would add (not ignored), so build output and node_modules are never read. */
const tracked = (): string[] => execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: codeRoot, encoding: 'utf8' })
  .split('\0').filter((file) => file && existsSync(join(codeRoot, file)));
const code = (): string[] => tracked().filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !file.startsWith('scripts/qa/'));

check('lint: every suppression covers one line, names its rule and says why, after " -- "', () => {
  const bad = code().filter((file) => file !== 'scripts/lint-repo.ts').flatMap((file) => read(file).split('\n').flatMap((line, index) =>
    /(?:ox|es)lint-(?:disable|enable)/.test(line) && !/oxlint-disable-(?:next-)?line\s+[\w/@-]+(?:,\s*[\w/@-]+)*\s+--\s+\S/.test(line) ? [`${file}:${index + 1}`] : []));
  // A whole-file disable is an exception list of its own, so only the one-line forms are allowed.
  assert.deepEqual(bad, [], 'write // oxlint-disable-next-line <rule> -- <why> (not eslint-disable, a bare disable or a whole-file one)');
});

check('imports: a relative import names the .ts file, never a .js one', () => {
  // Node runs the TypeScript as is, so `./x.js` fails at run time although tsc and oxlint accept it.
  const bad = code().flatMap((file) => [...read(file).matchAll(/(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"]+\.js)\1/g)].map((match) => `${file}: ${match[2]}`));
  assert.deepEqual(bad, []);
});

/** JSON with comments and trailing commas, as tsconfig.json, .oxlintrc.json and knip.jsonc may be written. */
const parseJsonc = (text: string): unknown => {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (char === '"') { // copy a string whole, escapes included
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1); i = end;
    } else if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; }
    else if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; if (i === 0) throw new Error('unclosed /* comment'); }
    else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
};
/** The commit this branch forked from main (in CI's PR checkout, main itself), or null without a local main. */
const base = (): string | null => {
  try { return execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: codeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {
    // CI makes a local main (ci.yml), so a missing one there is a broken setup, not a pass.
    if (process.env.CI) throw new Error('no local main branch to compare with');
    return null;
  }
};
const atBase = (commit: string, path: string): string | null => {
  try { return execFileSync('git', ['show', `${commit}:${path}`], { cwd: codeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
const current = (path: string): string | null => (existsSync(join(codeRoot, path)) ? read(path) : null);

type Override = { files: string[]; rules?: Record<string, unknown> };
const isOff = (value: unknown): boolean => ['off', 'allow', '0'].includes(String(Array.isArray(value) ? value[0] : value).toLowerCase());
/** An override that only turns rules off is an exception list; each entry is keyed by its rules, so a file in two lists is two entries. */
const exceptionKeys = (override: Override): string[] | null => {
  const rules = override.rules ?? {};
  return Object.keys(rules).length > 0 && Object.values(rules).every(isOff) ? override.files.map((file) => `${JSON.stringify(rules)}\0${file}`) : null;
};

/** Every file that configures a gate. CI workflows are included: they decide which gates run. */
const GATE_FILES = ['.oxlintrc.json', 'knip.jsonc', 'tsconfig.json', 'app/tsconfig.json', 'app/renderer/tsconfig.json', '.gitleaks.toml',
  '.github/workflows/ci.yml', '.github/workflows/pr-title.yml'];

/**
 * What the gates enforce, as one string: every gate file plus the package.json scripts that run them. With `keep`,
 * exception entries the branch removed (files in an all-off override, knip ignores) are dropped from this (main's)
 * version first, so that removing them is not a change.
 */
const gates = (source: (path: string) => string | null, keep: Set<string> | null): string => {
  const parsed = Object.fromEntries(GATE_FILES.map((path) => {
    const text = source(path);
    if (text === null) return [path, null];
    if (path.endsWith('.json') || path.endsWith('.jsonc')) return [path, parseJsonc(text)];
    // An action's version is Dependabot's to bump, not a gate change.
    // Whole-line comments and blank lines in YAML and TOML aren't gates either.
    const plain = path.endsWith('.yml') || path.endsWith('.toml') ? text.split('\n').filter((line) => line.trim() !== '' && !/^\s*#/.test(line)).join('\n') : text;
    return [path, path.endsWith('.yml') ? plain.replace(/^(\s*-?\s*uses:\s*[^@\s]+)@\S+.*$/gm, '$1') : plain];
  }));
  const oxlint = parsed['.oxlintrc.json'] as { overrides?: Override[] } | null;
  const knip = parsed['knip.jsonc'] as { ignore?: string[] } | null;
  if (keep && oxlint?.overrides) {
    oxlint.overrides = oxlint.overrides.map((override) => {
      const keys = exceptionKeys(override);
      return keys ? { ...override, files: override.files.filter((_, index) => keep.has(keys[index] ?? '')) } : override;
    }).filter((override) => override.files.length > 0);
  }
  if (keep && knip?.ignore) knip.ignore = knip.ignore.filter((entry) => keep.has(`knip\0${entry}`));
  // An emptied list and a removed one are the same.
  if (oxlint?.overrides?.length === 0) delete oxlint.overrides;
  if (knip?.ignore?.length === 0) delete knip.ignore;
  const pkg = JSON.parse(source('package.json') ?? '{}') as { scripts?: Record<string, string>; knip?: unknown };
  const scripts = Object.fromEntries(['check', 'lint', 'lint:repo', 'test', 'knowledge', 'app:build', 'app:package'].map((name) => [name, pkg.scripts?.[name]]));
  return JSON.stringify({ ...parsed, scripts, packageKnip: pkg.knip });
};
/** The exception entries the branch still has; any of main's that are missing were removed. */
const exceptionsNow = (): Set<string> => {
  const oxlint = parseJsonc(read('.oxlintrc.json')) as { overrides?: Override[] };
  const knip = parseJsonc(read('knip.jsonc')) as { ignore?: string[] };
  return new Set([...(oxlint.overrides ?? []).flatMap((override) => exceptionKeys(override) ?? []), ...(knip.ignore ?? []).map((entry) => `knip\0${entry}`)]);
};

// A reviewed change to the gates (any change but removing exceptions): the fingerprint the check below prints for it.
// It covers main's version and this one, so it only ever matches the change it was made for.
// Changing this line is how a PR says "this changes what the gates enforce, on purpose"; the reviewer sees both.
const ACKNOWLEDGED_GATE_CHANGE = '38b6b9baa6684b39';

check('gates: unchanged against main, except exceptions removed (lint, knip, tsconfigs, scripts, gitleaks, CI)', () => {
  const commit = base();
  if (commit === null) return;
  if (atBase(commit, '.oxlintrc.json') === null) return; // the gates are new on this branch
  const before = gates((path) => atBase(commit, path), exceptionsNow());
  const now = gates(current, null);
  if (now === before) return;
  // Salted with main's acknowledgement too, so a value left behind can't approve the same change a second time.
  const mainAck = /const ACKNOWLEDGED_GATE_CHANGE = '([0-9a-f]*)'/.exec(atBase(commit, 'scripts/lint-repo.ts') ?? '')?.[1] ?? '';
  const fingerprint = createHash('sha256').update(`${before}\0${now}\0${mainAck}`).digest('hex').slice(0, 16);
  assert.equal(ACKNOWLEDGED_GATE_CHANGE, fingerprint,
    `the gates changed against main (beyond removing exceptions). If that is the point of this PR, set ACKNOWLEDGED_GATE_CHANGE in scripts/lint-repo.ts to '${fingerprint}'; otherwise fix the code instead.`);
});

check('gates: no second config that a tool would read instead of, or on top of, the checked ones', () => {
  const files = tracked();
  const side = files.filter((file) => (/(^|\/)(\.oxlintrc\.json|oxlint\.config\.\w+)$/.test(file) && file !== '.oxlintrc.json')
    || /(^|\/)(\.eslintignore|\.oxlintignore|\.gitleaksignore|knip\.json|\.knip\.jsonc?|knip\.(ts|js|mjs)|knip\.config\.\w+)$/.test(file)
    || (/(^|\/)(\.oxlintrc|knip)\.jsonc?$/.test(file) && file.includes('/')));
  assert.deepEqual(side, [], 'one config per tool, at the root');
  assert.equal((JSON.parse(read('package.json')) as { knip?: unknown }).knip, undefined, 'knip is configured in knip.jsonc only');
  const marked = (marker: string): string[] => execFileSync('git', ['grep', '-lI', '--untracked', '--exclude-standard', '-F', marker, '--', '.', ':!scripts/lint-repo.ts'], { cwd: codeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  const grep = (marker: string): string[] => { try { return marked(marker); } catch { return []; } }; // git grep exits 1 on no match
  assert.deepEqual(grep('gitleaks:allow'), [], 'no inline gitleaks:allow; fix the fixture instead');
  // knip skips an export tagged @public, which would be an unreviewed exception.
  assert.deepEqual(grep('@public'), [], 'no @public tags; remove the unused export instead');
  // A tracked file that .gitignore also matches is skipped by oxlint (and is usually a mistake).
  const ignored = execFileSync('git', ['ls-files', '-ci', '--exclude-standard'], { cwd: codeRoot, encoding: 'utf8' }).trim();
  assert.equal(ignored, '', 'tracked files that .gitignore matches');
});

check('lint config: every file an exception names still exists', () => {
  const files = new Set(tracked());
  const named = ((parseJsonc(read('.oxlintrc.json')) as { overrides?: Override[] }).overrides ?? []).flatMap((override) => override.files)
    .concat((parseJsonc(read('knip.jsonc')) as { ignore?: string[] }).ignore ?? []);
  assert.deepEqual([...new Set(named)].filter((glob) => !/[*]/.test(glob) && !files.has(glob)), [], 'take files that no longer exist off the list');
});

check('repository: raw eval results stay off main (they live on the pr-assets/evals branch)', () => {
  assert.deepEqual(tracked().filter((file) => file.startsWith('evals/results/')), []);
});

check('repository: no real home folder in tracked files; use /Users/you', () => {
  const text = tracked().filter((file) => /\.(ts|tsx|mjs|cjs|md|json|ya?ml|sh|html|css)$/.test(file) && !file.startsWith('evals/fixture'));
  const bad = text.flatMap((file) => [...read(file).matchAll(/\/Users\/(?!(?:you|me|younger)\b)[A-Za-z0-9_.-]+/g)].map((match) => `${file}: ${match[0]}`));
  assert.deepEqual(bad, []);
});

check('renderer bundle: no Node or Electron module is reached, directly or through src/', async () => {
  // The import rules in .oxlintrc.json see one file at a time; this follows every value import from the entry point.
  const result = await build({
    entryPoints: [join(codeRoot, 'app/renderer/main.tsx')], absWorkingDir: codeRoot, bundle: true, write: false, metafile: true,
    platform: 'browser', format: 'esm', packages: 'external', logLevel: 'silent',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  });
  const node = Object.entries(result.metafile.inputs).flatMap(([input, { imports }]) => imports
    .filter((entry) => /^(node:|electron($|\/))/.test(entry.path) || builtinModules.includes(entry.path.split('/')[0] ?? ''))
    .map((entry) => `${input} imports ${entry.path}`));
  assert.deepEqual(node, []);
  assert.ok(Object.keys(result.metafile.inputs).length > 20, 'the renderer was bundled');
});

// --- Run -----------------------------------------------------------------------------------------------------------

let failed = 0;
for (const [name, run] of checks) {
  try { await run(); } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n  ${(error instanceof Error ? error.message : String(error)).split('\n').join('\n  ')}`);
  }
}
console.log(`lint:repo: ${checks.length - failed} of ${checks.length} checks pass`);
if (failed) process.exitCode = 1;
