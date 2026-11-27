// The run chat's pure half (Jobs › Chat): what a run's lines become on screen, and when the view follows new ones.
// - Messages: the owner's (with the images they attached), the agent's (text and the images it sent), each shown once.
// - Tool calls: consecutive ones fold into one compact row group; a question or permission is its own row.
// - Text: a small Markdown subset (paragraphs, lists, headings, code fences, inline code, bold, https links).
// - Scrolling: stick to the bottom while it streams, unless the owner scrolled up; then count what's new.
import type { LiveTurn, TranscriptEntry } from '../../../../src/agent/acp.ts';
import type { RunChat } from '../../../../src/agent/runs-view.ts';

export interface ChatImage { path: string; name: string }

/** One tool call as a row: its title, its ACP kind (`read`, `edit`, `execute`, …) and how it went. */
export interface ToolRow { key: string; title: string; kind: string | null; state: 'running' | 'done' | 'failed' }

export type ChatItem =
  /** `brief`: the whole brief Serra started the run with, when this is its first message; `text` is the request in it. */
  | { type: 'user'; key: string; text: string; images: ChatImage[]; brief?: string }
  | { type: 'agent'; key: string; parts: AgentPart[]; streaming: boolean }
  | { type: 'tools'; key: string; tools: ToolRow[] }
  | { type: 'ask'; key: string; permission: boolean; text: string; outcome: TranscriptEntry['outcome'] | 'waiting' };

type AgentPart = { type: 'text'; text: string } | { type: 'image'; image: ChatImage };

/** How `receiveAttachments` lists a file in a message: `- name ("type", N bytes): local path "…"`. */
const ATTACHMENT_LINE = /^- (.+?) \("(image\/[a-z0-9.+-]+)", \d+ bytes\): local path ("(?:[^"\\]|\\.)*")\s*$/;
/** The header line above those. */
const ATTACHMENT_HEADER = /^Attached files \(untrusted user content\):\s*$/;
/** And the note to the worker below them. */
const ATTACHMENT_NOTE = /^Inspect the local files with your file-reading tools/;
/** An image an agent's reply embeds: `![alt](/absolute/path.png)`, or `![alt](</path with spaces.png>)` as Markdown has it. */
const EMBED = /!\[([^\]]*)\]\((?:<(\/[^>\n]+\.(?:png|jpe?g|gif|webp))>|(\/[^)\s]+\.(?:png|jpe?g|gif|webp)))\)/gi;

/** `receiveAttachments` writes a file's name as a JSON string; older lines have it bare. */
const attachmentName = (name: string): string => {
  if (!name.startsWith('"')) return name;
  try { const parsed: unknown = JSON.parse(name); return typeof parsed === 'string' ? parsed : name; } catch { return name; }
};

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A message the owner sent: its words, and the images it lists, which show as thumbnails instead of lines. */
export const userMessage = (text: string): { text: string; images: ChatImage[] } => {
  const images: ChatImage[] = [];
  const kept = text.split('\n').filter((line) => {
    const found = ATTACHMENT_LINE.exec(line);
    if (found) {
      try {
        const path: unknown = JSON.parse(found[3]!);
        if (typeof path === 'string') { images.push({ path, name: attachmentName(found[1]!) }); return false; }
      } catch { /* not a path: keep the line as written */ }
    }
    return true;
  });
  // Serra's header and note to the worker go once the images are shown; they stay when a listed file wasn't an image.
  const others = kept.some((line) => /\): local path "/.test(line));
  const rest = images.length && !others ? kept.filter((line) => !ATTACHMENT_HEADER.test(line) && !ATTACHMENT_NOTE.test(line)) : kept;
  return { text: rest.join('\n').trim(), images };
};

/** The request in a brief Serra wrote (`<request>…</request>`), or null when the message is no brief. */
const REQUEST = /<request>\n?([\s\S]*?)\n?<\/request>/;

/** A message the owner or Serra sent: a brief shows as the request in it, with the brief itself to open. */
export const sentMessage = (text: string): { text: string; images: ChatImage[]; brief?: string } => {
  const request = REQUEST.exec(text);
  if (!request || request[0].length === text.trim().length) return userMessage(text);
  return { ...userMessage(request[1]!), brief: text };
};

/** An agent's reply as text and the images it embeds, in order. */
export const agentParts = (text: string): AgentPart[] => {
  const parts: AgentPart[] = [];
  let at = 0;
  for (const match of text.matchAll(EMBED)) {
    const before = text.slice(at, match.index).trim();
    if (before) parts.push({ type: 'text', text: before });
    const path = (match[2] ?? match[3])!;
    parts.push({ type: 'image', image: { path, name: match[1] && match[1] !== 'image' ? match[1] : baseName(path) } });
    at = (match.index ?? 0) + match[0].length;
  }
  const after = text.slice(at).trim();
  if (after) parts.push({ type: 'text', text: after });
  return parts;
};

/** A tool line from before tool lines kept their state: `Title (failed)`. */
const LEGACY_FAILED = / \(failed\)$/;
/** A question line: `Asked: …`; a permission's question: `<agent> wants to: <tool>`. */
const ASKED = /^Asked: /;
const WANTS = /^.+? wants to: /;

const toolRow = (entry: TranscriptEntry, key: string): ToolRow => {
  const legacyFailed = LEGACY_FAILED.test(entry.text);
  return { key, title: entry.text.replace(LEGACY_FAILED, '') || entry.kind || 'Tool', kind: entry.kind ?? null, state: entry.failed || legacyFailed ? 'failed' : 'done' };
};

const askItem = (entry: TranscriptEntry, key: string, waiting: boolean): ChatItem => {
  const question = entry.text.replace(ASKED, '');
  const permission = entry.ask ? entry.ask === 'permission' : WANTS.test(question);
  return {
    type: 'ask', key, permission,
    text: permission ? question.replace(WANTS, '') : question,
    outcome: entry.outcome ?? (waiting ? 'waiting' : undefined),
  };
};

/**
 * A run's lines as the chat shows them. Tool calls next to each other share one row group; the turn going now adds
 * its open tools and its reply so far (`streaming`). A question without an outcome waits when the run still waits.
 */
export const chatItems = (chat: Pick<RunChat, 'lines' | 'live' | 'waiting'>): ChatItem[] => {
  const items: ChatItem[] = [];
  const tools = (key: string): ToolRow[] => {
    const last = items.at(-1);
    if (last?.type === 'tools') return last.tools;
    const fresh: ChatItem = { type: 'tools', key, tools: [] };
    items.push(fresh);
    return fresh.tools;
  };
  const lastAsk = chat.lines.findLastIndex((entry) => entry.role === 'tool' && (entry.ask !== undefined || ASKED.test(entry.text)));
  chat.lines.forEach((entry, index) => {
    const key = `${index}`;
    if (entry.role === 'user') items.push({ type: 'user', key, ...sentMessage(entry.text) });
    else if (entry.role === 'assistant') {
      const parts = agentParts(entry.text);
      if (parts.length) items.push({ type: 'agent', key, parts, streaming: false });
    } else if (entry.ask !== undefined || ASKED.test(entry.text)) items.push(askItem(entry, key, index === lastAsk && chat.waiting.length > 0));
    else tools(key).push(toolRow(entry, key));
  });
  const live: LiveTurn | null = chat.live;
  if (live) {
    if (live.tools.length) {
      const open = tools(`live-tools-${live.runId}`);
      for (const tool of live.tools) open.push({ key: `live-${tool.id}`, title: tool.title || tool.kind || 'Tool', kind: tool.kind, state: 'running' });
    }
    items.push({ type: 'agent', key: `live-${live.runId}`, parts: agentParts(live.reply), streaming: true });
  }
  return items;
};

/** An MCP tool's raw name (`mcp__github__create_pull_request`) as words; other titles as they are. */
export const toolTitle = (title: string): string => {
  const mcp = /^mcp__[a-z0-9-]+(?:_[a-z0-9-]+)*?__([a-z0-9_]+)$/i.exec(title);
  if (!mcp) return title;
  const words = mcp[1]!.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A tool group's one-line summary while it's folded: the latest call, how many there were, and failures, which
 * stay an alarm only when the group ended on one (a retry that passed is just history).
 */
export const toolSummary = (tools: ToolRow[]): { title: string; count: number; running: boolean; failed: number; endedFailed: boolean } => ({
  title: toolTitle(tools.at(-1)?.title ?? ''),
  count: tools.length,
  running: tools.some((tool) => tool.state === 'running'),
  failed: tools.filter((tool) => tool.state === 'failed').length,
  endedFailed: tools.at(-1)?.state === 'failed',
});

/** A tool's title can name a service (an MCP tool like `mcp__github__create_pr`, or "Search Linear"): its brand mark. */
export const toolBrand = <Brand extends string>(title: string, brands: readonly Brand[]): Brand | null => {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return brands.find((brand) => words.includes(brand)) ?? null;
};

/** The words for a run's state in the header: one to three. */
export const statusLabel = (status: RunChat['status']): string =>
  ({ running: 'Working', waiting: 'Needs you', idle: 'Done', failed: 'Failed' })[status];

/** What the composer does now: answer the question the run waits on, send a follow-up, or say why it can't. */
export type Composer =
  | { mode: 'reply'; placeholder: string; note: string | null }
  | { mode: 'answer'; placeholder: string; note: null }
  | { mode: 'blocked'; reason: string };

export const composer = (chat: Pick<RunChat, 'backend' | 'status' | 'waiting' | 'replyBlocked'>, botUp: boolean): Composer => {
  if (chat.replyBlocked) return { mode: 'blocked', reason: chat.replyBlocked };
  if (!botUp) return { mode: 'blocked', reason: 'Start Serra to reply' };
  const question = chat.waiting[0]?.questions[0];
  // A choice only (a permission) can't take typed words: what's typed is the next message, after the turn.
  if (question && question.allowCustomAnswer === false) return { mode: 'reply', placeholder: 'Follow up', note: 'Sends after you answer' };
  if (question) return { mode: 'answer', placeholder: 'Or type an answer', note: null };
  // ACP can't add to a turn that's going: the message waits for it to end.
  const queued = chat.backend === 'acp' && chat.status === 'running';
  return { mode: 'reply', placeholder: 'Follow up', note: queued ? 'Sends after this turn' : null };
};

// Markdown --------------------------------------------------------------------------------------------------------

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; text: string };

/** Markdown blocks, enough for an agent's reply. Anything else stays a paragraph, as written. */
export const blocks = (text: string): Block[] => {
  const out: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = (): void => { if (paragraph.length) out.push({ type: 'p', text: paragraph.join('\n') }); paragraph = []; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (index += 1; index < lines.length && !/^\s*```\s*$/.test(lines[index]!); index += 1) code.push(lines[index]!);
      out.push({ type: 'code', lang: fence[1] ?? '', text: code.join('\n') });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) { flush(); out.push({ type: 'h', text: heading[1]! }); }
    else if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const last = out.at(-1);
      if (last?.type === 'list' && last.ordered === ordered) last.items.push(item[3]!);
      else out.push({ type: 'list', ordered, items: [item[3]!] });
    } else if (quote) {
      flush();
      const last = out.at(-1);
      if (last?.type === 'quote') last.text += `\n${quote[1]}`;
      else out.push({ type: 'quote', text: quote[1]! });
    } else {
      // A line under a list item carries it on.
      const last = out.at(-1);
      if (!paragraph.length && last?.type === 'list' && /^\s+\S/.test(line)) last.items[last.items.length - 1] += ` ${line.trim()}`;
      else paragraph.push(line);
    }
  }
  flush();
  return out;
};

export type Inline = { type: 'text' | 'code' | 'strong' | 'em'; text: string } | { type: 'link'; text: string; url: string };

/** Inline Markdown: `code`, **bold**, _em_, and links. Only https links are links; others stay text. */
export const inline = (text: string): Inline[] => {
  const out: Inline[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|(https:\/\/[^\s)<>]+[^\s)<>.,;:!?'"])/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) out.push({ type: 'text', text: text.slice(at, match.index) });
    if (match[1] !== undefined) out.push({ type: 'code', text: match[1] });
    else if (match[2] !== undefined) out.push({ type: 'strong', text: match[2] });
    else if (match[3] !== undefined) out.push({ type: 'em', text: match[3] });
    else if (match[4] !== undefined) out.push({ type: 'link', text: match[4], url: match[5]! });
    else out.push({ type: 'link', text: match[6]!, url: match[6]! });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
};

// Scrolling -------------------------------------------------------------------------------------------------------

/** Within this many pixels of the end counts as at the bottom. */
export const BOTTOM_SLACK = 48;

interface ScrollBox { scrollTop: number; scrollHeight: number; clientHeight: number }

export const atBottom = (box: ScrollBox, slack = BOTTOM_SLACK): boolean => box.scrollHeight - box.scrollTop - box.clientHeight <= slack;

/** Whether the view follows the end, and how many items arrived while it didn't. */
export interface Follow { stuck: boolean; unseen: number }

export type FollowEvent =
  | { type: 'scrolled'; box: ScrollBox }
  | { type: 'grew'; added: number }
  | { type: 'jumped' };

/**
 * Following the end: a scroll to the bottom sticks again (and clears what's new), a scroll up lets go; new items
 * while let go count as unseen, for the "jump to latest" button; a jump sticks.
 */
export const follow = (state: Follow, event: FollowEvent): Follow => {
  if (event.type === 'jumped') return { stuck: true, unseen: 0 };
  if (event.type === 'scrolled') return atBottom(event.box) ? { stuck: true, unseen: 0 } : { stuck: false, unseen: state.unseen };
  return state.stuck ? state : { stuck: false, unseen: state.unseen + Math.max(0, event.added) };
};

/** A signature of what's on screen, which changes when anything grows: a new item, or more streamed text. */
export const contentSize = (items: ChatItem[]): number => items.reduce((sum, item) => {
  if (item.type === 'agent') return sum + 1 + item.parts.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 1), 0);
  if (item.type === 'tools') return sum + 1 + item.tools.length;
  return sum + 1;
}, 0);
