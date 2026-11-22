import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * A `.env` file's variables, or none when the file is missing. A leaf, so secrets.ts can read `.env` without
 * importing config.ts (which imports secrets.ts).
 */
export const readEnv = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) if (typeof value === 'string') env[key] = value;
  return env;
};
