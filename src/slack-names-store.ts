/**
 * The Slack names the app shows (APP-29), without the bot token (SERRA-55). The app never reads the token for names:
 * it asks the running bot, which already holds it, over the status socket (`requestNames`), and keeps what it learns in
 * the profile's `slack-names.json` (names only, mode 600), so a launch shows known names with no lookup at all.
 *
 * Like `createSlackNames`, it never blocks: `userName` and `channelName` answer from the cache (an expired name is
 * still shown while it is refreshed), and `request` asks the bot for the rest in the background, then calls
 * `onResolved`. When the bot is stopped, older, or slow, rows keep the cached name or the raw ID, one line is logged,
 * and the bot is asked again after a backoff. An ID the bot couldn't name waits `retryMs` before it is asked again.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DM_LABEL, isSlackBotId, isSlackChannelId, isSlackUserId, type SlackNames } from './slack-names.ts';
import { MAX_NAME_IDS, type NamesReply } from './status-socket.ts';

export const SLACK_NAMES_FILE = 'slack-names.json';
/** The file keeps at most this many names; the oldest go first. */
export const MAX_STORED_NAMES = 2_000;

/** Asks the bot to name these IDs. Null when it doesn't answer. Never rejects. */
export type NamesAsk = (ids: { users: string[]; channels: string[] }) => Promise<NamesReply | null>;

export interface StoredSlackNamesOptions {
  profileDir: string;
  /** How the bot is asked. The app passes `requestNames` on the profile's status socket; tests pass a fake. */
  ask: NamesAsk;
  /** How long a name is fresh (default 6 h). After that it is still shown, and asked for again. */
  ttlMs?: number;
  /** How long an ID the bot couldn't name waits before it is asked again (default 10 min). */
  retryMs?: number;
  /** The first wait after the bot didn't answer (default 15 s); it doubles up to `maxBackoffMs` (default 5 min). */
  backoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  /** Called once an answer brought at least one new name. */
  onResolved?: () => void;
  /** Where "the bot isn't answering" is reported, once until it answers again. */
  log?: (message: string) => void;
}

interface Stored { name: string; at: number }

const validId = (id: string): boolean => isSlackUserId(id) || isSlackBotId(id) || isSlackChannelId(id);

/** The names in the file. A missing, unreadable or corrupt file is empty; entries that don't look right are dropped. */
export const readStoredNames = (profileDir: string): Map<string, Stored> => {
  const names = new Map<string, Stored>();
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(profileDir, SLACK_NAMES_FILE), 'utf8')); } catch { return names; }
  const entries = (value as { version?: unknown; names?: unknown } | null);
  if (typeof entries !== 'object' || entries === null || entries.version !== 1 || typeof entries.names !== 'object' || entries.names === null) return names;
  for (const [id, entry] of Object.entries(entries.names as Record<string, unknown>)) {
    const { name, at } = (entry ?? {}) as { name?: unknown; at?: unknown };
    if (validId(id) && typeof name === 'string' && name.trim() && typeof at === 'number' && Number.isFinite(at)) names.set(id, { name, at });
  }
  return names;
};

/** Writes the newest `MAX_STORED_NAMES` names atomically, readable by the owner only, and returns what it kept. */
const writeStoredNames = (profileDir: string, names: Map<string, Stored>): Map<string, Stored> => {
  const kept = [...names].sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_STORED_NAMES);
  const path = join(profileDir, SLACK_NAMES_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, names: Object.fromEntries(kept) })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Names are a convenience: a profile that can't be written keeps them in memory for this run.
    rmSync(temp, { force: true });
  }
  return new Map(kept);
};

export const createStoredSlackNames = ({
  profileDir, ask, ttlMs = 6 * 60 * 60_000, retryMs = 10 * 60_000, backoffMs = 15_000, maxBackoffMs = 5 * 60_000,
  now = () => Date.now(), onResolved = () => {}, log = () => {},
}: StoredSlackNamesOptions): SlackNames => {
  let names: Map<string, Stored> | null = null;
  const loaded = (): Map<string, Stored> => (names ??= readStoredNames(profileDir));
  const inFlight = new Set<string>();
  /** IDs the bot answered without a name, and when they may be asked again. Memory only. */
  const unnamed = new Map<string, number>();
  let quietUntil = 0;
  let wait = backoffMs;
  let reported = false;

  const cached = (id: string): string | undefined => loaded().get(id)?.name;
  const wanted = (id: string): boolean => {
    const entry = loaded().get(id);
    return !(entry && entry.at + ttlMs > now()) && !inFlight.has(id) && (unnamed.get(id) ?? 0) <= now();
  };

  const request: SlackNames['request'] = async ({ users = [], channels = [] }) => {
    if (quietUntil > now()) return false;
    const askUsers = [...new Set(users)].filter((id) => (isSlackUserId(id) || isSlackBotId(id)) && wanted(id)).slice(0, MAX_NAME_IDS);
    // A DM's label is known without asking.
    const askChannels = [...new Set(channels)].filter((id) => isSlackChannelId(id) && !id.startsWith('D') && wanted(id))
      .slice(0, MAX_NAME_IDS - askUsers.length);
    const asked = [...askUsers, ...askChannels];
    if (asked.length === 0) return false;
    for (const id of asked) inFlight.add(id);
    let reply: NamesReply | null = null;
    try { reply = await ask({ users: askUsers, channels: askChannels }); } catch { reply = null; }
    finally { for (const id of asked) inFlight.delete(id); }

    if (!reply) {
      if (!reported) log('[serra] Slack names: the bot didn\'t answer (stopped, or not updated yet). Jobs shows the names it knows and asks again later.');
      reported = true;
      quietUntil = now() + wait;
      wait = Math.min(wait * 2, maxBackoffMs);
      return false;
    }
    reported = false;
    wait = backoffMs;
    let found = false;
    const store = loaded();
    const answered = { ...reply.users, ...reply.channels };
    for (const id of asked) {
      const name = answered[id];
      if (typeof name === 'string' && name.trim()) {
        if (store.get(id)?.name !== name) found = true;
        store.set(id, { name, at: now() });
        unnamed.delete(id);
      } else {
        unnamed.set(id, now() + retryMs);
      }
    }
    if (asked.some((id) => store.has(id))) names = writeStoredNames(profileDir, store);
    if (found) {
      try { onResolved(); } catch { /* a listener's failure isn't the lookup's */ }
    }
    return found;
  };

  return {
    userName: (id) => cached(id),
    channelName: (id) => (id.startsWith('D') && isSlackChannelId(id) ? DM_LABEL : cached(id)),
    request: (ids) => request(ids).catch(() => false),
  };
};
