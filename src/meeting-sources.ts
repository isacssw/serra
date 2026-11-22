// Where a meeting transcript comes from (SERRA-62): a file or pasted text in the owner's DM, or a link to a Granola
// note or a Google Meet transcript Doc, read through the owner's own Claude Code connection.
//
// Serra never holds a Granola or Google token. The provider owns its MCP servers (claude.ai connectors, or
// `claude mcp add`); Serra lists them, and reads one transcript through them like this:
// 1. A probe of `claude -p` (in don't-ask mode, nothing allowed) is stopped at its init event, which lists the MCP
//    servers it loaded and whether each is signed in. That finds the server and the exact tool name.
// 2. One run with exactly that read tool allowed (with exactly the arguments Serra asked for), every built-in tool
//    off, from an empty folder, and `--max-turns 1`: Claude Code runs the tool and stops without sending its result
//    back to a model. Its prompt holds only the meeting's ID. Serra takes the transcript from the tool result in the
//    stream, so no model sees it here and nothing can act on what it says.
// Both runs get the extractor's checks first: a tested Claude Code build, only built-in plugins, no managed hooks.
// The transcript then goes through the same normaliser, secret screen and no-tool extractor as an upload.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable, toolEnv } from './exec.ts';
import { identity, MANAGED_SETTINGS_DIR, managedSettings, SUPPORTED_CLAUDE_VERSIONS, type SpawnClaude } from './meeting-extractor.ts';
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
/** Every provider, in display order. */
const PROVIDER_IDS: readonly MeetingProvider[] = ['granola', 'google-meet'];

const mcpToolName = (server: string, tool: string): string => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`;

type ProviderState = 'ready' | 'needs-sign-in' | 'missing' | 'unknown';

export interface ProviderStatus { provider: MeetingProvider; state: ProviderState; server: string | null; detail: string }

/** Built-in tools no fetch may use. Restricted mode already removes the ones that run code. */
const BUILT_INS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'Skill'];
const FETCH_FLAGS = ['-p', '--restricted', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--disable-slash-commands', '--max-turns', '1',
  '--disallowedTools', BUILT_INS.join(' '), '--output-format', 'stream-json', '--verbose'];

/** One line of Claude Code's stream-json output, as an untrusted record. */
type StreamEvent = Record<string, unknown>;

export interface FetchOptions {
  path: string;
  managedSettingsDir?: string;
  versions?: readonly string[];
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
    // No tool search: the MCP tool is loaded up front, so the one allowed call is the run's only turn.
    const env = { ...toolEnv(path), DISABLE_AUTOUPDATER: '1', MAX_MCP_OUTPUT_TOKENS: '120000', MCP_CONNECTION_NONBLOCKING: 'false', ENABLE_TOOL_SEARCH: 'false' };
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
        const event = parseJson(line);
        try { if (isRecord(event) && onEvent(event)) finish(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr?.resume();
    child.once('error', (error) => finish(error));
    child.once('close', () => finish());
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });

const serversOf = (event: StreamEvent): { name: string; status: string }[] => {
  const list: unknown[] = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
  return list.flatMap((server) => (isRecord(server) && typeof server.name === 'string' ? [{ name: server.name, status: stringField(server.status) ?? '' }] : []));
};

/** The content blocks of an assistant or user message in the stream. */
const blocks = (event: StreamEvent): Record<string, unknown>[] => {
  const content: unknown = isRecord(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
};

/** The text of a tool result, which the stream gives as a string or a list of content blocks. */
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const list: unknown[] = content;
  return list.flatMap((block) => (isRecord(block) && typeof block.text === 'string' ? [block.text] : [])).join('\n');
};

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

export const createSourceReader = ({
  path, spawn: spawnClaude = defaultSpawn, model = 'haiku', timeoutMs = 120_000, managedSettingsDir = MANAGED_SETTINGS_DIR, versions = SUPPORTED_CLAUDE_VERSIONS,
}: FetchOptions) => {
  /** The `claude` binary, after the same checks as the extractor's: no managed hooks, which would see the tool result. */
  const binary = (): string => {
    const found = findExecutable('claude', path);
    if (!found) throw new Error('Claude Code isn\'t installed where Serra can find it.');
    const { hooks } = managedSettings(managedSettingsDir);
    if (hooks.length) throw new Error('Claude Code has managed hooks, which would see the transcript, so Serra won\'t read meetings through it.');
    return found;
  };
  /** Why this init event's Claude Code can't be used, or null: a tested build, built-in plugins only. */
  const initProblem = (event: StreamEvent): string | null => {
    const version = stringField(event.claude_code_version);
    if (!version || !versions.includes(version)) return `Meeting capture is tested with Claude Code ${versions.join(', ')}, and this Mac has ${version ?? 'an unknown version'}. Update Serra, or that version of Claude Code.`;
    const plugins: unknown[] = Array.isArray(event.plugins) ? event.plugins : [];
    if (plugins.some((plugin) => !isRecord(plugin) || plugin.path !== 'builtin')) return 'Claude Code loads plugins, so Serra won\'t read meetings through it.';
    return null;
  };

  /** Which servers Claude Code loads, and whether each is signed in, from a probe stopped at its init event. */
  const servers = async (): Promise<{ name: string; status: string; tools: string[] }[]> => {
    const seen: { servers: { name: string; status: string; tools: string[] }[] | null; problem: string | null } = { servers: null, problem: null };
    await stream(spawnClaude, binary(), [...FETCH_FLAGS, '--model', model], 'Reply with the word ok.', path, 60_000, (event) => {
      if (event.type !== 'system' || event.subtype !== 'init') return false;
      seen.problem = initProblem(event);
      const listed: unknown[] = Array.isArray(event.tools) ? event.tools : [];
      const tools = listed.filter((tool): tool is string => typeof tool === 'string');
      seen.servers = serversOf(event).map((server) => ({ ...server, tools: tools.filter((tool) => tool.startsWith(mcpToolName(server.name, ''))) }));
      return true;
    });
    if (seen.problem) throw new Error(seen.problem);
    if (!seen.servers) throw new Error('Claude Code didn\'t start. Check it\'s signed in.');
    return seen.servers;
  };

  /** Whether each provider can be read now, and what the owner does if not. */
  const status = async (): Promise<ProviderStatus[]> => {
    let loaded: { name: string; status: string; tools: string[] }[];
    try { loaded = await servers(); } catch (error) {
      return PROVIDER_IDS.map((provider) => ({ provider, state: 'unknown', server: null, detail: error instanceof Error ? error.message : String(error) }));
    }
    return PROVIDER_IDS.map((provider) => {
      const spec = PROVIDERS[provider];
      // Of several matching servers (a connector and one added by hand), a connected one.
      const matching = loaded.filter((entry) => spec.server.test(entry.name));
      const server = matching.find((entry) => entry.status === 'connected') ?? matching[0];
      if (!server) return { provider, state: 'missing', server: null, detail: spec.setup };
      if (server.status !== 'connected') return { provider, state: 'needs-sign-in', server: server.name, detail: `${server.name} needs you to sign in again: run /mcp in Claude Code.` };
      if (!server.tools.includes(mcpToolName(server.name, spec.tool))) return { provider, state: 'missing', server: server.name, detail: `${server.name} doesn't offer ${spec.tool}. ${spec.plan}` };
      return { provider, state: 'ready', server: server.name, detail: spec.plan };
    });
  };

  /**
   * Read one meeting's transcript through the owner's provider connection. Exactly one tool, with exactly Serra's
   * arguments, in a one-turn run stopped the moment its result arrives. Any other call stops it, and nothing is used.
   * Errors never quote the tool's result: it may be transcript text.
   */
  const fetchTranscript = async (link: MeetingLink): Promise<Fetched> => {
    const spec = PROVIDERS[link.provider];
    // The binary the probe checked is the one the fetch runs: replaced in between, the fetch is refused.
    const checked = identity(binary());
    const state = (await status()).find((entry) => entry.provider === link.provider)!;
    if (state.state !== 'ready' || !state.server) throw new Error(state.detail);
    const tool = mcpToolName(state.server, spec.tool);
    const args = spec.args(link.id);
    const prompt = `Call the tool ${tool} exactly once, with exactly these arguments, and do nothing else:\n${JSON.stringify(args)}`;
    const sameArgs = (input: unknown): boolean => isRecord(input) && Object.keys(input).length === Object.keys(args).length
      && Object.entries(args).every(([key, value]) => input[key] === value);
    let callId: string | null = null;
    let fetched: Fetched | null = null;
    let failure: string | null = null;
    const runBinary = binary();
    if (identity(runBinary) !== checked) throw new Error('Claude Code changed while Serra was checking it. Send the meeting again.');
    await stream(spawnClaude, runBinary, [...FETCH_FLAGS, '--model', model, '--allowedTools', tool], prompt, path, timeoutMs, (event) => {
      const content = blocks(event);
      if (event.type === 'system' && event.subtype === 'init') {
        const problem = initProblem(event);
        if (problem) { failure = problem; return true; }
      }
      if (event.type === 'assistant') {
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          if (block.name !== tool || !sameArgs(block.input)) { failure = 'Claude didn\'t make the one call Serra asked for, so Serra stopped.'; return true; }
          callId = typeof block.id === 'string' ? block.id : null;
        }
      }
      if (event.type === 'user' && callId) {
        const result = content.find((block) => block.type === 'tool_result' && block.tool_use_id === callId);
        if (!result) return false;
        const text = resultText(result.content);
        if (result.is_error === true) {
          // Only an error result is read for its kind; its text is never repeated (it could be transcript text).
          failure = /sign in|re-?authenticate|unauthori[sz]ed|401/i.test(text.slice(0, 300))
            ? `${spec.label} needs you to sign in again: run /mcp in Claude Code.`
            : `${spec.label} couldn't give Serra that meeting. Check the link, and that your plan includes transcripts.`;
        } else if (/^\s*(?:Output too large|<persisted-output>)|saved to .*tool-results|\[(?:truncated|output truncated)\]|\(truncated\)\s*$/i.test(text)) {
          // Claude Code cut the result or saved it to a file: never read half a meeting as the whole one.
          failure = `That ${spec.label} transcript is too long to read through Claude Code. Export it and send the file instead.`;
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
