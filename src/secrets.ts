/**
 * Where the Slack tokens come from (APP-8). Each token has a source: a Keychain item (read through the `security`
 * CLI), a 1Password reference (read through `op`), or the profile's `.env`, the CLI fallback.
 *
 * Both tools run as child processes with a timeout, so a hang or crash can't take the daemon or the app down.
 * A token's value is never written to `secrets.json`, never returned to a caller other than the daemon's
 * `loadConfig`, and never part of an error message: every message from a tool is scrubbed before it is thrown.
 *
 * `secrets.json` in the profile holds only non-secret data: each token's source, when Slack last accepted it, the
 * last error, and the Slack workspace the bot token belongs to (its URL builds thread links).
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Profile, SecretName, SecretSource, SecretStatus } from './contracts.ts';
import { writeFileAtomic } from './lib/atomic.ts';
import { readEnv } from './lib/env.ts';

export const SECRETS_FILE = 'secrets.json';
export const SECRET_NAMES: readonly SecretName[] = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];

/** The external tools and how long each may take. Tests point these at fake binaries. */
export interface SecretTools {
  /** The macOS `security` CLI. */
  security: string;
  /** The 1Password CLI. */
  op: string;
  timeoutMs: number;
}
// 30 s leaves time for a 1Password unlock prompt.
const DEFAULT_SECRET_TOOLS: SecretTools = { security: 'security', op: 'op', timeoutMs: 30_000 };

interface CheckRecord { verifiedAt: string | null; error: string | null }

/** The Slack workspace the bot token belongs to, from the last passing `auth.test`. */
export interface SlackWorkspace { url: string; team?: string; checkedAt: string }

interface SecretsFile {
  version: 1;
  /** Tokens without an entry use `.env`. */
  sources: Partial<Record<SecretName, Exclude<SecretSource, { kind: 'env' }>>>;
  checks: Partial<Record<SecretName, CheckRecord>>;
  slack?: SlackWorkspace;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isSecretName = (value: unknown): value is SecretName => SECRET_NAMES.includes(value as SecretName);

// Keychain names and 1Password references end up in argv or on `security -i`'s command line, so they stay plain.
const KEYCHAIN_NAME = /^[\w.@:+-]{1,128}$/;
// 1Password names may contain spaces; the reference goes to `op` as one argv entry, never through a shell.
const OP_PART = String.raw`[^/\s"'\\](?:[^/\r\n\0"'\\]*[^/\s"'\\])?`;
const OP_REFERENCE = new RegExp(`^op://${OP_PART}/${OP_PART}(/${OP_PART}){1,2}$`);

/** Throws when `source` isn't a well-formed source. Returns it typed. */
const validateSecretSource = (source: unknown): SecretSource => {
  if (!record(source)) throw new Error('A secret source needs a kind: keychain, 1password or env');
  if (source.kind === 'env') return { kind: 'env' };
  if (source.kind === 'keychain') {
    const { service, account } = source;
    if (typeof service !== 'string' || !KEYCHAIN_NAME.test(service) || service.startsWith('-')) throw new Error('Keychain service must be 1-128 letters, digits or ._@:+-');
    if (typeof account !== 'string' || !KEYCHAIN_NAME.test(account) || account.startsWith('-')) throw new Error('Keychain account must be 1-128 letters, digits or ._@:+-');
    return { kind: 'keychain', service, account };
  }
  if (source.kind === '1password') {
    if (typeof source.reference !== 'string' || !OP_REFERENCE.test(source.reference)) throw new Error('A 1Password reference looks like op://vault/item/field');
    return { kind: '1password', reference: source.reference };
  }
  throw new Error('A secret source needs a kind: keychain, 1password or env');
};

const emptyFile = (): SecretsFile => ({ version: 1, sources: {}, checks: {} });

/** Read `secrets.json`. A profile without one uses `.env` for both tokens. */
export const readSecretsFile = (profileDir: string): SecretsFile => {
  const path = join(resolve(profileDir), SECRETS_FILE);
  if (!existsSync(path)) return emptyFile();
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${SECRETS_FILE} isn't valid JSON`); }
  if (!record(value) || value.version !== 1) throw new Error(`${SECRETS_FILE} needs version: 1`);
  const file = emptyFile();
  if (record(value.sources)) {
    for (const [name, source] of Object.entries(value.sources)) {
      if (!isSecretName(name)) throw new Error(`${SECRETS_FILE} has an unknown token: ${name}`);
      const valid = validateSecretSource(source);
      if (valid.kind !== 'env') file.sources[name] = valid;
    }
  }
  if (record(value.checks)) {
    for (const [name, check] of Object.entries(value.checks)) {
      if (!isSecretName(name) || !record(check)) continue;
      file.checks[name] = {
        verifiedAt: typeof check.verifiedAt === 'string' ? check.verifiedAt : null,
        error: typeof check.error === 'string' ? check.error : null,
      };
    }
  }
  const slack = value.slack;
  if (record(slack) && typeof slack.url === 'string' && /^https:\/\/[\w.-]+\/?$/.test(slack.url) && typeof slack.checkedAt === 'string') {
    file.slack = { url: slack.url, checkedAt: slack.checkedAt, ...(typeof slack.team === 'string' ? { team: slack.team } : {}) };
  }
  return file;
};

const writeSecretsFile = (profileDir: string, file: SecretsFile): void =>
  writeFileAtomic(join(resolve(profileDir), SECRETS_FILE), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });

/** Each token's source. Tokens without a configured source read `.env`. */
export const secretSource = (profileDir: string, name: SecretName): SecretSource =>
  readSecretsFile(profileDir).sources[name] ?? { kind: 'env' };

/** How a source reads in a status line: `Keychain`, `1Password` or `.env`. */
export const sourceLabel = (source: SecretSource): string =>
  source.kind === 'keychain' ? 'Keychain' : source.kind === '1password' ? '1Password' : '.env';

/** The Keychain item a token goes in unless the owner picks another: the bot's service label and the token's name. */
export const defaultKeychainSource = (profile: Pick<Profile, 'serviceLabel' | 'bot'>, name: SecretName): SecretSource & { kind: 'keychain' } => {
  return { kind: 'keychain', service: profile.serviceLabel ?? `dev.serra.${profile.bot.id}`, account: name };
};

/** The Slack workspace URL, like `https://acme.slack.com`, saved by the last passing bot-token check. For `listJobs`' `slackUrl`. */
export const slackWorkspace = (profileDir: string): SlackWorkspace | null => {
  try { return readSecretsFile(profileDir).slack ?? null; } catch { return null; }
};

// ---------------------------------------------------------------------------------------------------------------
// Running `security` and `op` without leaking values
// ---------------------------------------------------------------------------------------------------------------

const TOKEN_SHAPE = /\bx(?:ox[a-z]|app)-[A-Za-z0-9-]+/g;

/** Removes every known value and anything shaped like a Slack token. */
export const scrub = (text: string, values: (string | undefined)[] = []): string => {
  let out = text;
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 4) out = out.split(trimmed).join('[hidden]');
  }
  return out.replace(TOKEN_SHAPE, '[hidden]');
};

interface ToolOutcome { missing: boolean; timedOut: boolean; status: number | null; stdout: string; stderr: string }
interface ToolCall { label: string; bin: string; args: string[]; input?: string; timeoutMs: number; hide?: string[] }

/** Turns a finished child process into its stdout, or an error whose message carries no output that could be a value. */
const outcome = (call: ToolCall, result: ToolOutcome): string => {
  if (result.missing) throw new Error(`${call.label} isn't installed or isn't on PATH (${call.bin})`);
  if (result.timedOut) throw new Error(`${call.label} didn't answer within ${call.timeoutMs < 1000 ? `${call.timeoutMs} ms` : `${Math.round(call.timeoutMs / 1000)} s`}`);
  if (result.status !== 0) {
    const detail = scrub(result.stderr, [result.stdout, ...(call.hide ?? [])]).trim().split('\n').find(Boolean)?.slice(0, 300);
    throw new Error(`${call.label} failed${detail ? `: ${detail}` : ` with exit code ${result.status}`}`);
  }
  return result.stdout;
};

const runTool = (call: ToolCall): Promise<string> => new Promise((done, fail) => {
  const child = execFile(call.bin, call.args, { timeout: call.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    try {
      done(outcome(call, {
        missing: code === 'ENOENT',
        timedOut: Boolean(error && (error as { killed?: boolean }).killed),
        status: error ? (typeof code === 'number' ? code : 1) : 0,
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
      }));
    } catch (caught) { fail(caught); }
  });
  child.stdin?.on('error', () => { /* the child may exit before reading */ });
  child.stdin?.end(call.input ?? '');
});

const runToolSync = (call: ToolCall): string => {
  const result = spawnSync(call.bin, call.args, { input: call.input ?? '', timeout: call.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return outcome(call, {
    missing: code === 'ENOENT', timedOut: code === 'ETIMEDOUT',
    status: result.error ? 1 : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
  });
};

const readCall = (source: Exclude<SecretSource, { kind: 'env' }>, tools: SecretTools): ToolCall =>
  source.kind === 'keychain'
    ? { label: 'Keychain (security)', bin: tools.security, args: ['find-generic-password', '-s', source.service, '-a', source.account, '-w'], timeoutMs: tools.timeoutMs }
    : { label: '1Password (op)', bin: tools.op, args: ['read', '--no-newline', source.reference], timeoutMs: tools.timeoutMs };

const PREFIX: Record<SecretName, string> = { SLACK_BOT_TOKEN: 'xoxb-', SLACK_APP_TOKEN: 'xapp-' };

/** Throws, without the value, when `value` can't be the named token. */
const checkShape = (name: SecretName, value: string, where: string): string => {
  if (!value) throw new Error(`${name} from ${where} is empty`);
  if (!value.startsWith(PREFIX[name]) || /replace-me|\.\.\./.test(value)) throw new Error(`${name} from ${where} isn't a real ${PREFIX[name]} token`);
  if (/\s/.test(value)) throw new Error(`${name} from ${where} contains whitespace`);
  return value;
};

const fromOutput = (name: SecretName, source: SecretSource, stdout: string): string =>
  checkShape(name, stdout.replace(/\r?\n$/, '').trim(), sourceLabel(source));

/**
 * For `loadConfig`: the token from its configured source, or undefined when it has none (so `.env` applies).
 * Throws, without the value, when the source is configured but can't be read. Blocks while the tool runs.
 */
export const resolveConfiguredSecretSync = (profileDir: string, name: SecretName, tools: SecretTools = DEFAULT_SECRET_TOOLS): string | undefined => {
  const source = readSecretsFile(profileDir).sources[name];
  if (!source) return undefined;
  try { return fromOutput(name, source, runToolSync(readCall(source, tools))); }
  catch (error) { throw new Error(`Can't read ${name} from ${sourceLabel(source)}: ${(error as Error).message}`); }
};

/** The token from its source, `.env` included. For checks; never send the result to the window. */
const resolveSecret = async (profileDir: string, name: SecretName, source: SecretSource, tools: SecretTools): Promise<string> => {
  if (source.kind === 'env') return checkShape(name, readEnv(join(resolve(profileDir), '.env'))[name]?.trim() ?? '', `${resolve(profileDir)}/.env`);
  return fromOutput(name, source, await runTool(readCall(source, tools)));
};

const keychainHas = async (source: SecretSource & { kind: 'keychain' }, tools: SecretTools): Promise<boolean> => {
  // Without -w, `security` prints the item's attributes only, so this never reads the value.
  try { await runTool({ label: 'Keychain (security)', bin: tools.security, args: ['find-generic-password', '-s', source.service, '-a', source.account], timeoutMs: tools.timeoutMs }); return true; }
  catch (error) {
    if (/could not be found|exit code 44/.test((error as Error).message)) return false;
    throw error;
  }
};

/**
 * Adds or replaces a Keychain item. The value goes on `security -i`'s stdin, never in argv, where any process
 * could read it.
 */
const keychainWrite = async (name: SecretName, source: SecretSource & { kind: 'keychain' }, value: string, tools: SecretTools): Promise<void> => {
  if (/["'\\\s]/.test(value)) throw new Error(`${name} contains quotes, backslashes or whitespace`);
  const line = `add-generic-password -U -s "${source.service}" -a "${source.account}" -l "Serra ${name}" -w "${value}"\n`;
  await runTool({ label: 'Keychain (security)', bin: tools.security, args: ['-i'], input: line, timeoutMs: tools.timeoutMs, hide: [value] });
  // `security -i` exits 0 even when a command in it fails, so read the item back.
  let stored: string;
  try { stored = fromOutput(name, source, await runTool(readCall(source, tools))); }
  catch (error) { throw new Error(`The Keychain item wasn't saved: ${scrub((error as Error).message, [value])}`); }
  if (stored !== value) throw new Error("The Keychain item wasn't saved: it reads back a different value");
};

// ---------------------------------------------------------------------------------------------------------------
// Owner actions: setSecret, checkSecret, secretStatus
// ---------------------------------------------------------------------------------------------------------------

export interface SecretOptions {
  tools?: Partial<SecretTools>;
}

const toolsFrom = (options: SecretOptions): SecretTools => ({ ...DEFAULT_SECRET_TOOLS, ...options.tools });

const statusOf = async (profileDir: string, name: SecretName, file: SecretsFile, tools: SecretTools): Promise<SecretStatus> => {
  const source = file.sources[name] ?? { kind: 'env' as const };
  const check = file.checks[name] ?? { verifiedAt: null, error: null };
  let set: boolean;
  let error = check.error;
  let lookupFailed = false;
  if (source.kind === 'env') {
    const value = readEnv(join(resolve(profileDir), '.env'))[name]?.trim() ?? '';
    set = Boolean(value) && !/replace-me|\.\.\./.test(value);
  } else if (source.kind === 'keychain') {
    try { set = await keychainHas(source, tools); }
    catch (caught) { set = false; error = (caught as Error).message; lookupFailed = true; }
  } else {
    // Reading a 1Password reference can open an unlock prompt, so the list doesn't. Check resolves it.
    set = true;
  }
  return { name, source, set, verifiedAt: check.verifiedAt, error, ...(lookupFailed ? { lookupFailed: true as const } : {}) };
};

/** What the Secrets screen and `pnpm bot secrets` show for each token. Never the value. */
export const secretStatus = async (profileDir: string, options: SecretOptions = {}): Promise<SecretStatus[]> => {
  const file = readSecretsFile(profileDir);
  return Promise.all(SECRET_NAMES.map((name) => statusOf(profileDir, name, file, toolsFrom(options))));
};

/**
 * Chooses where a token comes from. Applies after restart.
 * - Keychain with `value`: stores the value in that item, then points the token at it.
 * - Keychain without `value`: points at an item that already exists.
 * - 1Password: points at the reference. `value` isn't accepted; the item stays in 1Password.
 * - `.env`: drops the configured source, so the token comes from the profile's `.env` again.
 * The last check is cleared, since it was for the old source.
 */
export const setSecret = async (profileDir: string, name: SecretName, source: SecretSource, value?: string, options: SecretOptions = {}): Promise<SecretStatus> => {
  if (!isSecretName(name)) throw new Error(`Unknown token: ${String(name)}. Use ${SECRET_NAMES.join(' or ')}`);
  const valid = validateSecretSource(source);
  const tools = toolsFrom(options);
  if (value !== undefined && valid.kind !== 'keychain') throw new Error(`Only a Keychain source stores a value. Put it in ${valid.kind === '1password' ? '1Password' : 'the profile .env'} instead`);
  if (valid.kind === 'keychain') {
    if (value !== undefined) await keychainWrite(name, valid, checkShape(name, value.trim(), 'the given value'), tools);
    else if (!(await keychainHas(valid, tools))) throw new Error(`No Keychain item for service ${valid.service}, account ${valid.account}`);
  }
  const file = readSecretsFile(profileDir);
  if (valid.kind === 'env') delete file.sources[name];
  else file.sources[name] = valid;
  delete file.checks[name];
  writeSecretsFile(profileDir, file);
  return statusOf(profileDir, name, file, tools);
};

/** What Slack says about a token. Throws with Slack's error code when it rejects the token. */
export type SlackVerify = (name: SecretName, token: string) => Promise<{ url?: string; team?: string }>;

/**
 * The bot token is checked with `auth.test`, which also names the workspace. An app-level token can't call
 * `auth.test`, so it is checked with `apps.connections.open`, which only hands out a Socket Mode URL that is never
 * opened.
 */
const slackVerify: SlackVerify = async (name, token) => {
  // Loaded here so `loadConfig`, which imports this file, doesn't pull in Bolt.
  const { webApi } = await import('@slack/bolt');
  const client = new webApi.WebClient(token, { retryConfig: { retries: 0 }, timeout: 15_000 });
  if (name === 'SLACK_BOT_TOKEN') {
    const auth = await client.auth.test();
    return { ...(auth.url ? { url: auth.url } : {}), ...(auth.team ? { team: auth.team } : {}) };
  }
  await client.apps.connections.open();
  return {};
};

/**
 * Resolves the token from its source and asks Slack whether it works. Saves when it passed (and, for the bot token,
 * the workspace URL) or why it didn't. The value is never returned or saved.
 */
export const checkSecret = async (profileDir: string, name: SecretName, options: SecretOptions & { verify?: SlackVerify; now?: Date } = {}): Promise<SecretStatus> => {
  if (!isSecretName(name)) throw new Error(`Unknown token: ${String(name)}. Use ${SECRET_NAMES.join(' or ')}`);
  const tools = toolsFrom(options);
  const verify = options.verify ?? slackVerify;
  const now = (options.now ?? new Date()).toISOString();
  const source = secretSource(profileDir, name);
  let value: string | undefined;
  let result: { url?: string; team?: string } | null = null;
  let error: string | null = null;
  try {
    value = await resolveSecret(profileDir, name, source, tools);
    try { result = await verify(name, value); }
    catch (caught) {
      const code = (caught as { data?: { error?: unknown } }).data?.error;
      // Slack's own answer means it refused the token; anything else means the check never reached a verdict.
      throw new Error(typeof code === 'string' ? `Slack rejected ${name}: ${code}` : `Couldn't reach Slack: ${(caught as Error).message}`);
    }
  } catch (caught) {
    error = scrub(caught instanceof Error ? caught.message : String(caught), [value]);
  }
  // Read again: the file may have changed while Slack answered.
  const file = readSecretsFile(profileDir);
  const previous = file.checks[name];
  file.checks[name] = error ? { verifiedAt: previous?.verifiedAt ?? null, error } : { verifiedAt: now, error: null };
  if (!error && name === 'SLACK_BOT_TOKEN' && result?.url && /^https:\/\/[\w.-]+\/?$/.test(result.url)) {
    file.slack = { url: result.url.replace(/\/+$/, ''), ...(result.team ? { team: result.team } : {}), checkedAt: now };
  }
  writeSecretsFile(profileDir, file);
  const status = await statusOf(profileDir, name, file, tools);
  // A value that resolved is set, whatever the cheaper existence check says.
  return value !== undefined && !error ? { ...status, set: true } : status;
};
