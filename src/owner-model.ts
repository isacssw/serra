// What a worker always knows about the owner, and who may hear what. Pure functions with no Node imports, so the
// app's About me screen shows exactly what a brief gets.
import { DATE, frontmatter } from './knowledge-rules.ts';

/**
 * Who will see the bot's reply. `owner`: only the owner (a DM with the owner, a task started in the app).
 * `team`: people in the owner's workspace (a channel, a teammate's DM). `external`: people from another company may
 * see it (a shared channel), or Serra can't tell.
 */
export type Visibility = 'owner' | 'team' | 'external';

/** Who a page may be quoted to, from its `audience:` header. A page without one is the owner's only. */
export type Audience = Visibility;

export const AUDIENCES: readonly Audience[] = ['owner', 'team', 'external'];

export const pageAudience = (fields: Map<string, string> | null): Audience => {
  const value = fields?.get('audience')?.trim();
  return AUDIENCES.includes(value as Audience) ? value as Audience : 'owner';
};

/** Whether a page for `audience` may be used in a reply seen by `visibility`. */
export const mayUse = (audience: Audience, visibility: Visibility): boolean =>
  visibility === 'owner' || (visibility === 'team' && audience !== 'owner') || audience === 'external';

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  owner: 'only you', team: 'your team', external: 'people outside your company',
};

/** About me rides in every brief, so its size is a cost every job pays. About 1,000 tokens. */
export const ABOUT_MAX_CHARS = 4000;
export const OWNER_FOLDER = 'owner';

/** Which owner pages come first when About me is over its size: who they are, then limits, rules, voice, skills. */
const rank = (path: string, type: string): number => {
  const name = path.split('/').pop() ?? '';
  if (/^(identity|responsibility|role)$/.test(type) || /^role\b/.test(name)) return 0;
  if (type === 'offlimits' || /off-?limits/.test(name)) return 1;
  if (type === 'voice' || /^voice\b/.test(name)) return 3;
  if (/^(rule|preference|decision)s?$/.test(type)) return 2;
  if (type === 'skill' || /^skills?\b/.test(name)) return 4;
  return 5;
};

/** The page without its header, and without anything under a `## Replaced` heading: replaced rules aren't current. */
const currentBody = (text: string): string => text
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/^##\s+Replaced\b[\s\S]*?(?=^##\s|(?![\s\S]))/gim, '')
  .trim();

export interface AboutMePage { path: string; reason?: string }

export interface AboutMe {
  /** The text that goes into the brief, or empty when no page qualifies. */
  text: string;
  /** Pages in it, in order. */
  included: string[];
  /** Owner pages left out, and why. */
  left: Required<AboutMePage>[];
  chars: number;
}

/**
 * About me for one reply: every verified page under `owner/` that this visibility may hear, most important first,
 * cut at whole pages to `ABOUT_MAX_CHARS`. Unverified, expired and replaced text is never in it.
 */
export const compileAboutMe = (pages: { path: string; text: string }[], visibility: Visibility, now: Date = new Date()): AboutMe => {
  const today = now.toISOString().slice(0, 10);
  const left: Required<AboutMePage>[] = [];
  const candidates = pages.filter((page) => page.path.startsWith(`${OWNER_FOLDER}/`)).flatMap((page) => {
    const fields = frontmatter(page.text);
    const verified = fields?.get('verified')?.trim() ?? '';
    const expires = fields?.get('expires')?.trim() ?? '';
    const audience = pageAudience(fields);
    if (!DATE.test(verified)) { left.push({ path: page.path, reason: 'not verified yet' }); return []; }
    if (DATE.test(expires) && expires < today) { left.push({ path: page.path, reason: `expired ${expires}` }); return []; }
    if (!mayUse(audience, visibility)) { left.push({ path: page.path, reason: `for ${VISIBILITY_LABEL[audience]} only` }); return []; }
    return [{ path: page.path, verified, rank: rank(page.path, fields?.get('type')?.trim() ?? ''), body: currentBody(page.text) }];
  }).sort((a, b) => a.rank - b.rank || b.verified.localeCompare(a.verified) || a.path.localeCompare(b.path));

  const sections: string[] = [];
  const included: string[] = [];
  let chars = 0;
  for (const page of candidates) {
    const section = `From ${page.path} (confirmed ${page.verified}):\n${page.body}`;
    if (chars + section.length + 2 > ABOUT_MAX_CHARS) { left.push({ path: page.path, reason: 'over the size limit' }); continue; }
    sections.push(section); included.push(page.path); chars += section.length + 2;
  }
  const text = sections.join('\n\n');
  return { text, included, left: left.sort((a, b) => a.path.localeCompare(b.path)), chars: text.length };
};

/**
 * The index with only the rows this visibility may open. A row is kept when the page it points at may be used, and
 * dropped when the page is for a narrower audience. Lines that point at no page (the heading, the table header) stay.
 */
export const filterIndex = (index: string, audienceOf: (page: string) => Audience | null, visibility: Visibility): string =>
  index.split('\n').filter((line) => {
    const pages = [...line.matchAll(/`([^`\s]+\.md)`/g)].map((match) => match[1]!);
    if (pages.length === 0) return true;
    return pages.every((page) => {
      const audience = audienceOf(page);
      return audience === null || mayUse(audience, visibility);
    });
  }).join('\n');
