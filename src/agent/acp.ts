// An ACP agent behind Serra's agent interface (src/agent/backend.ts): the owner's other choice to T3. Serra is the
// ACP client: it runs the agent the owner picked (src/agent/acp-agents.ts) over stdio and speaks the Agent Client
// Protocol v1 with the official SDK: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`,
// the streamed `session/update`s, the agent's `session/request_permission`s and its form `elicitation/create`s.
//
// What ACP doesn't give, Serra keeps itself:
// - A run record (`runsDir`, one JSON file per session): the messages, the folder, and whether a turn was going. It
//   is the run's transcript (Jobs shows it), and after a restart Serra reopens the session with `session/load` and
//   carries on a turn the restart cut off. Without `runsDir` (meeting runs) a run lives only in this process.
// - Worktrees: Serra makes one itself (src/agent/worktree.ts) and starts the session in it.
// - Steer: there is none in ACP v1, so a message sent while a turn runs is queued and sent when the turn ends.
//
// Access, never wider than T3 gives the same kind of run:
// - read-only (meeting extraction, Test, the weekly review; T3's `approval-required`): the agent is put in a mode that
//   asks before tools, and Serra refuses every request and counts it as waiting, so the run is stopped as on T3;
// - ask (a meeting link read; narrower than T3's default): the same mode, and Serra allows a read, search, fetch,
//   think or other tool once, and refuses edits, deletes, moves, commands and mode switches;
// - full (jobs, tasks, the interview; T3's default full access): the agent's full-access mode. What it still asks,
//   and every question it asks, waits as a question card (Slack, or the app's transcript view) for a person.
// Serra offers the agent no file system or terminal of its own, and opens no server: stdio only.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { writeFileAtomic } from '../config.ts';
import { isRecord, parseJson } from '../json-guards.ts';
import type { T3Question } from '../t3-questions.ts';
import {
  pollUntilSettled, type AgentBackend, type BackendCapabilities, type QuestionAnswers, type QuestionRequest, type RunDetail, type RunToolCall, type StartRun,
} from './backend.ts';
import { launchFor, type AcpAgent } from './acp-agents.ts';
import { attachedImages, imageContent, saveAgentImage } from './images.ts';
import { makeWorktree } from './worktree.ts';

/** Tool kinds an `ask` run may use without asking anyone. Everything else is refused. */
const ALLOWED_KINDS = new Set<acp.ToolKind>(['read', 'search', 'fetch', 'think', 'other']);

/** What a run may do: see the header. */
type RunAccess = 'read-only' | 'ask' | 'full';

/** What a person opens to see a run: one line per message, a tool's title, or a question that waited. */
export interface TranscriptEntry { role: 'user' | 'assistant' | 'tool'; runId: string; text: string; at: string }

/** A run as Serra records it in `runsDir`. */
export interface RunRecord {
  version: 1;
  agent: string;
  sessionId: string;
  title: string;
  cwd: string;
  access: RunAccess;
  createdAt: string;
  runs: number;
  /** The turn that was going when this was written, so a restart can carry it on. */
  active: string | null;
  /** The questions the run waits on when this was written (a restart cancels them). */
  waiting?: QuestionRequest[];
  entries: TranscriptEntry[];
}

export interface AcpBackendOptions {
  agent: AcpAgent;
  /** The environment the agent runs in (the owner's login environment), asked for when the agent starts; `agent.env` is added on top. */
  env?: () => Promise<NodeJS.ProcessEnv>;
  /** Where Serra makes worktrees for runs that need one. */
  worktreeRoot?: string;
  /** Where runs are recorded, for their transcript and to carry them on after a restart. None: runs live in memory. */
  runsDir?: string;
  /** Serra's attachments folder: an image listed in a message from here also goes to the agent as an image. */
  attachmentsDir?: string;
  /** The model the owner picked for this agent; the agent's own default when absent. */
  model?: string;
  /** Starts the agent; a test passes a fake agent's command. */
  spawnAgent?: (agent: AcpAgent, env: NodeJS.ProcessEnv) => ChildProcess;
  log?: (message: string) => void;
  /** MCP servers handed to every session, on top of the agent's own configuration. None by default: the agent's own connections are used, as in T3. */
  mcpServers?: acp.McpServer[];
  now?: () => Date;
}

interface ToolRecord { id: string; runId: string; title: string; kind: string | null; status: string | null; rawInput: unknown; rawOutput: unknown; content: unknown }

/** A question waiting for a person, and how to give the agent the answer. */
interface Waiting { request: QuestionRequest; answer: (answers: QuestionAnswers) => void; cancel: () => void }

interface Session {
  sessionId: string;
  record: RunRecord;
  active: string | null;
  /** Requests a read-only run made, all refused: the run is waiting, as far as Serra's concerned. */
  refused: number;
  waiting: Map<string, Waiting>;
  failed: string | null;
  /** The running turn's reply so far. */
  reply: string;
  tools: Map<string, ToolRecord>;
  queue: string[];
  /** What the running turn cost so far, as the agent reports it. */
  cost: { amount: number; currency: string } | null;
  /** The agent couldn't be put in a full-access mode, so Serra allows what it asks, as T3's full access would. */
  allowAll: boolean;
}

/** Modes in which an agent uses tools without asking. */
const PERMISSIVE = /auto|bypass|accept|yolo|full|dont-?ask|never/i;
/** An agent's full-access mode (Claude Code's bypassPermissions, Codex's agent-full-access). */
const FULL_ACCESS = /^(bypassPermissions|agent-full-access|full-access|full|yolo)$/i;

/**
 * The mode a run goes in. Read-only and ask: the agent's read-only mode if it has one (Codex), else a mode that asks
 * before tools (the current one when it does, else `default`). Full: its full-access mode. Null: nothing better than now.
 */
const modeFor = (modes: acp.SessionModeState, access: RunAccess): string | null => {
  if (access === 'full') return modes.availableModes.find((choice) => FULL_ACCESS.test(choice.id))?.id ?? null;
  const readOnlyMode = modes.availableModes.find((choice) => /^read-?only$/i.test(choice.id));
  if (readOnlyMode) return readOnlyMode.id;
  if (!PERMISSIVE.test(modes.currentModeId)) return modes.currentModeId;
  return modes.availableModes.find((choice) => /^(default|manual|ask)$/i.test(choice.id))?.id ?? null;
};

/**
 * Why a turn failed, as a fixed sentence: the adapter's error kind or ACP's auth error, never the agent's own text
 * (it can quote the brief, which may hold a transcript).
 */
const turnFailure = (error: unknown, name: string): string => {
  const record = typeof error === 'object' && error !== null ? (error as { code?: unknown; data?: unknown }) : {};
  const kind = typeof record.data === 'object' && record.data !== null && 'errorKind' in record.data ? String(record.data.errorKind) : null;
  if (record.code === -32000 || kind === 'authentication_failed') return `${name} needs you to sign in. Sign in with its own CLI, then try again.`;
  if (kind === 'rate_limit') return `${name} hit its usage or rate limit. Try again later.`;
  if (kind === 'billing_error') return `${name}'s account has a billing problem. Check it in ${name}.`;
  if (kind === 'server_error' || kind === 'transport_lost') return `${name} lost its connection to its provider. Try again.`;
  return `${name} stopped with an error${kind ? ` (${kind})` : ''}.`;
};

const textOf = (content: acp.ContentBlock): string => (content.type === 'text' ? content.text : '');

/** A tool call's output as the meeting reader expects one: the agent's raw output, else its text content as MCP parts. */
const toolOutput = (record: ToolRecord): unknown => {
  if (record.rawOutput !== undefined && record.rawOutput !== null) return record.rawOutput;
  const parts = Array.isArray(record.content) ? record.content : [];
  const texts = parts.flatMap((part: unknown) => {
    if (!isRecord(part) || part.type !== 'content' || !isRecord(part.content)) return [];
    return part.content.type === 'text' && typeof part.content.text === 'string' ? [{ type: 'text', text: part.content.text }] : [];
  });
  return texts.length ? { content: texts } : undefined;
};

/** The choices of a form field: `oneOf`/`anyOf` titled consts, or a plain `enum`. */
const fieldOptions = (field: Record<string, unknown>): { label: string; description: string; value: string }[] => {
  const list = Array.isArray(field.oneOf) ? field.oneOf : Array.isArray(field.anyOf) ? field.anyOf : null;
  if (list) {
    return list.filter(isRecord).filter((option) => typeof option.const === 'string').map((option) => ({
      label: typeof option.title === 'string' && option.title ? option.title : String(option.const),
      description: typeof option.description === 'string' ? option.description : '',
      value: String(option.const),
    }));
  }
  return Array.isArray(field.enum) ? field.enum.filter((value): value is string => typeof value === 'string').map((value) => ({ label: value, description: '', value })) : [];
};

/**
 * A form elicitation as question cards: one question per field. A select field's `<key>_custom` companion (Claude
 * Code's "Other" box) becomes that question's typed answer instead of a question of its own.
 */
const formQuestions = (message: string, schema: unknown): { questions: T3Question[]; custom: Map<string, string> } => {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const keys = Object.keys(properties);
  const custom = new Map<string, string>();
  const questions: T3Question[] = [];
  for (const key of keys) {
    const field = properties[key];
    if (!isRecord(field)) continue;
    if (key.endsWith('_custom') && keys.includes(key.slice(0, -'_custom'.length))) { custom.set(key.slice(0, -'_custom'.length), key); continue; }
    const items = isRecord(field.items) ? field.items : null;
    const multi = field.type === 'array' && items !== null;
    const options = field.type === 'boolean'
      ? [{ label: 'Yes', description: '', value: 'true' }, { label: 'No', description: '', value: 'false' }]
      : fieldOptions(multi ? items : field);
    const header = typeof field.title === 'string' ? field.title : '';
    const question = typeof field.description === 'string' && field.description.trim() ? field.description : keys.length <= 2 ? message : header || message;
    questions.push({ id: key, header, question, options, ...(multi ? { multiSelect: true } : {}) });
  }
  for (const question of questions) if (question.options.length) question.allowCustomAnswer = custom.has(question.id);
  return { questions, custom };
};

/** A person's answers as the form's content: a chosen option's value, a typed answer in the field's "Other" box. */
const formContent = (questions: T3Question[], custom: Map<string, string>, answers: QuestionAnswers, schema: unknown): Record<string, unknown> => {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const content: Record<string, unknown> = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) continue;
    const values = new Set(question.options.map((option) => option.value ?? option.label));
    const field = properties[question.id];
    if (isRecord(field) && field.type === 'boolean') { content[question.id] = answer === 'true' || answer === true; continue; }
    if (Array.isArray(answer)) { content[question.id] = answer.filter((value) => values.has(String(value))); continue; }
    if (typeof answer !== 'string') continue;
    const text = answer;
    if (!question.options.length || values.has(text)) content[question.id] = text;
    else if (custom.has(question.id)) content[custom.get(question.id)!] = text;
  }
  return content;
};

/** What a restart tells a turn it cut off. */
const RESUME = 'Serra restarted while you were working on the last message, so your turn was cut off. Carry on from where you were, and answer it.';

/**
 * Starts the agent from the PATH in its environment: its own command, or a bundled adapter run by this Node on the
 * owner's CLI. In a process group of its own, so `close()` stops the agent and everything it started (the CLI).
 */
const defaultSpawn = (agent: AcpAgent, env: NodeJS.ProcessEnv): ChildProcess => {
  const launch = launchFor(agent, env.PATH ?? '');
  if ('missing' in launch) throw new Error(launch.missing);
  return spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...agent.env, ...launch.env }, detached: true });
};

/** Signals the agent's process group, else the agent alone. */
const signal = (running: ChildProcess, name: NodeJS.Signals): void => {
  try {
    if (running.pid) { process.kill(-running.pid, name); return; }
  } catch { /* not a group leader (a test's fake): signal it alone */ }
  running.kill(name);
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const recordFile = (runsDir: string, sessionId: string): string => join(runsDir, `${encodeURIComponent(sessionId)}.json`);

/** A run's record from `runsDir`, or null. */
export const readRunRecord = (runsDir: string, sessionId: string): RunRecord | null => {
  let value: unknown;
  try { value = parseJson(readFileSync(recordFile(runsDir, sessionId), 'utf8')); } catch { return null; }
  if (!isRecord(value) || value.version !== 1 || typeof value.sessionId !== 'string' || typeof value.cwd !== 'string' || !Array.isArray(value.entries)) return null;
  const access: RunAccess = value.access === 'read-only' || value.access === 'ask' ? value.access : 'full';
  return {
    version: 1, agent: str(value.agent), sessionId: value.sessionId, title: str(value.title), cwd: value.cwd, access,
    createdAt: str(value.createdAt), runs: typeof value.runs === 'number' ? value.runs : 0,
    active: typeof value.active === 'string' ? value.active : null,
    waiting: Array.isArray(value.waiting) ? value.waiting.filter((entry): entry is QuestionRequest => isRecord(entry) && typeof entry.requestId === 'string' && Array.isArray(entry.questions)) : [],
    entries: value.entries.filter(isRecord).flatMap((entry): TranscriptEntry[] => {
      const role = entry.role === 'user' || entry.role === 'assistant' || entry.role === 'tool' ? entry.role : null;
      return role && typeof entry.text === 'string' ? [{ role, runId: str(entry.runId), text: entry.text, at: str(entry.at) }] : [];
    }),
  };
};

export const createAcpBackend = ({
  agent, env = async () => process.env, worktreeRoot, runsDir, attachmentsDir, model, spawnAgent = defaultSpawn, log = () => {}, mcpServers = [], now = () => new Date(),
}: AcpBackendOptions): AgentBackend => {
  const sessions = new Map<string, Session>();
  /** Sessions being reopened after a restart, so two reads don't load one twice. */
  const reopening = new Map<string, Promise<Session>>();
  let child: ChildProcess | null = null;
  let connection: Promise<acp.ClientConnection> | null = null;
  let hello: acp.InitializeResponse | null = null;
  let stderr = '';
  let exited: string | null = null;
  /** Bumped whenever a turn ends or a request waits, so a wait reads at once instead of on its next poll. */
  let version = 0;
  const waiters = new Set<() => void>();
  const changed = (): void => {
    version += 1;
    for (const wake of waiters) wake();
    waiters.clear();
  };

  const save = (current: Session): void => {
    if (!runsDir) return;
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const waiting = [...current.waiting.values()].map((entry) => entry.request);
    writeFileAtomic(recordFile(runsDir, current.sessionId), `${JSON.stringify({ ...current.record, active: current.active, waiting })}\n`, { mode: 0o600 });
  };
  const note = (current: Session, role: TranscriptEntry['role'], runId: string, text: string): void => {
    current.record.entries.push({ role, runId, text, at: now().toISOString() });
  };

  /** The agent went away: in-flight turns end, or with a record, are carried on when the run is next read. */
  const agentGone = (why: string): void => {
    for (const [id, current] of sessions) {
      for (const waiting of current.waiting.values()) waiting.cancel();
      current.waiting.clear();
      if (runsDir) { sessions.delete(id); continue; }
      if (current.active) current.failed = why;
      current.active = null;
      current.queue = [];
    }
    child = null;
    connection = null;
    hello = null;
    changed();
  };

  /** Puts a question in front of a person and gives back their answer. A read-only run gets none: it's refused. */
  const ask = (current: Session, questions: T3Question[]): Promise<QuestionAnswers | null> => new Promise((resolve) => {
    const requestId = randomUUID();
    const done = (answers: QuestionAnswers | null): void => {
      current.waiting.delete(requestId);
      save(current);
      changed();
      resolve(answers);
    };
    current.waiting.set(requestId, { request: { requestId, questions }, answer: (answers) => done(answers), cancel: () => done(null) });
    note(current, 'tool', current.active ?? `run-${current.record.runs}`, `Asked: ${questions.map((question) => question.question).join(' / ')}`);
    save(current);
    changed();
  });

  const app = acp.client({ name: 'serra' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const current = sessions.get(params.sessionId);
      if (!current) return;
      const update = params.update;
      const runId = current.active ?? `run-${current.record.runs}`;
      // Serra keeps the reply, the tool calls and the cost; plans, thoughts and modes it doesn't need.
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'image') {
        // An image the agent sends: saved where replies share images from, and embedded, so the chat uploads it.
        const embed = saveAgentImage(update.content.data, update.content.mimeType, `${current.sessionId}-${runId}-${current.tools.size}-${current.reply.length}`);
        current.reply += embed ? `\n\n${embed}\n\n` : `\n\n_(${agent.name} sent an image Serra can't show: ${update.content.mimeType})_\n\n`;
      } else if (update.sessionUpdate === 'agent_message_chunk') current.reply += textOf(update.content);
      else if (update.sessionUpdate === 'usage_update' && update.cost) current.cost = { amount: update.cost.amount, currency: update.cost.currency };
      else if (update.sessionUpdate === 'tool_call') {
        current.tools.set(update.toolCallId, { id: update.toolCallId, runId, title: update.title, kind: update.kind ?? null, status: update.status ?? null, rawInput: update.rawInput, rawOutput: update.rawOutput, content: update.content });
      } else if (update.sessionUpdate === 'tool_call_update') {
        const known = current.tools.get(update.toolCallId) ?? { id: update.toolCallId, runId, title: '', kind: null, status: null, rawInput: undefined, rawOutput: undefined, content: undefined };
        const next = {
          ...known,
          ...(update.title ? { title: update.title } : {}), ...(update.kind ? { kind: update.kind } : {}), ...(update.status ? { status: update.status } : {}),
          ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}), ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
          ...(update.content ? { content: update.content } : {}),
        };
        current.tools.set(update.toolCallId, next);
        if (next.status === 'completed' || next.status === 'failed') note(current, 'tool', next.runId, `${next.title || next.kind || 'Tool'}${next.status === 'failed' ? ' (failed)' : ''}`);
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      const current = sessions.get(params.sessionId);
      const kind = params.toolCall.kind ?? 'other';
      const pick = (kinds: acp.PermissionOptionKind[]): acp.RequestPermissionResponse => {
        const option = kinds.map((wanted) => params.options.find((choice) => choice.kind === wanted)).find(Boolean);
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
      };
      const title = params.toolCall.title ?? kind;
      if (!current || current.record.access === 'read-only') {
        if (current) { current.refused += 1; changed(); }
        log(`${agent.name} asked to use ${title} (${kind}) in a read-only run: refused.`);
        return pick(['reject_once', 'reject_always']);
      }
      if (current.record.access === 'ask') {
        const allow = ALLOWED_KINDS.has(kind);
        log(`${agent.name} asked to use ${title} (${kind}): ${allow ? 'allowed once' : 'refused'}.`);
        return allow ? pick(['allow_once']) : pick(['reject_once', 'reject_always']);
      }
      if (current.allowAll) return pick(['allow_once', 'allow_always']);
      // Full access, and the agent still asks: a person decides, on a question card.
      const allowOption = params.options.find((choice) => choice.kind === 'allow_once') ?? params.options.find((choice) => choice.kind === 'allow_always');
      const rejectOption = params.options.find((choice) => choice.kind === 'reject_once') ?? params.options.find((choice) => choice.kind === 'reject_always');
      if (!allowOption || !rejectOption) return pick(['reject_once', 'reject_always']);
      const answers = await ask(current, [{
        id: 'permission', header: 'Permission', question: `${agent.name} wants to: ${title}`,
        options: [{ label: 'Allow', description: '', value: allowOption.optionId }, { label: 'Deny', description: '', value: rejectOption.optionId }],
        allowCustomAnswer: false,
      }]);
      const chosen = answers?.permission;
      return typeof chosen === 'string' && (chosen === allowOption.optionId || chosen === rejectOption.optionId)
        ? { outcome: { outcome: 'selected', optionId: chosen } }
        : { outcome: { outcome: 'cancelled' } };
    })
    .onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
      const request = params as acp.CreateElicitationRequest & { sessionId?: string; requestedSchema?: unknown };
      const current = typeof request.sessionId === 'string' ? sessions.get(request.sessionId) : undefined;
      if (request.mode !== 'form' || !current) return { action: 'decline' };
      if (current.record.access !== 'full') {
        current.refused += 1;
        changed();
        log(`${agent.name} asked a question in a ${current.record.access} run: declined.`);
        return { action: 'decline' };
      }
      const { questions, custom } = formQuestions(request.message, request.requestedSchema);
      if (!questions.length) return { action: 'decline' };
      const answers = await ask(current, questions);
      return answers ? { action: 'accept', content: formContent(questions, custom, answers, request.requestedSchema) } as acp.CreateElicitationResponse : { action: 'cancel' };
    });

  /** Starts the agent and says hello, once (again after it went away). */
  const connect = (): Promise<acp.ClientConnection> => (connection ??= (async () => {
    exited = null;
    let started: ChildProcess;
    try { started = spawnAgent(agent, await env()); } catch (error) {
      exited = error instanceof Error ? error.message : String(error);
      connection = null;
      throw new Error(exited);
    }
    child = started;
    stderr = '';
    started.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4000); });
    const gone = new Promise<never>((_resolve, reject) => {
      started.once('error', (error: NodeJS.ErrnoException) => {
        exited = error.code === 'ENOENT' ? `Serra can't find \`${agent.command}\`. Install ${agent.name}, or pick another agent.` : `${agent.name} couldn't start: ${error.message}`;
        if (child === started) agentGone(exited);
        reject(new Error(exited));
      });
      started.once('exit', (code, signalName) => {
        exited ??= `${agent.name} stopped (${signalName ?? `exit ${code ?? '?'}`}).`;
        if (stderr.trim()) log(`${agent.name} stopped; its last log lines are kept out of Serra's log (${stderr.trim().split('\n').length} lines).`);
        if (child === started) agentGone(exited);
        reject(new Error(exited));
      });
    });
    gone.catch(() => {});
    if (!started.stdin || !started.stdout) throw new Error(`${agent.name} has no stdio to talk over.`);
    const stream = acp.ndJsonStream(Writable.toWeb(started.stdin), Readable.toWeb(started.stdout) as ReadableStream<Uint8Array>);
    const open = app.connect(stream);
    hello = await Promise.race([
      open.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: 'serra', version: '1' },
      }),
      gone,
    ]);
    if (hello.protocolVersion !== acp.PROTOCOL_VERSION) log(`${agent.name} speaks ACP ${hello.protocolVersion}; Serra speaks ${acp.PROTOCOL_VERSION}.`);
    return open;
  })());

  /** A plain sentence for an error starting or reopening a session: sign-in problems say where to sign in. */
  const plain = (error: unknown): Error => {
    if (exited) return new Error(exited);
    const text = error instanceof Error ? error.message : String(error);
    if ((typeof error === 'object' && error !== null && (error as { code?: unknown }).code === -32000) || /auth|sign[- ]?in|log[- ]?in|credential|api key/i.test(text)) {
      return new Error(`${agent.name} needs you to sign in. Sign in with its own CLI, then try again.`);
    }
    return new Error(`${agent.name}: ${text.slice(0, 300)}`);
  };

  /** A message as ACP content: its text, and each image attached to it when the agent takes images. */
  const promptFor = (text: string): acp.ContentBlock[] => {
    const images = attachmentsDir && hello?.agentCapabilities?.promptCapabilities?.image ? attachedImages(text, attachmentsDir) : [];
    return [{ type: 'text', text }, ...images.flatMap((image) => { const block = imageContent(image); return block ? [block] : []; })];
  };

  /** Runs one prompt turn, then the next queued message, if any. `runId` carries on a turn a restart cut off. */
  const turn = (current: Session, text: string, carryOn?: string): void => {
    let runId = carryOn;
    if (!runId) {
      current.record.runs += 1;
      runId = `run-${current.record.runs}`;
      note(current, 'user', runId, text);
    }
    current.active = runId;
    current.reply = '';
    current.failed = null;
    current.cost = null;
    save(current);
    void (async () => {
      const open = await connect().catch((error: unknown) => { current.failed = plain(error).message; return null; });
      if (open) {
        try {
          const done = await open.agent.request(acp.methods.agent.session.prompt, { sessionId: current.sessionId, prompt: promptFor(text) });
          if (done.stopReason !== 'end_turn') log(`${agent.name}'s turn ${runId} ended: ${done.stopReason}.`);
        } catch (error) {
          // The agent went away mid-turn (its exit can come just after the broken pipe): with a record, the turn is
          // carried on when the run is next read.
          if (runsDir) await new Promise((resolve) => { setTimeout(resolve, 300); });
          if (runsDir && sessions.get(current.sessionId) !== current) return;
          current.failed = exited ?? turnFailure(error, agent.name);
          log(`${agent.name}'s turn ${runId} failed: ${current.failed}`);
        }
      }
      if (current.active !== runId) return;
      if (current.cost) log(`${agent.name}'s turn ${runId} cost ${current.cost.amount.toFixed(4)} ${current.cost.currency}.`);
      if (current.reply) note(current, 'assistant', runId, current.reply);
      current.active = null;
      save(current);
      changed();
      const next = current.queue.shift();
      if (next !== undefined) turn(current, next);
    })();
  };

  /** Puts a new or reopened session in the mode its access needs, and on the owner's model. */
  const configure = async (open: acp.ClientConnection, sessionId: string, modes: acp.SessionModeState | null | undefined, configOptions: acp.SessionConfigOption[] | null | undefined, access: RunAccess): Promise<boolean> => {
    let allowAll = false;
    const mode = modes ? modeFor(modes, access) : null;
    if (mode && mode !== modes?.currentModeId) {
      try { await open.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode }); } catch (error) {
        if (access !== 'full') throw new Error(`${agent.name} wouldn't switch to a mode that asks before using tools, so Serra can't run this safely. ${plain(error).message}`);
        allowAll = true;
      }
    } else if (!mode && modes && access !== 'full' && PERMISSIVE.test(modes.currentModeId)) {
      throw new Error(`${agent.name} runs in "${modes.currentModeId}" mode and has none that asks before using tools, so Serra can't make this run read-only.`);
    } else if (!mode && access === 'full') allowAll = true;
    if (model) {
      const option = configOptions?.find((choice) => choice.category === 'model' || choice.id === 'model');
      if (option) {
        await open.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: option.id, value: model })
          .catch((error: unknown) => log(`${agent.name} kept its own model: ${plain(error).message}`));
      } else log(`${agent.name} offers no model choice over ACP; it uses its own default.`);
    }
    return allowAll;
  };

  const newSession = (record: RunRecord, allowAll: boolean): Session => ({
    sessionId: record.sessionId, record, active: null, refused: 0, waiting: new Map(), failed: null, reply: '', tools: new Map(), queue: [], cost: null, allowAll,
  });

  /** A run this backend follows, reopened from its record after a restart. Throws a plain sentence when it can't be. */
  const session = (threadId: string): Promise<Session> => {
    const found = sessions.get(threadId);
    if (found) return Promise.resolve(found);
    const record = runsDir ? readRunRecord(runsDir, threadId) : null;
    if (!record || (record.agent && record.agent !== agent.id)) return Promise.reject(new Error(`${agent.name} has no run ${threadId}: it ended when Serra restarted.`));
    const pending = reopening.get(threadId) ?? (async () => {
      const open = await connect().catch((error: unknown) => { throw plain(error); });
      if (!hello?.agentCapabilities?.loadSession) throw new Error(`${agent.name} can't reopen a run after a restart.`);
      let loaded: acp.LoadSessionResponse;
      try { loaded = await open.agent.request(acp.methods.agent.session.load, { sessionId: threadId, cwd: record.cwd, mcpServers }); } catch (error) { throw plain(error); }
      const allowAll = await configure(open, threadId, loaded.modes, loaded.configOptions, record.access);
      const current = newSession({ ...record, waiting: [] }, allowAll);
      sessions.set(threadId, current);
      save(current);
      log(`Reopened ${agent.name} run ${threadId} after a restart.`);
      if (record.active) turn(current, RESUME, record.active);
      return current;
    })();
    reopening.set(threadId, pending);
    return pending.finally(() => reopening.delete(threadId));
  };

  const start = async (input: StartRun): Promise<string> => {
    const access: RunAccess = input.readOnly ? 'read-only' : input.workspace.kind === 'worktree' ? 'full' : 'ask';
    const cwd = input.workspace.kind === 'folder'
      ? input.workspace.path
      : await makeWorktree({ ...input.workspace, ...(worktreeRoot ? { root: worktreeRoot } : {}) });
    let created: acp.NewSessionResponse;
    let open: acp.ClientConnection;
    try {
      open = await connect();
      created = await open.agent.request(acp.methods.agent.session.new, { cwd, mcpServers });
    } catch (error) { throw plain(error); }
    const { sessionId } = created;
    const allowAll = await configure(open, sessionId, created.modes, created.configOptions, access);
    const record: RunRecord = { version: 1, agent: agent.id, sessionId, title: input.title, cwd, access, createdAt: now().toISOString(), runs: 0, active: null, entries: [] };
    const current = newSession(record, allowAll);
    sessions.set(sessionId, current);
    turn(current, input.brief);
    return sessionId;
  };

  const read = async (threadId: string, messages = 1): Promise<RunDetail> => {
    const current = await session(threadId);
    const { runs } = current.record;
    return {
      thread: {
        threadId, link: '', status: current.active ? 'running' : current.failed ? 'failed' : 'idle',
        latestRunId: runs ? `run-${runs}` : null, activeRunId: current.active, pendingRequestCount: current.refused + current.waiting.size,
        ...(current.failed && !current.active ? { error: current.failed } : {}),
      },
      messages: current.record.entries.filter((entry) => entry.role !== 'tool').slice(-messages).map(({ role, runId, text }) => ({ role, runId, text })),
    };
  };

  const toolCall = async (threadId: string, runId: string, match: string): Promise<RunToolCall | null> => {
    const current = await session(threadId);
    const found = [...current.tools.values()].filter((record) => record.runId === runId && JSON.stringify(record.rawInput ?? record.title ?? '').includes(match)).at(-1);
    if (!found) return null;
    return { input: found.rawInput, output: toolOutput(found), failed: found.status === 'failed' };
  };

  return {
    id: 'acp',
    key: `acp:${agent.id}`,
    label: agent.name,
    capabilities: { steer: false, worktrees: false, persistentRuns: runsDir !== undefined, transcriptLink: false, readOnly: true, toolResults: true } satisfies BackendCapabilities,
    start,
    send: async (threadId, message) => {
      const current = await session(threadId);
      if (current.active) current.queue.push(message);
      else turn(current, message);
    },
    interrupt: async (threadId) => {
      const current = await session(threadId);
      current.queue = [];
      for (const waiting of current.waiting.values()) waiting.cancel();
      if (!connection || !current.active) return;
      await (await connection).agent.notify(acp.methods.agent.session.cancel, { sessionId: current.sessionId });
    },
    read,
    // Polling stays the contract; a turn ending or a request waiting wakes the wait at once.
    wait: (threadId, options) => {
      let seen = -1;
      const wake = async (ms: number): Promise<void> => {
        if (version !== seen) { seen = version; return; }
        const controller = new AbortController();
        let onWake: (() => void) | undefined;
        try {
          await Promise.race([
            options.sleep(ms, controller.signal),
            new Promise<void>((resolve) => { onWake = resolve; waiters.add(resolve); }),
          ]);
        } finally {
          controller.abort();
          if (onWake) waiters.delete(onWake);
        }
        seen = version;
      };
      return pollUntilSettled(read, threadId, { ...options, sleep: wake });
    },
    // Runs Serra started are found by their record; ACP has no list of a project's threads by title.
    list: async () => [],
    settle: async (threadId) => { sessions.delete(threadId); },
    toolCall,
    images: async () => {
      await connect().catch((error: unknown) => { throw plain(error); });
      return hello?.agentCapabilities?.promptCapabilities?.image === true;
    },
    questions: {
      list: async (threadId) => [...(await session(threadId)).waiting.values()].map((waiting) => structuredClone(waiting.request)),
      answer: async (threadId, requestId, answers) => {
        const waiting = (await session(threadId)).waiting.get(requestId);
        if (!waiting) throw new Error(`${agent.name} isn't waiting on that question any more.`);
        waiting.answer(answers);
      },
    },
    close: async () => {
      for (const current of sessions.values()) for (const waiting of current.waiting.values()) waiting.cancel();
      sessions.clear();
      const running = child;
      child = null;
      if (connection) {
        const open = connection;
        connection = null;
        await open.then((value) => value.close(), () => {});
      }
      if (!running || running.exitCode !== null || running.signalCode !== null) return;
      const ended = new Promise<void>((resolve) => { running.once('exit', () => resolve()); });
      running.stdin?.end();
      signal(running, 'SIGTERM');
      const timer = setTimeout(() => signal(running, 'SIGKILL'), 3_000);
      await ended;
      clearTimeout(timer);
    },
  };
};
