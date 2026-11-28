// The app's list of profiles (SB-10): `profiles.json` in the profiles folder keeps their order (⌘1…⌘9) and each one's
// colour. The folders stay the source of truth: a folder with no entry is listed after the others, and an entry with
// no folder is left out of the list but kept in the file. Entries are refs, `local/<folder>`, so a profile on a
// server can join later without renaming anything. Pure: `profiles.ts` reads and writes the file.

/** `profiles.json`. Nothing in it is needed: without the file, profiles are listed by folder name. */
export interface ProfilesFile {
  version: 1;
  /** Refs in the owner's order. */
  order: string[];
  /** Each ref's look. Only what the owner picked is kept. */
  look: Record<string, { color: string }>;
}

export const PROFILES_FILE = 'profiles.json';

export const emptyProfilesFile = (): ProfilesFile => ({ version: 1, order: [], look: {} });

/** A profile folder on this Mac, by its folder name. */
export const localRef = (folder: string): string => `local/${folder}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const REF = /^[\w.-]{1,64}\/[^/\0]{1,128}$/;
const isRef = (value: unknown): value is string => typeof value === 'string' && REF.test(value);
export const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** Reads the file leniently: anything that doesn't read right is left out, so a hand edit never stops the app. */
export const parseProfilesFile = (value: unknown): ProfilesFile => {
  const file = emptyProfilesFile();
  if (!isRecord(value)) return file;
  if (Array.isArray(value.order)) file.order = [...new Set(value.order.filter(isRef))];
  if (isRecord(value.look)) {
    for (const [ref, look] of Object.entries(value.look)) {
      if (isRef(ref) && isRecord(look) && isColor(look.color)) file.look[ref] = { color: look.color.toLowerCase() };
    }
  }
  return file;
};

/** The refs to list, in order: the file's order for the folders that exist, then new folders by name. */
export const arrange = (folders: readonly string[], file: ProfilesFile): string[] => {
  const present = new Set(folders.map(localRef));
  const known = file.order.filter((ref) => present.has(ref));
  const rest = [...folders].sort().map(localRef).filter((ref) => !known.includes(ref));
  return [...known, ...rest];
};

/**
 * The file with `listed` as the order of what is listed now. Entries the list doesn't show (a folder gone for now, a
 * server's profile) stay in the file, after them.
 */
export const withOrder = (file: ProfilesFile, listed: readonly string[]): ProfilesFile => ({
  ...file,
  order: [...listed, ...file.order.filter((ref) => !listed.includes(ref))],
});

/** Moves `ref` to `index` in the listed order. Out-of-range indexes clamp; an unknown ref changes nothing. */
export const moveRef = (listed: readonly string[], ref: string, index: number): string[] => {
  const from = listed.indexOf(ref);
  if (from < 0) return [...listed];
  const rest = listed.filter((entry) => entry !== ref);
  const to = Math.max(0, Math.min(rest.length, Math.trunc(index)));
  return [...rest.slice(0, to), ref, ...rest.slice(to)];
};

export const withColor = (file: ProfilesFile, ref: string, color: string): ProfilesFile => ({
  ...file, look: { ...file.look, [ref]: { color: color.toLowerCase() } },
});

/** The avatar colours, in the order profiles get them. No green, amber, red or mid-grey: those mean status. */
export const PROFILE_COLORS = ['#2b2b30', '#4b6a8a', '#4f55b8', '#7a5aa6', '#9a4f7c', '#2f7a9a', '#1f3a5f', '#7d6b7d'] as const;

/** The first colour no one in `taken` has; past eight profiles they repeat. */
const freeColor = (taken: ReadonlySet<string>, count = taken.size): string =>
  PROFILE_COLORS.find((color) => !taken.has(color)) ?? PROFILE_COLORS[count % PROFILE_COLORS.length]!;

/** Each listed ref's colour: the one kept in the file, else the first one free, in list order. */
export const resolveColors = (listed: readonly string[], file: ProfilesFile): Record<string, string> => {
  const taken = new Set(listed.flatMap((ref) => (file.look[ref] ? [file.look[ref].color] : [])));
  const colors: Record<string, string> = {};
  for (const ref of listed) {
    const kept = file.look[ref]?.color;
    const color = kept ?? freeColor(taken, Object.keys(colors).length);
    taken.add(color);
    colors[ref] = color;
  }
  return colors;
};

/**
 * The file with every listed profile's colour written in, done on each write: a colour picked by its place would
 * change when a profile before it is removed or moved, and a colour is how the owner tells profiles apart.
 */
export const withLooks = (file: ProfilesFile, listed: readonly string[]): ProfilesFile => {
  const colors = resolveColors(listed, file);
  return { ...file, look: { ...file.look, ...Object.fromEntries(Object.entries(colors).map(([ref, color]) => [ref, { color }])) } };
};

/** The file without `ref`: after a remove, the ⌘ numbers after it close up. */
export const withoutRef = (file: ProfilesFile, ref: string): ProfilesFile => {
  const { [ref]: _gone, ...look } = file.look;
  return { ...file, order: file.order.filter((entry) => entry !== ref), look };
};
