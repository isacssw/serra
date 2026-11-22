/**
 * The daemon: Bolt's listeners, the update pause, held requests, the poll timer, the status socket and shutdown,
 * around the bot. Everything it touches comes in as `DaemonDeps`, so the scenarios in `tests/scenarios/` run the real
 * wiring with Slack envelopes in, a recording Slack client and a fake T3 out, and a fake clock. `src/index.ts` only
 * builds the real dependencies and handles signals.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { App, Logger } from '@slack/bolt';
import { createBot, type BotDeps } from './bot.ts';
import { createDeliver } from './chat/deliver.ts';
import { proposeBriefUpdate } from './brief.ts';
import { systemClock, createTracker, type Clock } from './clock.ts';
import { defaultProfileRoot, type Config } from './config.ts';
import { incomingMessage } from './slack/incoming.ts';
import { acknowledgePause, admit, dropHeld, holdRequest, markAttempt, readHeld, readPause } from './intake.ts';
import type { createKnowledge } from './knowledge.ts';
import { errorMessage } from './lib/errors.ts';
import { acquireLock } from './lock.ts';
import { eventLog } from './logging.ts';
import { watchProfile as watchProfileFile } from './profile-reload.ts';
import { checkProjectAccess } from './project-access.ts';
import { answerNameRequests, createSlackNames } from './slack-names.ts';
import type { SlackApi } from './slack/api.ts';
import type { receiveAttachments } from './slack/attachments.ts';
import { createSlackChat } from './slack/chat.ts';
import { QUESTION_ACTION, questionInteraction } from './slack/questions.ts';
import { createStore } from './state.ts';
import { jobCounts, startStatusServer, type StatusServer } from './status-socket.ts';
import type { IncomingMessage } from './types.ts';
import { readAttachmentText } from './slack/attachments.ts';
import { createMeetingCapture, meetingsFirst, type MeetingCaptureDeps } from './meeting-capture.ts';
import { createMeetingRuns } from './meeting-runs.ts';

const POLL_MS = 15_000;
const HELD_REACTION = 'hourglass_flowing_sand';

/** Bolt's socket client connection events, so the status socket can say whether Slack is connected. */
interface ConnectionEvents { on(event: 'connected' | 'disconnected' | 'reconnecting', listener: () => void): unknown }

export interface DaemonDeps {
  config: Config;
  /** A Bolt app whose receiver delivers Slack's events. Its listeners are registered here. */
  app: Pick<App, 'event' | 'message' | 'action' | 'start' | 'stop'>;
  /** The Web API the daemon and bot call. In production, `app.client`. */
  client: SlackApi;
  logger: Logger;
  knowledge: Pick<ReturnType<typeof createKnowledge>, 'checkKnowledge' | 'loadIndex' | 'briefKnowledge' | 'seedApproved' | 'untaggedPages'>;
  clock?: Clock;
  connection?: ConnectionEvents;
  /** T3, questions, uploads and other bot seams. Production uses the real ones. */
  bot?: Partial<Pick<BotDeps, 't3' | 'questions' | 'fetchBase' | 'share' | 'reviewRequest' | 'timing'>>;
  /** Downloads the files people attach. Production uses the real one. */
  receive?: typeof receiveAttachments;
  checkAccess?: (paths: string[]) => Promise<void>;
  /** Takes a lock file and returns its release. Two daemons never serve one profile or one Slack identity. */
  lock?: (path: string) => () => void;
  locksDir?: string;
  /** The app's live view over `status.sock`. Off in tests that don't need it. */
  statusSocket?: boolean;
  /** Apply people and triggers when `profile.json` changes. */
  watchProfile?: boolean;
  pid?: number;
  pollMs?: number;
  /** Meeting capture's model and provider seams (SERRA-62). Production starts T3 runs (src/meeting-runs.ts). */
  meetings?: Partial<Pick<MeetingCaptureDeps, 'extractor' | 'sources' | 'readFile'>>;
}

export interface Daemon {
  /** Stops taking work, hands waiting messages to their workers, and waits for work in flight. */
  stop(): Promise<void>;
  /** Resolves once nothing the daemon or the bot started is still running. For tests. */
  idle(): Promise<void>;
}

/**
 * Checks access, connects to Slack and starts serving. Rejects before touching Slack when a repository can't be read
 * (macOS blocks a background service from Documents, Desktop and Downloads until the owner allows it).
 */
export const startDaemon = async (deps: DaemonDeps): Promise<Daemon> => {
  const {
    config, app, client, logger, knowledge, clock = systemClock, connection, checkAccess = checkProjectAccess,
    lock = acquireLock, locksDir = join(defaultProfileRoot, 'locks'), statusSocket = true, watchProfile = true,
    pid = process.pid, pollMs = POLL_MS,
  } = deps;
  const releases: (() => void)[] = [];
  mkdirSync(dirname(config.statePath), { recursive: true, mode: 0o700 });
  releases.push(lock(`${config.statePath}.lock`));
  try {
    // Under launchd, macOS may block the repository (Documents, Desktop, Downloads). Find out now, not on the first job.
    await checkAccess([config.project, ...config.repositories.map(({ path }) => path)]);
    return await serve();
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }

  async function serve(): Promise<Daemon> {
    const { checkKnowledge, loadIndex, briefKnowledge, seedApproved, untaggedPages } = knowledge;
    let slackConnected = false;
    let botUserId = '';
    let botId = '';
    const logsDir = join(config.profileDir, 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const store = createStore(config.statePath, { warn: (message) => logger.warn(message), now: () => new Date(clock.now()) });
    const logEvent = eventLog(join(logsDir, 'events.jsonl'), () => new Date(clock.now()));
    let status: StatusServer | null = null;
    // The Slack adapter. Its writer goes straight to `deliver`, the only code that ever holds it.
    const { chat, writer, sawDm } = createSlackChat({
      client, owner: config.owner, botUserId: () => botUserId, botToken: config.botToken, profileDir: config.profileDir, logger, clock,
      ...(deps.receive ? { receive: deps.receive } : {}),
    });
    const bot = createBot({
      ...deps.bot,
      config, chat, deliver: createDeliver(writer, briefKnowledge), store, loadIndex, loadKnowledge: (visibility) => briefKnowledge(visibility), logger, clock,
      // The app sees the same events as events.jsonl, live.
      events: (name, fields) => { logEvent(name, fields); status?.publish(name, fields); },
    });

    let stopping = false;
    const work = createTracker();
    const track = (promise: Promise<unknown>): Promise<void> => work.track(promise).then(() => undefined);

    /** Requests let through and still being started (fetching context, starting the T3 thread), not yet running jobs. */
    let starting = 0;
    /** While new work is paused, tells the app how many requests are still being started, so it waits for them. */
    const acknowledge = (): void => {
      if (readPause(config.profileDir, clock.now())) {
        try { acknowledgePause(config.profileDir, starting, { pid, now: clock.now() }); } catch (error) { logger.warn(`Couldn't acknowledge the pause: ${errorMessage(error)}`); }
      }
    };
    const start = async (msg: IncomingMessage): Promise<void> => {
      // Whose a DM is, for the adapter's check that the owner's DM is theirs alone: from every message handled, held
      // requests replayed after a restart included.
      if (!msg.botId) sawDm(msg.channel, msg.user);
      starting += 1;
      try { await track(bot.handle(msg)); } finally { starting -= 1; acknowledge(); }
    };

    /** The held request being started right now. It is still on disk, but replies in its thread no longer wait for it. */
    let releasingNow: IncomingMessage | null = null;
    /** A request waits on disk in this thread, other than the one being started now: replies there wait behind it. */
    const heldIn = (channel: string, threadTs: string): boolean => readHeld(config.profileDir).some((held) =>
      held.channel === channel && held.threadTs === threadTs && !(releasingNow && held.channel === releasingNow.channel && held.messageTs === releasingNow.messageTs));
    /** The bot's thread, or one with a request held or being started. */
    const owns = (channel: string, threadTs: string): boolean =>
      bot.ownsThread(channel, threadTs) || heldIn(channel, threadTs) || (releasingNow?.channel === channel && releasingNow.threadTs === threadTs);

    // "Remember this meeting" in the owner's DM (SERRA-62): caught before the pause hold and before any job, so a
    // transcript never reaches a job's worker. Off until the owner turns it on in the app. Reading a link and picking
    // out decisions are T3 runs with a read-only brief in Serra's own empty folder, on the worker's provider and model
    // (src/meeting-runs.ts): T3 is Serra's only agent layer.
    const runs = createMeetingRuns({ t3Bin: config.t3Bin, ...(config.workerProvider ? { provider: config.workerProvider } : {}), ...(config.workerModel ? { model: config.workerModel } : {}), log: (message) => logger.warn(message) });
    const extractor = deps.meetings?.extractor ?? { extract: runs.extract };
    const sources = deps.meetings?.sources ?? { fetchTranscript: runs.fetchTranscript };
    const meetings = createMeetingCapture({
      profileDir: config.profileDir, knowledgeDir: config.knowledgeDir, owner: config.owner,
      chat: {
        // No unfurling: meeting text is never turned into a link preview.
        post: async (channel, text, threadTs) => (await client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false, ...(threadTs ? { thread_ts: threadTs } : {}) })).ts,
        remove: async (channel, ts) => { await client.chat.delete({ channel, ts }); },
        earlierInThread: async (channel, threadTs, beforeTs) => {
          const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 20 });
          // People's messages only: an agent-view conversation can open with the app's own greeting.
          return (replies.messages ?? []).filter((message) => message.ts !== undefined && message.ts < beforeTs && !message.bot_id && message.user !== botUserId).length;
        },
      },
      readFile: deps.meetings?.readFile ?? ((file, maxChars) => readAttachmentText(client, file, config.botToken, maxChars)),
      sources, extractor,
      paused: () => readPause(config.profileDir, clock.now()) !== null,
      busy: (channel, threadTs) => owns(channel, threadTs),
      now: () => new Date(clock.now()),
      log: (message) => logger.info(message),
    });
    // A meeting approval a crash left half done is rolled back before anything reads knowledge.
    try { meetings.store.recover(); } catch (error) { logger.warn(`Meeting recovery: ${errorMessage(error)}`); }
    /** A meeting message is Serra's own work, counted like a starting job so an update waits for it. */
    const trackMeeting = (meetingWork: Promise<void>): Promise<void> => {
      starting += 1;
      return track(meetingWork).catch((error: unknown) => logger.error(`Meeting capture failed: ${errorMessage(error)}`))
        .finally(() => { starting -= 1; acknowledge(); });
    };

    /**
     * Handles a message now, or holds it while the app has paused new work for an update (intake.ts): a request that
     * would start a job waits, with an hourglass on it, for the restarted bot. Messages for running jobs go through.
     */
    const receiveRequest = async (msg: IncomingMessage): Promise<void> => {
      const paused = readPause(config.profileDir, clock.now());
      const waitingBehind = heldIn(msg.channel, msg.threadTs);
      if (waitingBehind || admit(paused !== null, bot.runningIn(msg.channel, msg.threadTs)) === 'hold') {
        try { holdRequest(config.profileDir, msg); } catch (error) {
          // Not holding it would lose it: it is handled now instead, and the update waits for it like any start.
          logger.error(`Couldn't hold a request in ${msg.channel} for after the update, so handling it now: ${errorMessage(error)}`);
          await start(msg);
          return;
        }
        await client.reactions.add({ channel: msg.channel, timestamp: msg.messageTs, name: HELD_REACTION }).catch(() => {});
        logger.info(`Holding a new request in ${msg.channel} until Serra finishes updating.`);
        acknowledge();
        return;
      }
      await start(msg);
    };
    // Meetings first (SERRA-62): before the pause hold and before any job starts or continues.
    const receive = meetingsFirst((msg) => meetings.intercept(msg), trackMeeting, receiveRequest);

    let releasing = false;
    /**
     * Starts the requests held during a pause, once it is over (at start, or when the update was called off), oldest
     * first. Each stays on disk until the bot has it (INTAKE-010): at least once, and the job's `heard` list makes a
     * replay after a crash a no-op.
     */
    const releaseHeld = async (): Promise<void> => {
      if (releasing) return;
      releasing = true;
      try {
        for (;;) {
          // Checked again before each one: an update may have paused new work meanwhile.
          if (stopping || readPause(config.profileDir, clock.now())) return;
          const next = readHeld(config.profileDir)[0];
          if (!next) return;
          // On disk before anything else: if this daemon stops while starting it, the next one looks for its thread.
          const marked = markAttempt(config.profileDir, next, new Date(clock.now()).toISOString());
          releasingNow = marked;
          try {
            await client.reactions.remove({ channel: next.channel, timestamp: next.messageTs, name: HELD_REACTION }).catch(() => {});
            // A meeting message is never started as a job, held or not (SERRA-62).
            const meeting = meetings.intercept(next);
            if (meeting) await trackMeeting(meeting.work);
            // Only a replay carries `attemptedAt` to the bot: a first attempt has no earlier thread to look for.
            // A start that throws is told in its thread like any failed request, then let go: retrying it would
            // repeat the failure on every poll.
            else {
              await start(next.attemptedAt ? next : { ...next, attemptedAt: undefined })
                .catch((error: unknown) => bot.reportUnhandled(next, error))
                .catch((error: unknown) => logger.error(`Couldn't report a failed held request in ${next.channel}: ${errorMessage(error)}`));
            }
          } finally { releasingNow = null; }
          dropHeld(config.profileDir, next);
        }
      } finally { releasing = false; }
    };
    /** Releases held requests; a file that can't be read or written is logged and tried again on the next poll. */
    const release = (): Promise<void> => track(releaseHeld()).catch((error: unknown) => logger.error(`Releasing held requests failed: ${errorMessage(error)}`));

    app.event('app_mention', async ({ event }) => {
      if (stopping) return;
      const msg = incomingMessage(event, 'app_mention', botUserId, owns, { messageTriggers: config.messageTriggers, botId });
      if (msg) await receive(msg);
    });
    // Agent view emits this when someone opens the app. Wait for their message before starting work.
    app.event('app_home_opened', async () => {});
    app.action(QUESTION_ACTION, async ({ ack, body }) => {
      await ack();
      if (stopping) return;
      const interaction = questionInteraction(body);
      if (!interaction) return;
      sawDm(interaction.channel, interaction.user);
      await track(bot.handleQuestionAction(interaction));
    });
    app.message(async ({ message }) => {
      if (stopping) return;
      const msg = incomingMessage(message, 'message', botUserId, owns, { messageTriggers: config.messageTriggers, botId });
      if (msg) await receive(msg);
    });

    // A missing index stops the daemon here instead of failing the first request. An index over its cap and page problems only warn.
    loadIndex();
    // From here on, briefs use the knowledge as the owner approved it: a file changed outside Serra waits for them in Pages.
    if (seedApproved()) logger.info('Keeping an approved copy of knowledge/ from now on.');
    // Pages from before audiences reach only the owner's replies: say so once at start, where an upgrading owner looks.
    const untagged = untaggedPages();
    if (untagged.length > 0) {
      logger.info(`${untagged.length} knowledge page(s) don't say who may hear them, so only your own replies use them. Choose in the app: Knowledge › About me.`);
    }
    if (proposeBriefUpdate(config.profileDir)) logger.info('The shipped brief has new knowledge rules: review it in Brief & policy (proposed/knowledge-update).');
    const checked = checkKnowledge({
      roots: [{ name: basename(config.project), path: config.project }, ...config.repositories.map(({ name, path }) => ({ name, path }))],
    });
    for (const problem of checked.problems) logger.warn(`knowledge/${problem}`);
    for (const warning of checked.warnings) logger.warn(`knowledge/${warning}`);

    // Meeting requests an older Serra held during an update are closed and dropped before intake opens, never replayed.
    {
      const { drop, replies } = meetings.closeHeld(readHeld(config.profileDir));
      for (const msg of drop) dropHeld(config.profileDir, msg);
      void Promise.allSettled(replies);
    }

    const auth = await client.auth.test();
    botUserId = auth.user_id ?? '';
    botId = auth.bot_id ?? '';
    if (!botUserId) throw new Error('Slack auth.test returned no bot user ID');
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    releases.push(lock(join(locksDir, `${botUserId}.lock`)));
    connection?.on('connected', () => { slackConnected = true; status?.refresh(); });
    for (const state of ['disconnected', 'reconnecting'] as const) connection?.on(state, () => { slackConnected = false; status?.refresh(); });
    await app.start();
    slackConnected = true;
    const startedAt = new Date(clock.now()).toISOString();
    if (statusSocket) {
      // The app's Jobs names (SERRA-55): the app asks over the status socket and gets names back, so it never reads the
      // bot token. The token is the one this process already holds; it never leaves it, and lookups never throw.
      const slackNames = createSlackNames({ token: async () => config.botToken, log: (message) => logger.warn(message) });
      // The app's live view. Without it the bot still works, and the app shows "stopped".
      status = await startStatusServer({
        profileDir: config.profileDir,
        status: () => ({ state: 'up', pid, startedAt, slackConnected, counts: jobCounts(store.allJobs().map(([, job]) => job)) }),
        names: answerNameRequests(slackNames),
      }).catch((error: unknown) => {
        logger.warn(`Status socket not started: ${errorMessage(error)}`);
        return null;
      });
    }
    const readyPath = join(config.profileDir, 'ready.json');
    writeFileSync(readyPath, JSON.stringify({ pid, botUserId, startedAt }), { mode: 0o600 });
    logger.info(`${config.name} is up as @${auth.user} in ${auth.team}. Project ${config.project}, base ${config.baseRef}.`);
    logger.info(`Knowledge: ${checked.pages.length} pages, ${checked.unverified.length} not verified, ${checked.proposals.length} proposals waiting.`);
    // People and message triggers apply as soon as profile.json changes. Other sections wait for a restart.
    const profileWatcher = watchProfile
      ? watchProfileFile(config.profileDir, bot.reloadProfile, {
        onError: (error) => logger.warn(`Not watching profile.json, changes apply after a restart: ${errorMessage(error)}`),
      })
      : { close: () => {} };
    // Jobs saved as running that T3 no longer runs (a run that ended while the bot was stopped, state from an older
    // install) are cleared once, before the first poll, so the Jobs list matches T3.
    void track(bot.reconcile()).catch((error: unknown) => logger.error(`Reconciling jobs failed: ${errorMessage(error)}`))
      .finally(() => status?.refresh());
    // Requests held while the previous bot was paused for an update start now.
    acknowledge();
    void release();
    const timer = clock.setInterval(() => {
      if (stopping) return;
      acknowledge();
      void release();
      void track(meetings.upkeep()).catch((error: unknown) => logger.warn(`Meeting upkeep: ${errorMessage(error)}`));
      void track(bot.poll()).catch((error: unknown) => logger.error(`Poll failed: ${errorMessage(error)}`)).finally(() => status?.refresh());
    }, pollMs);

    const idle = async (): Promise<void> => {
      do { await work.idle(); await bot.idle(); } while (work.size > 0);
    };

    return {
      idle,
      stop: async () => {
        if (stopping) return;
        stopping = true;
        clock.clearInterval(timer);
        profileWatcher.close();
        if (existsSync(readyPath)) rmSync(readyPath);
        await status?.close();
        status?.removeSocketFile();
        await app.stop();
        // Messages still waiting for a quiet moment go to their workers now, so a restart loses none.
        await bot.drain();
        await idle();
        for (const release of releases.reverse()) release();
      },
    };
  }
};
