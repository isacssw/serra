// The app's Slack names (APP-29), one cache per profile, shared by Jobs and Settings › People. The running bot names
// the IDs over the status socket, so the app never reads the bot token (SERRA-55); names are kept in the profile's
// `slack-names.json`.
import type { SlackNames } from '../../../src/slack-names.ts';
import { createStoredSlackNames, type NamesAsk } from '../../../src/slack-names-store.ts';
import { requestNames } from '../../../src/status-socket.ts';
import type { HandlerContext } from './context.ts';

/** Tests pass a fake `ask` or a timeout. */
export interface SlackNamesDeps {
  ask?: (profileDir: string) => NamesAsk; timeoutMs?: number; ttlMs?: number; retryMs?: number; backoffMs?: number;
  log?: (message: string) => void;
}

/** The names cache of a profile, made on first use. */
export type ProfileNames = (profileDir: string) => SlackNames;

export const profileSlackNames = (context: HandlerContext, deps: SlackNamesDeps = {}): ProfileNames => {
  // One cache per profile: another profile may be another Slack workspace.
  const byProfile = new Map<string, SlackNames>();
  return (profileDir) => {
    let names = byProfile.get(profileDir);
    if (!names) {
      names = createStoredSlackNames({
        profileDir,
        ask: deps.ask?.(profileDir) ?? ((ids) => requestNames(profileDir, ids, deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {})),
        ...(deps.ttlMs ? { ttlMs: deps.ttlMs } : {}),
        ...(deps.retryMs ? { retryMs: deps.retryMs } : {}),
        ...(deps.backoffMs ? { backoffMs: deps.backoffMs } : {}),
        // Only the newest profile's names refresh the screens; a switch away makes the old cache quiet.
        onResolved: () => {
          if (context.profileDirOrNull() !== profileDir) return;
          context.push?.('jobs', null);
          context.push?.('names', null);
        },
        log: deps.log ?? console.error,
      });
      byProfile.set(profileDir, names);
    }
    return names;
  };
};
