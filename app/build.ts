// Bundles the Electron main process with esbuild. Run with `pnpm app:build`.
// See docs/app/electron-build.md for why the app is bundled and why esbuild.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { RELEASE_INFO, stageReleaseSource } from '../src/deploy.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = join(root, 'app/out/main/index.mjs');

/**
 * Bundling puts every module in one file, so `import.meta.url` would be the bundle's URL in all of them.
 * `src/config.ts` derives `codeRoot` from it and the CLI entry points compare it with `process.argv[1]`.
 * Rewrite it to the module's own source URL, relative to the bundle, so both keep their unbundled meaning.
 */
const sourceImportMeta: Plugin = {
  name: 'source-import-meta',
  setup(builder) {
    builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
      const contents = await readFile(path, 'utf8');
      if (!contents.includes('import.meta.url')) return { contents, loader: 'ts' };
      const fromBundle = relative(dirname(outfile), path).split('\\').join('/');
      return { contents: contents.replaceAll('import.meta.url', `new URL(${JSON.stringify(fromBundle)}, import.meta.url).href`), loader: 'ts' };
    });
  },
};

await build({
  entryPoints: [join(root, 'app/main/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // electron and @slack/bolt stay in node_modules; only our own TypeScript is bundled.
  packages: 'external',
  sourcemap: 'linked',
  logLevel: 'info',
  plugins: [sourceImportMeta],
});

// The preload runs sandboxed: it must be one CommonJS file that only requires `electron` (APP-9).
await build({
  entryPoints: [join(root, 'app/preload.ts')],
  outfile: join(root, 'app/out/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'info',
});

// Updates › Prepare in the packaged app makes its release from this copy (electron-builder.yml, `extraResources`).
stageReleaseSource(root, join(root, 'app/out/release-source'));
// The copy has no git, so record what it was built from: releases made from it show this version and commit.
const commit = (() => {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
})();
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
writeFileSync(join(root, 'app/out/release-source', RELEASE_INFO), JSON.stringify({ version, ...(commit ? { commit } : {}) }, null, 2) + '\n');
