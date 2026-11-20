/**
 * Owner actions on `profile.json`: who may use the bot, and one setter per top-level section.
 *
 * Every change reads the file, applies the edit to a copy, then saves it through `writeProfileFile`, which runs
 * `validateProfile` before an atomic write. An invalid edit throws and leaves the file exactly as it was.
 * The CLI (`pnpm bot people`, `pnpm bot settings`) and the app's IPC handlers call these and nothing else.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type AtomicWriteIo, type Profile, PROFILE_FILE, validateProfile, writeProfileFile } from './config.ts';
import type { AppliesWhen, ProfileSection } from './contracts.ts';

/** When a change to each section takes effect, and anything else the owner should know before saving. */
export interface SectionSetting {
  appliesWhen: AppliesWhen;
  /** Required sections can't be removed. */
  required: boolean;
  note?: string;
}

/**
 * When each section of `profile.json` takes effect. The daemon reads the profile once at start, so everything is
 * `after restart` except `allowedUsers` and `messageTriggers`, which the daemon reloads live when the file changes
 * (`src/profile-reload.ts`). Marking another section `now` doesn't compile until that file says how to apply it.
 * `satisfies` makes the compiler reject a new `Profile` field until it has an entry here.
 */
export const PROFILE_SETTINGS = {
  bot: { appliesWhen: 'after restart', required: true, note: 'The bot id also names the background service and job branches. Prepare a new release after changing it.' },
  owner: { appliesWhen: 'after restart', required: true },
  project: { appliesWhen: 'after restart', required: true },
  allowedUsers: { appliesWhen: 'now', required: true },
  messageTriggers: { appliesWhen: 'now', required: false },
  review: { appliesWhen: 'after restart', required: false },
  repositories: { appliesWhen: 'after restart', required: false },
  worker: { appliesWhen: 'after restart', required: false },
  serviceLabel: { appliesWhen: 'after restart', required: false, note: 'Prepare a new release after changing it: activation refuses a release made for another label.' },
  t3Bin: { appliesWhen: 'after restart', required: false },
  branchPattern: { appliesWhen: 'after restart', required: false },
  // Read by Updates and Prepare each time they run; the daemon doesn't use it.
  updates: { appliesWhen: 'now', required: false },
} as const satisfies Record<ProfileSection, SectionSetting>;

export const PROFILE_SECTIONS = Object.keys(PROFILE_SETTINGS) as ProfileSection[];

export const isProfileSection = (name: string): name is ProfileSection => Object.hasOwn(PROFILE_SETTINGS, name);

export interface WriteOptions { io?: AtomicWriteIo }

/** The result of every change: the saved profile, whether the file changed, and when the change takes effect. */
export interface SettingChange {
  profile: Profile;
  changed: boolean;
  appliesWhen: AppliesWhen;
}

/**
 * Parse `profile.json` without validating it, so a section setter can repair a broken section. The result of
 * every edit is validated as a whole before it is written.
 */
const readRaw = (profileDir: string): Record<string, unknown> => {
  const path = join(resolve(profileDir), PROFILE_FILE);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return value as Record<string, unknown>;
};

const SLACK_MEMBER_ID = /^[UW][A-Z0-9]+$/;

const memberId = (value: string): string => {
  const id = value.trim();
  if (!SLACK_MEMBER_ID.test(id)) throw new Error(`Not a Slack member ID: ${value}. Member IDs look like U0123456789.`);
  return id;
};

// ---------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------

export interface Person {
  slackUserId: string;
  access: 'owner' | 'allowed';
  /** Only the owner's name is in the profile. Other names come from Slack, which this service doesn't call. */
  name?: string;
}

/** The owner first, then allowed people in file order. The owner is always allowed, listed or not. */
export const listPeople = (profileDir: string): Person[] => {
  const profile = validateProfile(readRaw(profileDir));
  const owner = profile.owner.slackUserId;
  return [
    { slackUserId: owner, access: 'owner', name: profile.owner.name },
    ...[...new Set(profile.allowedUsers)].filter((id) => id !== owner).map((id): Person => ({ slackUserId: id, access: 'allowed' })),
  ];
};

/** Allow a Slack member to use the bot. Adding someone already allowed (or the owner) changes nothing. */
export const addAllowedUser = (profileDir: string, slackUserId: string, options: WriteOptions = {}): SettingChange => {
  const id = memberId(slackUserId);
  const profile = validateProfile(readRaw(profileDir));
  const appliesWhen = PROFILE_SETTINGS.allowedUsers.appliesWhen;
  if (id === profile.owner.slackUserId || profile.allowedUsers.includes(id)) return { profile, changed: false, appliesWhen };
  return { profile: writeProfileFile(profileDir, { ...profile, allowedUsers: [...profile.allowedUsers, id] }, options), changed: true, appliesWhen };
};

/** Stop allowing a Slack member. The owner can't be removed. Removing someone not listed changes nothing. */
export const removeAllowedUser = (profileDir: string, slackUserId: string, options: WriteOptions = {}): SettingChange => {
  const id = memberId(slackUserId);
  const profile = validateProfile(readRaw(profileDir));
  if (id === profile.owner.slackUserId) throw new Error('The owner always has access and cannot be removed. Change the owner in the owner section instead.');
  const appliesWhen = PROFILE_SETTINGS.allowedUsers.appliesWhen;
  if (!profile.allowedUsers.includes(id)) return { profile, changed: false, appliesWhen };
  return { profile: writeProfileFile(profileDir, { ...profile, allowedUsers: profile.allowedUsers.filter((user) => user !== id) }, options), changed: true, appliesWhen };
};

// ---------------------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------------------

export interface SectionView extends SectionSetting {
  section: ProfileSection;
  /** The section's value today, or undefined when an optional section is not set. */
  value: unknown;
}

/** Every editable section with its current value and when a change applies, in display order. */
export const readProfileSettings = (profileDir: string): SectionView[] => {
  const profile = validateProfile(readRaw(profileDir)) as unknown as Record<string, unknown>;
  return PROFILE_SECTIONS.map((section) => ({ section, ...PROFILE_SETTINGS[section], value: profile[section] }));
};

/**
 * Replace one top-level section of `profile.json`. `undefined` removes an optional section. The whole profile is
 * validated before the write, so an invalid value throws and the file stays as it was. Works on a profile whose
 * other sections are valid but whose target section is broken, so the owner can repair it.
 */
export const updateProfileSection = <S extends ProfileSection>(
  profileDir: string, section: S, value: Profile[S] | undefined, options: WriteOptions = {},
): SettingChange => {
  if (!isProfileSection(section)) throw new Error(`Unknown profile section: ${String(section)}. Sections: ${PROFILE_SECTIONS.join(', ')}`);
  const setting: SectionSetting = PROFILE_SETTINGS[section];
  if (value === undefined && setting.required) throw new Error(`${section} is required and cannot be removed`);
  const current = readRaw(profileDir);
  const next = { ...current };
  if (value === undefined) delete next[section];
  else next[section] = value;
  // Compare against a valid current file only: rewriting an invalid file with itself still fails validation below.
  if (JSON.stringify(next) === JSON.stringify(current)) {
    try { return { profile: validateProfile(current), changed: false, appliesWhen: setting.appliesWhen }; } catch { /* fall through and report */ }
  }
  return { profile: writeProfileFile(profileDir, next, options), changed: true, appliesWhen: setting.appliesWhen };
};

/** How a change reads in the CLI and the app: "Applies now", "Applies on the next job", "Applies after a restart". */
export const appliesLabel = (when: AppliesWhen): string =>
  when === 'now' ? 'Applies now' : when === 'next job' ? 'Applies on the next job' : 'Applies after a restart';
