import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileArgument } from './config.ts';
import { hasServiceHost } from './service.ts';

/** What a command gets: its arguments, parsed helpers and the profile folder. Commands print with `log`. */
export interface CommandContext {
  /** Everything after `pnpm bot`, with `--` removed. `args[0]` is the command name. */
  args: string[];
  /** The value after `key`, like `option('--days')`. Throws when the flag is given without a value. */
  option: (key: string) => string | undefined;
  /** Whether a bare flag like `--apply` is present. */
  flag: (key: string) => boolean;
  /** Absolute profile folder from `--profile` or `BOT_PROFILE`. Empty for a command with `profile: false`. */
  profileDir: string;
  log: (text: string) => void;
}

/**
 * One `pnpm bot <name>` command. Commands only parse input, call a service in `src/` and report the result,
 * so the app and the CLI behave the same.
 */
export interface Command {
  /** One line for `pnpm bot --help`. */
  summary: string;
  /** Example invocations for `--help`. */
  usage?: string[];
  /** Runs the background service: launchd on macOS, systemd on Linux. */
  service?: boolean;
  /** About this computer, not one bot: no `--profile` needed. */
  profile?: false;
  run: (context: CommandContext) => Promise<void>;
}

export type CommandTable = Record<string, () => Promise<{ default: Command }>>;

/**
 * `pnpm bot <name>` loads `src/commands/<name>.ts`. To add a command, add the file and one line here.
 * Only the chosen command's module is loaded, so a command never pays for another's imports.
 */
export const commands: CommandTable = {
  prepare: () => import('./commands/prepare.ts'),
  activate: () => import('./commands/activate.ts'),
  rollback: () => import('./commands/rollback.ts'),
  status: () => import('./commands/status.ts'),
  stop: () => import('./commands/stop.ts'),
  start: () => import('./commands/start.ts'),
  restart: () => import('./commands/restart.ts'),
  cleanup: () => import('./commands/cleanup.ts'),
  releases: () => import('./commands/releases.ts'),
  jobs: () => import('./commands/jobs.ts'),
  proposals: () => import('./commands/proposals.ts'),
  people: () => import('./commands/people.ts'),
  settings: () => import('./commands/settings.ts'),
  secrets: () => import('./commands/secrets.ts'),
  tools: () => import('./commands/tools.ts'),
  task: () => import('./commands/task.ts'),
  interview: () => import('./commands/interview.ts'),
  server: () => import('./commands/server.ts'),
};

export const helpText = async (table: CommandTable = commands): Promise<string> => {
  const loaded = await Promise.all(Object.entries(table).map(async ([name, load]) => [name, (await load()).default] as const));
  const width = Math.max(...loaded.map(([name]) => name.length));
  return [
    'Usage: pnpm bot <command> --profile /absolute/profile/folder [options]',
    '       pnpm bot server doctor',
    '',
    'Commands:',
    ...loaded.map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}${command.service ? ' (macOS, Linux)' : ''}`),
    '',
    ...loaded.flatMap(([, command]) => command.usage ?? []),
  ].join('\n');
};

/** Parse `argv`, pick the command from `table` and run it. Returns the exit code; errors print as one message. */
export const runCli = async (argv: string[], {
  table = commands, platform = process.platform, log = console.log, error = console.error,
}: { table?: CommandTable; platform?: NodeJS.Platform; log?: (text: string) => void; error?: (text: string) => void } = {}): Promise<number> => {
  const args = argv.filter((arg) => arg !== '--');
  const name = args[0];
  try {
    if (!name || name === '--help' || name === 'help') {
      log(await helpText(table));
      return 0;
    }
    const load = Object.hasOwn(table, name) ? table[name] : undefined;
    if (!load) throw new Error(`Unknown bot command: ${name}. Run pnpm bot --help.`);
    const command = (await load()).default;
    if (command.service && !hasServiceHost(platform)) {
      throw new Error('Background service management supports macOS and Linux. Run pnpm start --profile ... in the foreground on other systems.');
    }
    const profile = command.profile === false ? '' : profileArgument(args) ?? '';
    if (command.profile !== false && !profile) throw new Error('--profile /absolute/profile/folder is required');
    const option = (key: string): string | undefined => {
      const index = args.indexOf(key);
      if (index === -1) return undefined;
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${key} needs a value`);
      return value;
    };
    await command.run({ args, option, flag: (key) => args.includes(key), profileDir: profile ? resolve(profile) : '', log });
    return 0;
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
};

// Node runs the real path of a symlinked script, so compare real paths: release wrappers may reach this file through a symlink.
const isMain = (): boolean => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (isMain()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
