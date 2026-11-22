import { homedir } from 'node:os';
import { basename, sep } from 'node:path';

/** A Markdown link, not an image, whose target is an absolute path on the owner's machine. */
const LOCAL_LINK = /(?<!!)\[([^\]\n]+)\]\((?:<(\/[^>\n]+)>|(\/[^)\s]+))\)/g;
/** `file.ts:95`, `file.ts:95:3` or `file.ts#L95`. */
const POSITION = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;

export interface PathRoots {
  /** Repository checkouts. A path inside one is shown from the repository root. */
  repos: string[];
  /** Folders holding `<project>/<worktree>/` checkouts, such as `~/.t3/worktrees`. */
  worktrees: string[];
  home?: string;
}

const inside = (path: string, root: string): string | null => (path.startsWith(`${root}${sep}`) ? path.slice(root.length + 1) : null);

/** A path as a Slack reader can use it: from the repository root when it is code, `~/…` otherwise. */
const shortPath = (path: string, { repos, worktrees, home = homedir() }: PathRoots): string => {
  for (const root of worktrees) {
    const rest = inside(path, root)?.split(sep).slice(2).join(sep);
    if (rest) return rest;
  }
  for (const root of repos) {
    const rest = inside(path, root);
    if (rest) return rest;
  }
  const fromHome = inside(path, home);
  return fromHome ? `~/${fromHome}` : path;
};

/**
 * Turns links to local files into plain text. Slack can't open a path on the owner's machine,
 * and a worktree path is noise to a reader: `[role enum](/Users/…/worktree/apps/api/roles.ts:95)`
 * becomes `role enum (`apps/api/roles.ts:95`)`.
 */
export const localLinksToText = (text: string, roots: PathRoots): string =>
  text.replace(LOCAL_LINK, (_link, label: string, bracketed: string | undefined, plain: string | undefined) => {
    const target = bracketed ?? plain ?? '';
    const short = shortPath(target, roots);
    const name = label.replaceAll('`', '').trim();
    const file = basename(target.replace(POSITION, ''));
    const sayOnlyPath = name === target || name === short || name === file || name === basename(target);
    return sayOnlyPath ? `\`${short}\`` : `${label} (\`${short}\`)`;
  });
