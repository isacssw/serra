// Where a meeting transcript comes from (SERRA-62, SERRA-69): a file or pasted text in the owner's DM, or a link to a
// Granola note or a Google Meet transcript Doc.
//
// Serra never holds a Granola or Google token, and never calls a provider itself: a link is read by a T3 run
// (src/meeting-runs.ts), through the connections the AI provider the owner picked in T3 already has. This module
// only says what a message asks for, what each source needs, and how to unwrap what the run gives back.
import { isRecord, parseJson, stringField } from './json-guards.ts';

export type MeetingProvider = 'granola' | 'google-meet';

/** A meeting the owner pointed at with a link. */
export interface MeetingLink { provider: MeetingProvider; id: string; url: string }

export interface MeetingRequest {
  /** The message starts with "remember this meeting". */
  trigger: boolean;
  link: MeetingLink | null;
  /** Text after the trigger phrase and link: a pasted transcript or summary, if any. */
  pasted: string;
}

/** Only "remember this meeting" at the very start (after an optional mention): "remember our meeting at 3" is a job. */
const TRIGGER = /^\s*(?:<@[UW][A-Z0-9]+(?:\|[^>]*)?>[\s,:]*)?remember\s+this\s+meeting\b(?!['’])[ \t:.,—–-]*/i;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `https://notes.granola.ai/d/<uuid>`, `https://app.granola.ai/…/<uuid or not_…>`. */
const GRANOLA = new RegExp(`<?(https://(?:notes|app)\\.granola\\.ai/[^\\s>|]*?(${UUID}|not_[A-Za-z0-9]{14}))(?:[/?#][^\\s>|]*)?(?:\\|[^>]*)?>?`, 'i');
/** A Google Doc or Drive file link. Meet saves transcripts as Docs. */
const GOOGLE_DOC = /<?(https:\/\/(?:docs\.google\.com\/document\/(?:u\/\d+\/)?d\/|drive\.google\.com\/(?:file\/d\/|open\?id=))([A-Za-z0-9_-]{20,}))(?:[/?#][^\s>|]*)?(?:\|[^>]*)?>?/;

/**
 * What a DM message asks for. Only a message that starts with the trigger phrase counts: "can you remember this
 * meeting later?" in the middle of a request is an ordinary job.
 */
export const meetingRequest = (text: string): MeetingRequest => {
  const trigger = TRIGGER.exec(text);
  if (!trigger) return { trigger: false, link: null, pasted: '' };
  let rest = text.slice(trigger[0].length);
  let link: MeetingLink | null = null;
  // A link counts only as the first thing after the phrase: a link inside a pasted transcript is part of the meeting.
  const granola = GRANOLA.exec(rest);
  const doc = GOOGLE_DOC.exec(rest);
  // Or a short one-line message that only introduces a link ("remember this meeting, here it is: <link>").
  // The note is on the trigger's own line, and nothing but punctuation follows the link.
  const introduces = (match: RegExpExecArray): boolean => {
    const before = rest.slice(0, match.index);
    const after = rest.slice(match.index + match[0].length).trim();
    return before.length < 120 && !before.includes('\n') && /^[.!)]*$/.test(after);
  };
  const first = [granola, doc].filter((match): match is RegExpExecArray => match !== null && (rest.slice(0, match.index).trim() === '' || introduces(match))).sort((a, b) => a.index - b.index)[0];
  if (first) {
    link = first === granola ? { provider: 'granola', id: first[2]!, url: first[1]! } : { provider: 'google-meet', id: first[2]!, url: first[1]! };
    rest = `${rest.slice(0, first.index)}${rest.slice(first.index + first[0].length)}`;
  }
  return { trigger: true, link, pasted: rest.trim() };
};

/** What each source is, what a run uses to read it, and what the owner does when it can't. */
export const PROVIDERS: Record<MeetingProvider, {
  label: string;
  /** The connection the run reads through, and the read it makes, for the brief. Never a token. */
  read: (id: string) => string;
  /** What the owner does when the run has no such connection. */
  setup: string;
  plan: string;
}> = {
  granola: {
    label: 'Granola',
    read: (id) => `Use your Granola connection's read tool that returns one meeting's transcript (for example get_meeting_transcript) for the meeting with ID "${id}".`,
    setup: 'Connect Granola in the AI provider you use in T3 (for Claude: claude.ai › Settings › Connectors › Granola; for others, add Granola’s MCP server, https://mcp.granola.ai/mcp) and sign in.',
    plan: 'Granola gives transcripts to AI tools on its Business and Enterprise plans.',
  },
  'google-meet': {
    label: 'Google Meet',
    read: (id) => `Use your Google Drive connection's read tool that returns a file's text content (for example read_file_content) for the Google Doc with file ID "${id}".`,
    setup: 'Connect Google Drive in the AI provider you use in T3 (for Claude: claude.ai › Settings › Connectors › Google Drive) and sign in.',
    plan: 'Meet saves transcripts to Drive on Google Workspace Business Standard and above, when transcripts are turned on for the meeting.',
  },
};

/** Every provider, in display order. */
export const PROVIDER_IDS: readonly MeetingProvider[] = ['granola', 'google-meet'];

/**
 * Whether a source can be read: `untested` until the owner presses Test (Serra never makes a model call on its own
 * to find out), then what the test run said.
 */
type ProviderState = 'ready' | 'needs-sign-in' | 'missing' | 'untested' | 'unknown';

export interface ProviderStatus {
  provider: MeetingProvider;
  state: ProviderState;
  detail: string;
  /** When the owner last tested it, for a result the app kept (`meeting-sources.json`). */
  testedAt?: string;
}

export interface Fetched { text: string; title: string | null }

/** The transcript in a tool's answer: plain text as is; JSON with a transcript, text, content or entries field unwrapped. */
export const transcriptFromResult = (text: string): Fetched => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { text: trimmed, title: null };
  {
    const value = parseJson(trimmed);
    if (value === undefined) return { text: trimmed, title: null };
    const pick = (item: unknown): Fetched | null => {
      if (typeof item === 'string') return { text: item, title: null };
      if (Array.isArray(item)) {
        const entries: unknown[] = item;
        const lines = entries.flatMap((record) => {
          if (!isRecord(record)) return [];
          const who = record.speaker;
          const speaker = typeof who === 'string' ? who
            : isRecord(who) ? stringField(who.name) ?? stringField(who.diarization_label) ?? stringField(who.source) ?? '' : '';
          const said = typeof record.text === 'string' ? record.text : '';
          return said ? [`${speaker ? `${speaker}: ` : ''}${said}`] : [];
        });
        return lines.length ? { text: lines.join('\n'), title: null } : null;
      }
      if (!isRecord(item)) return null;
      const record = item;
      const title = typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : null;
      for (const key of ['transcript', 'content', 'text', 'entries', 'body']) {
        const found = record[key] === undefined ? null : pick(record[key]);
        if (found) return { text: found.text, title: found.title ?? title };
      }
      return null;
    };
    return pick(value) ?? { text: trimmed, title: null };
  }
};

/** File types Serra reads as transcripts. */
export const TRANSCRIPT_FILE = /\.(?:txt|md|markdown|vtt|srt)$/i;
