// Where weekly knowledge reviews are kept, and whether they run: read by the review itself, Overview and the app.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { isArrayOf, isBoolean, isOneOf, isOptional, isRecord, isString, readJsonOrNull } from './lib/guards.ts';

/** One thing the review suggests, with the one action that settles it. */
export interface ReviewSuggestion {
  id: string;
  /** `replace`: a proposal rewrites the page; `retire`: the page leaves; `confirm`: the owner says it still holds. */
  kind: 'replace' | 'retire' | 'confirm';
  page: string;
  /** The page's description, the name the screen shows. */
  title: string;
  why: string;
  /** For `replace`: the proposal written for it, relative to `knowledge/proposals/`. */
  proposal?: string;
  /** SHA-256 of the page as the review saw it: a page changed since is never overwritten by the suggestion. */
  base?: string;
}

/** A request from the week answered again without the page that answered it, next to the real reply. */
export interface ReviewExample { page: string; title: string; request: string; withPage: string; without: string }

export interface KnowledgeReview {
  /** The day it ran, `YYYY-MM-DD`; also its file name. */
  id: string;
  at: string;
  /** The week it covers. */
  from: string;
  to: string;
  summary: string;
  replies: number;
  withKnowledge: number;
  score: { before: number | null; now: number };
  facts: { before: number | null; now: number };
  /** Pages the week's replies named, most used first. */
  used: { page: string; title: string; uses: number }[];
  /** What the bot said it needed and no page had, most asked first. */
  missing: { topic: string; count: number }[];
  suggestions: ReviewSuggestion[];
  examples: ReviewExample[];
  /** Why the model part didn't run, when it didn't. The rest of the digest still stands. */
  error?: string;
}

export const reviewsDir = (profileDir: string): string => join(profileDir, 'knowledge-reviews');
const settingsFile = (profileDir: string): string => join(profileDir, 'knowledge-review.json');

/** Weekly is on unless the owner turned it off. */
export const reviewSettings = (profileDir: string): { weekly: boolean } => {
  const saved = readJsonOrNull(settingsFile(profileDir), (value): value is { weekly: boolean } => isRecord(value) && isBoolean(value.weekly));
  return { weekly: saved?.weekly ?? true };
};

export const setReviewWeekly = (profileDir: string, weekly: boolean): void => {
  writeFileAtomic(settingsFile(profileDir), `${JSON.stringify({ weekly }, null, 2)}\n`, { mode: 0o600 });
};

const isSuggestion = (value: unknown): value is ReviewSuggestion => isRecord(value) && isString(value.id) && isOneOf('replace', 'retire', 'confirm')(value.kind)
  && isString(value.page) && isString(value.title) && isString(value.why) && isOptional(isString)(value.proposal) && isOptional(isString)(value.base);
const isReview = (value: unknown): value is KnowledgeReview => isRecord(value) && isString(value.id) && isString(value.at) && isString(value.summary)
  && isArrayOf(isSuggestion)(value.suggestions) && Array.isArray(value.examples) && Array.isArray(value.used) && Array.isArray(value.missing);

/** The most recent review, or null before the first. */
export const latestReview = (profileDir: string): KnowledgeReview | null => {
  const dir = reviewsDir(profileDir);
  if (!existsSync(dir)) return null;
  const last = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  return last ? readJsonOrNull(join(dir, last), isReview) : null;
};

