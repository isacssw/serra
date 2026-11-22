/**
 * Type guards for JSON read from files and sockets. Every such read goes through a guard instead of an `as T` cast,
 * so a malformed or old-shape file is rejected where it is read, and never surfaces as a TypeError deep in a caller.
 *
 * Guards check what the code relies on; they never change the stored format. Extra fields are allowed, so a newer
 * writer's file still reads.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Narrows `value` to `T` or rejects it. */
export type Guard<T> = (value: unknown) => value is T;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/** A finite number: JSON can't hold NaN or Infinity, but a caller's arithmetic shouldn't have to wonder. */
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A string `Date.parse` reads as a time. */
export const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

export const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** `undefined` (the key is absent) or a value the guard accepts. */
export const isOptional = <T>(guard: Guard<T>): Guard<T | undefined> =>
  (value: unknown): value is T | undefined => value === undefined || guard(value);

export const isArrayOf = <T>(guard: Guard<T>): Guard<T[]> =>
  (value: unknown): value is T[] => Array.isArray(value) && value.every(guard);

/** One of a fixed set of literals. */
export const isOneOf = <const T extends readonly (string | number | boolean | null)[]>(...values: T): Guard<T[number]> =>
  (value: unknown): value is T[number] => (values as readonly unknown[]).includes(value);

/** A record whose every value passes `guard` (the keys are any strings). */
export const isRecordOf = <T>(guard: Guard<T>): Guard<Record<string, T>> =>
  (value: unknown): value is Record<string, T> => isRecord(value) && Object.values(value).every(guard);

/** `JSON.parse` that returns `undefined` for text that isn't JSON, instead of throwing. */
export const parseJson = (text: string): unknown => {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
};

/** A JSON file read through a guard: not there, there but not the expected shape (or not JSON), or the value. */
export type JsonFile<T> = { state: 'absent' } | { state: 'invalid' } | { state: 'ok'; value: T };

/**
 * Reads `path` as JSON and checks it with `guard`. A missing file is `absent`; a file that isn't JSON, can't be read,
 * or fails the guard is `invalid`. Never throws.
 */
export const readJsonFile = <T>(path: string, guard: Guard<T>): JsonFile<T> => {
  if (!existsSync(path)) return { state: 'absent' };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { state: 'invalid' }; }
  const value = parseJson(text);
  return guard(value) ? { state: 'ok', value } : { state: 'invalid' };
};

/** `readJsonFile` for readers that treat a broken file like a missing one: the value, or null. */
export const readJsonOrNull = <T>(path: string, guard: Guard<T>): T | null => {
  const file = readJsonFile(path, guard);
  return file.state === 'ok' ? file.value : null;
};
