// The Markdown of the owner's pages, parsed for the About me previews: the same text a worker's brief carries,
// structured into blocks and inline spans. Pure and tested; the rendering lives in AboutMe.tsx.

/** Inline Markdown as styled spans: bold, italics, code and links, with everything else as plain text. */
export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** A body's blocks: headings, bullets (nested by indent), tables, quotes, fences and paragraphs. */
export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'item'; depth: number; number: number | null; spans: Span[] }
  | { kind: 'table'; head: Span[][]; rows: Span[][][] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'fence'; text: string }
  | { kind: 'text'; spans: Span[] };

const isWord = (character: string | undefined): boolean => character !== undefined && /[A-Za-z0-9]/.test(character);
// Underscore is a word character in an identifier, so `_a_b` and `__init__` are names, not markup.
const isIdentifier = (character: string | undefined): boolean =>
  character !== undefined && /[A-Za-z0-9_]/.test(character);

const textSpan = (text: string): Span[] => (text ? [{ kind: 'text', text }] : []);

/** One inline pass: the first code span, link, autolink, bold or italic run, and where it sits. */
const nextSpan = (text: string, from: number): { start: number; end: number; span: Span } | null => {
  const rest = text.slice(from);
  const code = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest);
  // Only http(s) is a link; anything else (`javascript:`, `mailto:`) stays as the text it was written as.
  const link = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
  const autolink = /<(https?:\/\/[^>\s]+)>/.exec(rest);
  const bold = /(\*\*|__)([\s\S]+?)\1/.exec(rest);
  // Italics need a non-word on the far side of each delimiter, so `snake_case` and `a * b` stay plain.
  const italic = /(\*|_)(\S(?:[\s\S]*?\S)?)\1/.exec(rest);
  const boundary = (match: RegExpExecArray, identifier: boolean): boolean => {
    const outside = identifier ? isIdentifier : isWord;
    return outside(text[from + match.index - 1]) || outside(text[from + match.index + match[0].length]);
  };
  if (italic) {
    const before = text[from + italic.index - 1];
    const after = text[from + italic.index + italic[0].length];
    if (italic[1] === '_' ? isIdentifier(before) || isIdentifier(after) : isWord(before) || isWord(after)) italic.index = rest.length;
  }
  if (bold && bold[1] === '__') {
    // A dunder such as `__init__` is an identifier, not markup: `__` marks up words, not a bare name.
    if (boundary(bold, true) || !/\s/.test(bold[2]!)) bold.index = rest.length;
  }
  const found: { start: number; end: number; span: Span }[] = [];
  if (code) found.push({ start: code.index, end: code.index + code[0].length, span: { kind: 'code', text: code[2]! } });
  if (link) found.push({ start: link.index, end: link.index + link[0].length, span: { kind: 'link', text: link[1]!, href: link[2]! } });
  if (autolink) found.push({ start: autolink.index, end: autolink.index + autolink[0].length, span: { kind: 'link', text: autolink[1]!, href: autolink[1]! } });
  if (bold && bold.index < rest.length) found.push({ start: bold.index, end: bold.index + bold[0].length, span: { kind: 'bold', text: bold[2]! } });
  if (italic && italic.index < rest.length) found.push({ start: italic.index, end: italic.index + italic[0].length, span: { kind: 'italic', text: italic[2]! } });
  if (found.length === 0) return null;
  found.sort((first, second) => first.start - second.start || second.end - first.end);
  return found[0]!;
};

/** Inline Markdown of one line as spans: `**bold**`, `*italics*`, `_italics_`, `` `code` ``, `[text](url)` and `<url>`. */
export const inlineSpans = (text: string): Span[] => {
  const out: Span[] = [];
  let from = 0;
  for (;;) {
    const found = nextSpan(text, from);
    if (!found) break;
    if (found.start > 0) out.push({ kind: 'text', text: text.slice(from, from + found.start) });
    out.push(found.span);
    from += found.end;
  }
  return [...out, ...textSpan(text.slice(from))];
};

/** A table row's cells: the `|`s split, the outer ones dropped, the rest trimmed. */
const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

/** Whether a row is a table's rule of dashes, as in `| --- | --- |`. */
const isRule = (row: string[]): boolean => row.length > 0 && row.every((cell) => /^:?-+:?$/.test(cell));

/** A body as blocks. Consecutive plain lines join into one paragraph, as Markdown reads them; rules are quiet. */
export const pageBlocks = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  const lines = markdown.split('\n');
  let paragraph: string[] = [];
  let quote: string[] = [];
  const endParagraph = (): void => {
    if (paragraph.length) blocks.push({ kind: 'text', spans: inlineSpans(paragraph.join(' ')) });
    paragraph = [];
  };
  const endQuote = (): void => {
    if (quote.length) blocks.push({ kind: 'quote', spans: inlineSpans(quote.join(' ')) });
    quote = [];
  };
  const endLoose = (): void => { endParagraph(); endQuote(); };
  for (let at = 0; at < lines.length; at++) {
    const trimmed = lines[at]!.trim();
    if (!trimmed) { endLoose(); continue; }
    // A fence keeps its lines verbatim, markup-shaped or not, until the fence closes or the text ends.
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      endLoose();
      const marker = fence[1]![0]!;
      const width = fence[1]!.length;
      const closes = (line: string): boolean => {
        const run = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
        return run !== null && run[1]![0]! === marker && run[1]!.length >= width;
      };
      const inner: string[] = [];
      at += 1;
      while (at < lines.length && !closes(lines[at]!)) inner.push(lines[at++]!);
      // The loop stops on the closing fence, which the for-loop's own step skips; at the end there is none.
      blocks.push({ kind: 'fence', text: inner.join('\n') });
      continue;
    }
    // A rule only splits pages visually; the sections already carry their own borders.
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) { endLoose(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      endLoose();
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: inlineSpans(heading[2]!) });
      continue;
    }
    if (trimmed.startsWith('|')) {
      endLoose();
      const rows = [cells(trimmed)];
      while (at + 1 < lines.length && lines[at + 1]!.trim().startsWith('|')) rows.push(cells(lines[++at]!.trim()));
      const rule = rows.length > 1 && isRule(rows[1]!);
      blocks.push({
        kind: 'table',
        head: rule ? rows[0]!.map(inlineSpans) : [],
        rows: (rule ? rows.slice(2) : rows).map((row) => row.map(inlineSpans)),
      });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(lines[at]!);
    if (bullet) {
      endLoose();
      blocks.push({ kind: 'item', depth: Math.min(2, Math.floor(bullet[1]!.length / 2)), number: null, spans: inlineSpans(bullet[2]!) });
      continue;
    }
    const ordered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(lines[at]!);
    if (ordered) {
      endLoose();
      blocks.push({ kind: 'item', depth: Math.min(2, Math.floor(ordered[1]!.length / 2)), number: Number(ordered[2]), spans: inlineSpans(ordered[3]!) });
      continue;
    }
    const said = /^>\s?(.*)$/.exec(trimmed);
    if (said) { endParagraph(); quote.push(said[1]!); continue; }
    paragraph.push(trimmed);
  }
  endLoose();
  return blocks;
};

/** Words a file name can't spell: `pr-style.md` reads "PR style", not "Pr style". */
const ACRONYMS: Record<string, string> = { pr: 'PR', prs: 'PRs', api: 'API', ui: 'UI', ci: 'CI', qa: 'QA', oncall: 'On-call', offlimits: 'Off-limits' };

/** A path in words: `owner/working-hours.md` reads "Working hours"; the brief's own sections have their own names. */
export const sectionTitle = (path: string): string => {
  const named: Record<string, string> = { 'people/': 'People', outsiders: 'Rules for outsiders', 'private topics': 'Private topics', 'owner/off-limits.md': 'Off-limits' };
  if (named[path]) return named[path];
  const words = (path.split('/').pop() ?? path).replace(/\.md$/, '').split(/[-_\s]+/).filter(Boolean).map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * One About me card: a single title, the page's own first heading when it has one (so "Role" isn't said twice), and
 * the body without that heading or the line the brief adds for the bot (`prefaces`).
 */
export const aboutCard = (path: string, body: string, prefaces: readonly string[] = []): { title: string; body: string } => {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const strip = (): void => { while (lines.length && !lines[0]!.trim()) lines.shift(); };
  strip();
  if (lines.length && prefaces.includes(lines[0]!.trim())) { lines.shift(); strip(); }
  const heading = lines.length ? /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(lines[0]!.trim()) : null;
  if (heading) { lines.shift(); strip(); }
  const title = heading ? inlineSpans(heading[1]!).map((span) => span.text).join('') : sectionTitle(path);
  return { title, body: lines.join('\n').trimEnd() };
};

/** The pages About me leaves out, in one line: "3 pages left out until verified". Null when none are. */
export const leftOutLine = (left: readonly { reason: string }[]): string | null => {
  if (left.length === 0) return null;
  const pages = left.length === 1 ? '1 page left out' : `${left.length} pages left out`;
  const reasons = new Set(left.map((page) => page.reason));
  if (reasons.size === 1 && reasons.has('not verified yet')) return `${pages} until verified`;
  if (reasons.size === 1 && reasons.has('over the size limit')) return `${pages}: over the size limit`;
  return pages;
};
