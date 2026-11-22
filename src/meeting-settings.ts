// Meeting capture's opt-in (SERRA-62): off until the owner turns it on in the app, which is where they acknowledge
// what is sent to the AI provider they use in T3 and what is kept. Stored in `meeting-capture.json` in the profile, read on every capture,
// so turning it off applies to the next message.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './config.ts';
import { isRecord, parseJson } from './json-guards.ts';

const MEETING_SETTINGS_FILE = 'meeting-capture.json';

/** What the owner acknowledges by turning capture on. A new version asks again. */
// 2: meeting runs moved from Claude Code to T3 (SERRA-69), so what is sent where changed.
const MEETING_NOTICE_VERSION = 2;
export const MEETING_NOTICE = [
  'Add only meetings you were in, recorded with everyone’s knowledge, that your team may hear about. Your teammates can see what you keep.',
  'The AI provider you use in T3 reads the transcript in a read-only T3 run, told to use no tools, after Serra redacts secrets. For a Granola or Meet link, a T3 run first reads it through that provider’s own connection with one read tool. These runs start in Serra’s own empty folder, never your repository. Serra never stores the transcript; T3 keeps those runs in its history like any thread. Serra keeps the decisions you approve, short quotes for review until you approve or discard them (up to 30 days), and a digest message in your DM.',
  'Until workers are isolated from the profile folder, Serra’s own workers could read those pending quotes on this Mac.',
  'Forget meeting removes all of these, except your upload in Slack, the T3 runs that read the meeting (delete them in T3), the provider’s copy, and app tasks that already read them.',
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
