/**
 * A clock tests move by hand. `advance(ms)` fires every timer due in that span in time order (ties in the order they
 * were set), settling after each one, so a test never sleeps and never races a real timer.
 */
import type { Clock, Timer } from '../../src/clock.ts';

export interface FakeClock extends Clock {
  /** Moves time forward, firing due timers in order and settling after each. */
  advance(ms: number): Promise<void>;
  /** Runs what is runnable now without moving time. */
  settle(): Promise<void>;
  /** Also waits for this after each step (for example `daemon.idle`), on top of letting promises run. */
  settleWith(wait: () => Promise<void>): void;
  /** Timers still set, for asserting nothing is left behind. */
  pending(): number;
}

type Entry = { at: number; seq: number; callback: () => void; every?: number };

/** Lets every promise that can run now run, including ones queued behind I/O callbacks of in-process fakes. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

export const fakeClock = (start: string | number = '2026-11-20T10:00:00Z'): FakeClock => {
  let now = typeof start === 'number' ? start : Date.parse(start);
  let seq = 0;
  const timers = new Map<Timer, Entry>();
  const waits: (() => Promise<void>)[] = [];

  const settle = async (): Promise<void> => {
    await flush();
    for (const wait of waits) await wait();
    await flush();
  };
  const set = (callback: () => void, ms: number, every?: number): Timer => {
    const handle = {};
    timers.set(handle, { at: now + Math.max(0, ms), seq: seq++, callback, ...(every === undefined ? {} : { every: Math.max(1, every) }) });
    return handle;
  };
  const clear = (timer: Timer | undefined): void => { if (timer) timers.delete(timer); };

  return {
    now: () => now,
    setTimeout: (callback, ms) => set(callback, ms),
    clearTimeout: clear,
    setInterval: (callback, ms) => set(callback, ms, ms),
    clearInterval: clear,
    settle,
    settleWith: (wait) => { waits.push(wait); },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, entry]) => entry.at <= target).sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq)[0];
        if (!due) break;
        const [handle, entry] = due;
        now = Math.max(now, entry.at);
        if (entry.every === undefined) timers.delete(handle);
        else timers.set(handle, { ...entry, at: entry.at + entry.every, seq: seq++ });
        entry.callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
};
