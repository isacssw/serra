import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic, type AtomicWriteIo } from './lib/atomic.ts';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { resolveConfiguredSecretSync } from './secrets.ts';

export const codeRoot = fileURLToPath(new URL('..', import.meta.url));
export const defaultProfileRoot = join(homedir(), '.local/share/serra');

export interface Repository {
  name: string;
  path: string;
  baseRef: string;
  githubRepo?: string;
}

/** An owner-authorized source of automatic, read-only investigations. */
export interface MessageTrigger {
  channel: string;
  botId?: string;
  userId?: string;
  instructions: string;
}

export interface Profile {
  version: 1;
  bot: { id: string; name: string };
  owner: { name: string; slackUserId: string; githubLogin: string };
  project: { path: string; remote: string; baseRef: string; githubRepo: string };
  allowedUsers: string[];
  messageTriggers?: MessageTrigger[];
  review?: { channel: string; repositories: string[] };
  repositories?: Repository[];
  /** Which T3 provider instance and model run the bot's jobs. Without it, T3 uses the project's default. */
  worker?: { provider?: string; model: string };
  serviceLabel?: string;
  t3Bin?: string;
  /**
   * How a job's task branch is named. Placeholders: {id} the bot id, {slug} from the request, {stamp} a short
   * unique suffix, {DDMM} and {MMDD} today's date. Must contain {slug} and {stamp}, so two jobs never share a branch.
   */
  branchPattern?: string;
  /**
   * Where Updates and Prepare get new code. `source` is a git checkout of the Serra repository (a packaged app has
   * none of its own) and `ref` the branch to follow in it, `origin/main` by default. Without it, the code the app or
   * CLI runs from is used.
   */
  updates?: { source: string; ref?: string };
}

export const DEFAULT_BRANCH_PATTERN = '{id}/{slug}-{stamp}';
const BRANCH_PLACEHOLDER = /\{(id|slug|stamp|DDMM|MMDD)\}/g;

/** Why a branch pattern can't name a valid, unique Git branch, or null when it can. */
export const branchPatternProblem = (pattern: string): string | null => {
  if (!pattern.includes('{slug}') || !pattern.includes('{stamp}')) return 'branchPattern must contain {slug} and {stamp}';
  const literal = pattern.replace(BRANCH_PLACEHOLDER, 'x');
  if (/[{}]/.test(literal)) return 'branchPattern has an unknown placeholder. Use {id}, {slug}, {stamp}, {DDMM} or {MMDD}';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(literal) || /\.\.|\/\/|\/$|\.lock$|\/\.|\.$/.test(literal)) return 'branchPattern must make a valid Git branch name';
  return null;
};

export const readEnv = (path: string): Record<string, string> =>
  existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) as Record<string, string> : {};

export const profileArgument = (args = process.argv.slice(2)): string | undefined => {
  const index = args.indexOf('--profile');
  if (index === -1) return process.env.BOT_PROFILE;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--profile needs an absolute folder path');
  return value;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate profiles before using their fields as paths, service labels, or worker instructions. */
export const validateProfile = (value: unknown): Profile => {
  if (!record(value) || value.version !== 1) throw new Error('profile.json needs version: 1');
  const object = (key: string): Record<string, unknown> => {
    const item = value[key];
    if (!record(item)) throw new Error(`profile.json needs ${key}`);
    return item;
  };
  const string = (obj: Record<string, unknown>, key: string): string => {
    const item = obj[key];
    if (typeof item !== 'string' || !item.trim() || /[\r\n\0]/.test(item)) throw new Error(`Invalid profile field: ${key}`);
    return item;
  };
  const strings = (item: unknown, label: string): string[] => {
    if (!Array.isArray(item) || item.some((v) => typeof v !== 'string' || !v.trim())) throw new Error(`Invalid ${label}`);
    return item as string[];
  };
  const bot = object('bot');
  const id = string(bot, 'id');
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new Error('Bot id must start with a letter and contain 1-48 lowercase letters, digits, or hyphens');
  string(bot, 'name');
  const owner = object('owner');
  string(owner, 'name');
  if (!/^[UW][A-Z0-9]+$/.test(string(owner, 'slackUserId'))) throw new Error('Invalid owner Slack member ID');
  if (!/^[\w-]+$/.test(string(owner, 'githubLogin'))) throw new Error('Invalid GitHub login');
  const project = object('project');
  if (!isAbsolute(string(project, 'path'))) throw new Error('Project path must be absolute');
  for (const key of ['remote', 'baseRef']) {
    if (string(project, key).startsWith('-')) throw new Error(`Invalid project ${key}`);
  }
  const repoName = (name: string): void => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`Invalid GitHub repository: ${name}`);
  };
  repoName(string(project, 'githubRepo'));
  if (strings(value.allowedUsers, 'allowedUsers').some((id) => !/^[UW][A-Z0-9]+$/.test(id))) throw new Error('Invalid allowed Slack member ID');
  if (value.messageTriggers !== undefined) {
    if (!Array.isArray(value.messageTriggers)) throw new Error('Invalid messageTriggers');
    const sources = new Set<string>();
    for (const trigger of value.messageTriggers) {
      if (!record(trigger)) throw new Error('Invalid message trigger');
      const channel = string(trigger, 'channel');
      if (!/^[CG][A-Z0-9]+$/.test(channel)) throw new Error('Invalid message trigger channel ID');
      for (const key of ['botId', 'userId']) {
        if (trigger[key] !== undefined && typeof trigger[key] !== 'string') throw new Error(`Invalid message trigger ${key}`);
      }
      const botId = (trigger.botId as string | undefined)?.trim() ?? '';
      const userId = (trigger.userId as string | undefined)?.trim() ?? '';
      if (botId && !/^B[A-Z0-9]+$/.test(botId)) throw new Error('Invalid message trigger bot ID');
      if (userId && !/^[UW][A-Z0-9]+$/.test(userId)) throw new Error('Invalid message trigger user ID');
      if (botId && userId) throw new Error('Message triggers can select either botId or userId, not both');
      if (typeof trigger.instructions !== 'string' || !trigger.instructions.trim() || trigger.instructions.length > 10_000 || trigger.instructions.includes('\0')) {
        throw new Error('Message trigger instructions must contain 1-10000 characters');
      }
      const source = `${channel}:${botId || userId || '*'}`;
      if (sources.has(source)) throw new Error(`Duplicate message trigger: ${source}`);
      sources.add(source);
    }
  }
  if (value.review !== undefined) {
    const review = object('review');
    if (!/^[CG][A-Z0-9]+$/.test(string(review, 'channel'))) throw new Error('Invalid review channel ID');
    const repos = strings(review.repositories, 'review.repositories');
    if (!repos.length) throw new Error('Review posting needs at least one allowed repository');
    repos.forEach(repoName);
  }
  if (value.repositories !== undefined) {
    if (!Array.isArray(value.repositories)) throw new Error('Invalid repositories');
    for (const repo of value.repositories) {
      if (!record(repo) || !isAbsolute(string(repo, 'path'))) throw new Error('Additional repository paths must be absolute');
      string(repo, 'name');
      if (string(repo, 'baseRef').startsWith('-')) throw new Error('Invalid additional repository baseRef');
      if (repo.githubRepo !== undefined) repoName(string(repo, 'githubRepo'));
    }
  }
  if (value.worker !== undefined) {
    const worker = object('worker');
    // Both become CLI arguments, so neither may read as a flag.
    if (string(worker, 'model').startsWith('-')) throw new Error('Invalid worker model');
    if (worker.provider !== undefined && string(worker, 'provider').startsWith('-')) throw new Error('Invalid worker provider');
  }
  if (value.serviceLabel !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(string(value, 'serviceLabel'))) throw new Error('Invalid service label');
  if (value.t3Bin !== undefined && !isAbsolute(string(value, 't3Bin'))) throw new Error('t3Bin must be absolute');
  if (value.updates !== undefined) {
    const updates = object('updates');
    if (!isAbsolute(string(updates, 'source'))) throw new Error('updates.source must be an absolute path');
    // `ref` becomes a git argument, so it may not read as a flag.
    if (updates.ref !== undefined && string(updates, 'ref').startsWith('-')) throw new Error('Invalid updates.ref');
  }
  if (value.branchPattern !== undefined) {
    const problem = branchPatternProblem(string(value, 'branchPattern'));
    if (problem) throw new Error(problem);
  }
  return value as unknown as Profile;
};

export { writeFileAtomic, type AtomicWriteIo } from './lib/atomic.ts';

export const PROFILE_FILE = 'profile.json';

/**
 * The only way to write a profile's `profile.json`. Validates first, so an invalid profile never reaches disk,
 * then writes atomically with owner-only permissions. Returns the validated profile.
 */
export const writeProfileFile = (profileDir: string, profile: unknown, options: { io?: AtomicWriteIo } = {}): Profile => {
  const valid = validateProfile(profile);
  writeFileAtomic(join(resolve(profileDir), PROFILE_FILE), JSON.stringify(valid, null, 2) + '\n', { mode: 0o600, ...options });
  return valid;
};

/** Read and validate a profile's `profile.json`. */
export const readProfileFile = (profileDir: string): Profile =>
  validateProfile(JSON.parse(readFileSync(join(resolve(profileDir), PROFILE_FILE), 'utf8')));

export interface Config {
  profileDir: string;
  profile: Profile;
  name: string;
  id: string;
  ownerName: string;
  owner: string;
  githubLogin: string;
  botToken: string;
  appToken: string;
  project: string;
  remote: string;
  baseRef: string;
  reviewChannel?: string;
  reviewRepos: string[];
  repositories: Repository[];
  workerProvider?: string;
  workerModel?: string;
  allowed: Set<string>;
  messageTriggers: MessageTrigger[];
  briefPath: string;
  knowledgeDir: string;
  statePath: string;
  t3Bin: string;
  serviceLabel: string;
  branchPattern: string;
}

/** Every bot runs from a profile. The code checkout holds no owner settings, brief, knowledge, or state. */
export const loadConfig = ({ profileDir = profileArgument(), env = process.env }: {
  profileDir?: string; env?: NodeJS.ProcessEnv;
} = {}): Config => {
  if (!profileDir) throw new Error('Select a bot profile with --profile /absolute/profile/folder or BOT_PROFILE. Run pnpm run setup to create one.');
  const directory = resolve(profileDir);
  // Tokens come from the profile (secrets.json sources or its .env), never from a checkout's .env.
  const values = { ...readEnv(join(directory, '.env')), ...env };
  const required = (key: string): string => {
    const value = values[key]?.trim();
    if (!value) throw new Error(`Missing ${key} in ${directory}/.env`);
    return value;
  };
  const profile = readProfileFile(directory);
  // A token comes from the process environment, then its source in secrets.json (Keychain or 1Password), then .env.
  // It is read on first use, so commands that never touch Slack (stop, status) never run `security` or `op`.
  const token = (key: 'SLACK_BOT_TOKEN' | 'SLACK_APP_TOKEN'): () => string => {
    let value: string | undefined;
    return () => (value ??= env[key]?.trim() || resolveConfiguredSecretSync(directory, key) || required(key));
  };
  const botToken = token('SLACK_BOT_TOKEN');
  const appToken = token('SLACK_APP_TOKEN');
  const owner = profile.owner.slackUserId;
  const repositories = profile.repositories ?? [];
  return {
    profileDir: directory, profile,
    id: profile.bot.id, name: profile.bot.name,
    ownerName: profile.owner.name, owner, githubLogin: profile.owner.githubLogin,
    get botToken() { return botToken(); }, get appToken() { return appToken(); },
    project: profile.project.path, remote: profile.project.remote, baseRef: profile.project.baseRef,
    reviewChannel: profile.review?.channel, reviewRepos: profile.review?.repositories ?? [],
    repositories,
    workerProvider: profile.worker?.provider, workerModel: profile.worker?.model,
    allowed: new Set([owner, ...profile.allowedUsers]),
    messageTriggers: profile.messageTriggers ?? [],
    briefPath: join(directory, 'brief.md'), knowledgeDir: join(directory, 'knowledge'),
    statePath: join(directory, 'state.json'),
    t3Bin: profile.t3Bin ?? values.T3_BIN?.trim() ?? join(homedir(), '.t3/bin/t3'),
    serviceLabel: profile.serviceLabel ?? `dev.serra.${profile.bot.id}`,
    branchPattern: profile.branchPattern ?? DEFAULT_BRANCH_PATTERN,
  };
};
