// Meeting transcripts as Serra reads them (SERRA-62): normalised into numbered speaker turns, with secrets redacted
// before any model sees the text. Pure functions with no Node imports.
//
// Every source ends up here: a file the owner uploads (.txt, .md, .vtt, .srt), pasted text, a Granola transcript or a
// Google Meet transcript Doc fetched through the owner's own provider connection. The quote check (meeting-digest.ts)
// runs on the normalised text this returns, so timing lines, cue numbers, wraps and speaker prefixes never break it.

/** A transcript larger than this is refused: "split it, or send the summary". About 2–3 hours of talk. */
export const MAX_TRANSCRIPT_CHARS = 200_000;

interface Turn {
  /** 1-based, in order. The extractor cites turns by this number. */
  n: number;
  /** The speaker as the transcript names them, or null when it doesn't. Unverified: a label, not an identity. */
  speaker: string | null;
  text: string;
}

export interface Transcript {
  turns: Turn[];
  /** The turns as `n. Speaker: text` lines: what the extractor reads and what quotes are checked against. */
  text: string;
  speakers: string[];
  /** A title the source gave, like a Meet doc's first line. */
  title: string | null;
  /** A date the source gave, `YYYY-MM-DD`. */
  date: string | null;
  /** How many secrets were redacted before anything else saw the text. */
  redacted: number;
}

const TIMING = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?.*$/;
/** A bare timestamp line, as Meet and Granola put between turns: `00:05:00`, `[12:03]`, `(1:02:03)`. */
const BARE_TIME = /^\s*[[(]?(?:\d{1,2}:)?\d{1,2}:\d{2}[\])]?\s*$/;
/** A timestamp in front of a line: `[00:01:02] `, `(12:03) `, `00:12 - `. */
const LEADING_TIME = /^\s*[[(]?(?:\d{1,2}:)?\d{1,2}:\d{2}[\])]?\s*(?:[-–—|]\s*)?/;
/** A timestamp after the speaker, Granola's import style: `Ana [12:03]: text`. */
const SPEAKER_TIME = /\s*[[(](?:\d{1,2}:)?\d{1,2}:\d{2}[\])]\s*(?=:)/;
/** `Speaker: text`. A speaker is 1–4 words, starting with a letter, no sentence punctuation. */
const SPEAKER_LINE = /^([\p{L}][\p{L}\p{M}'’.-]*(?:\s[\p{L}\p{M}'’.()-]+){0,3}):\s+(.*)$/u;
const VTT_VOICE = /^<v(?:\.[^\s>]+)?\s+([^>]+)>(.*?)(?:<\/v>)?$/;
const DATE_IN_TEXT = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/;
/** Words that look like a speaker label but start an ordinary sentence ("Note: …", "Action: …"). */
const NOT_SPEAKERS = new Set(['note', 'notes', 'action', 'actions', 'todo', 'decision', 'decisions', 'summary', 'agenda', 'http', 'https', 're', 'fyi', 'ps', 'q', 'a', 'attendees', 'transcript']);

// ---------------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------------

/**
 * Credentials that can turn up in a meeting ("the staging key is sk-live-…"). Matched text is replaced with
 * `[redacted]` before the extractor, the evidence file or a reply sees it. Errs toward redacting.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-\d-[A-Za-z0-9-]{10,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi,
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|token)\s*(?:is|[:=])\s*["'`]?(?!\[redacted\])[^\s"'`]{6,}/gi,
];

/** `text` with every secret replaced by `[redacted]`, and how many were. */
export const redactSecrets = (text: string): { text: string; count: number } => {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep the label of a `password: …` match, so the sentence still reads.
      const label = /^(\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|token)\s*(?:is|[:=])\s*)/i.exec(match)?.[1];
      count += 1;
      return label ? `${label}[redacted]` : '[redacted]';
    });
  }
  return { text: out, count };
};

/** Whether `text` still holds something that looks like a secret. Checked again before anything is stored or posted. */
export const hasSecret = (text: string): boolean => redactSecrets(text).count > 0;

// ---------------------------------------------------------------------------------------------------------------
// Sensitive topics
// ---------------------------------------------------------------------------------------------------------------

/**
 * Words that mark a turn or item as being about pay, hiring, performance, health or someone's personal life. Crude,
 * and errs toward dropping: a dropped item is a line the owner can add by hand, a kept one is a colleague's private
 * matter on a page the team reads.
 */
// Word forms that are also ordinary payments and engineering talk ("fire the webhook", "pay the invoice", "promote the
// build", "health check", "a sick node") are matched only in their HR sense.
const SENSITIVE = new RegExp([
  'salar(?:y|ies)', 'pay ?(?:rise|raise|band|cut|review)s?', 'payroll', '(?:annual|performance|signing) bonus(?:es)?', 'compensation (?:review|package|band)',
  'equity grant', 'promotion (?:case|cycle|packet|review)', 'demot(?:e|ed|ion)',
  'hiring (?:freeze|plan|manager|pipeline|decision|budget)', '(?:got|been|be|was|were|is|being) (?:fired|let go|laid off)', 'firing (?:him|her|them)', 'layoffs?', 'made redundant', 'redundancies at',
  'performance improvement plan', "(?:his|her|their|\\w+['’]s) performance (?:review|plan)", 'disciplinary', 'resignation', '(?:hand(?:ed|ing|s)?|gave|giving) in (?:his|her|their) notice',
  'on (?:medical|sick|parental|maternity|paternity|compassionate|stress) leave', 'laid off', 'on a (?:pip|performance plan)', 'cancer', 'chemo(?:therapy)?',
  '(?:off|out|called in) sick', 'sick (?:leave|days?|note)', 'illness', 'health (?:issue|problem|condition|reasons|scare)', 'mental health', 'medical (?:leave|condition|appointment)',
  'diagnosed with', "(?:his|her|their|\\w+['’]s) diagnosis", 'therap(?:y|ist)', 'surgery', 'hospital(?:ised|ized)?', 'pregnan(?:t|cy)', 'maternity', 'paternity', 'parental leave',
  'divorce', 'bereavement', 'funeral', 'burn(?:ed|t) out', 'burnout', 'visa status', 'immigration (?:status|case|lawyer|appointment)',
].map((word) => `\\b${word}\\b`).join('|'), 'i');
/**
 * Case matters here: a person (a capitalised name, not a sentence-opening word, or a pronoun) is what tells these
 * from engineering talk ("the canary build was promoted", "we are resigning the iOS binary", "PIP mode").
 */
const PERSON = "(?:(?!(?:We|It|This|That|These|Those|The|Our|Their|Its|There|Then|So|And|But|Also|Now|Today|Yesterday|Build|Release|Canary|Deploy)\\b)[A-Z][a-z]+|[Hh]e|[Ss]he|[Tt]hey)";
const SENSITIVE_CASED = new RegExp([
  '(?:put|placed|is|was|are) on (?:a )?PIP', `PIP (?:for|with) ${PERSON}`, `${PERSON}['’]s PIP`, `(?:fire|fired|promoted|terminated) ${PERSON}`, `cut ${PERSON}['’]s pay`, `give ${PERSON} a (?:raise|pay rise)`,
  `${PERSON} (?:was|has been|is being|got) terminated`, `${PERSON} (?:is|was|has been) on leave`,
  `performance (?:review|reviews) (?:for|of|with) ${PERSON}`, `[Rr]aise for ${PERSON}`, `${PERSON} (?:got|gets|is getting|asked for|wants) a (?:raise|pay rise)`,
  `${PERSON} (?:is|was|are|were) leaving the company`, `${PERSON} (?:has |have |just )?(?:quit|quits|is quitting|resigned|is resigning|are resigning)\\b(?! (?:the|this|that|its|their|on|early|unexpectedly) (?:process|job|build|run|worker|app|binary)s?\\b)`,
  `${PERSON} (?:got|gets|has been|have been|was|were|is|will be) promoted(?! to (?:prod|production|staging|main|stable|release|beta|live)\\b)`,
  `${PERSON} (?:is|was|has been|are|have been|were) underperforming`, `${PERSON} (?:is|are|was|were) (?:going|off) on leave`,
  `${PERSON} (?:has|have|had|is having|are having) performance issues`, 'letting (?:[A-Z][a-z]+|him|her|them) go',
].map((word) => `\\b${word}\\b`).join('|'));

export const isSensitive = (text: string): boolean => SENSITIVE.test(text) || SENSITIVE_CASED.test(text);

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

/** Text as one line: whitespace collapsed. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Inline tags WebVTT allows inside a cue (`<c>`, `<i>`, `<00:01.000>`), removed. */
const stripCueTags = (text: string): string => text.replace(/<\/?(?:c|i|b|u|lang|ruby|rt)(?:\.[^>]*)?(?:\s[^>]*)?>/g, '').replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}>/g, '');

interface Raw { speaker: string | null; text: string }

/** The lines of a WebVTT or SRT file as (speaker, text) cues, with timing, numbering, headers and notes removed. */
const cues = (lines: string[]): Raw[] => {
  const out: Raw[] = [];
  let block: string[] = [];
  let skipping = false;
  const flush = (): void => {
    const text = block.join(' ').trim();
    block = [];
    if (!text) return;
    const voice = VTT_VOICE.exec(text);
    if (voice) { out.push({ speaker: oneLine(voice[1]!), text: stripCueTags(voice[2] ?? '') }); return; }
    const clean = stripCueTags(text);
    const named = SPEAKER_LINE.exec(clean);
    if (named && !NOT_SPEAKERS.has(named[1]!.toLowerCase())) out.push({ speaker: named[1]!.trim(), text: named[2]! });
    else out.push({ speaker: null, text: clean });
  };
  for (const line of lines) {
    if (!line.trim()) { flush(); skipping = false; continue; }
    if (skipping) continue;
    if (/^WEBVTT\b/.test(line) || /^(?:NOTE|STYLE|REGION)\b/.test(line)) { flush(); skipping = true; continue; }
    if (TIMING.test(line)) { block = []; continue; }
    // A cue number (SRT) or identifier (VTT) on its own line just before the timing line.
    if (/^\d+$/.test(line.trim()) && block.length === 0) continue;
    block.push(line.trim());
  }
  flush();
  return out;
};

/** Lines of plain text as (speaker, text), with timestamps dropped and continuation lines joined to their turn. */
const plain = (lines: string[]): { raws: Raw[]; title: string | null } => {
  const raws: Raw[] = [];
  let title: string | null = null;
  let seenSpeaker = false;
  for (const original of lines) {
    if (!original.trim() || BARE_TIME.test(original)) continue;
    const line = original.replace(/^\s*[-*>]\s+/, '').replace(LEADING_TIME, '').replace(SPEAKER_TIME, '').replace(/^\*\*([^*]+?):?\*\*:?/, '$1:');
    if (!line.trim()) continue;
    const match = SPEAKER_LINE.exec(line.trim());
    if (match && !NOT_SPEAKERS.has(match[1]!.toLowerCase()) && !/^\d/.test(match[1]!)) {
      seenSpeaker = true;
      raws.push({ speaker: match[1]!.trim(), text: match[2]!.trim() });
      continue;
    }
    // Before the first speaker line, a short line is the title (a Meet doc's name, a Markdown heading).
    if (!seenSpeaker && title === null && raws.length === 0 && line.trim().length <= 120) {
      title = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    const last = raws.at(-1);
    if (last && seenSpeaker) last.text = `${last.text} ${line.trim()}`;
    else raws.push({ speaker: null, text: line.trim() });
  }
  return { raws, title };
};

/** Consecutive cues from the same speaker become one turn, as a reader would hear them. */
const merge = (raws: Raw[]): Raw[] => raws.reduce<Raw[]>((turns, raw) => {
  const text = oneLine(raw.text);
  if (!text) return turns;
  const last = turns.at(-1);
  if (last && last.speaker === raw.speaker && raw.speaker !== null) last.text = `${last.text} ${text}`;
  else turns.push({ speaker: raw.speaker, text });
  return turns;
}, []);

const dateOf = (text: string): string | null => {
  const match = DATE_IN_TEXT.exec(text);
  if (!match) return null;
  const date = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
};

/** A turn as the extractor reads it and quotes are checked against. */
const turnLine = (turn: Turn): string => `${turn.n}. ${turn.speaker ? `${turn.speaker}: ` : ''}${turn.text}`;

/**
 * A transcript from any supported format, normalised, with secrets redacted first. `name` is the file's name, when
 * there is one (`.vtt` and `.srt` are read as captions). Throws when the text is empty or over the cap.
 */
export const parseTranscript = (raw: string, { name, title: givenTitle, date: givenDate }: { name?: string; title?: string; date?: string } = {}): Transcript => {
  if (raw.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error(`That transcript is ${Math.round(raw.length / 1000)} KB; the limit is ${MAX_TRANSCRIPT_CHARS / 1000} KB. Split it, or send the meeting's summary instead.`);
  }
  const { text: screened, count } = redactSecrets(raw.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, ''));
  const lines = screened.split('\n');
  const captions = /\.(?:vtt|srt)$/i.test(name ?? '') || /^WEBVTT\b/.test(screened.trimStart()) || lines.some((line) => TIMING.test(line));
  const parsed = captions ? { raws: cues(lines), title: null } : plain(lines);
  const turns = merge(parsed.raws).map((turn, index) => ({ n: index + 1, speaker: turn.speaker, text: turn.text }));
  if (turns.length === 0) throw new Error('That transcript has no text in it.');
  const speakers = [...new Set(turns.flatMap((turn) => (turn.speaker ? [turn.speaker] : [])))];
  // "Payments sync (2026-11-20 at 10:00 GMT) - Transcript", as Meet names its Docs: the meeting is the part before.
  const title = (givenTitle?.trim() || parsed.title || '').replace(/\s*[-–—]\s*Transcript\s*$/i, '') || null;
  return {
    turns, text: turns.map(turnLine).join('\n'), speakers,
    title: title ? oneLine(title).slice(0, 120) : null,
    date: givenDate && dateOf(givenDate) ? dateOf(givenDate) : dateOf(title ?? '') ?? dateOf(name ?? ''),
    redacted: count,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------------------------

/** Text folded for span checks: case, curly quotes, dashes and whitespace don't count; punctuation at the ends doesn't either. */
export const fold = (text: string): string => text
  .toLowerCase()
  .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, '');

/**
 * The turns a quote sits in, or null when it isn't a span of the transcript. A quote may run across turns
 * ("Ana: three attempts. Isac: yes"), so each part between speaker labels must be a span of consecutive turns.
 */
export const locateQuote = (transcript: Transcript, quote: string): number[] | null => {
  // Split "Ana: … Isac: …" into its parts, so the speaker labels the extractor added don't have to match exactly.
  const labels = transcript.speakers.map((speaker) => speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = (labels.length ? quote.split(new RegExp(`(?:^|\\s)(?:${labels.join('|')}):\\s`)) : [quote]).map(fold).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.join(' ').length < 12) return null;
  const folded = transcript.turns.map((turn) => fold(turn.text));
  const found: number[] = [];
  let from = 0;
  for (const part of parts) {
    const at = folded.findIndex((text, index) => index >= from && text.includes(part));
    if (at === -1) return null;
    found.push(at + 1);
    from = at;
  }
  return [...new Set(found)];
};
