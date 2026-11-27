// "Both hold, not a conflict": pairs of rules the owner said are fine together. Kept in the profile, beside the weekly
// review's settings, never in a knowledge page: saying two rules both hold changes nothing the bot reads. A pair is
// known by `pairId` (both pages and both lines), so it comes back on its own once either line is edited.
import { join } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { isRecord, isRecordOf, isString, isTime, readJsonOrNull } from './lib/guards.ts';

interface Dismissal { at: string; lines: [string, string] }
interface DismissalFile { pairs: Record<string, Dismissal> }

const file = (profileDir: string): string => join(profileDir, 'knowledge-dismissed.json');
const isDismissal = (value: unknown): value is Dismissal => isRecord(value) && isTime(value.at)
  && Array.isArray(value.lines) && value.lines.length === 2 && value.lines.every(isString);
const isFile = (value: unknown): value is DismissalFile => isRecord(value) && isRecordOf(isDismissal)(value.pairs);

const read = (profileDir: string): DismissalFile => readJsonOrNull(file(profileDir), isFile) ?? { pairs: {} };
const write = (profileDir: string, data: DismissalFile): void => {
  writeFileAtomic(file(profileDir), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
};

/** The pairs the owner said both hold, by id. A missing or damaged file is none: every pair shows again. */
export const dismissedPairs = (profileDir: string): Set<string> => new Set(Object.keys(read(profileDir).pairs));

/** Remember that both rules of a pair hold. `lines` are kept only so a person reading the file can tell which pair. */
export const dismissPair = (profileDir: string, id: string, lines: [string, string], now = new Date()): void => {
  const data = read(profileDir);
  write(profileDir, { pairs: { ...data.pairs, [id]: { at: now.toISOString(), lines } } });
};

/** Undo "Both hold": the pair is listed again. */
export const restorePair = (profileDir: string, id: string): void => {
  const data = read(profileDir);
  if (!(id in data.pairs)) return;
  const { [id]: _gone, ...rest } = data.pairs;
  write(profileDir, { pairs: rest });
};
