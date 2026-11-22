// Secrets (APP-15), on APP-8's token sources in `src/secrets.ts`. Only sources and check results go back to the
// window, never a token's value. A value the owner types for a Keychain item arrives here in `setSource`, goes to
// `setSecret` (which hands it to `security` on stdin) and is never returned, logged or echoed in an error.
import { readProfileFile } from '../../../src/config.ts';
import type { SecretName, SecretSource, SecretStatus } from '../../../src/contracts.ts';
import {
  checkSecret, defaultKeychainSource, isSecretName, scrub, SECRET_NAMES, secretStatus, setSecret,
  type SecretOptions, type SlackVerify,
} from '../../../src/secrets.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

/** Tests swap the `security`/`op` binaries and Slack's verification for fakes. */
export interface SecretsHandlerOptions extends SecretOptions {
  verify?: SlackVerify;
}

const secretName = (name: unknown): SecretName => {
  if (!isSecretName(name)) throw new Error(`Unknown token. Use ${SECRET_NAMES.join(' or ')}.`);
  return name;
};

/** Copies only the contract's fields, so nothing else a service might add can reach the window. */
const plainSource = (source: SecretSource): SecretSource =>
  source.kind === 'keychain' ? { kind: 'keychain', service: source.service, account: source.account }
    : source.kind === '1password' ? { kind: '1password', reference: source.reference }
      : { kind: 'env' };

const plainStatus = (status: SecretStatus): SecretStatus => ({
  name: status.name,
  source: plainSource(status.source),
  set: status.set === true,
  verifiedAt: typeof status.verifiedAt === 'string' ? status.verifiedAt : null,
  error: typeof status.error === 'string' ? status.error : null,
});

/** Runs `action` and rethrows its error with `value` and anything token-shaped removed from the message. */
const hiding = async <T>(value: string | undefined, action: () => Promise<T>): Promise<T> => {
  try { return await action(); }
  catch (error) { throw new Error(scrub(error instanceof Error ? error.message : String(error), [value])); }
};

export const secretsHandlers = (context: HandlerContext, options: SecretsHandlerOptions = {}): Handlers<'secrets'> => ({
  list: async () => (await secretStatus(context.profileDir(), options)).map(plainStatus),

  setSource: async (name, source, value) => {
    const token = secretName(name);
    if (value !== undefined && typeof value !== 'string') throw new Error('A token value must be text.');
    const typed = typeof value === 'string' && value.trim() ? value : undefined;
    return hiding(typed, async () => {
      const dir = context.profileDir();
      // A Keychain source with no service and account means the bot's default item for this token.
      const chosen = source && typeof source === 'object' && source.kind === 'keychain' && !source.service && !source.account
        ? defaultKeychainSource(readProfileFile(dir), token)
        : source;
      return plainStatus(await setSecret(dir, token, chosen, typed, options));
    });
  },

  check: async (name) => plainStatus(await checkSecret(context.profileDir(), secretName(name), options)),
});
