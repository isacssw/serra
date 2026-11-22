// `pnpm lint:repo`: rules about the repository itself (config, templates, packaging, styles) that a type checker or
// oxlint can't express. Each check is named for the rule it holds. These were tests that read source instead of
// running behaviour (SERRA-57 audit); here they say what they are. Runs in `pnpm lint` and so in CI.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

// --- Lint configuration --------------------------------------------------------------------------------------------

check('lint: every oxlint-disable comment says why, after " -- "', () => {
  const code = ['src', 'app', 'tests', 'evals', 'scripts'].flatMap((folder) => filesUnder(folder, (name) => /\.(ts|tsx|mjs)$/.test(name) && !name.includes('out/')))
    .filter((file) => file !== 'scripts/lint-repo.ts');
  const bare = code.flatMap((file) => read(file).split('\n').flatMap((line, index) =>
    /oxlint-disable/.test(line) && !/oxlint-disable\S*\s+[\w/@-]+(?:,\s*[\w/@-]+)*\s+--\s+\S/.test(line) ? [`${file}:${index + 1}`] : []));
  assert.deepEqual(bare, [], 'name the rule and give a reason: // oxlint-disable-next-line <rule> -- <why>');
});

// The files that had unsafe casts when the rule was turned on. The list may only shrink: lower this number when you
// clean a file and take it off the list.
const LEGACY_CAST_FILES = 49;
check(`lint: the unsafe-cast exception list in .oxlintrc.json only shrinks (at most ${LEGACY_CAST_FILES} files)`, () => {
  const config = read('.oxlintrc.json');
  const block = config.slice(config.indexOf('"files": [', config.indexOf('Casts that existed')));
  const files = block.slice(0, block.indexOf(']')).match(/"[^"]+\.tsx?"/g) ?? [];
  assert.ok(files.length > 0, 'the exception list is found');
  assert.ok(files.length <= LEGACY_CAST_FILES, `${files.length} files; add none, fix the cast instead`);
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
