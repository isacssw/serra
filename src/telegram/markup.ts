/**
 * The worker's Markdown as Telegram's HTML (`parse_mode: HTML`): bold, italic, strike, inline code, code blocks, links
 * and headings; everything else as text. Pure. Telegram refuses a message with a tag it doesn't know or one left open,
 * so every piece of the input is escaped first and only tags made here are added.
 */

/** Telegram's cap on a message's text, with room for the footer Serra adds. */
const MESSAGE_LIMIT = 4096;
const BODY_LIMIT = 3600;

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;');

/** An http(s) link as an `href`, or null for anything else (`javascript:`, `tg:` from the worker). */
const safeHref = (url: string): string | null => (/^https?:\/\/[^\s<>"]+$/.test(url) ? url : null);

/** `<a href>` to an http(s) URL, or just the label when the URL isn't one. */
export const link = (url: string, label: string): string => {
  const href = safeHref(url);
  return href ? `<a href="${escapeAttribute(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
};

/** Inline Markdown on one escaped line. Code spans are cut out first so nothing inside them is read as markup. */
const inline = (line: string): string => {
  const codes: string[] = [];
  const held = line.replace(/`([^`\n]+)`/g, (_match, code: string) => { codes.push(code); return `\uE000${codes.length - 1}\uE001`; });
  let out = escapeHtml(held)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
      const href = safeHref(url.replace(/&amp;/g, '&'));
      return href ? `<a href="${escapeAttribute(href)}">${label}</a>` : match;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,!?:;])/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
  out = out.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => `<code>${escapeHtml(codes[Number(index)] ?? '')}</code>`);
  return out;
};

/** Markdown to Telegram HTML, without truncating. */
export const markdownToHtml = (markdown: string): string => {
  const out: string[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (index++; index < lines.length && !/^\s*```/.test(lines[index] ?? ''); index++) body.push(lines[index] ?? '');
      out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { out.push(`<b>${inline(heading[1] ?? '')}</b>`); continue; }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) { out.push(`${bullet[1] ?? ''}• ${inline(bullet[2] ?? '')}`); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { out.push(`<blockquote>${inline(quote[1] ?? '')}</blockquote>`); continue; }
    out.push(inline(line));
  }
  return out.join('\n');
};

/**
 * The worker's Markdown as one message's HTML, `footer` (already HTML) under it. A body too long for one message is cut
 * at a line and says the rest is in T3; the cut is made on the Markdown, so no tag is ever left open.
 */
export const messageHtml = (markdown: string, footer = ''): string => {
  const room = MESSAGE_LIMIT - footer.length - 64;
  let body = markdown.length > BODY_LIMIT ? markdown.slice(0, BODY_LIMIT) : markdown;
  let cut = body !== markdown;
  let html = markdownToHtml(body);
  while (html.length > room && body.length > 0) {
    body = body.slice(0, Math.floor(body.length * 0.8));
    cut = true;
    html = markdownToHtml(body);
  }
  if (cut) {
    // Close a code block the cut left open in the Markdown, then say where the rest is.
    if ((body.match(/^\s*```/gm) ?? []).length % 2 === 1) html = markdownToHtml(`${body}\n\`\`\``);
    html += '\n\n<i>…cut short, the full reply is in T3</i>';
  }
  return footer ? `${html}\n\n${footer}` : html;
};

/** A line of Serra's own text (a notice), escaped. */
export const plain = (text: string): string => escapeHtml(text);
