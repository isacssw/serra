// Which knowledge pages the bot's replies actually used. The worker names them in a `<knowledge-used>` line at the end
// of its reply (the brief asks for it, whatever the T3 provider); Serra takes the line out before anything is posted
// and keeps one record per run in `logs/knowledge-usage.jsonl` in the profile. Only the owner's app reads it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isArrayOf, isNumber, isOneOf, isOptional, isRecord, isString } from './lib/guards.ts';

const BLOCK = /\n?[ \t]*<knowledge-used>([\s\S]*?)<\/knowledge-used>[ \t]*/gi;
const MISSING = /\n?[ \t]*<knowledge-missing>([\s\S]*?)<\/knowledge-missing>[ \t]*/gi;

/**
 * The reply without its `<knowledge-used>` and `<knowledge-missing>` lines, the page paths the first named, each once,
 * and what the second said the owner hadn't written down (a few words each, at most five).
 */
export const takeKnowledgeUsed = (reply: string): { reply: string; cited: string[]; missing: string[] } => {
  const cited: string[] = [];
  const missing: string[] = [];
  let stripped = reply.replace(BLOCK, (_line, list: string) => {
    for (const item of list.split(/[,\n]/)) {
      const path = item.trim().replace(/^`|`$/g, '').replace(/^\.\//, '');
      if (/^[\w@().-]+(?:\/[\w@().-]+)*\.md$/.test(path) && !cited.includes(path)) cited.push(path);
    }
    return '';
  });
  stripped = stripped.replace(MISSING, (_line, list: string) => {
    for (const item of list.split(/[;\n]/)) {
      const topic = item.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (topic && missing.length < 5 && !missing.includes(topic)) missing.push(topic);
    }
    return '';
  });
  return { reply: stripped !== reply ? stripped.trimEnd() : reply, cited, missing };
};

export interface KnowledgeUse {
  at: string;
  /** The run whose reply it was: a run posted twice is counted once. */
  runId: string;
  /** Who saw the reply. */
  visibility: 'owner' | 'team' | 'external';
  /** Pages the reply named that its worker could read. A name it couldn't read is dropped. */
  cited: string[];
  /** How many pages the worker could open. */
  offered: number;
  /** The start of what was asked. */
  request?: string;
  /** The start of the reply as posted. */
  reply?: string;
  /** What the worker said it needed and the owner hadn't written down. */
  missing?: string[];
}

const isUse = (value: unknown): value is KnowledgeUse => isRecord(value) && isString(value.at) && isString(value.runId)
  && isOneOf('owner', 'team', 'external')(value.visibility) && isArrayOf(isString)(value.cited) && isNumber(value.offered)
  && isOptional(isString)(value.request) && isOptional(isString)(value.reply) && isOptional(isArrayOf(isString))(value.missing);

const usageFile = (profileDir: string): string => join(profileDir, 'logs', 'knowledge-usage.jsonl');

export const recordKnowledgeUse = (profileDir: string, use: KnowledgeUse): void => {
  const file = usageFile(profileDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(use)}\n`, { mode: 0o600 });
};

/** The most recent records, oldest first, one per run. A line that doesn't parse is skipped. */
export const readKnowledgeUse = (profileDir: string, { limit = 1000 }: { limit?: number } = {}): KnowledgeUse[] => {
  const file = usageFile(profileDir);
  if (!existsSync(file)) return [];
  const byRun = new Map<string, KnowledgeUse>();
  for (const line of readFileSync(file, 'utf8').split('\n').slice(-limit * 2)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isUse(value)) byRun.set(value.runId, value);
    } catch { /* a torn last line from a crash is skipped */ }
  }
  return [...byRun.values()].slice(-limit);
};
