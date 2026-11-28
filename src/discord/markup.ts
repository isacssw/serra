/**
 * The worker's Markdown as a Discord message. Discord reads Markdown itself (bold, italics, code, headings, lists,
 * quotes, `[label](url)` links), so little changes: links to anything but http(s) become plain text, and a reply
 * longer than Discord's 2,000 characters is cut at a line and says the rest is in T3. Pure.
 *
 * Nobody can be pinged through this text: every message goes out with no allowed mentions (`api.ts`).
 */

/** Discord's cap on a message's text. */
export const MESSAGE_LIMIT = 2000;

/** `[label](url)` with an http(s) URL in angle brackets (no preview), or just the label when the URL isn't one. */
export const link = (url: string, label: string): string =>
  (/^https?:\/\/[^\s<>()]+$/.test(url) ? `[${label.replace(/[[\]]/g, '')}](<${url}>)` : label);

/** Markdown links to anything but http(s) (`javascript:`, `discord:`) as their label. */
const safeLinks = (markdown: string): string =>
  markdown.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (match, label: string, url: string) => (/^<?https?:\/\//.test(url) ? match : label));

/**
 * The worker's Markdown as one message, `footer` (Serra's own line) under it. A body too long is cut at a line break
 * when there is one near the end, a code block it cut open is closed, and it says the rest is in T3.
 */
export const messageText = (markdown: string, footer = ''): string => {
  const tail = footer ? `\n\n${footer}` : '';
  const body = safeLinks(markdown.replace(/\r\n/g, '\n')).trim();
  if (body.length + tail.length <= MESSAGE_LIMIT) return `${body}${tail}`;
  const note = '\n\n*…cut short, the full reply is in T3*';
  const room = MESSAGE_LIMIT - tail.length - note.length - 8;
  let cut = body.slice(0, room);
  const line = cut.lastIndexOf('\n');
  if (line > room * 0.6) cut = cut.slice(0, line);
  if ((cut.match(/^\s*```/gm) ?? []).length % 2 === 1) cut += '\n```';
  return `${cut}${note}${tail}`;
};
