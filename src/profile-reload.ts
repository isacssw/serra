/**
 * Live reload of the `profile.json` sections marked `appliesWhen: 'now'` in `PROFILE_SETTINGS`.
 *
 * The daemon reads the profile once at start. Afterwards it watches the profile folder, and when `profile.json`
 * changes it validates the whole file again and swaps the live sections into the running `Config`. Everything else
 * keeps "after restart": a changed section is reported, never applied. An invalid file is reported once and ignored,
 * so the running config stays in force until the file is valid again.
 *
 * The app uses the same watching for `knowledge/proposals/` (`watchProposals`, APP-26), so a proposal a worker or the
 * knowledge interview writes shows in the Proposals queue without a restart.
 */
import { type FSWatcher, readFileSync, watch } from 'node:fs';
import { join, sep } from 'node:path';
import { type Config, type Profile, PROFILE_FILE, validateProfile } from './config.ts';
import { AGENT_BACKEND_FILE } from './agent/acp-agents.ts';
import type { ProfileSection } from './contracts.ts';
import { PROPOSALS_DIR } from './knowledge-rules.ts';
import { PROFILE_SECTIONS, PROFILE_SETTINGS } from './profile-settings.ts';

type Settings = typeof PROFILE_SETTINGS;

/** The sections the daemon applies without a restart: exactly those whose `appliesWhen` is `now`. */
type LiveSection = { [S in keyof Settings]: Settings[S]['appliesWhen'] extends 'now' ? S : never }[keyof Settings];

/**
 * How each live section reaches the running config. Keyed by `LiveSection`, so marking another section `now` in
 * `PROFILE_SETTINGS` doesn't compile until it says how it is applied here.
 */
const APPLY: { [S in LiveSection]: (config: Config, profile: Profile) => void } = {
  // The owner is always allowed. A changed owner applies after restart, so this keeps the running one.
  allowedUsers: (config, profile) => { config.allowed = new Set([config.owner, ...profile.allowedUsers]); },
  messageTriggers: (config, profile) => { config.messageTriggers = profile.messageTriggers ?? []; },
  // Only Updates and Prepare read it, from the file each time: nothing in the running daemon to change.
  updates: () => {},
};

const LIVE_SECTIONS = Object.keys(APPLY) as LiveSection[];

const isLive = (section: ProfileSection): section is LiveSection => Object.hasOwn(APPLY, section);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What one look at `profile.json` did. */
export type ReloadResult =
  /** Nothing to report: the file is byte-for-byte what was last seen, missing for a moment, or changed nothing. */
  | { status: 'unchanged' }
  /** `applied` took effect now. `restartNeeded` lists sections that differ from what the daemon started with. */
  | { status: 'applied'; applied: LiveSection[]; restartNeeded: ProfileSection[] }
  /** The file can't be used. The running config is untouched. */
  | { status: 'invalid'; error: string };

/**
 * Make a reloader for a running `config`. Each call reads `profile.json` and applies what changed. The same file
 * contents are only looked at once, so an invalid edit is reported once however many times the folder changes.
 */
export const createProfileReloader = (config: Config): (() => ReloadResult) => {
  const path = join(config.profileDir, PROFILE_FILE);
  /** What the daemon started with. Sections that apply after restart are compared to this. */
  const started = config.profile;
  // Not read up front: the first call compares the file with the running config, so an edit made between
  // `loadConfig` and here is still picked up.
  let lastText: string | null = null;
  let lastRestartNeeded: ProfileSection[] = [];
  let lastInvalid = false;

  return () => {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch (error) {
      // Editors and atomic writers can leave a moment with no file. The next change event reads the new one.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unchanged' };
      throw error;
    }
    if (text === lastText) return { status: 'unchanged' };
    lastText = text;

    let profile: Profile;
    try { profile = validateProfile(JSON.parse(text)); } catch (error) {
      lastInvalid = true;
      return { status: 'invalid', error: error instanceof Error ? error.message : String(error) };
    }
    const running = config.profile as unknown as Record<string, unknown>;
    const next = profile as unknown as Record<string, unknown>;
    const applied = LIVE_SECTIONS.filter((section) => !same(running[section], next[section]));
    for (const section of applied) APPLY[section](config, profile);
    // The config's profile shows what is in force: the live sections as reloaded, the rest as started.
    if (applied.length) config.profile = { ...config.profile, ...Object.fromEntries(applied.map((section) => [section, profile[section]])) };

    const startedFields = started as unknown as Record<string, unknown>;
    const restartNeeded = PROFILE_SECTIONS.filter((section) => !isLive(section) && !same(startedFields[section], next[section]));
    const recovered = lastInvalid;
    lastInvalid = false;
    if (!applied.length && !recovered && same(restartNeeded, lastRestartNeeded)) return { status: 'unchanged' };
    lastRestartNeeded = restartNeeded;
    return { status: 'applied', applied, restartNeeded };
  };
};

export interface ProfileWatcher { close: () => void }

interface WatchOptions { debounceMs?: number; onError?: (error: Error) => void }

/**
 * Call `onChange` shortly after a file in `dir` that `matches` changes. Bursts of events within `debounceMs` become
 * one call. Some platforms don't name the file, so `matches` gets null and should then say yes. A watcher that fails
 * reports through `onError` and stops.
 */
const watchFolder = (dir: string, matches: (filename: string | null) => boolean, onChange: () => void,
  { debounceMs = 100, onError = () => {}, recursive = false }: WatchOptions & { recursive?: boolean }): ProfileWatcher => {
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher;
  const fire = (): void => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
    timer.unref();
  };
  try {
    watcher = watch(dir, { persistent: false, ...(recursive ? { recursive } : {}) }, (_event, filename) => {
      if (matches(filename === null ? null : filename.split(sep).join('/'))) fire();
    });
  } catch (error) {
    onError(error as Error);
    return { close: () => {} };
  }
  watcher.on('error', (error) => { clearTimeout(timer); watcher.close(); onError(error); });
  return { close: () => { clearTimeout(timer); watcher.close(); } };
};

/**
 * Call `onChange` shortly after `profile.json` in `profileDir` changes. The folder is watched rather than the file,
 * because an atomic write replaces the file with a new one. Bursts of events within `debounceMs` become one call.
 * A watcher that fails reports through `onError` and stops: the daemon keeps running on the config it has.
 */
export const watchProfile = (profileDir: string, onChange: () => void, options: WatchOptions = {}): ProfileWatcher =>
  watchFolder(profileDir, (filename) => filename === null || filename === PROFILE_FILE, onChange, options);

/**
 * Call `onChange` shortly after anything under `knowledgeDir/proposals/` is added, changed or removed (APP-26): a
 * worker or the knowledge interview wrote a proposal, so the app's Proposals queue rereads its list. `knowledge/` is
 * watched, recursively, so a `proposals/` folder created later is still seen.
 */
export const watchProposals = (knowledgeDir: string, onChange: () => void, options: WatchOptions = {}): ProfileWatcher =>
  watchFolder(knowledgeDir, (filename) => filename === null || filename === PROPOSALS_DIR || filename.startsWith(`${PROPOSALS_DIR}/`),
    onChange, { ...options, recursive: true });

/**
 * Call `onChange` shortly after `agent-backend.json` in `profileDir` is added, edited or removed, so the app's
 * Agent backend card picks up hand-edited custom agents live without a restart.
 */
export const watchAgentBackend = (profileDir: string, onChange: () => void, options: WatchOptions = {}): ProfileWatcher =>
  watchFolder(profileDir, (filename) => filename === null || filename === AGENT_BACKEND_FILE, onChange, options);
