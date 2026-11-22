// Meeting capture's opt-in (SERRA-62): off until the owner turns it on in the app, which is where they acknowledge
// what is sent to Claude and what is kept. Stored in `meeting-capture.json` in the profile, read on every capture,
// so turning it off applies to the next message.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { isRecord, parseJson } from './json-guards.ts';

const MEETING_SETTINGS_FILE = 'meeting-capture.json';

/** What the owner acknowledges by turning capture on. A new version asks again. */
const MEETING_NOTICE_VERSION = 1;
export const MEETING_NOTICE = [
  'Add only meetings you were in, recorded with everyone’s knowledge, that your team may hear about. Your teammates can see what you keep.',
  'Claude reads the transcript once, with no tools, after Serra redacts secrets. For a Granola or Meet link, Claude Code first fetches it through your own connection with one read tool, and stops before any model sees it. Serra never stores the transcript. It keeps the decisions you approve, short quotes for review until you approve or discard them (up to 30 days), and a digest message in your DM.',
  'Until workers are isolated from the profile folder, Serra’s own workers could read those pending quotes on this Mac.',
  'Forget meeting removes all of these, except your upload in Slack, the copy Claude processed, and app tasks that already read them.',
].join('\n\n');

export interface MeetingSettings {
  enabled: boolean;
  /** When the owner acknowledged the notice, and which version. */
  acknowledged: { at: string; version: number } | null;
}

export const readMeetingSettings = (profileDir: string): MeetingSettings => {
  let text: string;
  try { text = readFileSync(join(profileDir, MEETING_SETTINGS_FILE), 'utf8'); } catch { return { enabled: false, acknowledged: null }; }
  const value = parseJson(text);
  if (!isRecord(value)) return { enabled: false, acknowledged: null };
  const ack = value.acknowledged;
  const acknowledged = isRecord(ack) && typeof ack.at === 'string' && typeof ack.version === 'number' ? { at: ack.at, version: ack.version } : null;
  // On only with the current notice acknowledged: a changed notice turns capture off until the owner reads it.
  return { enabled: value.enabled === true && acknowledged?.version === MEETING_NOTICE_VERSION, acknowledged };
};

/** Turn capture on (acknowledging the notice now) or off. */
export const writeMeetingSettings = (profileDir: string, enabled: boolean, now: Date = new Date()): MeetingSettings => {
  const current = existsSync(join(profileDir, MEETING_SETTINGS_FILE)) ? readMeetingSettings(profileDir) : { enabled: false, acknowledged: null };
  const next: MeetingSettings = { enabled, acknowledged: enabled ? { at: now.toISOString(), version: MEETING_NOTICE_VERSION } : current.acknowledged };
  writeFileAtomic(join(profileDir, MEETING_SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
};
