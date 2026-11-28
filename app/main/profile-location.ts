// Where the app finds the bot profile (APP-17). A packaged app opened from Finder gets no `--profile` and no
// `BOT_PROFILE`, so it falls back to the folder it was given before, then to the only profile `pnpm run setup` made.
// The profile folders themselves are found by the core (`profilesUnder` in src/profiles.ts).
import { isAbsolute, resolve } from 'node:path';

export interface ProfileSources {
  /** `--profile` or `BOT_PROFILE`, when given. */
  argument?: string;
  /** The folder saved in app prefs. */
  saved: string | null;
  /** Profile folders found in the default location. Only used when there is exactly one. */
  discovered: readonly string[];
}

/** The profile the app starts with: the argument, then the saved folder, then the only discovered profile. */
export const startupProfile = ({ argument, saved, discovered }: ProfileSources): string | null => {
  if (argument) return resolve(argument);
  if (saved) return saved;
  return discovered.length === 1 ? discovered[0] ?? null : null;
};

/** The folder to save in prefs so the next launch from Finder finds the same profile, or null to leave prefs as they are. */
export const profileToRemember = (startup: string | null, saved: string | null): string | null =>
  startup && isAbsolute(startup) && startup !== saved ? startup : null;
