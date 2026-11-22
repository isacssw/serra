// "Remember this meeting" in the owner's DM (SERRA-62): the daemon's side, before any job starts.
//
// `intercept` runs first in `receive()` and in the held-request release path, before the update-pause hold and
// before any job starts or continues. Its decision is synchronous: a top-level trigger closes the thread on disk
// before any await, so no reply in it can reach a T3 worker, even if capture is then refused. Everything after
// (reading the transcript, the extractor, the checks, the digest) is the returned `work`, which the caller tracks
// like a starting job so an update waits for it.
//
// Capture needs: capture turned on in the app; the owner's own ID; a real one-to-one DM; a new top-level message
// (or a DM thread Serra has no job in and no earlier messages, for Slack's agent view); and no update pause.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { isRecord, parseJson } from './json-guards.ts';
import { shortError } from './lib/errors.ts';
import { createJournal } from './knowledge-journal.ts';
import { frontmatter, NOT_PAGES, PROPOSALS_DIR } from './knowledge-rules.ts';
import { checkDigest, extractionPrompt, meetingStamp, parseDigestOutput, type Digest, type TeamPage } from './meeting-digest.ts';
import type { MeetingRuns } from './meeting-runs.ts';
import { readMeetingSettings } from './meeting-settings.ts';
import { meetingRequest, PROVIDERS, TRANSCRIPT_FILE, type MeetingLink } from './meeting-sources.ts';
import { createMeetingStore, DuplicateMeeting, replyLines, transcriptHash, type MeetingSourceKind, type MeetingStore } from './meeting-store.ts';
import { MAX_TRANSCRIPT_CHARS, parseTranscript } from './meeting-transcript.ts';
import type { IncomingFile, IncomingMessage } from './types.ts';

const CLOSED_THREADS_FILE = 'meeting-threads.json';

/** How Serra talks in Slack while capturing. Posting failures are logged, never thrown. */
export interface MeetingChat {
  /** Post `text` (in `threadTs`'s thread when given). Returns the new message's ts. */
  post: (channel: string, text: string, threadTs?: string) => Promise<string | undefined>;
  /** Delete a message Serra posted (its digest, on Forget). */
  remove: (channel: string, ts: string) => Promise<void>;
  /** How many messages a DM thread had before `beforeTs`, for the agent-view check. */
  earlierInThread: (channel: string, threadTs: string, beforeTs: string) => Promise<number>;
}

export interface MeetingCaptureDeps {
  profileDir: string;
  knowledgeDir: string;
  owner: string;
  chat: MeetingChat;
  /** Read an uploaded file's text, refusing anything over `maxChars`. Never written to disk. */
  readFile: (file: IncomingFile, maxChars: number) => Promise<{ name: string; text: string }>;
  /** Reads a linked meeting in a T3 run (src/meeting-runs.ts). */
  sources: Pick<MeetingRuns, 'fetchTranscript'>;
  /** Picks the decisions out in a T3 run, briefed to use no tools. */
  extractor: Pick<MeetingRuns, 'extract'>;
  /** Whether an update has paused new work. */
  paused: () => boolean;
  /** Whether Serra has a job or a held request in this thread. */
  busy: (channel: string, threadTs: string) => boolean;
  store?: MeetingStore;
  now?: () => Date;
  log?: (message: string) => void;
}

export const COPY = {
  closed: 'This thread holds a meeting transcript, so Serra won’t use it. Ask in a new message.',
  inThread: 'To add a meeting, send it as a new message in our DM, starting with “remember this meeting”.',
  notOwner: (owner: string) => `Only <@${owner}> can add meetings, as a new message in their DM with me.`,
  ownerElsewhere: 'Add meetings as a new message in our DM, not here.',
  off: 'Meeting capture is off. Turn it on in Serra › Settings › Meetings, then send the meeting again.',
  paused: 'Serra is updating. Send the meeting again in a minute.',
  earlier: 'To add a meeting, start a new conversation with me and send it there first.',
  linkAndText: 'Reading the link. The text you pasted with it is ignored.',
  nothing: 'Send the transcript as a file (.txt, .md, .vtt or .srt), paste it after “remember this meeting”, or add a Granola or Google Meet transcript link.',
  oneFile: 'Send one transcript file at a time (.txt, .md, .vtt or .srt).',
  reading: (what: string) => `Reading ${what}… You review every item before Serra keeps it.`,
  done: 'Done. The digest is below in our DM.',
  failed: (why: string) => `Couldn’t read that meeting: ${why}`,
} as const;

const key = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;

/** The pages a meeting may change, from the approved copy: audience exactly `team`. And every page path that exists. */
export const meetingPages = (knowledgeDir: string): { team: TeamPage[]; existing: Set<string> } => {
  const journal = createJournal(knowledgeDir);
  const base = journal.seeded() ? journal.approvedRoot : knowledgeDir;
  const paths: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(join(base, dir))) return;
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (path !== PROPOSALS_DIR) walk(path); continue; }
      if (entry.name.endsWith('.md') && !NOT_PAGES.has(path) && entry.name !== 'README.md') paths.push(path);
    }
  };
  walk('');
  const team = paths.sort().flatMap((path) => {
    const text = readFileSync(join(base, path), 'utf8');
    const fields = frontmatter(text);
    // Never owner/ or people/, whatever their header says.
    if (fields?.get('audience')?.trim() !== 'team' || /^(?:owner|people)\//.test(path)) return [];
    return [{ path, description: fields.get('description')?.trim() ?? '', text }];
  });
  return { team, existing: new Set(paths) };
};

/** Model text as plain Slack text: `&`, `<` and `>` escaped, so an injected line can't become a link or a mention. */
const plain = (text: string): string => text.replace(/`/g, "'").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // A bare URL would still turn into a link: code formatting keeps it plain text.
  .replace(/\b(?:https?:\/\/|www\.)[^\s`]*[^\s`.,;:!?)]|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?![\w-])(?:\/[^\s`]*[^\s`.,;:!?)])?/gi, (url) => `\`${url}\``);

/** The digest message: what's waiting for review, what's already known, action items and questions, what was left out. */
export const digestText = (digest: Digest, from: string): string => {
  const lines = [`*${plain(digest.meeting.title)}* · ${digest.meeting.date} · from ${from}`];
  const count = digest.items.length;
  lines.push(count ? `${count} ${count === 1 ? 'decision' : 'decisions'} to review in Serra › Knowledge › Proposals:` : 'Nothing new to remember from this meeting.');
  for (const item of digest.items) lines.push(`• ${plain(item.edit.text)} → \`${item.target}\``);
  if (digest.known.length) lines.push('', `Already in your notes: ${digest.known.length}.`);
  const actions = digest.reply.filter((line) => line.kind === 'action');
  const questions = digest.reply.filter((line) => line.kind === 'question');
  const dated = digest.reply.filter((line) => line.kind === 'dated');
  if (actions.length) lines.push('', '*Action items*', ...replyLines(actions).map(plain));
  if (questions.length) lines.push('', '*Open questions*', ...replyLines(questions).map(plain));
  if (dated.length) lines.push('', '*Until a date*', ...replyLines(dated).map(plain));
  const left = Object.entries(digest.dropped).filter(([, n]) => n > 0).map(([reason, n]) => `${n} ${reason}`);
  if (left.length) lines.push('', `Left out: ${left.join(', ')}.`);
  return lines.join('\n');
};

export const createMeetingCapture = (deps: MeetingCaptureDeps) => {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const store = deps.store ?? createMeetingStore({ knowledgeDir: deps.knowledgeDir, now });
  const closedPath = join(deps.profileDir, CLOSED_THREADS_FILE);

  const readClosed = (): Record<string, string> => {
    let value: unknown;
    try { value = parseJson(readFileSync(closedPath, 'utf8')); } catch { return {}; }
    return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  };
  const closedThreads = readClosed();

  /** Close a thread, on disk, synchronously: from now on nothing in it reaches a worker. */
  const close = (channel: string, threadTs: string): void => {
    // Never evicted: a thread that holds a transcript stays closed for good. One short line per meeting sent.
    closedThreads[key(channel, threadTs)] = now().toISOString();
    writeFileAtomic(closedPath, `${JSON.stringify(closedThreads, null, 2)}\n`, { mode: 0o600 });
  };
  const closed = (channel: string, threadTs: string): boolean => key(channel, threadTs) in closedThreads;

  const say = async (channel: string, text: string, threadTs?: string): Promise<string | undefined> => {
    try { return await deps.chat.post(channel, text, threadTs); } catch (error) { log(`Couldn't post to Slack: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  };

  /** The transcript the message carries: a provider link, one file, or pasted text. */
  const transcriptOf = async (msg: IncomingMessage, link: MeetingLink | null, pasted: string): Promise<{ raw: string; name?: string; title?: string; source: MeetingSourceKind; from: string }> => {
    if (link) {
      const fetched = await deps.sources.fetchTranscript(link);
      return { raw: fetched.text, ...(fetched.title ? { title: fetched.title } : {}), source: link.provider, from: PROVIDERS[link.provider].label };
    }
    const files = msg.files ?? [];
    if (files.length > 1) throw new Error(COPY.oneFile);
    if (files.length === 1) {
      const file = files[0]!;
      if (!TRANSCRIPT_FILE.test(file.name ?? '')) throw new Error(COPY.nothing);
      const { name, text } = await deps.readFile(file, MAX_TRANSCRIPT_CHARS);
      return { raw: text, name, source: 'upload', from: 'an upload' };
    }
    if (pasted.trim()) return { raw: pasted, source: 'paste', from: 'pasted text' };
    throw new Error(COPY.nothing);
  };

  /** Read, extract, check, record and post the digest. Every failure is a reply in the meeting's thread. */
  const capture = async (msg: IncomingMessage, link: MeetingLink | null, pasted: string): Promise<void> => {
    const thread = msg.threadTs;
    try {
      if (!msg.files?.length && !link && !pasted.trim()) throw new Error(COPY.nothing);
      await say(msg.channel, COPY.reading(link ? `the ${PROVIDERS[link.provider].label} transcript` : 'the transcript'), thread);
      if (link && (pasted.trim() || msg.files?.length)) await say(msg.channel, COPY.linkAndText, thread);
      let source = await transcriptOf(msg, link, pasted);
      const transcript = parseTranscript(source.raw, { ...(source.name ? { name: source.name } : {}), ...(source.title ? { title: source.title } : {}) });
      // The raw text is no longer needed: only the redacted, normalised transcript goes further.
      source = { ...source, raw: '' };
      // The same meeting sent twice is caught before a T3 run, and again when it's recorded (two sent at once).
      const hash = transcriptHash(transcript);
      const earlier = store.findTranscript(hash);
      if (earlier) throw new DuplicateMeeting(earlier);
      const today = now().toISOString().slice(0, 10);
      const { team, existing } = meetingPages(deps.knowledgeDir);
      const id = store.newId();
      const output = await deps.extractor.extract(extractionPrompt(transcript, team, today));
      const raw = parseDigestOutput(output);
      const meeting = meetingStamp(raw, transcript, id, today);
      const digest = checkDigest(raw, { transcript, pages: team, existing, meeting });
      if (transcript.redacted) digest.dropped['secret redacted'] = transcript.redacted;
      store.addMeeting({ meeting, items: digest.items, source: source.source, speakers: transcript.speakers, dropped: digest.dropped, pages: new Map(team.map((page) => [page.path, page.text])), transcript: hash });
      await say(msg.channel, COPY.done, thread);
      const ts = await say(msg.channel, digestText(digest, source.from));
      // The digest holds unreviewed text from the meeting (action items aren't quote-checked): its thread is closed
      // too, so a reply there never hands it to a worker as Serra's own words.
      if (ts) { close(msg.channel, ts); store.setDigest(id, { channel: msg.channel, ts }); }
      log(`Meeting ${id}: ${digest.items.length} item(s) to review, ${digest.reply.length} for the reply.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`Meeting capture failed: ${reason}`);
      // The DM gets a short reason: never a command's raw output or a local path. The log keeps the detail.
      // A duplicate names the earlier meeting's title, which came from the meeting: plain text only.
      const text = error instanceof DuplicateMeeting ? plain(reason) : reason === COPY.nothing || reason === COPY.oneFile ? reason : COPY.failed(shortError(error));
      await say(msg.channel, text, thread);
    }
  };

  /**
   * Whether this message is about meetings, decided synchronously. Null: not a meeting message, handle it as usual.
   * Otherwise the message is Serra's: the caller tracks `work` and never passes the message to a job.
   */
  const intercept = (msg: IncomingMessage): { work: Promise<void> } | null => {
    if (msg.botId) return null;
    if (closed(msg.channel, msg.threadTs)) return { work: say(msg.channel, COPY.closed, msg.threadTs).then(() => {}) };
    const request = meetingRequest(msg.text);
    if (!request.trigger) return null;
    const enabled = readMeetingSettings(deps.profileDir).enabled;
    const topLevel = msg.threadTs === msg.messageTs;
    const dm = msg.im === true && msg.channel.startsWith('D');
    const fromOwner = msg.user === deps.owner && dm && !msg.automaticTrigger;
    // With capture off, only the owner's messages are about meetings: anyone else's is an ordinary request.
    if (!enabled && (msg.user !== deps.owner || msg.automaticTrigger)) return null;
    if (!topLevel) {
      // A trigger in a thread Serra is working in is never passed to that job, and doesn't close it.
      if (!dm || deps.busy(msg.channel, msg.threadTs)) return { work: say(msg.channel, COPY.inThread, msg.threadTs).then(() => {}) };
    }
    // From here on the thread holds a transcript (or is about to): closed before any await.
    close(msg.channel, msg.threadTs);
    const refuse = (text: string): { work: Promise<void> } => ({ work: say(msg.channel, text, msg.threadTs).then(() => {}) });
    if (!fromOwner) return refuse(msg.user === deps.owner && !msg.automaticTrigger ? COPY.ownerElsewhere : COPY.notOwner(deps.owner));
    if (!enabled) return refuse(COPY.off);
    if (deps.paused()) return refuse(COPY.paused);
    return {
      work: (async () => {
        // Slack's agent view: a DM conversation is a thread. Only one with nothing before the trigger may hold a meeting.
        if (!topLevel && await deps.chat.earlierInThread(msg.channel, msg.threadTs, msg.messageTs).catch(() => 1) > 0) {
          await say(msg.channel, COPY.earlier, msg.threadTs);
          return;
        }
        await capture(msg, request.link, request.pasted);
      })(),
    };
  };

  /**
   * At start, before intake opens: requests held by an older Serra during an update that say "remember this meeting"
   * are closed and dropped (with a "send it again" reply), so a restart never replays a transcript to a job.
   */
  const closeHeld = (held: IncomingMessage[]): { drop: IncomingMessage[]; replies: Promise<void>[] } => {
    // A top-level trigger is a transcript on disk: dropped. A trigger inside a thread is answered when it's released.
    const drop = held.filter((msg) => (meetingRequest(msg.text).trigger && msg.threadTs === msg.messageTs) || closed(msg.channel, msg.threadTs));
    for (const msg of drop) close(msg.channel, msg.threadTs);
    return { drop, replies: drop.map((msg) => say(msg.channel, 'Serra restarted before reading this meeting. Send it again as a new message.', msg.threadTs).then(() => {})) };
  };

  /** Periodic upkeep: finish crashed approvals and Forgets, expire old pending edits, delete forgotten digests. */
  const upkeep = async (): Promise<void> => {
    store.recover();
    store.resumeForgets();
    const expired = store.expire();
    if (expired.length) log(`Meeting edits expired after 30 days: ${expired.join(', ')}.`);
    for (const digest of store.digestsToDelete()) {
      try {
        await deps.chat.remove(digest.channel, digest.ts);
        store.digestDeleted(digest.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Already gone (the owner deleted it) counts as deleted.
        if (/message_not_found|channel_not_found/.test(message)) store.digestDeleted(digest.id);
        else log(`Couldn't delete a forgotten meeting's digest: ${message}`);
      }
    }
  };

  return { intercept, closed, closeHeld, upkeep, store };
};


/**
 * Meetings first: the routing `receive()` and the held-request release path both use. A message `intercept` claims
 * is tracked as Serra's own work and never reaches `next` (the pause hold, then a job); anything else goes to `next`
 * unchanged.
 */
export const meetingsFirst = (
  intercept: (msg: IncomingMessage) => { work: Promise<void> } | null,
  track: (work: Promise<void>) => Promise<void>,
  next: (msg: IncomingMessage) => Promise<void>,
) => (msg: IncomingMessage): Promise<void> => {
  const meeting = intercept(msg);
  return meeting ? track(meeting.work) : next(msg);
};
