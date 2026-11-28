// The daemon's live status as the core sees it. `socketStatusSource` follows the profile's `status.sock` (APP-6's
// client); `stoppedStatusSource` is what is shown with no daemon to talk to. The app forwards it to the window
// (app/main/status.ts).
import type { BotEvent, BotStatus, StatusMessage } from './contracts.ts';
import { subscribeStatus } from './status-socket.ts';

interface StatusListener {
  status(status: BotStatus): void;
  event(event: BotEvent): void;
}

/** Where live status comes from. A source never throws for a missing daemon: it reports `stopped`. */
export interface StatusSource {
  current(): BotStatus;
  subscribe(listener: StatusListener): () => void;
  /**
   * Resolves once the profile followed now has reported (or after `timeoutMs`), so a window that just switched
   * profiles asks for the new one's status, not the `stopped` reported while it connects. Absent: no wait.
   */
  settled?(timeoutMs: number): Promise<void>;
}

export const STOPPED: BotStatus = { state: 'stopped' };

/** A source for when there is no daemon to talk to. */
export const stoppedStatusSource = (): StatusSource => ({
  current: () => STOPPED,
  subscribe: () => () => {},
});

/** How `socketStatusSource` reaches the daemon: APP-6's `subscribeStatus`, or a fake in tests. */
export type StatusSubscriber = (profileDir: string, listener: (message: StatusMessage) => void) => { close(): void };

/** A status source that can switch to another profile (or none) and be shut down. */
export interface FollowingStatusSource extends StatusSource {
  /** Follows the daemon of `profileDir` from now on. The same folder again changes nothing. */
  follow(profileDir: string | null): void;
  /** Stops following. Listeners hear nothing more. */
  close(): void;
}

/**
 * Live status from the daemon's `status.sock` in the profile. Reports `stopped` while there is no profile, before
 * the daemon answers, and whenever it goes away; the subscriber reconnects on its own when it comes back.
 * Switching profiles reports `stopped` until the new daemon answers, so the old profile's state never lingers.
 */
export const socketStatusSource = (profileDir: string | null, subscribe: StatusSubscriber = subscribeStatus): FollowingStatusSource => {
  const listeners = new Set<StatusListener>();
  let current: BotStatus = STOPPED;
  let following: string | null = null;
  let subscription: { close(): void } | null = null;
  let closed = false;
  let generations = 0;
  /** Whether the profile followed now has reported, and who waits for that. */
  let heard = false;
  let waiting: (() => void)[] = [];
  const hear = (): void => {
    heard = true;
    for (const wake of waiting.splice(0)) wake();
  };

  const each = (call: (listener: StatusListener) => void): void => {
    for (const listener of [...listeners]) {
      try { call(listener); } catch { /* A listener's failure is its own. */ }
    }
  };
  const setStatus = (status: BotStatus): void => {
    if (JSON.stringify(status) === JSON.stringify(current)) return;
    current = status;
    each((listener) => listener.status(status));
  };

  const follow = (next: string | null): void => {
    if (closed || next === following) return;
    subscription?.close();
    subscription = null;
    following = next;
    const generation = ++generations;
    heard = false;
    setStatus(STOPPED);
    if (next === null) { hear(); return; }
    // Messages from an earlier profile's subscription may still be in flight; only the latest one counts.
    subscription = subscribe(next, (message) => {
      if (closed || generation !== generations) return;
      if (message.type === 'status') { setStatus(message.status); hear(); }
      else each((listener) => listener.event(message.event));
    });
  };

  follow(profileDir);
  return {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    settled: (timeoutMs) => (heard || closed ? Promise.resolve() : new Promise<void>((done) => {
      const wake = (): void => { clearTimeout(timer); done(); };
      const timer = setTimeout(() => { waiting = waiting.filter((entry) => entry !== wake); done(); }, timeoutMs);
      waiting.push(wake);
    })),
    follow,
    close: () => {
      closed = true;
      for (const wake of waiting.splice(0)) wake();
      subscription?.close();
      subscription = null;
      listeners.clear();
    },
  };
};
