// Which knowledge pages the bot's replies actually used. The worker names them in a `<knowledge-used>` line at the end
// of its reply (the brief asks for it, whatever the T3 provider); Serra takes the line out before anything is posted
// and keeps one record per run in `logs/knowledge-usage.jsonl` in the profile. Only the owner's app reads it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isArrayOf, isNumber, isOneOf, isRecord, isString } from './lib/guards.ts';

const BLOCK = /\n?[ \t]*<knowledge-used>([\s\S]*?)<\/knowledge-used>[ \t]*/gi;

/** The reply without its `<knowledge-used>` lines, and the page paths they named, each once. */
export const takeKnowledgeUsed = (reply: string): { reply: string; cited: string[] } => {
  const cited: string[] = [];
  const stripped = reply.replace(BLOCK, (_line, list: string) => {
    for (const item of list.split(/[,\n]/)) {
      const path = item.trim().replace(/^`|`$/g, '').replace(/^\.\//, '');
      if (/^[\w@().-]+(?:\/[\w@().-]+)*\.md$/.test(path) && !cited.includes(path)) cited.push(path);
    }
    return '';
  });
  return { reply: cited.length > 0 || stripped !== reply ? stripped.trimEnd() : reply, cited };
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
}

const isUse = (value: unknown): value is KnowledgeUse => isRecord(value) && isString(value.at) && isString(value.runId)
  && isOneOf('owner', 'team', 'external')(value.visibility) && isArrayOf(isString)(value.cited) && isNumber(value.offered);

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
