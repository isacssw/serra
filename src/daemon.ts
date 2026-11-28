/**
 * The daemon: the chat connections, the update pause, held requests, the poll timer, the status socket and shutdown,
 * around the bot. It starts every chat it serves (Slack, and any `chats` it is given) as a `ChatConnection`
 * (`src/chat/connection.ts`), hands their inbound messages to the bot, and gives the bot one `ChatPort` over all of
 * them (`src/chat/router.ts`) and one `deliver` holding each chat's writer. Everything it touches comes in as
 * `DaemonDeps`, so the scenarios in `tests/scenarios/` run the real wiring with Slack envelopes in, a recording Slack
 * client and a fake T3 out, and a fake clock. `src/index.ts` only loads the profile and handles signals.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createBot, type BotDeps } from './bot.ts';
import { createBackendPool, type AgentBackends } from './agent/pool.ts';
import { createT3Backend } from './agent/t3.ts';
import { startInterview, startTask } from './tasks.ts';
import type { RunRequest } from './status-socket.ts';
import { kindOf, SLACK, type ChatConnection, type ChatIdentity, type ConnectionState, type Inbound, type MeetingSeam } from './chat/connection.ts';
import { createDeliver, type ChatAdapter } from './chat/deliver.ts';
import { routeChats } from './chat/router.ts';
import { proposeBriefUpdate } from './brief.ts';
import { systemClock, createTracker, type Clock } from './clock.ts';
import { defaultProfileRoot, type Config } from './config.ts';
import { acknowledgePause, admit, dropHeld, holdRequest, markAttempt, readHeld, readPause } from './intake.ts';
import type { createKnowledge } from './knowledge.ts';
import { errorMessage } from './lib/errors.ts';
import { acquireLock } from './lock.ts';
import { heldForMove } from './moves/hold.ts';
import { eventLog, type Logger } from './logging.ts';
import { watchProfile as watchProfileFile } from './profile-reload.ts';
import { checkProjectAccess } from './project-access.ts';
import { answerNameRequests, createSlackNames } from './slack-names.ts';
import type { SlackApi } from './slack/api.ts';
import type { receiveAttachments } from './slack/attachments.ts';
import { createSlackConnection, slackSocketApp, type SlackApp, type SlackConnectionEvents } from './slack/connection.ts';
import { createStore } from './state.ts';
import { jobCounts, startStatusServer, type StatusServer } from './status-socket.ts';
import type { IncomingMessage } from './types.ts';
import { createMeetingCapture, meetingsFirst, type MeetingCaptureDeps } from './meeting-capture.ts';
import { createMeetingRuns } from './meeting-runs.ts';
import { chosenBackend } from './agent/select.ts';
import { reviewDue, runKnowledgeReview } from './knowledge-review.ts';

const POLL_MS = 15_000;

export interface DaemonDeps {
  config: Config;
  /**
   * A Bolt app whose receiver delivers Slack's events, and the Web API the Slack connection calls (`client`, in
   * production `app.client`). Without them the daemon makes Bolt's Socket Mode app from the profile's tokens.
   */
  app?: SlackApp;
  client?: SlackApi;
  /** The Slack socket's connection events, for the status socket. */
  connection?: SlackConnectionEvents;
  /** More chats to serve beside Slack, each with its own writer for `deliver`. */
  chats?: ChatAdapter[];
  logger: Logger;
  knowledge: Pick<ReturnType<typeof createKnowledge>, 'checkKnowledge' | 'loadIndex' | 'briefKnowledge' | 'seedApproved' | 'untaggedPages'>;
  clock?: Clock;
  /** T3, questions, uploads and other bot seams. Production uses the real ones. */
  bot?: Partial<Pick<BotDeps, 'agents' | 't3' | 'questions' | 'fetchBase' | 'share' | 'reviewRequest' | 'timing'>>;
  /** Downloads the files people attach. Production uses the real one. */
  receive?: typeof receiveAttachments;
  checkAccess?: (paths: string[]) => Promise<void>;
  /** Takes a lock file and returns its release. Two daemons never serve one profile or one bot identity in a chat. */
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
  /** The weekly knowledge review's model run, for tests. Defaults to a read-only T3 run. */
  reviewAsk?: (title: string, prompt: string) => Promise<string>;
}

export interface Daemon {
  /** Stops taking work, hands waiting messages to their workers, and waits for work in flight. */
  stop(): Promise<void>;
  /** Resolves once nothing the daemon or the bot started is still running. For tests. */
  idle(): Promise<void>;
}

/** Does the app's work on an ACP agent (see `RunRequest`): a task or the interview starts on the owner's current backend. */
const runForApp = async (request: RunRequest, agents: AgentBackends, profileDir: string): Promise<unknown> => {
  switch (request.op) {
    case 'task': return startTask(profileDir, request.request, { agent: agents.current() });
    case 'interview': return startInterview(profileDir, { agent: agents.current() });
    case 'send': return agents.get(request.backend).send(request.threadId, request.message);
    case 'answer': {
      const questions = agents.get(request.backend).questions;
      if (!questions) throw new Error('That agent has no questions to answer.');
      return questions.answer(request.threadId, request.requestId, request.answers);
    }
  }
};

/**
 * Checks access, connects the chats and starts serving. Rejects before touching Slack when a repository can't be read
 * (macOS blocks a background service from Documents, Desktop and Downloads until the owner allows it).
 */
export const startDaemon = async (deps: DaemonDeps): Promise<Daemon> => {
  const {
    config, logger, knowledge, clock = systemClock, checkAccess = checkProjectAccess,
    lock = acquireLock, locksDir = join(defaultProfileRoot, 'locks'), statusSocket = true, watchProfile = true,
    pid = process.pid, pollMs = POLL_MS,
  } = deps;
  // Held for a move or a restore (SB-34): the profile is on its way, so this computer must not serve it (E4).
  if (heldForMove(config.profileDir, clock.now())) throw new Error('This profile is being moved or restored, so it doesn’t start here. Serra starts it when that is done.');
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
    /** Each chat's connection state, for the status socket. */
    const connected = new Map<string, boolean>();
    const logsDir = join(config.profileDir, 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const store = createStore(config.statePath, { warn: (message) => logger.warn(message), now: () => new Date(clock.now()) });
    const logEvent = eventLog(join(logsDir, 'events.jsonl'), () => new Date(clock.now()));
    let status: StatusServer | null = null;
    // The chats. Slack first: Bolt's Socket Mode app from the profile's tokens, unless a test hands one in. A bot that
    // isn't on Slack (no owner member ID: Telegram or Discord only) opens no Slack connection at all.
    if (deps.app && !deps.client) throw new Error('A Slack app needs its client');
    const onSlack = config.slack !== false || Boolean(deps.app);
    const slack = onSlack ? (() => {
      const bolt = deps.app && deps.client ? { app: deps.app, client: deps.client, events: deps.connection }
        : slackSocketApp({ botToken: config.botToken, appToken: config.appToken, logger });
      return createSlackConnection({
        app: bolt.app, client: bolt.client, ...(bolt.events ? { events: bolt.events } : {}), owner: config.owner, botToken: config.botToken,
        profileDir: config.profileDir, messageTriggers: () => config.messageTriggers, logger, clock, ...(deps.receive ? { receive: deps.receive } : {}),
      });
    })() : null;
    const adapters = [...(slack ? [slack] : []), ...(deps.chats ?? [])];
    if (adapters.length === 0) throw new Error('No chat to listen on: connect Slack, Telegram or Discord first.');
    // The bot sees every chat as one port. Each chat's writer goes straight to `deliver`, the only code that holds one.
    const chats = routeChats(adapters.map(({ connection }) => connection));
    const deliver = createDeliver(new Map(adapters.map(({ connection, writer }) => [connection.kind, writer])), briefKnowledge);
    const { chat, connectionOf } = chats;
    // The agent backends jobs run on (src/agent/pool.ts): T3, and the ACP agent the owner picked. Tests that pass a fake
    // T3 keep the bot's own single-T3 default.
    const agents = deps.bot?.agents ?? (deps.bot?.t3 ? undefined : createBackendPool({
      profileDir: config.profileDir, t3: createT3Backend({ bin: config.t3Bin }), log: (message) => logger.info(message),
    }));
    const bot = createBot({
      ...deps.bot,
      ...(agents ? { agents } : {}),
      config, chat, deliver, store, loadIndex, loadKnowledge: (visibility) => briefKnowledge(visibility), logger, clock,
      // Approvals follow the owner: their own conversation in each other chat that is connected now.
      ownerSpaces: async (except) => {
        const found = await Promise.all(chats.connections.filter((connection) => connection.kind !== except && connected.get(connection.kind) === true)
          .map(async (connection) => (connection.ownerSpace?.() ?? Promise.resolve(null)).catch((error: unknown) => { logger.debug(`${connection.kind}: no owner conversation (${errorMessage(error)})`); return null; })));
        return found.filter((conversation): conversation is string => conversation !== null);
      },
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
      // The chat learns from every message handled, held requests replayed after a restart included (Slack: whose a DM is).
      connectionOf(msg.channel)?.saw(msg);
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
    // out decisions are runs with a read-only brief in Serra's own empty folder (src/meeting-runs.ts), on the agent
    // backend the owner picked (src/agent/select.ts, read per run): T3 by default, on the worker's provider and model.
    const runs = createMeetingRuns({
      t3Bin: config.t3Bin, ...(config.workerProvider ? { provider: config.workerProvider } : {}), ...(config.workerModel ? { model: config.workerModel } : {}),
      backend: () => chosenBackend(config.profileDir, { t3Bin: config.t3Bin, log: (message) => logger.info(message) }), log: (message) => logger.warn(message),
    });
    const extractor = deps.meetings?.extractor ?? { extract: runs.extract };
    const sources = deps.meetings?.sources ?? { fetchTranscript: runs.fetchTranscript };
    // Meetings are caught only in the chat that has the owner's DM for them (Slack's); every other chat's messages are
    // ordinary requests.
    const meetingChat = chats.connections.find((connection) => connection.meetings);
    const meetingSeam: MeetingSeam = meetingChat?.meetings ?? {
      chat: { post: async () => undefined, remove: async () => {}, earlierInThread: async () => 0 },
      readFile: async () => { throw new Error('No chat takes meetings'); },
    };
    const inMeetingChat = (msg: IncomingMessage): boolean => meetingChat !== undefined && kindOf(msg.channel) === meetingChat.kind;
    const meetings = createMeetingCapture({
      profileDir: config.profileDir, knowledgeDir: config.knowledgeDir, owner: config.owner,
      chat: meetingSeam.chat,
      readFile: deps.meetings?.readFile ?? meetingSeam.readFile,
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
        await connectionOf(msg.channel)?.hold({ conversation: msg.channel, id: msg.messageTs }, true);
        logger.info(`Holding a new request in ${msg.channel} until Serra finishes updating.`);
        acknowledge();
        return;
      }
      await start(msg);
    };
    // Meetings first (SERRA-62): before the pause hold and before any job starts or continues.
    const intercept = (msg: IncomingMessage): { work: Promise<void> } | null => (inMeetingChat(msg) ? meetings.intercept(msg) : null);
    const receive = meetingsFirst(intercept, trackMeeting, receiveRequest);

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
          // A request held in a chat this daemon doesn't serve now waits on disk for one that does.
          const next = readHeld(config.profileDir).find((held) => connectionOf(held.channel) !== undefined);
          if (!next) return;
          // On disk before anything else: if this daemon stops while starting it, the next one looks for its thread.
          const marked = markAttempt(config.profileDir, next, new Date(clock.now()).toISOString());
          releasingNow = marked;
          try {
            await connectionOf(next.channel)?.hold({ conversation: next.channel, id: next.messageTs }, false);
            // A meeting message is never started as a job, held or not (SERRA-62).
            const meeting = intercept(next);
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

    /** What every chat hands the daemon: messages for the core, card answers, and which threads are the bot's. */
    const inbound: Inbound = {
      owns,
      message: async (msg) => {
        if (stopping) return;
        await receive(msg);
      },
      answer: async (interaction) => {
        if (stopping) return;
        await track(bot.handleQuestionAction(interaction));
      },
    };

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
      const { drop, replies } = meetings.closeHeld(readHeld(config.profileDir).filter(inMeetingChat));
      for (const msg of drop) dropHeld(config.profileDir, msg);
      void Promise.allSettled(replies);
    }

    // Each chat signs in, then its bot identity is locked (two daemons never answer as one bot), then it listens.
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const identities: (ChatIdentity & { kind: string })[] = [];
    for (const { connection } of adapters) {
      const identity = await connection.identify();
      releases.push(lock(join(locksDir, `${identity.lock}.lock`)));
      identities.push({ ...identity, kind: connection.kind });
    }
    const listening: ChatConnection[] = [];
    try {
      for (const { connection } of adapters) {
        connected.set(connection.kind, false);
        connection.watch((state: ConnectionState) => { connected.set(connection.kind, state === 'connected'); status?.refresh(); });
        await connection.listen(inbound);
        listening.push(connection);
        connected.set(connection.kind, true);
      }
    } catch (error) {
      // A chat that can't start fails the daemon, and the ones already listening stop: no half-started bot.
      for (const connection of listening) await connection.stop().catch(() => {});
      throw error;
    }
    const startedAt = new Date(clock.now()).toISOString();
    if (statusSocket) {
      // The app's Jobs names (SERRA-55): the app asks over the status socket and gets names back, so it never reads the
      // bot token. The token is the one this process already holds; it never leaves it, and lookups never throw.
      const slackNames = onSlack ? createSlackNames({ token: async () => config.botToken, log: (message) => logger.warn(message) }) : null;
      // The app's live view. Without it the bot still works, and the app shows "stopped".
      status = await startStatusServer({
        profileDir: config.profileDir,
        status: () => ({
          // A bot without Slack reports its own chats here, so every reader of "connected" (the app's header, the
          // menubar, setup) sees a Telegram- or Discord-only bot as connected when it is.
          state: 'up', pid, startedAt, slackConnected: onSlack ? connected.get(SLACK) ?? false : [...connected.values()].every(Boolean),
          chats: [...connected].map(([kind, up]) => ({ kind, connected: up })),
          counts: jobCounts(store.allJobs().map(([, job]) => job)),
        }),
        names: slackNames ? answerNameRequests(slackNames) : async () => ({ users: {}, channels: {} }),
        // The app's tasks, interview, replies and answers on an ACP agent run here, where the agent lives.
        ...(agents ? { runs: (request) => runForApp(request, agents, config.profileDir) } : {}),
      }).catch((error: unknown) => {
        logger.warn(`Status socket not started: ${errorMessage(error)}`);
        return null;
      });
    }
    const readyPath = join(config.profileDir, 'ready.json');
    const botUserId = identities.find((identity) => identity.kind === SLACK)?.self ?? identities[0]?.self ?? '';
    writeFileSync(readyPath, JSON.stringify({ pid, botUserId, startedAt }), { mode: 0o600 });
    logger.info(`${config.name} is up as ${identities.map((identity) => identity.describe).join(', ')}. Project ${config.project}, base ${config.baseRef}.`);
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
    // ACP runs a restart cut off mid-turn carry on now (Slack jobs would on their next poll; app tasks only this way).
    if (agents?.resume) void track(agents.resume());
    // Requests held while the previous bot was paused for an update start now.
    acknowledge();
    void release();
    // The weekly knowledge review (knowledge-review.ts): checked once an hour, run when a week has passed and there were
    // replies to look at. Its model work is a read-only T3 run, like a meeting's; the owner approves what it suggests.
    let reviewCheckedAt = 0;
    let reviewing = false;
    const maybeReview = (): void => {
      if (reviewing || clock.now() - reviewCheckedAt < 60 * 60 * 1000) return;
      reviewCheckedAt = clock.now();
      if (!reviewDue(config.profileDir, new Date(clock.now()))) return;
      reviewing = true;
      void track(runKnowledgeReview({ profileDir: config.profileDir, knowledgeDir: config.knowledgeDir, ask: deps.reviewAsk ?? runs.ask, now: new Date(clock.now()) })
        .then((review) => logger.info(`Weekly knowledge review ${review.id}: ${review.suggestions.length} suggestions${review.error ? ` (model part failed: ${review.error})` : ''}.`))
        .catch((error: unknown) => logger.warn(`Weekly knowledge review: ${errorMessage(error)}`))
        .finally(() => { reviewing = false; }));
    };
    const timer = clock.setInterval(() => {
      if (stopping) return;
      acknowledge();
      void release();
      maybeReview();
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
        // No chat delivers anything new from here on.
        for (const connection of listening) await connection.stop();
        // Messages still waiting for a quiet moment go to their workers now, so a restart loses none.
        await bot.drain();
        await idle();
        // ACP agents stop with the bot; a turn they were in carries on after the next start.
        await agents?.close().catch((error: unknown) => logger.warn(`Stopping ACP agents: ${errorMessage(error)}`));
        for (const release of releases.reverse()) release();
      },
    };
  }
};
