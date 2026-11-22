/**
 * Time, as one injected dependency. The daemon, the bot and its batcher read the time and set timers only through a
 * `Clock`, so tests drive time with a fake one (`tests/fakes/clock.ts`) instead of sleeping, and every timer fires in
 * a known order.
 */

/** A timer handle. Opaque: only the clock that made it can clear it. */
export type Timer = object;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer | undefined): void;
  setInterval(callback: () => void, ms: number): Timer;
  clearInterval(timer: Timer | undefined): void;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout | undefined),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout | undefined),
};

/**
 * Work in flight that a caller may wait for. `idle()` resolves once nothing tracked is running, including work that
 * tracked work started meanwhile: what a test waits on instead of a sleep, and what shutdown drains.
 */
export const createTracker = () => {
  const running = new Set<Promise<unknown>>();
  return {
    track<T>(work: Promise<T>): Promise<T> {
      running.add(work);
      void work.then(() => running.delete(work), () => running.delete(work));
      return work;
    },
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
    get size(): number { return running.size; },
  };
};
