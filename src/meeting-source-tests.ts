// What the owner's last Test said about each meeting source, kept in `meeting-sources.json` in the profile so the
// answer survives leaving Settings › Meetings or restarting the app. Reading it is a file read: no model call. A
// result counts only for the T3 provider and model it ran on, and for a week; after that the source shows untested.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { isRecord, parseJson } from './json-guards.ts';
import { PROVIDER_IDS, PROVIDERS, type MeetingProvider, type ProviderStatus } from './meeting-sources.ts';

const SOURCE_TESTS_FILE = 'meeting-sources.json';

/** How long a test's answer stands before the source shows untested again. */
export const SOURCE_TEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The T3 provider instance and model a test ran on. Null when T3 picked its default. */
export interface SourceTestRunner { instance: string | null; model: string | null }

interface SavedTest { state: ProviderStatus['state']; detail: string; at: string; runner: SourceTestRunner }

const STATES: readonly ProviderStatus['state'][] = ['ready', 'needs-sign-in', 'missing', 'unknown'];

const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

const parseSaved = (value: unknown): SavedTest | null => {
  if (!isRecord(value) || !isRecord(value.runner)) return null;
  const { detail, at, runner } = value;
  const state = STATES.find((entry) => entry === value.state);
  if (!state || typeof detail !== 'string' || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (!nullableString(runner.instance) || !nullableString(runner.model)) return null;
  return { state, detail, at, runner: { instance: runner.instance, model: runner.model } };
};

const readAll = (profileDir: string): Partial<Record<MeetingProvider, SavedTest>> => {
  let text: string;
  try { text = readFileSync(join(profileDir, SOURCE_TESTS_FILE), 'utf8'); } catch { return {}; }
  const value = parseJson(text);
  if (!isRecord(value)) return {};
  const saved: Partial<Record<MeetingProvider, SavedTest>> = {};
  for (const provider of PROVIDER_IDS) {
    const entry = parseSaved(value[provider]);
    if (entry) saved[provider] = entry;
  }
  return saved;
};

/** Keep a test's answer, with when it ran and on which T3 provider and model. Returns it as the screen shows it. */
export const saveSourceTest = (profileDir: string, result: ProviderStatus, runner: SourceTestRunner, now: Date = new Date()): ProviderStatus => {
  const all = readAll(profileDir);
  const at = now.toISOString();
  all[result.provider] = { state: result.state, detail: result.detail, at, runner: { instance: runner.instance, model: runner.model } };
  writeFileAtomic(join(profileDir, SOURCE_TESTS_FILE), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  return { provider: result.provider, state: result.state, detail: result.detail, testedAt: at };
};

/**
 * Every source as the screen shows it: the last test's answer while it was on the same T3 provider and model and
 * less than a week ago, else untested.
 */
export const sourceStatuses = (profileDir: string, runner: SourceTestRunner, now: Date = new Date()): ProviderStatus[] => {
  const saved = readAll(profileDir);
  return PROVIDER_IDS.map((provider) => {
    const entry = saved[provider];
    const age = entry ? now.getTime() - Date.parse(entry.at) : Number.NaN;
    const current = entry && entry.runner.instance === runner.instance && entry.runner.model === runner.model && age >= 0 && age < SOURCE_TEST_TTL_MS;
    return current
      ? { provider, state: entry.state, detail: entry.detail, testedAt: entry.at }
      : { provider, state: 'untested' as const, detail: PROVIDERS[provider].plan };
  });
};
