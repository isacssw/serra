// Which checkout paths electron-builder.yml packages. Shared by `pnpm lint:repo` and tests/app-package.test.ts.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { codeRoot } from '../../src/config.ts';

export const builderConfig = (): string => readFileSync(join(codeRoot, 'electron-builder.yml'), 'utf8');

/** The `files:` list of electron-builder.yml: include patterns and `!` exclude patterns. */
const filePatterns = (config: string): { include: string[]; exclude: string[] } => {
  const lines = config.split('\n');
  const start = lines.indexOf('files:');
  if (start === -1) throw new Error('electron-builder.yml has no files list');
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+"?([^"]+?)"?\s*$/.exec(line);
    if (!match) break;
    entries.push(match[1] ?? '');
  }
  return { include: entries.filter((e) => !e.startsWith('!')), exclude: entries.filter((e) => e.startsWith('!')).map((e) => e.slice(1)) };
};

// `**/` and `**` are swapped for private-use placeholders while single `*` is translated, then put back.
const glob = (pattern: string): RegExp => new RegExp(`^${pattern
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\//g, '\uE001').replace(/\*\*/g, '\uE000').replace(/\*/g, '[^/]*')
  .replace(/\uE001/g, '(?:.*/)?').replace(/\uE000/g, '.*')}$`);

/** True when electron-builder.yml's `files:` list puts `path` in the packaged app. */
export const packaged = (path: string, config = builderConfig()): boolean => {
  const { include, exclude } = filePatterns(config);
  // A folder (no extension, like templates/knowledge) is packaged when its contents are.
  const candidates = extname(path) ? [path] : [path, `${path}/page.md`];
  return candidates.some((candidate) => include.some((p) => glob(p).test(candidate)) && !exclude.some((p) => glob(p).test(candidate)));
};
