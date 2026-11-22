// The AI providers T3 runs jobs with (SER-27), read from T3's own settings: `<T3 home>/userdata/settings.json`,
// `providerInstances`. Serra never runs a provider itself (T3 is its only agent layer), and never writes these
// settings. Read-only, and only ids, driver kinds, labels and whether each is on leave this module: an instance's
// `config` and `environment` can hold paths and keys, and are never read past `enabled`.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord, parseJson } from './json-guards.ts';

/** A provider kind whose MCP setup Serra can read (src/mcp.ts). Every other T3 driver is listed as not supported yet. */
export type McpReader = 'claude' | 'codex';

export interface T3Provider {
  /** The instance id T3 and `worker.provider` use: `claudeAgent`, `codex`, `cursor`, or a custom instance's id. */
  instanceId: string;
  /** T3's driver kind: `claudeAgent`, `codex`, `cursor`, `antigravity`, … */
  driver: string;
  /** The name T3 shows: the instance's display name, else the driver's. */
  label: string;
  enabled: boolean;
  /** Which of Serra's MCP readers covers it, or null: Serra can't read that provider's setup yet. */
  mcp: McpReader | null;
}

export interface T3Providers {
  providers: T3Provider[];
  /** T3's default provider instance for new threads, when its settings name one. */
  defaultInstance: string | null;
  defaultModel: string | null;
}

/**
 * The drivers this T3 build knows, with the names T3 shows and whether a fresh install has them on. T3 makes one
 * built-in instance per driver (its id is the driver's), except ACP Registry, which has only instances people add.
 */
const KNOWN_DRIVERS: readonly { driver: string; label: string; on: boolean; builtIn: boolean }[] = [
  { driver: 'claudeAgent', label: 'Claude', on: true, builtIn: true },
  { driver: 'codex', label: 'Codex', on: true, builtIn: true },
  { driver: 'cursor', label: 'Cursor', on: false, builtIn: true },
  { driver: 'antigravity', label: 'Antigravity', on: false, builtIn: true },
  { driver: 'grok', label: 'Grok', on: false, builtIn: true },
  { driver: 'opencode', label: 'OpenCode', on: false, builtIn: true },
  { driver: 'kiro', label: 'Kiro', on: false, builtIn: true },
  { driver: 'muse', label: 'Muse Code', on: false, builtIn: true },
  { driver: 'pi', label: 'Pi', on: false, builtIn: true },
  { driver: 'fx', label: 'fx', on: false, builtIn: true },
  { driver: 'acpRegistry', label: 'ACP Registry', on: false, builtIn: false },
];

const MCP_READERS: Record<string, McpReader> = { claudeAgent: 'claude', codex: 'codex' };

/** An id or label worth showing: no control characters, not a paragraph. */
const SAFE = /^[\p{L}\p{N}_ .:@/+&()'-]{1,60}$/u;

/** The providers in T3's settings JSON. Pure: unknown fields are ignored, and settings that aren't an object give the defaults. */
export const t3Providers = (settings: unknown): T3Providers => {
  const root = isRecord(settings) ? settings : {};
  const instances = isRecord(root.providerInstances) ? root.providerInstances : {};
  const providers: T3Provider[] = [];
  const known = new Map(KNOWN_DRIVERS.map((entry) => [entry.driver, entry]));
  const make = (instanceId: string, driver: string, instance: Record<string, unknown>): T3Provider => {
    const spec = known.get(driver);
    const config = isRecord(instance.config) ? instance.config : {};
    // T3 reads `enabled` from the instance, else its driver settings, else the driver's default.
    const enabled = typeof instance.enabled === 'boolean' ? instance.enabled : typeof config.enabled === 'boolean' ? config.enabled : spec?.on ?? false;
    const named = typeof instance.displayName === 'string' && SAFE.test(instance.displayName.trim()) ? instance.displayName.trim() : null;
    return { instanceId, driver, label: named ?? spec?.label ?? driver, enabled, mcp: MCP_READERS[driver] ?? null };
  };
  for (const spec of KNOWN_DRIVERS) {
    if (!spec.builtIn) continue;
    const own = instances[spec.driver];
    providers.push(make(spec.driver, spec.driver, isRecord(own) && own.driver === spec.driver ? own : {}));
  }
  for (const [instanceId, instance] of Object.entries(instances)) {
    if (!isRecord(instance) || typeof instance.driver !== 'string' || !SAFE.test(instanceId) || !SAFE.test(instance.driver)) continue;
    if (known.get(instanceId)?.builtIn && instance.driver === instanceId) continue;
    providers.push(make(instanceId, instance.driver, instance));
  }
  const selection = isRecord(root.defaultModelSelection) ? root.defaultModelSelection : {};
  const defaultInstance = typeof selection.instanceId === 'string' && SAFE.test(selection.instanceId) ? selection.instanceId : null;
  const defaultModel = typeof selection.model === 'string' && SAFE.test(selection.model) ? selection.model : null;
  return { providers, defaultInstance, defaultModel };
};

/** T3's data folder: `T3CODE_HOME`, as T3's own launcher sets it, else `~/.t3`. */
const t3Home = (home: string = homedir(), env: Record<string, string | undefined> = process.env): string =>
  env.T3CODE_HOME?.trim() || join(home, '.t3');

/** T3's providers on this Mac, or null when its settings can't be read (T3 not installed, or a format Serra doesn't know). */
export const readT3Providers = ({ home, env }: { home?: string; env?: Record<string, string | undefined> } = {}): T3Providers | null => {
  let text: string;
  try { text = readFileSync(join(t3Home(home, env), 'userdata', 'settings.json'), 'utf8'); } catch { return null; }
  const value = parseJson(text);
  return isRecord(value) ? t3Providers(value) : null;
};

/** The provider a `worker.provider` instance id names, or null when T3 has no such instance. */
export const providerFor = (list: T3Providers, instanceId: string): T3Provider | null =>
  list.providers.find((provider) => provider.instanceId === instanceId) ?? null;
