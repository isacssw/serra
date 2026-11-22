// Setup (APP-27, SERRA-51), on the setup service in `src/setup.ts`. Handlers check input, call the service and
// return plain data. `detect` summarises the profile in use and any others found, so the window can resume a setup
// made by the CLI or an older app instead of starting over. Tokens are set through the `secrets` namespace (APP-15), so no value passes through here; the
// owner check resolves the bot token in this process and only Slack's answer, scrubbed, goes back to the window.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { defaultProfileRoot } from '../../../src/config.ts';
import { findNode } from '../../../src/releases.ts';
import { scrub } from '../../../src/secrets.ts';
import { readProfileFile } from '../../../src/config.ts';
import type { SecretName } from '../../../src/contracts.ts';
import { secretStatus, type SecretOptions } from '../../../src/secrets.ts';
import {
  certainPresence, confirmOwner, createSetupProfile, detectGithubLogin, detectProject, installService, recordServiceAnswered, setupProgress, slackManifest,
  summarizeProfile, type InstallOptions, type MemberLookup, type ProfileDraft, type SetupProgress,
} from '../../../src/setup.ts';
import { run } from '../../../src/t3.ts';
import type { Handlers, SetupDetection } from '../bridge.ts';
import { profilesUnder } from '../profile-location.ts';
import { mergePrefs } from '../prefs.ts';
import type { HandlerContext } from './context.ts';

export interface SetupDeps {
  /** Where new profiles go by default (tests: a temp folder). */
  root?: string;
  /** Finds the real Node binary for launchd (tests: a fake). */
  findNode?: (profileDir: string) => Promise<string>;
  /** Extra install options (tests: fake launchd driver, fake Slack check, no `pnpm install`). */
  install?: Omit<InstallOptions, 'node' | 'log'>;
  /** Slack's member lookup for the owner check (tests: a fake). */
  lookup?: MemberLookup;
  /** GitHub login detection (tests: a fake, so they don't run `gh`). */
  githubLogin?: () => Promise<string>;
  /** The name in the owner's Git config (tests: a fake). */
  gitName?: () => Promise<string>;
  /** Keychain tools for token presence (tests: a fake `security`). */
  secrets?: SecretOptions;
  /** Where launchd plists live (tests: a temp folder). */
  launchAgentsDir?: string;
  /** How long token presence is reused between progress reads (default 3 s; tests: 0). */
  presenceCacheMs?: number;
  /** How long to give a daemon that has a socket to answer, right after launch (default 1.5 s; tests: 0). */
  answerWaitMs?: number;
  /** Where log lines go besides the window (default: the main process's console). */
  echo?: (line: string) => void;
}

const DRAFT_FIELDS = [
  'botName', 'botId', 'ownerName', 'ownerSlackUserId', 'githubLogin', 'projectPath', 'remote', 'baseRef', 'githubRepo', 't3Bin', 'directory',
] as const satisfies readonly (keyof ProfileDraft)[];

/** Copies only the known text fields, so nothing else from the window reaches the service. */
const parseDraft = (value: unknown): ProfileDraft => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The setup form must be an object.');
  const draft: Record<string, string> = {};
  for (const field of DRAFT_FIELDS) {
    const item = (value as Record<string, unknown>)[field];
    if (item === undefined || item === null) continue;
    if (typeof item !== 'string') throw new Error(`${field} must be text.`);
    draft[field] = item;
  }
  return draft as unknown as ProfileDraft;
};

/** Puts the Node binary's folder first on PATH, as the service plist does, so `pnpm` beside it is found from Finder. */
const nodeOnPath = (node: string): void => {
  const folder = dirname(node);
  const path = process.env.PATH ?? '';
  if (!path.split(delimiter).includes(folder)) process.env.PATH = path ? `${folder}${delimiter}${path}` : folder;
};

export const setupHandlers = (context: HandlerContext, deps: SetupDeps = {}): Handlers<'setup'> => {
  const root = deps.root ?? defaultProfileRoot;
  const find = deps.findNode ?? ((profileDir: string) => findNode(profileDir));
  const echo = deps.echo ?? ((line: string) => console.log(`[serra] ${line}`));
  let installing = false;

  const line = (text: string): void => {
    for (const part of scrub(text).split('\n')) {
      echo(part);
      context.push?.('releaseLog', part);
    }
  };

  const lookup = deps.launchAgentsDir ? { launchAgentsDir: deps.launchAgentsDir } : {};

  /**
   * Whether the profile's bot answers on its status socket. Right after launch the app may not have heard from it
   * yet, so with a socket present it waits a moment for the first answer instead of calling a running bot stopped.
   */
  const running = async (): Promise<boolean> => {
    // Running means what the install step waits for: the daemon answers and is connected to Slack.
    const live = (status: ReturnType<typeof context.status.current>): boolean => status.state === 'up' && status.slackConnected;
    const now = context.status.current();
    if (live(now)) return true;
    // Up but not connected to Slack is a known answer, not a daemon still starting: no need to wait.
    if (now.state === 'up') return false;
    const directory = context.profileDirOrNull();
    if (!directory || !existsSync(join(directory, 'status.sock'))) return false;
    return new Promise((done) => {
      let off: () => void = () => {};
      const timer = setTimeout(() => { off(); done(live(context.status.current())); }, deps.answerWaitMs ?? 1_500);
      off = context.status.subscribe({ status: (status) => { if (live(status)) { clearTimeout(timer); off(); done(true); } }, event: () => {} });
    });
  };

  /**
   * Which tokens are still where their source says, cached for a few seconds: progress is read on every window focus
   * and status change, and each read would run `security` once per token.
   */
  let cached: { key: string; at: number; present: Partial<Record<SecretName, boolean>> | undefined } | null = null;
  /** Saving or checking a token rewrites secrets.json (or .env), so the cache follows those files' change times. */
  const stamp = (file: string): number => { try { return statSync(file).mtimeMs; } catch { return 0; } };
  const presence = async (directory: string): Promise<Partial<Record<SecretName, boolean>> | undefined> => {
    const key = `${directory}:${stamp(join(directory, 'secrets.json'))}:${stamp(join(directory, '.env'))}`;
    if (cached && cached.key === key && Date.now() - cached.at < (deps.presenceCacheMs ?? 3_000)) return cached.present;
    let present: Partial<Record<SecretName, boolean>> | undefined;
    try { present = certainPresence(await secretStatus(directory, deps.secrets)); } catch { /* the files' view stands */ }
    cached = { key, at: Date.now(), present };
    return present;
  };

  /**
   * Setup's progress for the profile in use. Keychain items are checked for presence once Slack would count as done
   * (a deleted item isn't connected), and the bot's first answer after an install is recorded, so a bot stopped later
   * doesn't reopen setup. The wait for a daemon to answer only happens until that first answer.
   */
  const progress = async (): Promise<SetupProgress> => {
    const directory = context.profileDirOrNull();
    if (!directory) return setupProgress(null, lookup);
    let present: Partial<Record<SecretName, boolean>> | undefined;
    if (setupProgress(directory, { ...lookup, running: false }).steps.find((step) => step.id === 'slack')?.done) {
      present = await presence(directory);
    }
    const base = { ...lookup, ...(present ? { present } : {}) };
    const stopped = setupProgress(directory, { ...base, running: false });
    const serviceDone = stopped.steps.find((step) => step.id === 'service')?.done === true;
    // Done from the daemon's ready.json alone (a bot set up before answers were recorded): record it now, since a
    // restart clears that file and setup would otherwise reopen. recordServiceAnswered writes only once.
    if (serviceDone && stopped.installed) recordServiceAnswered(directory);
    if (serviceDone || !stopped.installed || !(await running())) return stopped;
    recordServiceAnswered(directory);
    return setupProgress(directory, { ...base, running: true });
  };

  const detect = async (): Promise<SetupDetection> => {
    const current = context.profileDirOrNull();
    const selectedDir = current ? resolve(current) : null;
    // Only the profile in use has a status socket the app follows, so only it can be called running.
    const up = selectedDir ? await running() : false;
    if (up && selectedDir && setupProgress(selectedDir, lookup).installed) recordServiceAnswered(selectedDir);
    const options = { ...lookup, ...(deps.secrets ? { secrets: deps.secrets } : {}) };
    const others = profilesUnder(root).map((dir) => resolve(dir)).filter((dir) => dir !== selectedDir);
    return {
      selected: selectedDir ? await summarizeProfile(selectedDir, {
        ...options, running: up, disconnected: !up && context.status.current().state === 'up',
      }) : null,
      others: await Promise.all(others.map((dir) => summarizeProfile(dir, options))),
      pinned: context.profilePinned === true,
      profileRoot: root,
      home: homedir(),
    };
  };

  return {
    progress,

    detect,

    useProfile: async (directory) => {
      if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Choose a profile folder.');
      const target = resolve(directory);
      if (!existsSync(join(target, 'profile.json'))) throw new Error(`${target} has no profile.json. Choose the folder that holds it.`);
      readProfileFile(target); // Throws a clear message for an invalid profile.
      const current = context.profileDirOrNull();
      if (context.profilePinned && current && resolve(current) !== target) {
        throw new Error('Serra was started with a profile given on the command line, so it can’t switch here. Quit and open it without --profile.');
      }
      context.prefs.set(mergePrefs(context.prefs.get(), { profileDir: target }));
      return detect();
    },

    chooseFolder: async (purpose) => {
      if (purpose !== 'repository' && purpose !== 'profile') throw new Error('Unknown folder purpose.');
      if (!context.chooseFolder) return null;
      return context.chooseFolder(purpose === 'repository'
        ? { title: 'Choose the repository', buttonLabel: 'Use this repository', defaultPath: homedir() }
        : { title: 'Choose a Serra profile folder', buttonLabel: 'Use this profile', defaultPath: root });
    },

    defaults: async () => {
      const [githubLogin, ownerName] = await Promise.all([
        (deps.githubLogin ?? detectGithubLogin)(),
        (deps.gitName ?? (() => run('git', ['config', '--global', 'user.name'], { timeoutMs: 5_000 }).then((v) => v.trim())))().catch(() => ''),
      ]);
      return { githubLogin, ownerName, profileRoot: root };
    },

    detectProject: (path, remote) => {
      if (typeof path !== 'string') throw new Error('The repository path must be text.');
      if (remote !== undefined && typeof remote !== 'string') throw new Error('The remote must be text.');
      return detectProject(path.trim(), remote?.trim() || 'origin');
    },

    create: async (value) => {
      const directory = await createSetupProfile(parseDraft(value), { root });
      // Remember the new profile so the app (and its next launch from Finder) manages it.
      context.prefs.set(mergePrefs(context.prefs.get(), { profileDir: directory, setupDraft: null }));
      const current = context.profileDirOrNull();
      if (!current || resolve(current) !== directory) {
        throw new Error(`Profile created at ${directory}, but the app was started with --profile ${current}. Quit and open Serra without --profile to finish setting it up.`);
      }
      return setupProgress(directory, { ...lookup, running: false });
    },

    manifest: () => slackManifest(context.profileDir()),

    confirmOwner: (slackUserId) => {
      if (typeof slackUserId !== 'string') throw new Error('The member ID must be text.');
      return confirmOwner(context.profileDir(), slackUserId, deps.lookup ? { lookup: deps.lookup } : {});
    },

    installService: async () => {
      if (context.runtime.platform !== 'darwin') throw new Error('The background service uses launchd, so it installs on macOS only.');
      const profileDir = context.profileDir();
      if (installing) throw new Error('The service is already being installed. Wait for it to finish.');
      installing = true;
      try {
        line('Looking for Node');
        const node = await find(profileDir);
        line(`Using ${node}`);
        nodeOnPath(node);
        const outcome = await installService(profileDir, { ...deps.install, node, log: line });
        line(outcome.ok ? `Installed and started ${outcome.release}` : `Not installed: ${outcome.error}`);
        return outcome;
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error));
        line(`Install failed: ${message}`);
        throw new Error(message);
      } finally { installing = false; }
    },
  };
};
