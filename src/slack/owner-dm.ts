/**
 * The owner's own DM with the Slack bot, where a copy of an approval from another chat may go (`src/chat/mirrors.ts`).
 * Slack won't say whose a DM is without `im:read`, which the app doesn't ask for, so Serra learns it from a message the
 * owner wrote there, and keeps it with the owner's ID it was learned for: a profile whose owner changes has none until
 * the new owner writes to the bot. Never a guess: no message from the owner in a DM, no copies on Slack.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../lib/guards.ts';

export const SLACK_OWNER_DM_FILE = 'slack-owner-dm.json';

/** The DM saved for `owner`, or null when none is (or it was learned for someone else). */
export const readOwnerDm = (profileDir: string, owner: string): string | null => {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(profileDir, SLACK_OWNER_DM_FILE), 'utf8'));
    return isRecord(saved) && saved.owner === owner && typeof saved.conversation === 'string' && /^D[A-Z0-9]+$/.test(saved.conversation) ? saved.conversation : null;
  } catch { return null; }
};

/** Saves `conversation` as `owner`'s DM, readable by the profile's user only. Best effort: it is learned again next time. */
export const writeOwnerDm = (profileDir: string, owner: string, conversation: string): void => {
  const path = join(profileDir, SLACK_OWNER_DM_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ owner, conversation })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch { rmSync(temp, { force: true }); }
};
