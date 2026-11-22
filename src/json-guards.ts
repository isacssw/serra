// Narrowing untrusted JSON (files Serra reads back, a CLI's stream, a model's answer) without type assertions.
// Pure: no Node imports.

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `JSON.parse`, or undefined when the text isn't JSON. */
export const parseJson = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return undefined; }
};

/** The value when it's a string, else undefined. */
export const stringField = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A Node system error's `code` (`EEXIST`, `ESRCH`), or undefined. */
export const errorCode = (error: unknown): string | undefined => (isRecord(error) ? stringField(error.code) : undefined);
