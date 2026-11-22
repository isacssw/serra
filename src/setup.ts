/**
 * Creating a bot profile, for `pnpm run setup` (the CLI) and the app's first-run wizard (APP-27).
 *
 * The wizard's steps are owner actions here, each usable on its own and safe to repeat:
 * 1. `createSetupProfile`: the profile folder, seeded like `pnpm run setup` does.
 * 2. `slackManifest`: the Slack app manifest and a link that opens Slack's "create app" page with it filled in.
 * 3. Tokens go through the Secrets sources (`src/secrets.ts`: Keychain or 1Password), not through this file.
 * 4. `confirmOwner`: looks the owner up in Slack with the bot token, so a wrong member ID shows up before the bot runs.
 * 5. `installService`: prepares a release and activates it under launchd, with `diagnose()` as the preflight.
 * `setupProgress` reads which steps are done from the profile's files, without running `security`, `op` or Slack.
 *
 * No token value is returned or written to `setup.json`. Errors from Slack are scrubbed before they are thrown.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { codeRoot, defaultProfileRoot, loadConfig, profileArgument, readProfileFile, validateProfile, writeFileAtomic, type Profile } from './config.ts';
import { readEnv } from './lib/env.ts';
import type { DeployLog, DeployOptions, Prepared, PrepareOptions } from './deploy.ts';
import { diagnose, type DiagnoseOptions } from './doctor.ts';
import { isRecord, isString, parseJson, readJsonFile, readJsonOrNull } from './lib/guards.ts';
import { updateProfileSection } from './profile-settings.ts';
import { activateRelease, prepareNextRelease, type ActivationOutcome } from './releases.ts';
import type { SecretName, SecretStatus } from './contracts.ts';
import { isTokenVerdict } from './token-errors.ts';
import { readSecretsFile, scrub, SECRET_NAMES, secretStatus, slackWorkspace, sourceLabel, type SecretOptions } from './secrets.ts';
import { run } from './t3.ts';

/** How to start the knowledge interview (docs/knowledge-interview.md) for a profile. */
export const onboardingPrompt = (directory: string): string =>
  `Start the knowledge interview from the Serra app: Knowledge, Proposals, then Start interview. Without the app, run pnpm onboard --profile ${JSON.stringify(directory)} and paste what it prints into a new T3 thread in your project.`;

/** The Slack app manifest template that ships with Serra, named for this bot. */
const manifestFor = (profile: Pick<Profile, 'bot'>): Record<string, unknown> => {
  const path = join(codeRoot, 'templates/manifest.json');
  const template = parseJson(readFileSync(path, 'utf8'));
  if (!isRecord(template) || !isRecord(template.display_information) || !isRecord(template.features) || !isRecord(template.features.bot_user)) {
    throw new Error(`${path} isn't a Slack app manifest with display_information and features.bot_user.`);
  }
  template.display_information.name = profile.bot.name;
  template.features.bot_user.display_name = profile.bot.id;
  return template;
};

export const createProfile = (directory: string, input: Profile): void => {
  const profile = validateProfile(input);
  if (existsSync(join(directory, 'profile.json'))) throw new Error(`Profile already exists: ${directory}. Existing settings were preserved.`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  // No overwrite on reruns, including a partly completed setup.
  const seed = (name: string, content: string): void => {
    if (!existsSync(join(directory, name))) writeFileSync(join(directory, name), content, { flag: 'wx', mode: 0o600 });
  };
  seed('.env', 'SLACK_APP_TOKEN=xapp-replace-me\nSLACK_BOT_TOKEN=xoxb-replace-me\n');
  seed('brief.md', readFileSync(join(codeRoot, 'templates/brief.md'), 'utf8'));
  seed('policy.md', '# Owner policy\n\nAdd your workflow choices here after the knowledge interview.\n');
  if (!existsSync(join(directory, 'knowledge'))) cpSync(join(codeRoot, 'templates/knowledge'), join(directory, 'knowledge'), { recursive: true, errorOnExist: true, force: false });
  seed('manifest.json', JSON.stringify(manifestFor(profile), null, 2) + '\n');
  seed('onboarding.md', `# Teach your bot how you work\n\n${onboardingPrompt(directory)}\n\nThe interview writes what you confirm to knowledge/proposals/ for you to review. You can stop and resume. Progress belongs in knowledge/proposals/onboarding-progress.md.\n`);
  seed('state.json', '{}\n');
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
};

// ---------------------------------------------------------------------------------------------------------------
// Detecting defaults (shared by the CLI prompts and the wizard's form)
// ---------------------------------------------------------------------------------------------------------------

/** A bot ID from a display name: lowercase letters, digits and hyphens, starting with a letter. */
export const suggestBotId = (name: string): string => {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return id || 'bot';
};

/** The GitHub login `gh` is signed in as, or empty when `gh` is missing or signed out. */
export const detectGithubLogin = (): Promise<string> =>
  run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 }).then((v) => v.trim()).catch(() => '');

export interface DetectedProject {
  /** The remote's default branch, like `origin/main`. Falls back to `<remote>/main`. */
  baseRef: string;
  /** `owner/repo` from a GitHub remote URL, or empty when the remote isn't on GitHub. */
  githubRepo: string;
  /** Why the folder doesn't look usable, or null. The form shows it; validation happens on create. */
  problem: string | null;
}

/** Reads a repository's base branch and GitHub name, as the CLI prompts suggest them. Never throws. */
export const detectProject = async (path: string, remote = 'origin'): Promise<DetectedProject> => {
  const fallback = { baseRef: `${remote}/main`, githubRepo: '' };
  if (!path || !isAbsolute(path)) return { ...fallback, problem: 'Enter the absolute path of the repository.' };
  if (!existsSync(path)) return { ...fallback, problem: `${path} doesn't exist.` };
  if (remote.startsWith('-')) return { ...fallback, problem: 'Invalid Git remote.' };
  const git = (args: string[]): Promise<string> => run('git', ['-C', path, ...args], { timeoutMs: 15_000 }).then((v) => v.trim());
  try { await git(['rev-parse', '--show-toplevel']); }
  catch { return { ...fallback, problem: `${path} isn't a Git repository.` }; }
  const baseRef = await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => fallback.baseRef);
  const url = await git(['remote', 'get-url', remote]).catch(() => null);
  if (url === null) return { baseRef, githubRepo: '', problem: `The repository has no remote named ${remote}.` };
  const githubRepo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? '';
  return { baseRef, githubRepo, problem: githubRepo ? null : `The ${remote} remote isn't on GitHub, so enter owner/repo yourself.` };
};

// ---------------------------------------------------------------------------------------------------------------
// Step 1: the profile
// ---------------------------------------------------------------------------------------------------------------

/** What the wizard's first step asks for. Everything else gets the same defaults as `pnpm run setup`. */
export interface ProfileDraft {
  botName: string;
  /** Defaults to `suggestBotId(botName)`. */
  botId?: string;
  ownerName: string;
  ownerSlackUserId: string;
  githubLogin: string;
  projectPath: string;
  remote?: string;
  /** Defaults to the remote's default branch. */
  baseRef?: string;
  /** Defaults to the GitHub name in the remote's URL. */
  githubRepo?: string;
  /** The T3 CLI, when it isn't at `~/.t3/bin/t3`. */
  t3Bin?: string;
  /** Where the profile goes. Defaults to `~/.local/share/serra/<bot id>`, where the app looks for profiles. */
  directory?: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The profile and folder a draft makes. Throws `validateProfile`'s message when a field is wrong. */
export const profileFromDraft = async (draft: ProfileDraft, { root = defaultProfileRoot }: { root?: string } = {}): Promise<{ directory: string; profile: Profile }> => {
  const botName = text(draft.botName);
  if (!botName) throw new Error('Give the bot a name.');
  const id = text(draft.botId) || suggestBotId(botName);
  const path = text(draft.projectPath);
  if (!path || !isAbsolute(path)) throw new Error('The repository path must be absolute.');
  const remote = text(draft.remote) || 'origin';
  const needsDetection = !text(draft.baseRef) || !text(draft.githubRepo);
  const detected = needsDetection ? await detectProject(path, remote) : null;
  const t3Bin = text(draft.t3Bin);
  const profile: Profile = {
    version: 1,
    bot: { id, name: botName },
    owner: { name: text(draft.ownerName), slackUserId: text(draft.ownerSlackUserId), githubLogin: text(draft.githubLogin) },
    project: { path, remote, baseRef: text(draft.baseRef) || detected!.baseRef, githubRepo: text(draft.githubRepo) || detected!.githubRepo },
    allowedUsers: [],
    repositories: [],
    ...(t3Bin ? { t3Bin } : {}),
  };
  validateProfile(profile);
  const directory = text(draft.directory) || join(root, id);
  if (!isAbsolute(directory)) throw new Error('The profile folder must be an absolute path.');
  return { directory: resolve(directory), profile };
};

/**
 * Creates the profile folder from the wizard's form, seeded like `pnpm run setup` (brief, policy, knowledge, manifest,
 * an empty state). Refuses a folder that already has a profile, leaving it untouched. Returns the folder.
 */
export const createSetupProfile = async (draft: ProfileDraft, options: { root?: string } = {}): Promise<string> => {
  const { directory, profile } = await profileFromDraft(draft, options);
  createProfile(directory, profile);
  return directory;
};

// ---------------------------------------------------------------------------------------------------------------
// Step 2: the Slack app
// ---------------------------------------------------------------------------------------------------------------

export interface SlackManifest {
  /** The profile's `manifest.json`, named after the bot. */
  json: string;
  /** Opens Slack's "Create an app from a manifest" page with this manifest filled in. */
  createUrl: string;
}

/** The manifest `createProfile` seeded for this bot, and the link that creates a Slack app from it. */
export const slackManifest = (profileDir: string): SlackManifest => {
  const directory = resolve(profileDir);
  const path = join(directory, 'manifest.json');
  const file = readJsonFile(path, isRecord);
  // A broken manifest.json is reported, not replaced: it may hold the owner's edits.
  if (file.state === 'invalid') throw new Error(`${path} isn't a JSON object. Fix it, or remove it to start again from the template.`);
  const manifest = file.state === 'ok' ? file.value : manifestFor(readProfileFile(directory));
  return {
    json: JSON.stringify(manifest, null, 2) + '\n',
    createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Step 4: the owner
// ---------------------------------------------------------------------------------------------------------------

/** `setup.json` in the profile: what the wizard verified. Never a token. */
interface SetupFile {
  version: 1;
  /** The owner member ID Slack confirmed with this bot's token, and when. */
  owner?: { slackUserId: string; slackName: string; checkedAt: string };
  /**
   * When the installed bot first answered, connected to Slack (SERRA-51). Setup's last step is done from then on: a
   * bot stopped later is a status to fix, not setup to redo.
   */
  serviceAnsweredAt?: string;
}

export const SETUP_FILE = 'setup.json';

/** `setup.json`, keeping each part that reads right. A missing or broken file, or a broken part, is not verified. */
const readSetupFile = (profileDir: string): SetupFile => {
  const value = readJsonOrNull(join(resolve(profileDir), SETUP_FILE), isRecord);
  if (!value) return { version: 1 };
  const owner = value.owner;
  return {
    version: 1,
    ...(isRecord(owner) && isString(owner.slackUserId) && isString(owner.slackName) && isString(owner.checkedAt)
      ? { owner: { slackUserId: owner.slackUserId, slackName: owner.slackName, checkedAt: owner.checkedAt } } : {}),
    ...(isString(value.serviceAnsweredAt) ? { serviceAnsweredAt: value.serviceAnsweredAt } : {}),
  };
};

/** A Slack member as the owner check sees them. */
export interface SlackMember { name: string; isBot: boolean; deleted: boolean }

/** Looks a member up with the bot token. Throws Slack's error code (like `user_not_found`) when it refuses. */
export type MemberLookup = (botToken: string, slackUserId: string) => Promise<SlackMember>;

export const slackMemberLookup: MemberLookup = async (botToken, slackUserId) => {
  const { webApi } = await import('@slack/bolt');
  const client = new webApi.WebClient(botToken, { retryConfig: { retries: 0 }, timeout: 15_000 });
  const { user } = await client.users.info({ user: slackUserId });
  if (!user) throw new Error('user_not_found');
  return {
    name: user.real_name || user.profile?.real_name || user.name || slackUserId,
    isBot: Boolean(user.is_bot), deleted: Boolean(user.deleted),
  };
};

export interface OwnerConfirmed {
  slackUserId: string;
  /** The name Slack shows for the owner. */
  slackName: string;
  /** False when the member ID was already the profile's owner. */
  changed: boolean;
}

/**
 * Makes `slackUserId` the bot's owner after Slack confirms, with the bot token, that the member exists and is a
 * person. Saves the owner section (applies after restart) and records the check in `setup.json`.
 */
export const confirmOwner = async (
  profileDir: string, slackUserId: string, { lookup = slackMemberLookup, now = new Date() }: { lookup?: MemberLookup; now?: Date } = {},
): Promise<OwnerConfirmed> => {
  const directory = resolve(profileDir);
  const id = text(slackUserId);
  if (!/^[UW][A-Z0-9]+$/.test(id)) throw new Error(`Not a Slack member ID: ${id || '(empty)'}. Member IDs look like U0123456789.`);
  let token: string | undefined;
  let member: SlackMember;
  try {
    token = loadConfig({ profileDir: directory, env: {} }).botToken;
    member = await lookup(token, id);
  } catch (error) {
    const code = (error as { data?: { error?: unknown } }).data?.error;
    const message = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
    const hint = message === 'user_not_found' ? ' Copy the member ID from your Slack profile menu (⋮ › Copy member ID).' : '';
    throw new Error(scrub(`Slack couldn't confirm ${id}: ${message}.${hint}`, [token]));
  }
  if (member.deleted) throw new Error(`${id} is a deactivated Slack account.`);
  if (member.isBot) throw new Error(`${id} is a bot, not a person. Use your own member ID.`);
  const profile = readProfileFile(directory);
  const { changed } = updateProfileSection(directory, 'owner', { ...profile.owner, slackUserId: id });
  const file = readSetupFile(directory);
  file.owner = { slackUserId: id, slackName: member.name, checkedAt: now.toISOString() };
  writeFileAtomic(join(directory, SETUP_FILE), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  return { slackUserId: id, slackName: member.name, changed };
};

// ---------------------------------------------------------------------------------------------------------------
// Step 5: the background service
// ---------------------------------------------------------------------------------------------------------------

export interface InstallOptions {
  /** A real Node binary for launchd (inside the app, `findNode`'s answer; never Electron). */
  node?: string;
  log?: DeployLog;
  /** Extra prepare options (tests: `root`, `install: false`). */
  prepare?: Omit<PrepareOptions, 'node' | 'log'>;
  /** Extra activation options (tests: a fake launchd driver and LaunchAgents folder). */
  deploy?: Omit<DeployOptions, 'log' | 'preflight'>;
  /** Options for the `diagnose()` preflight (tests: a fake Slack check). `nodeBinary` defaults to `node`. */
  diagnose?: DiagnoseOptions;
  /** Replaces `prepareNextRelease` (tests). */
  prepareRelease?: (profileDir: string, options: PrepareOptions) => Promise<Prepared>;
}

/**
 * Installs and starts the bot under launchd: prepares a release from this code, then activates it. Activation runs
 * `diagnose()` first and refuses to touch launchd while any check fails, so a bot that starts has passed every check.
 * Never throws for a refused or failed activation: the outcome says what happened, as on the Updates screen.
 */
export const installService = async (profileDir: string, options: InstallOptions = {}): Promise<ActivationOutcome> => {
  const directory = resolve(profileDir);
  const log = options.log ?? (() => {});
  const prepare = options.prepareRelease ?? prepareNextRelease;
  await prepare(directory, { ...options.prepare, ...(options.node ? { node: options.node } : {}), log });
  const node = options.node;
  return activateRelease(directory, {
    ...options.deploy,
    log,
    preflight: async (dir) => {
      const results = await diagnose(loadConfig({ profileDir: dir, env: {} }), {
        ...(node ? { nodeBinary: async () => node } : {}),
        ...options.diagnose,
      });
      for (const result of results) log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
      const failed = results.filter((result) => !result.ok);
      if (failed.length) throw new Error(failed.map((result) => `${result.name}: ${result.detail}`).join('; '));
    },
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------------------------

/** The setup steps, in order. The Slack step covers the app and both of its tokens. */
export type SetupStepId = 'profile' | 'slack' | 'owner' | 'service';

export const SETUP_STEP_IDS: readonly SetupStepId[] = ['profile', 'slack', 'owner', 'service'];

export interface SetupStep {
  id: SetupStepId;
  done: boolean;
  /** One line about the step's state. */
  detail: string;
}

export interface SetupProgress {
  /** The profile folder the wizard works on, or null before one is chosen. */
  profileDir: string | null;
  /** From the profile, once it exists. */
  bot: { id: string; name: string } | null;
  owner: { name: string; slackUserId: string; slackName: string | null } | null;
  steps: SetupStep[];
  /** The first step not done, or null when setup is complete. */
  next: SetupStepId | null;
  /** The service is installed (whether or not it runs). */
  installed: boolean;
}

/**
 * Where launchd keeps the bot's plist (tests pass a temp folder), and whether the daemon answers on its status
 * socket and is connected to Slack. Only the app knows that (it follows the socket); given, the service step needs the bot running, not only
 * installed. The CLI leaves it out.
 */
export interface ServiceLookup {
  launchAgentsDir?: string;
  running?: boolean;
  /**
   * Whether each token is still where its source says (the Keychain item exists), from `secretStatus`. The app passes
   * it; without it only `.env` values are looked at, since checking the Keychain means running `security`.
   */
  present?: Partial<Record<SecretName, boolean>>;
}

/**
 * Token presence that is certain: a Keychain lookup that failed (timed out, locked) says nothing, so it is left out
 * and the files' view stands, rather than calling a working token deleted.
 */
export const certainPresence = (statuses: readonly SecretStatus[]): Partial<Record<SecretName, boolean>> =>
  Object.fromEntries(statuses.filter((status) => !status.lookupFailed).map((status) => [status.name, status.set]));

/** Records that the installed bot answered, connected to Slack, so setup's last step stays done (see `SetupFile`). */
export const recordServiceAnswered = (profileDir: string, now = new Date()): void => {
  const directory = resolve(profileDir);
  const file = readSetupFile(directory);
  if (file.serviceAnsweredAt) return;
  file.serviceAnsweredAt = now.toISOString();
  writeFileAtomic(join(directory, SETUP_FILE), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
};

/** Whether the bot's service was installed: an activated release (`active.json`) or a plist from an older install. */
export const serviceInstalled = (profileDir: string, profile: Profile, { launchAgentsDir }: ServiceLookup = {}): boolean => {
  if (existsSync(join(profileDir, 'active.json'))) return true;
  const label = profile.serviceLabel ?? `dev.serra.${profile.bot.id}`;
  return existsSync(join(launchAgentsDir ?? join(homedir(), 'Library/LaunchAgents'), `${label}.plist`));
};

/**
 * Which steps are done, from the profile's files only: `profile.json`, the last token checks in `secrets.json`,
 * `setup.json`, `active.json` and the launchd plist. Runs no `security`, `op`, Slack or launchd call, so it is cheap
 * to call often. Tokens that are present but never checked don't finish the Slack step: `summarizeProfile` reports
 * them as found, so the window can check them instead of asking for them again.
 */
export const setupProgress = (profileDir: string | null, lookup: ServiceLookup = {}): SetupProgress => {
  const directory = profileDir ? resolve(profileDir) : null;
  let profile: Profile | null = null;
  let profileProblem = 'No profile yet';
  if (directory && existsSync(join(directory, 'profile.json'))) {
    try { profile = readProfileFile(directory); }
    catch (error) { profileProblem = `profile.json can't be read: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const steps: SetupStep[] = [];
  const add = (id: SetupStepId, done: boolean, detail: string): void => { steps.push({ id, done, detail }); };
  if (!directory || !profile) {
    add('profile', false, profileProblem);
    for (const id of ['slack', 'owner', 'service'] as const) add(id, false, 'Needs a profile first');
    return { profileDir: directory, bot: null, owner: null, steps, next: 'profile', installed: false };
  }
  add('profile', true, profile.bot.name);
  let checks: ReturnType<typeof readSecretsFile>['checks'] = {};
  let secretsProblem: string | null = null;
  try { checks = readSecretsFile(directory).checks; }
  catch (error) { secretsProblem = error instanceof Error ? error.message : String(error); }
  // A passing check counts only while the token is still there: a value removed from `.env` since isn't verified.
  // Keychain and 1Password values can't be read without running `security` or `op`, so their check record stands.
  let sources: ReturnType<typeof readSecretsFile>['sources'] = {};
  try { sources = readSecretsFile(directory).sources; } catch { /* reported as secretsProblem */ }
  const env = readEnv(join(directory, '.env'));
  const present = (name: SecretName): boolean => lookup.present?.[name]
    ?? (sources[name] ? true : Boolean(env[name]?.trim()) && !/replace-me|\.\.\./.test(env[name] ?? ''));
  const bot = present('SLACK_BOT_TOKEN') ? checks.SLACK_BOT_TOKEN : undefined;
  const app = present('SLACK_APP_TOKEN') ? checks.SLACK_APP_TOKEN : undefined;
  // A pass stands until Slack gives a verdict against the token: a later check that only failed to run (offline,
  // Slack busy, a locked Keychain) doesn't undo it.
  const verified = (check: typeof bot): boolean => Boolean(check?.verifiedAt && (!check.error || !isTokenVerdict(check.error)));
  const slackDone = verified(bot) && verified(app);
  add('slack', slackDone, secretsProblem ?? (slackDone ? 'Both tokens checked with Slack'
    : bot?.error || app?.error || `${[!verified(bot) && 'Bot token', !verified(app) && 'app token'].filter(Boolean).join(' and ')} not checked yet`));
  const setup = readSetupFile(directory);
  const ownerDone = setup.owner?.slackUserId === profile.owner.slackUserId;
  add('owner', ownerDone, ownerDone ? `Slack knows ${profile.owner.slackUserId} as ${setup.owner!.slackName}` : `${profile.owner.slackUserId} not confirmed yet`);
  const installed = serviceInstalled(directory, profile, lookup);
  // Done once the installed bot has answered (recorded in setup.json), or answers now. The CLI, which can't tell,
  // counts an installed service.
  // A bot set up before this was recorded counts too when it left `ready.json`, written once it reached Slack.
  const answered = Boolean(setup.serviceAnsweredAt) || existsSync(join(directory, 'ready.json')) || (lookup.running ?? true);
  add('service', installed && answered, !installed ? 'Not installed yet' : lookup.running ? 'Running' : answered ? 'Installed under launchd' : 'Installed, hasn’t answered yet');
  return {
    profileDir: directory,
    bot: { id: profile.bot.id, name: profile.bot.name },
    owner: { name: profile.owner.name, slackUserId: profile.owner.slackUserId, slackName: ownerDone ? setup.owner!.slackName : null },
    steps,
    next: steps.find((step) => !step.done)?.id ?? null,
    installed,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Detection: what an existing profile already has
// ---------------------------------------------------------------------------------------------------------------

/**
 * A token as setup sees it. `found`: a value is there (`.env` or Keychain) or a 1Password reference is set, but Slack
 * hasn't checked it yet. `rejected`: the last check or read failed.
 */
export type TokenState = 'verified' | 'found' | 'missing' | 'rejected';

export interface TokenSummary {
  name: SecretName;
  state: TokenState;
  /** Where the token is read from. */
  where: 'Keychain' | '1Password' | '.env';
  error: string | null;
}

/**
 * `running`: the daemon answers on its status socket, connected to Slack. `disconnected`: it answers, not connected.
 * `installed`: launchd has it, but it isn't answering.
 */
export type ServiceState = 'running' | 'disconnected' | 'installed' | 'none';

/** One profile as the setup's first screen summarises it: what is there, and the first step still missing. */
export interface ProfileSummary extends SetupProgress {
  profileDir: string;
  /** Why profile.json can't be used, or null. */
  problem: string | null;
  /** `owner/repo`, or the repository folder's name. */
  repo: string | null;
  /** The Slack workspace the bot token last checked against, like `acme.slack.com`. */
  workspace: string | null;
  tokens: TokenSummary[];
  service: ServiceState;
}

export const tokenState = (status: SecretStatus): TokenState => {
  // Gone for sure is missing, whatever the last check said; a lookup that failed is a problem to retry.
  if (!status.set) return status.lookupFailed ? (status.verifiedAt ? 'verified' : 'rejected') : 'missing';
  if (status.verifiedAt && (!status.error || !isTokenVerdict(status.error))) return 'verified';
  if (status.error) return 'rejected';
  return status.set ? 'found' : 'missing';
};

/**
 * Summarises a profile folder for the setup's first screen: `setupProgress`, plus where each token is and whether
 * the service runs. Reads Keychain item presence (never a value) and never opens 1Password, so it doesn't prompt.
 * `running` comes from the caller, which follows the selected profile's status socket; left out (another profile),
 * an installed service counts as done.
 */
export const summarizeProfile = async (
  profileDir: string,
  { running, disconnected, secrets, ...lookup }: ServiceLookup & { secrets?: SecretOptions; disconnected?: boolean } = {},
): Promise<ProfileSummary> => {
  const directory = resolve(profileDir);
  let profile: Profile | null = null;
  try { profile = readProfileFile(directory); } catch { /* reported in progress */ }
  let tokens: TokenSummary[] = [];
  let present: Partial<Record<SecretName, boolean>> | undefined;
  if (profile) {
    try {
      const statuses = await secretStatus(directory, secrets);
      present = certainPresence(statuses);
      tokens = statuses.map((status) => ({
        name: status.name, state: tokenState(status), where: sourceLabel(status.source) as TokenSummary['where'], error: status.error,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tokens = SECRET_NAMES.map((name) => ({ name, state: 'rejected', where: '.env', error: message }));
    }
  }
  const progress = setupProgress(directory, { ...lookup, ...(present ? { present } : {}), ...(running === undefined ? {} : { running }) });
  const { installed } = progress;
  const workspace = slackWorkspace(directory)?.url.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? null;
  return {
    ...progress,
    profileDir: directory,
    problem: profile ? null : progress.steps[0]?.detail ?? null,
    repo: profile ? profile.project.githubRepo || basename(profile.project.path) : null,
    workspace,
    tokens,
    service: installed ? (running ? 'running' : disconnected ? 'disconnected' : 'installed') : 'none',
  };
};

export const setup = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  let directory = profileArgument();
  if (directory && existsSync(join(resolve(directory), 'profile.json'))) {
    validateProfile(JSON.parse(readFileSync(join(resolve(directory), 'profile.json'), 'utf8')));
    console.log(`Existing profile preserved: ${resolve(directory)}\nEdit its .env to finish connecting Slack.\nRun pnpm run doctor --profile ${JSON.stringify(resolve(directory))}\n\n${onboardingPrompt(resolve(directory))}`);
    return;
  }
  let profile: Profile;
  if (configIndex !== -1) {
    const file = args[configIndex + 1];
    if (!file) throw new Error('--config needs a profile JSON file');
    profile = validateProfile(JSON.parse(readFileSync(resolve(file), 'utf8')));
    directory ??= join(defaultProfileRoot, profile.bot.id);
  } else {
    if (!stdin.isTTY) throw new Error('Interactive setup needs a terminal. Use --config examples/profile.json --profile /absolute/folder for unattended setup.');
    const rl = createInterface({ input: stdin, output: stdout });
    const ask = async (question: string, fallback = ''): Promise<string> => {
      const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
      return answer || fallback;
    };
    try {
      const name = await ask('Bot display name');
      const id = await ask('Stable bot ID, lowercase letters, digits, hyphens', suggestBotId(name));
      directory ??= join(defaultProfileRoot, id);
      const ownerName = await ask('Your name');
      const slackUserId = await ask('Your Slack member ID, from your profile menu');
      const githubLogin = await ask('Your GitHub login', await detectGithubLogin());
      const path = resolve(await ask('Absolute path to the repository registered in T3 Code'));
      const remote = await ask('Git remote', 'origin');
      const detected = await detectProject(path, remote);
      const baseRef = await ask('Base branch for new worktrees', detected.baseRef);
      const githubRepo = await ask('GitHub repository, owner/repo', detected.githubRepo);
      const allowedUsers = (await ask('Additional allowed Slack member IDs, comma-separated, or leave empty')).split(',').map((v) => v.trim()).filter(Boolean);
      const channel = await ask('Optional code-review Slack channel ID, or leave empty');
      profile = { version: 1, bot: { id, name }, owner: { name: ownerName, slackUserId, githubLogin }, project: { path, remote, baseRef, githubRepo }, allowedUsers, repositories: [], ...(channel ? { review: { channel, repositories: [githubRepo] } } : {}) };
    } finally { rl.close(); }
  }
  directory = resolve(directory);
  createProfile(directory, profile);
  console.log(`Profile created: ${directory}\n\nConnect your chat channel (Slack is the one supported today):\n1. Create a Slack app from ${join(directory, 'manifest.json')}.\n2. Install it to your workspace. Create an app-level token with connections:write.\n3. Put the xapp and xoxb tokens in ${join(directory, '.env')}.\n4. Run pnpm run doctor --profile ${JSON.stringify(directory)}.\n5. Invite @${profile.bot.id} to a test channel.\n6. Run pnpm start --profile ${JSON.stringify(directory)}.\n\nTeach your bot how you work. ${onboardingPrompt(directory)}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setup().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
