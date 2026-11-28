// Forwarding the daemon's live status (src/status-source.ts) to the window.
import type { BotEvent, BotStatus } from '../../src/contracts.ts';
import { STOPPED, type StatusSource } from '../../src/status-source.ts';

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
