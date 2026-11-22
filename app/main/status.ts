// The daemon's live status as the main process sees it, and its forwarding to the window.
// `socketStatusSource` follows the profile's `status.sock` (APP-6's client); `stoppedStatusSource` is what the app
// shows with no daemon to talk to.
import type { BotEvent, BotStatus, StatusMessage } from '../../src/contracts.ts';
import { subscribeStatus } from '../../src/status-socket.ts';

interface StatusListener {
  status(status: BotStatus): void;
  event(event: BotEvent): void;
}

/** Where live status comes from. A source never throws for a missing daemon: it reports `stopped`. */
export interface StatusSource {
  current(): BotStatus;
  subscribe(listener: StatusListener): () => void;
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
    setStatus(STOPPED);
    if (next === null) return;
    // Messages from an earlier profile's subscription may still be in flight; only the latest one counts.
    subscription = subscribe(next, (message) => {
      if (closed || generation !== generations) return;
      if (message.type === 'status') setStatus(message.status);
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
    follow,
    close: () => {
      closed = true;
      subscription?.close();
      subscription = null;
      listeners.clear();
    },
  };
};

/** The window side of forwarding, so it can be faked in tests. `send` may throw once the window is gone. */
export interface StatusTarget {
  isDestroyed(): boolean;
  send(channel: 'status' | 'event', payload: BotStatus | BotEvent): void;
}

/**
 * Sends the current status to the window now and on every change, and each daemon event as it happens.
 * A source or window failure is logged and reported as `stopped`; it never takes the main process down.
 * Call `resend()` after the window (re)loads, since a reload drops what it was sent before.
 */
export const forwardStatus = (source: StatusSource, target: StatusTarget, log: (message: string) => void = console.error): { resend(): void; stop(): void } => {
  const send = (channel: 'status' | 'event', payload: BotStatus | BotEvent): void => {
    if (target.isDestroyed()) return;
    try { target.send(channel, payload); }
    catch (error) { log(`[serra] could not send ${channel} to the window: ${String(error)}`); }
  };
  const current = (): BotStatus => {
    try { return source.current(); }
    catch (error) { log(`[serra] status source failed: ${String(error)}`); return STOPPED; }
  };
  let unsubscribe: () => void = () => {};
  try {
    unsubscribe = source.subscribe({ status: (status) => send('status', status), event: (event) => send('event', event) });
  } catch (error) {
    log(`[serra] could not subscribe to status: ${String(error)}`);
  }
  send('status', current());
  return {
    resend: () => send('status', current()),
    stop: () => { try { unsubscribe(); } catch { /* already gone */ } },
  };
};
