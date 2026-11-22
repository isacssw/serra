import { run } from './t3.ts';

/**
 * macOS asks the owner before a background service may read Documents, Desktop or Downloads. Under launchd the
 * daemon's first `git` call in such a repository waits on that prompt (or is refused), so without this check the
 * bot starts fine and every job then fails with "git timed out". Checking at startup raises the prompt while the
 * owner is installing, and a refusal stops the daemon with the reason instead of failing jobs later.
 */
export const checkProjectAccess = async (paths: readonly string[],
  { timeoutMs = 15_000, git = 'git' }: { timeoutMs?: number; git?: string } = {}): Promise<void> => {
  for (const path of new Set(paths)) {
    try { await run(git, ['-C', path, 'rev-parse', '--git-dir'], { timeoutMs }); }
    catch (error) { throw new Error(projectAccessMessage(path, error)); }
  }
};

const projectAccessMessage = (path: string, error: unknown): string => {
  const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  return `Can't read the repository ${path} (${reason}). If it is in Documents, Desktop or Downloads, macOS must ` +
    'allow this background service to read it: answer the macOS prompt, or allow "node" in System Settings › ' +
    'Privacy & Security › Files and Folders, then restart the bot. Or move the repository out of those folders.';
};
