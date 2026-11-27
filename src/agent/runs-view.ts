// What the app and `pnpm bot jobs` read about a run: an ACP run's state and PR from its record in the profile
// (src/agent/acp.ts), files only, so it works whether or not the daemon runs; and the chat view of either backend's
// run (the record for ACP, the backend's `read` for T3), with the images its messages name.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, sep } from 'node:path';
import { GITHUB_PR_URL } from '../t3.ts';
import type { TaskState } from '../tasks.ts';
import { readRunRecord, type LiveTurn, type TranscriptEntry } from './acp.ts';
import { acpAgents, readAgentBackend } from './acp-agents.ts';
import type { AgentBackend, QuestionRequest } from './backend.ts';
import { AGENT_IMAGES_DIR } from './images.ts';
import { agentRunsDir } from './pool.ts';

/** A GitHub PR link anywhere in a line of text. */
const PR_IN_TEXT = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** A run's state for its Jobs row, like `t3TaskState` gives a T3 thread's. Null when there's no record. */
export const acpRunState = (profileDir: string, threadId: string): (TaskState & { title: string }) | null => {
  const record = readRunRecord(agentRunsDir(profileDir), threadId);
  if (!record) return null;
  const pr = record.entries.filter((entry) => entry.role === 'assistant').flatMap((entry) => entry.text.match(PR_IN_TEXT) ?? []).filter((url) => GITHUB_PR_URL.test(url)).at(-1);
  const updatedAt = record.entries.at(-1)?.at || record.createdAt;
  return {
    title: record.title,
    running: record.active !== null,
    waiting: (record.waiting?.length ?? 0) > 0,
    ...(pr ? { pr } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(record.runs ? { latestRunId: `run-${record.runs}` } : {}),
  };
};

/** A run as the app's chat view shows it, on either backend. */
export interface RunChat {
  threadId: string;
  backend: 'acp' | 't3';
  /** The agent's id (`claude`, `codex`, …, or `t3`), for its mark, and its name as copy shows it. */
  agentId: string;
  agent: string;
  title: string;
  status: 'running' | 'waiting' | 'idle' | 'failed';
  /** Why the latest run failed, as the backend put it. */
  error?: string;
  /** Where the run opens on the web (T3). */
  link?: string;
  /** What was said and done, oldest first. T3 gives messages only: its tools are in T3. */
  lines: TranscriptEntry[];
  /** The running turn so far (ACP): its reply and the tools it has open. */
  live: LiveTurn | null;
  /** Questions answered from here (ACP). */
  waiting: QuestionRequest[];
  /** Why a follow-up can't be sent from here; absent when it can. */
  replyBlocked?: string;
}

/** How many of a T3 thread's latest messages the chat shows. */
export const T3_CHAT_MESSAGES = 80;

/** An ACP agent's name from the profile's agents, else its id. */
const agentName = (profileDir: string, id: string): string => {
  try { return acpAgents(readAgentBackend(profileDir)).find((agent) => agent.id === id)?.name ?? id; } catch { return id; }
};

/** An ACP run's chat, from its record. Null when Serra has no record of it. Files only: it works with the daemon stopped. */
export const acpChat = (profileDir: string, threadId: string): RunChat | null => {
  const record = readRunRecord(agentRunsDir(profileDir), threadId);
  if (!record) return null;
  const waiting = record.waiting ?? [];
  const running = record.active !== null;
  return {
    threadId, backend: 'acp', agentId: record.agent || 'acp', agent: agentName(profileDir, record.agent), title: record.title,
    status: waiting.length ? 'waiting' : running ? 'running' : 'idle',
    lines: record.entries,
    live: running ? record.live ?? null : null,
    waiting,
    // Meeting runs and checks are read-only: nobody carries them on.
    ...(record.access === 'full' ? {} : { replyBlocked: 'Read-only run' }),
  };
};

/** A T3 run's chat, read through its backend: its latest messages and state. T3 keeps the rest, behind `link`. */
export const t3Chat = async (backend: Pick<AgentBackend, 'read'>, threadId: string, title = ''): Promise<RunChat> => {
  const { thread, messages } = await backend.read(threadId, T3_CHAT_MESSAGES);
  const waiting = (thread.pendingRequestCount ?? 0) > 0;
  return {
    threadId, backend: 't3', agentId: 't3', agent: 'T3', title,
    status: waiting ? 'waiting' : thread.activeRunId ? 'running' : thread.error ? 'failed' : 'idle',
    ...(thread.error ? { error: thread.error } : {}),
    ...(thread.link ? { link: thread.link } : {}),
    lines: messages.flatMap((message): TranscriptEntry[] => ((message.role === 'user' || message.role === 'assistant') && message.text
      ? [{ role: message.role, runId: message.runId ?? '', text: message.text, at: '' }] : [])),
    live: null,
    waiting: [],
    // T3's questions have their own card in T3; a reply would only queue behind them.
    ...(waiting ? { replyBlocked: 'Answer in T3' } : {}),
  };
};

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** An image the chat shows inline is at most this big. */
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * An image a run's messages name, as a data URL the chat shows, or null. Only from Serra's own folders: the profile's
 * attachments (images sent in) and where agents' images are saved (images out), so a path in a message can't make
 * the app read any other file.
 */
export const chatImage = (profileDir: string, path: string, roots: string[] = [join(profileDir, 'attachments'), AGENT_IMAGES_DIR]): string | null => {
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type || !isAbsolute(path)) return null;
  try {
    const real = realpathSync(path);
    const inside = roots.some((root) => { try { return real.startsWith(`${realpathSync(root)}${sep}`); } catch { return false; } });
    if (!inside || statSync(real).size > MAX_CHAT_IMAGE_BYTES) return null;
    return `data:${type};base64,${readFileSync(real).toString('base64')}`;
  } catch { return null; }
};
