// The edits a meeting makes to a knowledge page (SERRA-62), as pure functions with no Node imports, so the app's
// review screen renders exactly what an approval writes.
//
// A meeting only ever adds or replaces one bullet under `## Decisions`, moves a replaced line (from Decisions or
// anywhere else on the page) under `## Replaced`, and adds a `sources:` entry. Every line it writes carries the
// meeting's tag, `<!-- m:ID -->`, so Forget meeting finds exactly those lines and nothing else.
import { frontmatter } from './knowledge-rules.ts';

/** A page's `## Decisions` takes at most this many bullets from all sources. A full page takes no more. */
const DECISIONS_MAX_BULLETS = 15;
/** `## Replaced` keeps the last this-many meeting bullets. Older ones go. */
const REPLACED_KEEP = 5;
/** Both sections together, provenance included. */
const MEETING_SECTION_MAX_CHARS = 3000;
/** One bullet's own text, before provenance. */
export const ITEM_MAX_CHARS = 200;
/** Where a meeting's one new page goes. */
export const NEW_PAGE_FOLDER = 'decisions';

export interface MeetingStamp {
  /** The meeting's short ID, 6 hex characters. */
  id: string;
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

export interface PageEdit {
  op: 'add' | 'replace';
  /** The decision in the extractor's words, already checked: one line, at most ITEM_MAX_CHARS. */
  text: string;
  /** For `replace`: the old bullet's text, as `decisionBullets` gives it. */
  old?: string;
  /** Who agreed, only when the transcript shows them agreeing. */
  who?: string[];
  links?: string[];
}

export interface Bullet {
  /** The whole line, as on the page. */
  line: string;
  /** The bullet's text without its provenance and tag: what a `replace` names. */
  text: string;
  /** The meeting that wrote it, or null for a bullet the owner wrote. */
  meeting: string | null;
}

export const MEETING_ID = /^[0-9a-f]{6}$/;
const TAG = /\s*<!--\s*m:([0-9a-f]{6})\s*-->\s*$/;

const meetingTag = (id: string): string => `<!-- m:${id} -->`;

/** The lines of the page's body section `heading` (`Decisions`, `Replaced`): where it starts and ends, and its bullets. */
const section = (page: string, heading: string): { start: number; end: number; lines: string[] } | null => {
  const lines = page.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end += 1;
  return { start, end, lines };
};

const bulletOf = (line: string): Bullet | null => {
  const match = /^[-*]\s+(.*)$/.exec(line);
  if (!match) return null;
  const meeting = TAG.exec(line)?.[1] ?? null;
  const withoutTag = match[1]!.replace(TAG, '').trim();
  // A meeting bullet's provenance is its last parenthesis: "(2026-11-20, Payments sync: Ana; LIN-482)".
  const text = meeting ? withoutTag.replace(/\s*\((?:stopped applying|\d{4}-\d{2}-\d{2})[^()]*\)\s*$/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}[^()]*\)\s*$/, '').trim() : withoutTag;
  return { line, text, meeting };
};

/** The bullets under `## Decisions`, current rules first to last. */
export const decisionBullets = (page: string): Bullet[] => {
  const found = section(page, 'Decisions');
  if (!found) return [];
  return found.lines.slice(found.start + 1, found.end).flatMap((line) => bulletOf(line) ?? []);
};

/** One current bullet on the page, wherever it sits, and its line number. */
interface PlacedBullet extends Bullet { at: number; inDecisions: boolean }

/**
 * Every bullet on the page that still applies: top-level bullets in the body, in any section but `## Replaced`. A rule
 * the owner wrote above `## Decisions` ("- Releases go out on Tuesdays.") is one a meeting can replace too.
 */
const placedBullets = (page: string): PlacedBullet[] => {
  const lines = page.split('\n');
  const body = /^---\n[\s\S]*?\n---\n/.exec(page)?.[0].split('\n').length ?? 1;
  let heading: string | null = null;
  const found: PlacedBullet[] = [];
  for (let at = body - 1; at < lines.length; at += 1) {
    const line = lines[at]!;
    const title = /^(#{1,2})\s+(.*?)\s*$/.exec(line);
    if (title) { heading = title[1] === '##' ? title[2]!.toLowerCase() : null; continue; }
    if (heading === 'replaced') continue;
    const bullet = bulletOf(line);
    if (bullet) found.push({ ...bullet, at, inDecisions: heading === 'decisions' });
  }
  return found;
};

/** The page's current rules, for the extractor and its checks: every bullet a meeting may replace. */
export const currentBullets = (page: string): Bullet[] => placedBullets(page).map(({ line, text, meeting }) => ({ line, text, meeting }));

/** The bullets under `## Replaced`. */
export const replacedBullets = (page: string): Bullet[] => {
  const found = section(page, 'Replaced');
  if (!found) return [];
  return found.lines.slice(found.start + 1, found.end).flatMap((line) => bulletOf(line) ?? []);
};

/** Text folded for comparing bullets: case, punctuation and spacing don't count. */
export const sameDecision = (a: string, b: string): boolean => {
  const fold = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return fold(a) === fold(b);
};

/** The bullet a meeting writes: the decision, then when, where and (only when shown) who, then its tag. */
const renderBullet = (edit: Pick<PageEdit, 'text' | 'who' | 'links'>, meeting: MeetingStamp): string => {
  const who = edit.who?.length ? `: ${edit.who.join(', ')}` : '';
  const links = edit.links?.length ? `; ${edit.links.join(', ')}` : '';
  return `- ${edit.text.trim()} (${meeting.date}, ${meeting.title}${who}${links}) ${meetingTag(meeting.id)}`;
};

/** The `sources:` entry a meeting adds. Forget finds it by its start, `meeting ID `. */
const sourceEntry = (meeting: MeetingStamp): string => `meeting ${meeting.id} ${meeting.date} "${meeting.title.replace(/"/g, "'")}", transcript not kept`;

/** The page with `entry` added to its header's `sources:` list (made a list if it was one line). */
const addSource = (page: string, entry: string): string => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(page);
  if (!match?.[1]) return page;
  const lines = match[1].split('\n');
  const start = lines.findIndex((line) => line.startsWith('sources:'));
  if (start === -1) {
    lines.push('sources:', `  - ${entry}`);
  } else {
    const inline = lines[start]!.slice('sources:'.length).trim();
    let end = start + 1;
    while (end < lines.length && /^\s+-/.test(lines[end]!)) end += 1;
    const items = [...(inline ? [`  - ${inline.replace(/^-\s*/, '')}`] : []), ...lines.slice(start + 1, end)];
    if (items.some((item) => item.trim() === `- ${entry}`)) return page;
    lines.splice(start, end - start, 'sources:', ...items, `  - ${entry}`);
  }
  return `---\n${lines.join('\n')}\n---\n${page.slice(match[0].length)}`;
};

/** Insert `line` at the end of section `heading`'s bullets, making the section (before `## Replaced`, else at the end) if needed. */
const appendTo = (page: string, heading: string, line: string): string => {
  const trimmed = page.replace(/\n+$/, '');
  const found = section(trimmed, heading);
  const lines = trimmed.split('\n');
  if (found) {
    let at = found.end;
    while (at > found.start + 1 && !lines[at - 1]!.trim()) at -= 1;
    lines.splice(at, 0, line);
    return `${lines.join('\n')}\n`;
  }
  const replaced = heading === 'Decisions' ? lines.findIndex((text) => /^##\s+Replaced\s*$/i.test(text)) : -1;
  if (replaced !== -1) {
    lines.splice(replaced, 0, `## ${heading}`, '', line, '');
    return `${lines.join('\n')}\n`;
  }
  return `${lines.join('\n')}\n\n## ${heading}\n\n${line}\n`;
};

/**
 * `## Replaced` keeps every owner bullet and the last REPLACED_KEEP meeting bullets, plus any bullet a current
 * Decisions bullet replaced: forgetting that meeting must be able to bring it back.
 */
const trimReplaced = (page: string): string => {
  const found = section(page, 'Replaced');
  if (!found) return page;
  const live = new Set(decisionBullets(page).flatMap((bullet) => (bullet.meeting ? [bullet.meeting] : [])));
  const bullets = found.lines.slice(found.start + 1, found.end).map((line, offset) => ({ line, at: found.start + 1 + offset, bullet: bulletOf(line) }));
  const meetingLines = bullets.filter((entry) => entry.bullet?.meeting && !live.has(/replaced by m:([0-9a-f]{6})\)/.exec(entry.line)?.[1] ?? ''));
  const drop = new Set(meetingLines.slice(0, Math.max(0, meetingLines.length - REPLACED_KEEP)).map((entry) => entry.at));
  return found.lines.filter((_, at) => !drop.has(at)).join('\n');
};

/** Why `page` can't take one more meeting bullet `line`, or null when it can. */
const roomProblem = (page: string, line: string, replacing: boolean): string | null => {
  const decisions = decisionBullets(page);
  if (!replacing && decisions.length >= DECISIONS_MAX_BULLETS) return `its Decisions section is full (${DECISIONS_MAX_BULLETS} bullets). Tidy it in Pages`;
  const chars = [...decisions, ...replacedBullets(page)].reduce((sum, bullet) => sum + bullet.line.length + 1, 0) + line.length + 1;
  if (chars > MEETING_SECTION_MAX_CHARS) return `its Decisions and Replaced sections would be over ${MEETING_SECTION_MAX_CHARS} characters. Tidy it in Pages`;
  return null;
};

/**
 * The page after a meeting's edit, or why it can't be applied. `add` appends a bullet to `## Decisions`; `replace`
 * takes the old line out of the page's current rules (any bullet `currentBullets` lists), puts the new bullet under
 * `## Decisions`, and moves the old line under `## Replaced` with the date it stopped applying, keeping the old
 * bullet's own meeting tag. The page's `sources:` gains the meeting. `verified:` is left
 * alone: one bullet doesn't re-verify a page the owner didn't review.
 */
export const applyEdit = (page: string, edit: PageEdit, meeting: MeetingStamp): { text: string } | { problem: string } => {
  const line = renderBullet(edit, meeting);
  const old = edit.op === 'replace' ? placedBullets(page).find((bullet) => sameDecision(bullet.text, edit.old ?? '')) : undefined;
  if (edit.op === 'replace' && !old) return { problem: "The page changed: the line this replaces isn't on it any more. Discard this edit." };
  const room = roomProblem(page, line, old?.inDecisions === true);
  if (room) return { problem: `This page can't take more: ${room}.` };
  let text: string;
  if (old) {
    // The old line leaves the page's current rules: a Decisions bullet is swapped in place; a line elsewhere on the
    // page is removed and the new bullet goes under Decisions. Either way the old one moves under Replaced.
    const tag = TAG.exec(old.line)?.[0] ?? '';
    const retired = `${old.line.replace(TAG, '')} (stopped applying ${meeting.date}, replaced by m:${meeting.id})${tag ? ` ${tag.trim()}` : ''}`;
    const lines = page.split('\n');
    if (old.inDecisions) lines[old.at] = line;
    else lines.splice(old.at, 1);
    const swapped = old.inDecisions ? lines.join('\n') : appendTo(lines.join('\n'), 'Decisions', line);
    text = trimReplaced(appendTo(swapped, 'Replaced', retired));
  } else {
    text = appendTo(page, 'Decisions', line);
  }
  return { text: addSource(text, sourceEntry(meeting)) };
};

/** A page name from a topic: `payments webhooks` → `payments-webhooks`. */
export const topicSlug = (topic: string): string => topic.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'meeting-decisions';

/** The description and index row a meeting's new page gets. Recorded, so Forget can scrub them from backups. */
const newPageDescription = (topic: string): string => `Decisions about ${topic.trim()}, from team meetings.`;

/** A meeting's one new page: team audience, verified today (the owner approves its whole content), one bullet. */
export const newDecisionPage = (topic: string, edit: PageEdit, meeting: MeetingStamp, today: string): string => [
  '---',
  'type: decisions',
  `description: ${newPageDescription(topic)}`,
  'audience: team',
  `written: ${today}`,
  `verified: ${today}`,
  'sources:',
  `  - ${sourceEntry(meeting)}`,
  '---',
  `# ${topic.trim().replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())}`,
  '',
  '## Decisions',
  '',
  renderBullet(edit, meeting),
  '',
].join('\n');

/** The index row for a new page, in the index's `| When | Page | Gives |` shape. */
export const indexRow = (path: string, topic: string): string => {
  const cell = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return `| ${cell(`Anything about ${topic}`)} | \`${path}\` | ${cell(newPageDescription(topic))} |`;
};

/**
 * Everything meeting `id` added to `text`, removed:
 * - lines tagged with it, under Decisions or Replaced;
 * - its `sources:` entry;
 * - a bullet it replaced goes back under `## Decisions`, without its "replaced by" note: with the meeting forgotten,
 *   that rule is current again;
 * - `rows`: index rows the meeting added for a page that Forget removes, line by line.
 * Used on pages, the approved copy, the index and every backup.
 */
export const scrubMeeting = (text: string, id: string, rows: string[] = []): string => {
  if (!MEETING_ID.test(id)) throw new Error(`Not a meeting ID: ${id}`);
  const tag = new RegExp(`<!--\\s*m:${id}\\s*-->`);
  const note = new RegExp(` \\(stopped applying \\d{4}-\\d{2}-\\d{2}, replaced by m:${id}\\)`);
  const source = new RegExp(`^\\s+-\\s+meeting ${id} `);
  const drop = new Set(rows.map((line) => line.trim()).filter(Boolean));
  // When the meeting's own bullet was itself replaced later (by m:NEXT), what it replaced was replaced by NEXT in
  // effect: that bullet stays under Replaced, its note pointing at NEXT. Otherwise it's current again.
  const successor = text.split('\n').filter((line) => tag.test(line)).map((line) => /replaced by m:([0-9a-f]{6})\)/.exec(line)?.[1]).find(Boolean);
  const restored: string[] = [];
  const lines = text.split('\n').flatMap((line) => {
    if (tag.test(line) || source.test(line) || drop.has(line.trim())) return [];
    if (note.test(line) && /^[-*]\s/.test(line)) {
      if (successor) return [line.replace(note, (match) => match.replace(`m:${id}`, `m:${successor}`))];
      restored.push(line.replace(note, ''));
      return [];
    }
    return [line];
  });
  let out = lines.join('\n');
  // A Decisions or Replaced heading left with nothing under it goes too.
  out = out.replace(/\n## (?:Decisions|Replaced)\s*\n+(?=## |$)/g, '\n').replace(/\n{3,}/g, '\n\n');
  for (const line of restored) out = appendTo(out, 'Decisions', line);
  // A `sources:` key left with no entries stays: the header check needs the key.
  return out;
};

/** Whether a page's text still mentions meeting `id` anywhere. */
export const mentionsMeeting = (text: string, id: string): boolean => text.includes(`m:${id}`) || new RegExp(`meeting ${id} `).test(text);

/** The page's audience exactly as written, for the team-only rule: an untagged page is the owner's. */
export const audienceLine = (page: string): string | null => frontmatter(page)?.get('audience')?.trim() ?? null;
