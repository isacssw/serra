// Worktrees for backends that don't make their own (an ACP agent): Serra runs `git worktree add` itself, on a new
// branch from the base, under `~/.serra/worktrees/<project>/<branch>`. T3 keeps making its own under `~/.t3/worktrees`.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { run } from '../t3.ts';

const SERRA_WORKTREES = join(homedir(), '.serra', 'worktrees');

/** Makes the worktree and returns its folder. Refuses a branch or base that reads as a flag. */
export const makeWorktree = async (
  { project, baseRef, branch, root = SERRA_WORKTREES, git = run }: { project: string; baseRef: string; branch: string; root?: string; git?: typeof run },
): Promise<string> => {
  if (branch.startsWith('-') || baseRef.startsWith('-')) throw new Error('A branch or base can\'t start with "-".');
  const folder = join(root, basename(project), branch.replace(/[^\w.-]+/g, '-'));
  mkdirSync(join(root, basename(project)), { recursive: true, mode: 0o700 });
  await git('git', ['-C', project, 'worktree', 'add', '-b', branch, folder, baseRef]);
  return folder;
};
