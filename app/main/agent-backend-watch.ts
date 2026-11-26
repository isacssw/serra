// Pushes `agentBackend` to the window when `agent-backend.json` in the profile changes, so a custom ACP agent edited
// by hand in the config file shows up in Settings › Worker live without a restart. Follows the profile when Settings
// picks another one. Free of Electron, so tests drive it with a real folder.
import { join } from 'node:path';
import { AGENT_BACKEND_FILE } from '../../src/agent/acp-agents.ts';
import { watchAgentBackend, type ProfileWatcher } from '../../src/profile-reload.ts';

export interface AgentBackendFollower {
  /** Watches this profile's `agent-backend.json` instead, or nothing for null. The same folder again changes nothing. */
  follow(profileDir: string | null): void;
  close(): void;
}

export const followAgentBackend = (
  changed: () => void,
  { debounceMs = 200, log = (message: string) => console.error(message) }: { debounceMs?: number; log?: (message: string) => void } = {},
): AgentBackendFollower => {
  let current: string | null = null;
  let watcher: ProfileWatcher | null = null;
  return {
    follow(profileDir) {
      if (profileDir === current) return;
      watcher?.close();
      watcher = null;
      current = profileDir;
      if (!profileDir) return;
      watcher = watchAgentBackend(profileDir, changed, {
        debounceMs,
        onError: (error) => log(`[serra] not watching ${join(profileDir, AGENT_BACKEND_FILE)}: ${error.message}`),
      });
    },
    close() {
      watcher?.close();
      watcher = null;
      current = null;
    },
  };
};
