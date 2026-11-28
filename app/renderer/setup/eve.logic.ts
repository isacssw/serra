// eve on Vercel (SB-17), as the window shows it: the host a URL names, the one-line notice that names it, and the
// Details lines. Main checks the URL again and is the one that refuses; this only shapes what the owner reads. Pure:
// imported by `node --test` as well as the renderer.

/** The agent's id when it is eve on Vercel (src/agent/eve-cloud.ts). */
export const EVE_CLOUD_ID = 'eve-cloud';

/** The host a typed URL names, the way main reads it (https, or http on this Mac), or null while it isn't one yet. */
export const eveHost = (input: string): string | null => {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    if (!url.hostname.includes('.') && !local) return null;
    return url.host;
  } catch { return null; }
};

/** The one sentence the owner reads before anything is sent. */
export const eveNotice = (host: string): string => `Requests and this profile’s knowledge index go to ${host}.`;

/** What Details lists: what is sent, what stays, how to stop. */
export const EVE_DETAILS: readonly string[] = [
  'Sent: each request, its follow-ups, and your answers to the agent’s questions and approvals.',
  'Sent: the knowledge index, with every request. Pages and files on this Mac aren’t.',
  'Stays here: your files, Slack tokens, meeting transcripts and your Vercel login.',
  'A bypass secret stays in your Keychain and goes only to eve on this Mac.',
  'To stop: remove it in Settings › Worker, then run vercel logout or rotate the secret in Vercel. What was sent stays in that project.',
];

/** The primary button: pressing it is the owner's yes for this host. */
export const eveContinueLabel = (host: string | null, verb: 'Continue with' | 'Connect'): string =>
  host ? `${verb} ${host}` : verb === 'Connect' ? 'Connect' : 'Continue';

/**
 * A bypass secret typed in Add… › Profile, held in memory between its two screens and taken once by the Create that
 * saves it: never in the router's history state, which outlives the form.
 */
let pendingSecret: string | null = null;
export const holdEveSecret = (secret: string | null): void => { pendingSecret = secret?.trim() ? secret.trim() : null; };
export const takeEveSecret = (): string | null => { const secret = pendingSecret; pendingSecret = null; return secret; };
