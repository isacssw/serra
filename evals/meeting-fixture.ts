// The meeting evals' shared setup (SERRA-62): the ten fake transcripts in evals/meetings/, their gold files, and a
// scratch copy of the Robin fixture with each transcript's seeded Decisions sections. Used by the deterministic test
// (tests/meeting-evals.test.ts) and the live run (evals/meeting.ts).
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledge } from '../src/knowledge.ts';

export const MEETINGS_DIR = new URL('./meetings/', import.meta.url).pathname;
const FIXTURE = new URL('./fixture/knowledge/', import.meta.url).pathname;

export interface GoldItem {
  id: string;
  kind?: 'decision' | 'constraint';
  /** Every pattern must match the kept item's text (case-insensitive) for it to count as this gold item. */
  match: string[];
  /** An exact span of the transcript showing it: what a perfect extractor would quote. */
  quote?: string;
  target?: string;
  op?: 'add' | 'replace';
  old?: string;
  links?: string[];
  who?: string[];
  /** Names that must never be listed as agreeing (they only said "sounds fine I guess"). */
  whoMustNotInclude?: string[];
}

export interface Gold {
  name: string;
  transcript: string;
  heldOut: boolean;
  tests: string;
  /** Text appended to pages before the meeting, like an existing Decisions section. */
  seed?: Record<string, string>;
  memory: GoldItem[];
  /** Decisions already on a page: proposing them again is a false positive. */
  known?: GoldItem[];
  reply: { kind: 'action' | 'question' | 'dated'; match: string[] }[];
  /** Patterns no kept item, quote, context, reply line or digest may match. */
  forbidden: string[];
  /** Patterns no kept item may match: things that belong in the reply (a dated freeze) or were reversed, never in memory. */
  forbiddenInMemory?: string[];
  /** Secrets in the transcript: they must never reach the model, the evidence, a page or a reply. */
  secrets?: string[];
  /** The memory cap the transcript is meant to hit. */
  cap?: number;
}

export const golds = (): Gold[] => readdirSync(MEETINGS_DIR).filter((name) => name.endsWith('.json')).sort()
  .map((name) => ({ name: name.replace(/\.json$/, ''), ...(JSON.parse(readFileSync(join(MEETINGS_DIR, name), 'utf8')) as Omit<Gold, 'name'>) }));

export const transcriptText = (gold: Gold): string => readFileSync(join(MEETINGS_DIR, gold.transcript), 'utf8');

/** A scratch profile with the fixture's knowledge, the gold's seeds, and the approved copy made. Returns its knowledge folder. */
export const scratchKnowledge = (gold: Gold): string => {
  const dir = mkdtempSync(join(tmpdir(), `serra-meeting-eval-${gold.name}-`));
  const knowledgeDir = join(dir, 'profile', 'knowledge');
  cpSync(FIXTURE, knowledgeDir, { recursive: true });
  for (const [path, text] of Object.entries(gold.seed ?? {})) appendFileSync(join(knowledgeDir, path), text);
  createKnowledge(knowledgeDir).seedApproved();
  return knowledgeDir;
};

export const matches = (patterns: string[], text: string): boolean => patterns.every((pattern) => new RegExp(pattern, 'iu').test(text));
