import { readProfileFile } from '../config.ts';
import type { Command } from '../manage.ts';
import type { SecretSource, SecretStatus } from '../contracts.ts';
import {
  checkSecret, defaultKeychainSource, isSecretName, SECRET_NAMES, secretStatus, setSecret, sourceLabel,
} from '../secrets.ts';

const VALUE_FLAGS = ['--profile', '--1password', '--service', '--account'];

/** Arguments after the command name, without flags and their values. */
const positionals = (args: string[]): string[] =>
  args.slice(1).filter((arg, index, rest) => !arg.startsWith('--') && !VALUE_FLAGS.includes(rest[index - 1]!));

const describe = (status: SecretStatus): string => {
  const source = status.source.kind === 'keychain' ? `Keychain ${status.source.service} / ${status.source.account}`
    : status.source.kind === '1password' ? `1Password ${status.source.reference}` : sourceLabel(status.source);
  const state = status.error ? `error: ${status.error}`
    : status.verifiedAt ? `verified ${status.verifiedAt}` : status.set ? 'set, not checked' : 'not set';
  return `${status.name}  ${source}  ${state}`;
};

/** The token for a Keychain item, from stdin. Never from argv, where shell history and `ps` would keep it. */
const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) throw new Error('Pipe the token on stdin, like: pbpaste | pnpm bot secrets set SLACK_BOT_TOKEN --keychain --profile ...');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
};

const command: Command = {
  summary: 'Show where the Slack tokens come from, move them to the Keychain or 1Password, and check them with Slack.',
  usage: [
    'pnpm bot secrets --profile /absolute/profile',
    'pbpaste | pnpm bot secrets set SLACK_BOT_TOKEN --keychain [--service dev.serra.friday --account SLACK_BOT_TOKEN] --profile /absolute/profile',
    'pnpm bot secrets set SLACK_BOT_TOKEN --keychain --existing --service dev.serra.friday --account SLACK_BOT_TOKEN --profile /absolute/profile',
    'pnpm bot secrets set SLACK_APP_TOKEN --1password op://vault/item/field --profile /absolute/profile',
    'pnpm bot secrets set SLACK_APP_TOKEN --env --profile /absolute/profile',
    'pnpm bot secrets check [SLACK_BOT_TOKEN] --profile /absolute/profile',
  ],
  async run({ args, option, flag, profileDir, log }) {
    const [action = 'list', name, ...extra] = positionals(args);
    if (extra.length) throw new Error(`Unexpected arguments: ${extra.join(' ')}`);
    if (name !== undefined && !isSecretName(name)) throw new Error(`Unknown token: ${name}. Use ${SECRET_NAMES.join(' or ')}`);
    if (action === 'list') {
      if (name) throw new Error('secrets takes no token name. Use secrets check <name>');
      for (const status of await secretStatus(profileDir)) log(describe(status));
      return;
    }
    if (action === 'check') {
      let failed = false;
      for (const each of name ? [name] : SECRET_NAMES) {
        const status = await checkSecret(profileDir, each);
        failed ||= Boolean(status.error);
        log(describe(status));
      }
      if (failed) throw new Error('A token check failed.');
      return;
    }
    if (action !== 'set') throw new Error(`Unknown secrets action: ${action}. Use list, set or check.`);
    if (!name) throw new Error(`secrets set needs a token: ${SECRET_NAMES.join(' or ')}`);
    const reference = option('--1password');
    const kinds = [flag('--keychain'), reference !== undefined, flag('--env')].filter(Boolean).length;
    if (kinds !== 1) throw new Error('secrets set needs exactly one of --keychain, --1password op://vault/item/field or --env');
    let source: SecretSource;
    let value: string | undefined;
    if (flag('--keychain')) {
      const fallback = defaultKeychainSource(readProfileFile(profileDir), name);
      source = { kind: 'keychain', service: option('--service') ?? fallback.service, account: option('--account') ?? fallback.account };
      if (!flag('--existing')) value = await readStdin();
    } else if (reference !== undefined) source = { kind: '1password', reference };
    else source = { kind: 'env' };
    const status = await setSecret(profileDir, name, source, value);
    log(describe(status));
    log(`${name} now comes from ${sourceLabel(status.source)}. Applies after restart. Run pnpm bot secrets check ${name} to test it with Slack.`);
    if (value !== undefined) log('Remove the token from the profile .env once the check passes.');
  },
};
export default command;
