// What the app and `pnpm bot jobs` read about an ACP run, from its record in the profile (src/agent/acp.ts): whether
// it runs or waits, its PR, and its transcript. Files only, so it works whether or not the daemon runs.
import { GITHUB_PR_URL } from '../t3.ts';
import type { TaskState } from '../tasks.ts';
import { readRunRecord, type TranscriptEntry } from './acp.ts';
import type { QuestionRequest } from './backend.ts';
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

/** What the transcript view shows: the run's lines, whether it runs, and what it waits on. */
export interface RunTranscript {
  title: string;
  agent: string;
  running: boolean;
  entries: TranscriptEntry[];
  waiting: QuestionRequest[];
}

export const acpTranscript = (profileDir: string, threadId: string): RunTranscript | null => {
  const record = readRunRecord(agentRunsDir(profileDir), threadId);
  return record ? { title: record.title, agent: record.agent, running: record.active !== null, entries: record.entries, waiting: record.waiting ?? [] } : null;
};
