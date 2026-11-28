// A profile's tokens during a move (SB-34, ux-rules E12): read on the source from wherever they come from, and written
// on the target into that host's own store, never into a copy, a backup or a log. A Mac keeps them in the Keychain;
// a server without one keeps them in the profile's `.env` (mode 600). A 1Password reference travels as the reference,
// never as its value, and needs `op` signed in on the target.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProfileFile } from '../config.ts';
import type { SecretName } from '../contracts.ts';
import { writeFileAtomic } from '../lib/atomic.ts';
import {
  defaultKeychainSource, keychainStore, readSecretsFile, SECRET_NAMES, setSecret, type SecretOptions, type SecretStore,
} from '../secrets.ts';
import { envTokens, type MoveSecret, type SecretPort } from './host.ts';

/** Writes `values` into the profile's `.env`, keeping its other lines, private to the user. */
const writeEnvTokens = (profileDir: string, values: Partial<Record<SecretName, string>>): void => {
  const path = join(profileDir, '.env');
  const names = new Set(Object.keys(values));
  const kept = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() && !names.has(line.split('=')[0]!.trim()))
    : [];
  const lines = [...kept, ...Object.entries(values).map(([name, value]) => `${name}=${value}`)];
  writeFileAtomic(path, `${lines.join('\n')}\n`, { mode: 0o600 });
};

const isValue = (value: string): boolean => /^[\x21-\x7e]{1,4096}$/.test(value);

/**
 * The tokens' store on this host. `keychain`: this Mac's Keychain (tokens go in the profile's default item, as setup
 * puts them); otherwise the profile's `.env`.
 */
export const secretPort = ({ keychain, store = keychainStore(), options = {} }: {
  keychain: boolean;
  store?: SecretStore;
  options?: SecretOptions;
}): SecretPort => ({
  async read(profileDir) {
    const file = readSecretsFile(profileDir);
    const fromEnv = envTokens(profileDir);
    const found: MoveSecret[] = [];
    for (const name of SECRET_NAMES) {
      const source = file.sources[name];
      if (source?.kind === '1password') { found.push({ name, reference: source.reference }); continue; }
      const value = source?.kind === 'keychain' ? await store.get(source.service, source.account) : fromEnv[name];
      if (value) found.push({ name, value });
    }
    return found;
  },
  async write(profileDir, secrets) {
    const profile = readProfileFile(profileDir);
    const values: Partial<Record<SecretName, string>> = {};
    for (const secret of secrets) {
      if (!SECRET_NAMES.includes(secret.name)) throw new Error('A token arrived that this host doesn’t know.');
      if (secret.reference !== undefined) { await setSecret(profileDir, secret.name, { kind: '1password', reference: secret.reference }, undefined, options); continue; }
      if (secret.value === undefined || !isValue(secret.value)) throw new Error(`${secret.name} arrived empty or malformed.`);
      if (keychain) await setSecret(profileDir, secret.name, defaultKeychainSource(profile, secret.name), secret.value, options);
      else values[secret.name] = secret.value;
    }
    if (!keychain) {
      if (Object.keys(values).length) writeEnvTokens(profileDir, values);
      // The copy's sources may name the other computer's Keychain, which isn't here: those tokens are in `.env` now.
      const file = readSecretsFile(profileDir);
      for (const name of SECRET_NAMES) if (file.sources[name]?.kind === 'keychain') await setSecret(profileDir, name, { kind: 'env' }, undefined, options);
    }
  },
});
