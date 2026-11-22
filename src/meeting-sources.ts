// Where a meeting transcript comes from (SERRA-62): a file or pasted text in the owner's DM, or a link to a Granola
// note or a Google Meet transcript Doc, read through the owner's own Claude Code connection.
//
// Serra never holds a Granola or Google token. The provider owns its MCP servers (claude.ai connectors, or
// `claude mcp add`); Serra lists them, and reads one transcript through them like this:
// 1. A probe of `claude -p` (in don't-ask mode, nothing allowed) is stopped at its init event, which lists the MCP
//    servers it loaded and whether each is signed in. That finds the server and the exact tool name.
// 2. One run with exactly that read tool allowed, every built-in tool off, from an empty folder. Its prompt holds only
//    the meeting's ID, never transcript text. Serra stops it the moment the tool's result arrives in the stream and
//    takes the transcript from that result, so the model never acts on what the transcript says.
// The transcript then goes through the same normaliser, secret screen and no-tool extractor as an upload.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable, toolEnv } from './exec.ts';
import type { SpawnClaude } from './meeting-extractor.ts';

export type MeetingProvider = 'granola' | 'google-meet';

/** A meeting the owner pointed at with a link. */
export interface MeetingLink { provider: MeetingProvider; id: string; url: string }

export interface MeetingRequest {
  /** The owner said "remember this meeting" (or "remember the meeting", "remember my meeting"). */
  trigger: boolean;
  link: MeetingLink | null;
  /** Text after the trigger phrase and link: a pasted transcript or summary, if any. */
  pasted: string;
}

const TRIGGER = /^\s*(?:<@[UW][A-Z0-9]+(?:\|[^>]*)?>[\s,:]*)?(?:please\s+)?remember\s+(?:this|the|my|our)\s+meeting\b[\s:.,-]*/i;
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
  const granola = GRANOLA.exec(rest);
  const doc = GOOGLE_DOC.exec(rest);
  const first = [granola, doc].filter((match): match is RegExpExecArray => match !== null).sort((a, b) => a.index - b.index)[0];
  if (first) {
    link = first === granola ? { provider: 'granola', id: first[2]!, url: first[1]! } : { provider: 'google-meet', id: first[2]!, url: first[1]! };
    rest = `${rest.slice(0, first.index)}${rest.slice(first.index + first[0].length)}`;
  }
  return { trigger: true, link, pasted: rest.trim() };
};

/** How each provider's server is recognised in Claude Code, and the one tool Serra may call on it. */
export const PROVIDERS: Record<MeetingProvider, {
  label: string;
  server: RegExp;
  tool: string;
  args: (id: string) => Record<string, unknown>;
  /** What the owner does when it's missing. */
  setup: string;
  plan: string;
}> = {
  granola: {
    label: 'Granola',
    server: /granola/i,
    tool: 'get_meeting_transcript',
    args: (id) => ({ meeting_id: id }),
    setup: 'Connect Granola in Claude: claude.ai › Settings › Connectors › Granola, or run `claude mcp add granola --transport http https://mcp.granola.ai/mcp` and sign in with /mcp.',
    plan: 'Granola gives transcripts to Claude on its Business and Enterprise plans.',
  },
  'google-meet': {
    label: 'Google Meet',
    server: /google[\s_-]*drive|gdrive/i,
    tool: 'read_file_content',
    args: (id) => ({ fileId: id }),
    setup: 'Connect Google Drive in Claude: claude.ai › Settings › Connectors › Google Drive. If it\'s already there, sign in again with /mcp in Claude Code.',
    plan: 'Meet saves transcripts to Drive on Google Workspace Business Standard and above, when transcripts are turned on for the meeting.',
  },
};

/** Claude Code's name for an MCP tool: `mcp__<server>__<tool>`, the server name with anything but letters, digits, `_` and `-` made `_`. */
export const mcpToolName = (server: string, tool: string): string => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`;

export type ProviderState = 'ready' | 'needs-sign-in' | 'missing' | 'unknown';

export interface ProviderStatus { provider: MeetingProvider; state: ProviderState; server: string | null; detail: string }

/** Built-in tools no fetch may use. Restricted mode already removes the ones that run code. */
const BUILT_INS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'Skill'];
const FETCH_FLAGS = ['-p', '--restricted', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--disable-slash-commands',
  '--disallowedTools', BUILT_INS.join(' '), '--output-format', 'stream-json', '--verbose'];

interface StreamEvent { type?: string; subtype?: string; tools?: unknown; mcp_servers?: unknown; message?: { content?: unknown } }

export interface FetchOptions {
  path: string;
  spawn?: SpawnClaude;
  model?: string;
  timeoutMs?: number;
}

export interface Fetched { text: string; title: string | null }

const defaultSpawn: SpawnClaude = (command, args, options) => spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });

/** Run `claude` with `flags`, feeding `input`, calling `onEvent` per stream line until it returns true (then stop). */
const stream = (spawnClaude: SpawnClaude, binary: string, flags: string[], input: string, path: string, timeoutMs: number, onEvent: (event: StreamEvent) => boolean): Promise<void> =>
  new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'serra-fetch-'));
    // Long transcripts must arrive whole: Claude Code otherwise cuts MCP results at 25,000 tokens. And the init event
    // waits for connectors, so it lists them every time instead of only when they happen to connect first.
    const env = { ...toolEnv(path), DISABLE_AUTOUPDATER: '1', MAX_MCP_OUTPUT_TOKENS: '120000', MCP_CONNECTION_NONBLOCKING: 'false' };
    const child = spawnClaude(binary, flags, { cwd, env });
    let buffer = '';
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      rmSync(cwd, { recursive: true, force: true });
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Reading the meeting took too long.')), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !done) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { if (onEvent(JSON.parse(line) as StreamEvent)) finish(); } catch (error) { if (error instanceof Error && !(error instanceof SyntaxError)) finish(error); }
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr?.resume();
    child.once('error', (error) => finish(error));
    child.once('close', () => finish());
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });

const serversOf = (event: StreamEvent): { name: string; status: string }[] => (Array.isArray(event.mcp_servers) ? event.mcp_servers : [])
  .flatMap((server) => (typeof server === 'object' && server && typeof (server as { name?: unknown }).name === 'string'
    ? [{ name: (server as { name: string }).name, status: String((server as { status?: unknown }).status ?? '') }] : []));

/** The text of a tool result, which the stream gives as a string or a list of content blocks. */
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => (typeof block === 'object' && block && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : [])).join('\n');
};

/** The transcript in a tool's answer: plain text as is; JSON with a transcript, text, content or entries field unwrapped. */
export const transcriptFromResult = (text: string): Fetched => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { text: trimmed, title: null };
  try {
    const value = JSON.parse(trimmed) as unknown;
    const pick = (item: unknown): Fetched | null => {
      if (typeof item === 'string') return { text: item, title: null };
      if (Array.isArray(item)) {
        const lines = item.flatMap((entry) => {
          if (typeof entry !== 'object' || !entry) return [];
          const record = entry as Record<string, unknown>;
          const speaker = typeof record.speaker === 'string' ? record.speaker
            : typeof record.speaker === 'object' && record.speaker ? String((record.speaker as Record<string, unknown>).name ?? (record.speaker as Record<string, unknown>).diarization_label ?? (record.speaker as Record<string, unknown>).source ?? '') : '';
          const said = typeof record.text === 'string' ? record.text : '';
          return said ? [`${speaker ? `${speaker}: ` : ''}${said}`] : [];
        });
        return lines.length ? { text: lines.join('\n'), title: null } : null;
      }
      if (typeof item !== 'object' || !item) return null;
      const record = item as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : null;
      for (const key of ['transcript', 'content', 'text', 'entries', 'body']) {
        const found = record[key] === undefined ? null : pick(record[key]);
        if (found) return { text: found.text, title: found.title ?? title };
      }
      return null;
    };
    return pick(value) ?? { text: trimmed, title: null };
  } catch { return { text: trimmed, title: null }; }
};

export const createSourceReader = ({ path, spawn: spawnClaude = defaultSpawn, model = 'haiku', timeoutMs = 120_000 }: FetchOptions) => {
  const binary = (): string => {
    const found = findExecutable('claude', path);
    if (!found) throw new Error('Claude Code isn\'t installed where Serra can find it.');
    return found;
  };

  /** Which servers Claude Code loads, and whether each is signed in, from a probe stopped at its init event. */
  const servers = async (): Promise<{ name: string; status: string; tools: string[] }[]> => {
    let found: { name: string; status: string; tools: string[] }[] | null = null;
    await stream(spawnClaude, binary(), [...FETCH_FLAGS, '--model', model], 'Reply with the word ok.', path, 60_000, (event) => {
      if (event.type !== 'system' || event.subtype !== 'init') return false;
      const tools = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string') : [];
      found = serversOf(event).map((server) => ({ ...server, tools: tools.filter((tool) => tool.startsWith(mcpToolName(server.name, ''))) }));
      return true;
    });
    if (!found) throw new Error('Claude Code didn\'t start. Check it\'s signed in.');
    return found;
  };

  /** Whether each provider can be read now, and what the owner does if not. */
  const status = async (): Promise<ProviderStatus[]> => {
    let loaded: { name: string; status: string; tools: string[] }[];
    try { loaded = await servers(); } catch (error) {
      return (Object.keys(PROVIDERS) as MeetingProvider[]).map((provider) => ({ provider, state: 'unknown', server: null, detail: error instanceof Error ? error.message : String(error) }));
    }
    return (Object.keys(PROVIDERS) as MeetingProvider[]).map((provider) => {
      const spec = PROVIDERS[provider];
      const server = loaded.find((entry) => spec.server.test(entry.name));
      if (!server) return { provider, state: 'missing', server: null, detail: spec.setup };
      if (server.status !== 'connected') return { provider, state: 'needs-sign-in', server: server.name, detail: `${server.name} needs you to sign in again: run /mcp in Claude Code.` };
      if (!server.tools.includes(mcpToolName(server.name, spec.tool))) return { provider, state: 'missing', server: server.name, detail: `${server.name} doesn't offer ${spec.tool}. ${spec.plan}` };
      return { provider, state: 'ready', server: server.name, detail: spec.plan };
    });
  };

  /**
   * Read one meeting's transcript through the owner's provider connection. Exactly one tool is allowed; the run is
   * stopped the moment its result arrives. Any other tool call stops it too, and nothing is used.
   */
  const fetchTranscript = async (link: MeetingLink): Promise<Fetched> => {
    const spec = PROVIDERS[link.provider];
    const state = (await status()).find((entry) => entry.provider === link.provider)!;
    if (state.state !== 'ready' || !state.server) throw new Error(state.detail);
    const tool = mcpToolName(state.server, spec.tool);
    const prompt = `Call the tool ${tool} exactly once, with exactly these arguments, and do nothing else:\n${JSON.stringify(spec.args(link.id))}`;
    let callId: string | null = null;
    let fetched: Fetched | null = null;
    let failure: string | null = null;
    await stream(spawnClaude, binary(), [...FETCH_FLAGS, '--model', model, '--allowedTools', tool], prompt, path, timeoutMs, (event) => {
      const content = Array.isArray(event.message?.content) ? event.message.content as Record<string, unknown>[] : [];
      if (event.type === 'assistant') {
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          // ToolSearch only loads the tool's schema. Anything else is not what Serra asked for: stop.
          if (block.name === 'ToolSearch') continue;
          if (block.name !== tool) { failure = 'Claude tried to use another tool, so Serra stopped.'; return true; }
          callId = typeof block.id === 'string' ? block.id : null;
        }
      }
      if (event.type === 'user' && callId) {
        const result = content.find((block) => block.type === 'tool_result' && block.tool_use_id === callId);
        if (!result) return false;
        const text = resultText(result.content);
        if (result.is_error || /needs you to sign in|re-?authenticate|not authorized|permission denied/i.test(text.slice(0, 300))) {
          failure = /sign in|authenticate/i.test(text) ? `${spec.label} needs you to sign in again: run /mcp in Claude Code.` : `${spec.label} couldn't give Serra that meeting: ${text.slice(0, 200)}`;
        } else fetched = transcriptFromResult(text);
        return true;
      }
      if (event.type === 'result') { failure ??= `Claude didn't read the meeting from ${spec.label}.`; return true; }
      return false;
    });
    if (failure) throw new Error(failure);
    if (!fetched) throw new Error(`Claude didn't read the meeting from ${spec.label}.`);
    return fetched;
  };

  return { status, fetchTranscript };
};

export type SourceReader = ReturnType<typeof createSourceReader>;

/** File types Serra reads as transcripts. */
export const TRANSCRIPT_FILE = /\.(?:txt|md|markdown|vtt|srt)$/i;
