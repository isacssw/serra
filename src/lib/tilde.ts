// Paths under the home folder shown as `~`, so neither a screen nor a pasted report carries the account name. The
// main process applies it before anything reaches the window, which never learns the home folder itself.

/** Paths under the home folder as `~/…`: shorter, and a pasted report doesn't carry the account name. */
export const tildePaths = (text: string, home: string | undefined): string => {
  const root = home?.replace(/\/+$/, '');
  if (!root || root === '/' || !text.includes(root)) return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${escaped}(?![\\w.-])`, 'g'), '~');
};
