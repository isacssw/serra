// `pnpm lint:repo`: rules about the repository itself (config, templates, packaging, styles) that a type checker or
// oxlint can't express. Each check is named for the rule it holds. These were tests that read source instead of
// running behaviour (SERRA-57 audit); here they say what they are. Runs in `pnpm lint` and so in CI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const code = (): string[] => tracked().filter((file) => /\.(ts|tsx|mjs|cjs)$/.test(file) && !file.startsWith('scripts/qa/'));

check('lint: every suppression names its rule and says why, after " -- "', () => {
  const bad = code().filter((file) => file !== 'scripts/lint-repo.ts').flatMap((file) => read(file).split('\n').flatMap((line, index) =>
    /(?:ox|es)lint-disable/.test(line) && !/oxlint-disable(?:-next-line|-line)?\s+[\w/@-]+(?:,\s*[\w/@-]+)*\s+--\s+\S/.test(line) ? [`${file}:${index + 1}`] : []));
  assert.deepEqual(bad, [], 'write // oxlint-disable-next-line <rule> -- <why> (not eslint-disable, not a bare disable)');
});

check('imports: a relative import names the .ts file, never a .js one', () => {
  // Node runs the TypeScript as is, so `./x.js` fails at run time although tsc and oxlint accept it.
  const bad = code().flatMap((file) => [...read(file).matchAll(/(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"]+\.js)\1/g)].map((match) => `${file}: ${match[2]}`));
  assert.deepEqual(bad, []);
});

/** A JSON file with whole-line // comments, as .oxlintrc.json and knip.jsonc are written. */
const parseJsonc = (text: string): unknown => JSON.parse(text.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n'));
const onMain = (path: string): string | null => {
  try { return execFileSync('git', ['show', `main:${path}`], { cwd: codeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {
    // CI makes a local main (ci.yml), so a missing one there is a broken setup, not a pass.
    if (process.env.CI && execFileSync('git', ['branch', '--list', 'main'], { cwd: codeRoot, encoding: 'utf8' }).trim() === '') throw new Error('no local main branch to compare with');
    return null;
  }
};

type Severity = { level: string; options: string };
/** Every (file glob, rule) setting in an oxlint config: top-level rules under "*", each override per glob. */
const ruleSettings = (config: unknown): Map<string, Severity> => {
  const settings = new Map<string, Severity>();
  const add = (glob: string, rules: Record<string, unknown>): void => {
    for (const [rule, value] of Object.entries(rules)) {
      const [level, ...options] = Array.isArray(value) ? value : [value];
      settings.set(`${glob} ${rule}`, { level: String(level), options: JSON.stringify(options) });
    }
  };
  const { rules = {}, overrides = [], categories = {} } = config as { rules?: Record<string, unknown>; overrides?: { files: string[]; rules: Record<string, unknown> }[]; categories?: Record<string, unknown> };
  add('*', rules);
  for (const [category, level] of Object.entries(categories)) settings.set(`* category:${category}`, { level: String(level), options: '[]' });
  for (const override of overrides) for (const glob of override.files) add(glob, override.rules);
  return settings;
};

// A deliberate loosening of the lint config, reviewed in its PR: add its "<glob> <rule>" key here, with the reason.
const ALLOWED_LOOSENING: string[] = [];

check('lint config: nothing is loosened against main (a rule turned off, an exception added, options changed)', () => {
  const base = onMain('.oxlintrc.json');
  if (base === null) return; // the config is new on this branch
  const before = ruleSettings(parseJsonc(base));
  const now = ruleSettings(parseJsonc(read('.oxlintrc.json')));
  const loosened: string[] = [];
  for (const [key, was] of before) {
    const is = now.get(key);
    if (was.level === 'off') continue;
    if (!is || is.level === 'off') loosened.push(`${key}: ${was.level} → ${is?.level ?? 'removed'}`);
    else if (is.options !== was.options) loosened.push(`${key}: options changed`);
  }
  for (const [key, is] of now) if (is.level === 'off' && before.get(key)?.level !== 'off') loosened.push(`${key}: turned off`);
  assert.deepEqual(loosened.filter((entry) => !ALLOWED_LOOSENING.some((key) => entry.startsWith(`${key}:`))), [],
    'fix the code instead; if the change is deliberate, add its key to ALLOWED_LOOSENING in scripts/lint-repo.ts');
});

check('knip config: nothing new is ignored against main', () => {
  const ignored = (text: string): string[] => Object.entries(parseJsonc(text) as Record<string, unknown>)
    .filter(([key]) => key.startsWith('ignore')).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((entry) => `${key}: ${JSON.stringify(entry)}`));
  const now = ignored(read('knip.jsonc'));
  const base = onMain('knip.jsonc');
  if (base === null) return; // the config is new on this branch
  const before = ignored(base);
  assert.deepEqual(now.filter((entry) => !before.includes(entry)), [], 'remove the unused code instead of ignoring it');
});

check('lint config: every file an exception names still exists', () => {
  const files = new Set(tracked());
  const named = [...ruleSettings(parseJsonc(read('.oxlintrc.json'))).keys()].map((key) => key.split(' ')[0] ?? '')
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
