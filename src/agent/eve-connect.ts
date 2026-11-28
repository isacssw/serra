// Connecting a profile to its agent on Vercel (SB-17): Check, save, and disconnect, for Settings › Worker and Add… ›
// Profile. Check goes through the agent layer like a job does (an ACP backend's `check`: start eve, open a session, no
// prompt), so it costs no model call. Every step refuses before anything is sent unless the owner accepted the notice
// for the URL's host. Secrets: a typed bypass secret goes to the Keychain (or stays a 1Password reference); only where
// it is goes into `agent-backend.json`. Rules and copy: src/agent/eve-cloud.ts.
import { readProfileFile } from '../config.ts';
import { isRecord } from '../json-guards.ts';
import { keychainStore, readStoredSecret, validateSecretSource, type SecretStore } from '../secrets.ts';
import { createAcpBackend } from './acp.ts';
import { readAgentBackend, recordEveCheck, writeEveCloud } from './acp-agents.ts';
import {
  BYPASS_ACCOUNT, EVE_NOTICE_VERSION, eveCloudAgent, eveOutcomeOf, eveSentence, normalizeEveUrl, normalizeTeam, parseBypassInput,
  type EveCheck, type EveCloud, type EveSecret,
} from './eve-cloud.ts';
import { envFor } from './pool.ts';

/** What the window sends: the address, the team, a bypass secret (typed now, or blank to keep the saved one), and the host whose notice the owner accepted. */
export interface EveInput {
  url: string;
  team?: string | null;
  secret?: string | null;
  /** The host the notice named when the owner pressed the button. Nothing is sent unless it is this URL's host. */
  accept: string;
}

export interface EveDeps {
  /** Where a typed secret is kept (tests: a fake); the Keychain otherwise. */
  store?: SecretStore;
  /** Reads a kept secret (tests: a fake); the Keychain or 1Password otherwise. */
  readSecret?: (source: EveSecret) => Promise<string>;
  /** Makes the ACP backend Check runs on (tests: one on the fake agent). */
  makeAcp?: typeof createAcpBackend;
  now?: () => Date;
  /** How long Check waits: the first start fetches eve with npx. */
  timeoutMs?: number;
}

export type EveCheckView = EveCheck & { sentence: string };

/** The window's input, checked: never trusted to be well formed. */
export const eveInput = (value: unknown): EveInput => {
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.accept !== 'string') throw new Error('Enter the agent’s URL.');
  if (value.team !== undefined && value.team !== null && typeof value.team !== 'string') throw new Error('A Vercel team is its short name, like acme.');
  if (value.secret !== undefined && value.secret !== null && typeof value.secret !== 'string') throw new Error('A bypass secret is 16 or more letters and digits.');
  return { url: value.url, accept: value.accept, team: value.team ?? null, secret: value.secret ?? null };
};

/** The address and team from the input, refused unless the notice the owner accepted named this host. */
const accepted = (input: EveInput): { url: string; host: string; team: string | null } => {
  const address = normalizeEveUrl(input.url);
  const team = normalizeTeam(input.team);
  if (input.accept.trim().toLowerCase() !== address.host.toLowerCase()) throw new Error(eveSentence('consent', address.host));
  return { ...address, team };
};

/** A typed 1Password reference, checked as Serra checks the chat tokens' ones. */
const reference = (text: string): EveSecret => {
  const source = validateSecretSource({ kind: '1password', reference: text });
  if (source.kind !== '1password') throw new Error('A 1Password reference looks like op://vault/item/field');
  return source;
};

/**
 * Check: starts eve for the URL, opens a session and stops, with no prompt. A typed secret is used for this start
 * only; blank uses the one saved for the same host. Recorded on the profile when it is its agent's host.
 */
export const checkEve = async (profileDir: string | null, input: EveInput, deps: EveDeps = {}): Promise<EveCheckView> => {
  const address = accepted(input);
  const now = deps.now ?? (() => new Date());
  const saved = profileDir ? readAgentBackend(profileDir).eve : null;
  const typed = parseBypassInput(input.secret);
  const readSaved = deps.readSecret ?? ((source: EveSecret) => readStoredSecret(source));
  let bypass: EveSecret | null = null;
  let readSecret = readSaved;
  if (typed && 'value' in typed) {
    // Never written anywhere: handed to this one start through the same path a saved secret takes.
    bypass = { kind: 'keychain', service: 'dev.serra.check', account: BYPASS_ACCOUNT };
    readSecret = async () => typed.value;
  } else if (typed) bypass = reference(typed.reference);
  else if (saved?.host === address.host) bypass = saved.bypass;
  const cloud: EveCloud = {
    ...address, bypass, secretSavedAt: null, check: null,
    notice: { host: address.host, version: EVE_NOTICE_VERSION, acceptedAt: now().toISOString() },
  };
  const agent = eveCloudAgent(cloud);
  const backend = (deps.makeAcp ?? createAcpBackend)({ agent, env: envFor(agent, readSecret), log: () => {} });
  let check: EveCheck;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(eveSentence('offline', address.host))), deps.timeoutMs ?? 60_000);
    });
    const { version } = await Promise.race([backend.check!(), timeout]);
    check = { at: now().toISOString(), result: 'ok', version };
  } catch (error) {
    check = { at: now().toISOString(), result: eveOutcomeOf(error instanceof Error ? error.message : '', address.host), version: null };
  } finally {
    clearTimeout(timer);
    await backend.close();
  }
  if (profileDir && saved?.host === address.host) recordEveCheck(profileDir, address.host, check);
  return { ...check, sentence: eveSentence(check.result, address.host, check.version) };
};

/** The Keychain item a profile's bypass secret is kept in: the profile's service and Serra's account for it. */
const keychainItem = (profileDir: string): { service: string; account: string } => {
  const profile = readProfileFile(profileDir);
  return { service: profile.serviceLabel ?? `dev.serra.${profile.bot.id}`, account: BYPASS_ACCOUNT };
};

/**
 * Saves the cloud agent on the profile and makes it the agent new work runs on, with the owner's yes to the notice for
 * this host. A typed secret goes to the Keychain first; blank keeps the one saved for the same host. `check` is the
 * last Check's outcome, when one just ran.
 */
export const saveEve = async (profileDir: string, input: EveInput, deps: EveDeps & { check?: EveCheck | null } = {}): Promise<void> => {
  const address = accepted(input);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const saved = readAgentBackend(profileDir).eve;
  const typed = parseBypassInput(input.secret);
  let bypass: EveSecret | null = saved?.host === address.host ? saved.bypass : null;
  let secretSavedAt = saved?.host === address.host ? saved.secretSavedAt : null;
  if (typed && 'value' in typed) {
    const item = keychainItem(profileDir);
    try { await (deps.store ?? keychainStore()).set(item.service, item.account, typed.value); }
    catch (error) {
      if (/only on macOS/.test(error instanceof Error ? error.message : '')) throw new Error('There’s no Keychain here. Paste an op:// reference instead.');
      throw new Error('Serra couldn’t save the bypass secret in the Keychain. Nothing was changed.');
    }
    bypass = { kind: 'keychain', ...item };
    secretSavedAt = now;
  } else if (typed) {
    bypass = reference(typed.reference);
    secretSavedAt = now;
  }
  writeEveCloud(profileDir, {
    ...address, bypass, secretSavedAt,
    notice: { host: address.host, version: EVE_NOTICE_VERSION, acceptedAt: now },
    check: deps.check ?? null,
  });
};

/** Check, then save only when it connected: a failure says why, in one sentence, and changes nothing. */
export const connectEve = async (profileDir: string, input: EveInput, deps: EveDeps = {}): Promise<EveCheckView> => {
  const check = await checkEve(profileDir, input, deps);
  if (check.result !== 'ok') throw new Error(check.sentence);
  await saveEve(profileDir, input, { ...deps, check: { at: check.at, result: check.result, version: check.version } });
  return check;
};

/** Removes the profile's cloud agent and its Keychain item. New work goes back to T3. Refused while it has a run going. */
export const disconnectEve = async (profileDir: string, deps: Pick<EveDeps, 'store'> = {}): Promise<void> => {
  const eve = readAgentBackend(profileDir).eve;
  if (!eve) return;
  writeEveCloud(profileDir, null);
  await forgetEveSecret(eve, deps.store);
};

/** Deletes a cloud agent's Keychain item; a 1Password reference is the owner's and stays. Never throws. */
export const forgetEveSecret = async (eve: Pick<EveCloud, 'bypass'> | null | undefined, store: SecretStore = keychainStore()): Promise<void> => {
  if (eve?.bypass?.kind !== 'keychain') return;
  try { await store.remove(eve.bypass.service, eve.bypass.account); } catch { /* already gone, or no Keychain here */ }
};
