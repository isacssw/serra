/**
 * The real daemon (`startDaemon`) under test. Slack's events go in as the envelopes Slack sends, through a real Bolt
 * `App` and its middleware (only the socket is replaced, by `TestReceiver`), Web API calls come out on the recording
 * fake Slack, T3 is the scriptable fake, and time is a fake clock. `restart` stops the daemon cleanly and starts a new
 * one on the same profile; `crash` abandons it wherever it is (typically held inside a Slack call) and starts a new one.
 */
import { App, LogLevel, type Logger, type Receiver, type ReceiverEvent } from '@slack/bolt';
import type { TestContext } from 'node:test';
import type { Clock, Timer } from '../../src/clock.ts';
import type { Config } from '../../src/config.ts';
import { startDaemon, type Daemon, type DaemonDeps } from '../../src/daemon.ts';
import { createKnowledge } from '../../src/knowledge.ts';
import { existsSync, readFileSync } from 'node:fs';
import { fakeClock, type FakeClock } from './clock.ts';
import { testProfile, BOT, type ProfileOverrides } from './profile.ts';
import { createFakeSlack, type FakeSlack, type FakeSlackOptions } from './slack.ts';
import { createFakeT3, type FakeT3, type FakeT3Options } from './t3.ts';

/** Delivers envelopes to the app the way Bolt's Socket Mode receiver does, and reports whether each was acked. */
export class TestReceiver implements Receiver {
  private app: App | null = null;
  init(app: App): void { this.app = app; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  /** `gaveUp`: stop waiting for the listeners when it resolves (a call they made hangs: the process died there). */
  async deliver(body: Record<string, unknown>, gaveUp: Promise<void> = new Promise(() => {})): Promise<{ acked: boolean }> {
    if (!this.app) throw new Error('The app is not started');
    let acked = false;
    const event: ReceiverEvent = { body, ack: async () => { acked = true; } };
    await Promise.race([this.app.processEvent(event), gaveUp]);
    return { acked };
  }
}

const quietLogger = (lines: string[]): Logger => ({
  debug: () => {}, info: (...args) => { lines.push(`info: ${args.join(' ')}`); }, warn: (...args) => { lines.push(`warn: ${args.join(' ')}`); },
  error: (...args) => { lines.push(`error: ${args.join(' ')}`); }, setLevel: () => {}, getLevel: () => LogLevel.INFO, setName: () => {},
});

/** A view of the clock whose timers can all be dropped at once: what a crashed process leaves behind. */
const scopedClock = (clock: Clock): Clock & { dropAll(): void } => {
  const mine = new Set<Timer>();
  return {
    now: () => clock.now(),
    setTimeout: (callback, ms) => { const timer = clock.setTimeout(() => { mine.delete(timer); callback(); }, ms); mine.add(timer); return timer; },
    clearTimeout: (timer) => { if (timer) mine.delete(timer); clock.clearTimeout(timer); },
    setInterval: (callback, ms) => { const timer = clock.setInterval(callback, ms); mine.add(timer); return timer; },
    clearInterval: (timer) => { if (timer) mine.delete(timer); clock.clearInterval(timer); },
    dropAll: () => { for (const timer of mine) clock.clearTimeout(timer); mine.clear(); },
  };
};

/**
 * The same object with every function gated on `alive()`: once a daemon has crashed, its calls never answer, as if
 * the process were gone. Without this, work the old daemon still had in flight could reach Slack, T3 or state.json.
 */
const gated = <T extends object>(target: T, alive: () => boolean): T => {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(target)) {
    out[name] = typeof value === 'function'
      ? (...args: unknown[]) => (alive() ? (value as (...a: unknown[]) => unknown)(...args) : new Promise<never>(() => {}))
      : value !== null && typeof value === 'object' ? gated(value as object, alive) : value;
  }
  return out as T;
};

export interface DaemonHarnessOptions {
  profile?: ProfileOverrides;
  clock?: FakeClock;
  slack?: FakeSlackOptions;
  t3?: FakeT3Options;
  /** Extra seams for the bot. Uploads and review requests are pass-throughs unless given. */
  bot?: DaemonDeps['bot'];
  checkAccess?: DaemonDeps['checkAccess'];
  /** Meeting capture's model and provider seams (SERRA-62). */
  meetings?: DaemonDeps['meetings'];
}

export interface DaemonHarness {
  config: Config;
  clock: FakeClock;
  slack: FakeSlack;
  t3: FakeT3;
  logs: string[];
  /** Delivers one Slack envelope and settles. Returns whether Bolt acked it. */
  deliver(body: Record<string, unknown>): Promise<{ acked: boolean }>;
  advance(ms: number): Promise<void>;
  restart(): Promise<void>;
  crash(): Promise<void>;
  stop(): Promise<void>;
  /** The jobs saved in state.json now. */
  state(): Record<string, Record<string, unknown>>;
}

export const startTestDaemon = async (t: TestContext, options: DaemonHarnessOptions = {}): Promise<DaemonHarness> => {
  const { config } = testProfile(t, options.profile);
  const clock = options.clock ?? fakeClock();
  const slack = createFakeSlack({ botUserId: BOT, names: { UOWNER: 'Alex Doe', USAM: 'Sam' }, now: () => clock.now(), ...options.slack });
  const t3 = createFakeT3({ now: () => clock.now(), ...options.t3 });
  let generation = 0;
  const logs: string[] = [];
  let current: { daemon: Daemon; receiver: TestReceiver; clock: ReturnType<typeof scopedClock> } | null = null;
  let hung = false;

  const boot = async (): Promise<void> => {
    const mine = ++generation;
    const alive = (): boolean => generation === mine;
    const receiver = new TestReceiver();
    const app = new App({ token: 'xoxb-test', botId: 'BBOT', botUserId: BOT, receiver, tokenVerificationEnabled: false, logger: quietLogger(logs), logLevel: LogLevel.ERROR });
    const scoped = scopedClock(clock);
    const daemon = await startDaemon({
      config, app, client: gated(slack.client, alive), logger: quietLogger(logs), clock: scoped, knowledge: createKnowledge(config.knowledgeDir),
      bot: {
        t3: gated(t3.t3, alive), questions: gated(t3.questions, alive), fetchBase: async () => {}, share: async (text) => text,
        reviewRequest: async (text) => ({ reply: text, postedFor: null }), ...options.bot,
      },
      receive: async () => '',
      checkAccess: options.checkAccess ?? (async () => {}), lock: () => () => {}, statusSocket: false, watchProfile: false, pid: 4242,
      // Never the real Claude Code: a test that sends a meeting passes its own extractor.
      meetings: { extractor: { extract: async () => { throw new Error('no extractor in this test'); } }, sources: { fetchTranscript: async () => { throw new Error('no sources in this test'); } }, ...options.meetings },
    });
    current = { daemon, receiver, clock: scoped };
  };
  // A daemon held inside a Slack call never goes idle: settling stops waiting once something hangs.
  const settle = async (): Promise<void> => {
    if (!current || hung) return;
    const daemon = current.daemon;
    await Promise.race([daemon.idle(), slack.whenHung().then(() => { hung = true; }), t3.whenHung().then(() => { hung = true; })]);
  };
  clock.settleWith(settle);
  await boot();
  await clock.settle();
  t.after(async () => { if (current && !hung) await current.daemon.stop(); });

  return {
    config, clock, slack, t3, logs,
    deliver: async (body) => {
      if (!current) throw new Error('The daemon is not running');
      const result = await current.receiver.deliver(body, Promise.race([slack.whenHung(), t3.whenHung()]).then(() => { hung = true; }));
      await clock.settle();
      return result;
    },
    advance: (ms) => clock.advance(ms),
    restart: async () => {
      if (current) await current.daemon.stop();
      await boot();
      await clock.settle();
    },
    crash: async () => {
      current?.clock.dropAll();
      current = null;
      generation += 1;
      hung = false;
      slack.resetHung();
      t3.resetHung();
      await boot();
      await clock.settle();
    },
    stop: async () => { if (current) await current.daemon.stop(); current = null; },
    /** `state.json` as saved on disk: each job's `phase`, and the flags older builds read made from it. */
    state: (): Record<string, Record<string, unknown>> => (existsSync(config.statePath) ? JSON.parse(readFileSync(config.statePath, 'utf8')) as Record<string, Record<string, unknown>> : {}),
  };
};
