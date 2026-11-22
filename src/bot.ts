import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fillBrief, needsOwner, NO_THREAD } from './brief.ts';
import type { Deliver, Delivery, Refused } from './chat/deliver.ts';
import { MAX_ATTACHMENTS, MessageGone, type Audience as Visibility, type ChatPort, type InboundText, type InPlaceOf, type MessageRef, type Notice, type OwnerNotify, type PersonId, type SetupProblem, type Target, type WorkerOut, t3LinkOf } from './chat/port.ts';
import { stampProposalsFolder, threadProposalsFolder } from './proposals.ts';
import type { BriefKnowledge } from './knowledge.ts';
import { revokedAt, type Heard } from './hearing.ts';
import type { Config, MessageTrigger } from './config.ts';
import { audienceOf, createBatcher, followUpMessage, isPing, ownerNotice, speakerName, type Audience, type ThreadLine } from './conversation.ts';
import { shareImages, type Upload } from './images.ts';
import { meetingRequest } from './meeting-sources.ts';
import { matchMessageTrigger } from './message-triggers.ts';
import { localLinksToText } from './links.ts';
import { createProfileReloader } from './profile-reload.ts';
import { handleReviewRequest, type PostReview } from './review.ts';
import { slackKey, type createStore } from './state.ts';
import { findThreads, jobThreadInput, run, sendToThread, showThread, startThread } from './t3.ts';
import { answerQuestion, listQuestions, type T3QuestionRequest } from './t3-questions.ts';
import { FOLLOW_UP_MS, follow, followed, forgetRun, looksRunning, replied, RECENT_MESSAGES, seeRun, seenRun, settle, step, stopWaiting, waitFor, waitStep, withProgress, type PollStep } from './lifecycle.ts';
import { canShowQuestion, choiceAnswer, typedAnswer, type QuestionAnswer, type QuestionCard, type QuestionInteraction } from './questions.ts';
import type { IncomingFile, IncomingMessage, Job, T3Message, T3Thread } from './types.ts';
import { createTracker, systemClock, type Clock } from './clock.ts';
import { errorMessage, shortError } from './lib/errors.ts';

/** A job nobody is waiting on is still checked this often, so runs the worker starts itself (a PR watch) get posted. */
const IDLE_POLL_MS = 2 * 60_000;
/** A worker's reply that starts with this line has nothing for the chat: a background check-in, or a message that wasn't for the bot. */
const QUIET = /^\s*\(quiet\)\s*(\n|$)/i;
/** How long a thread must be silent before what was said goes to the worker, so quick messages become one turn. */
const FOLLOW_UP_QUIET_MS = 4_000;
/** How often to look again while the worker is still busy with its current turn. */
const FOLLOW_UP_RETRY_MS = 5_000;
const THREAD_CONTEXT_LIMIT = 20_000;
/** A run someone is waiting on shows what it is doing once it has gone on this long. */
const PROGRESS_AFTER_MS = 3 * 60_000;
const PROGRESS_TEXT_LIMIT = 300;
/** A chat's native status may expire (Slack's after two minutes); refresh it before then. */
const LOADING_REFRESH_MS = 60_000;
/** After answering a ping, how long the next message from the same person counts as the request, mention or not. */
const PING_THREAD_MS = 30 * 60_000;
/** Replies to "I'm here" that aren't a request. */
const ACKNOWLEDGEMENT = /^(?:thanks?|thx|ty|cheers|nvm|never ?mind|sorted|all good|cool|great|nice|perfect|np|ok(?:ay)?|k|👍)[\s!.,]*$/iu;

/** What the bot records for each thing it does in the chat, one JSON line each, to measure how it behaves. */
export type BotEvents = (name: string, fields: Record<string, unknown>) => void;

/** Keeps Slack text inside its <slack-thread> tags. */
const quoteThread = (text: string): string => text.replaceAll('</slack-thread>', '&lt;/slack-thread&gt;');

/** Keeps the newest lines that fit in the limit, oldest first. */
const newestThatFit = (lines: string[]): string[] => {
  const kept: string[] = [];
  let total = 0;
  for (const line of lines.toReversed()) {
    if (total + line.length > THREAD_CONTEXT_LIMIT) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return kept;
};

/** How much of a reply's text its saved intent keeps. A reply's fallback text is at most 3,000 characters. */
const INTENT_TEXT = 3_000;

/** The question card open in the job's thread, if any. */
const cardOf = (job: Job): QuestionCard | undefined => (job.phase.state === 'waiting' ? job.phase.card : undefined);

/** The worker's latest note in a run that is still going, such as "Reproducing the bug locally first." */
const latestNote = (runId: string, messages: T3Message[]): string | undefined =>
  messages.findLast((message) => message.role === 'assistant' && message.runId === runId && message.text?.trim())?.text?.trim();

const oneParagraph = (text: string): string => {
  const flat = text.split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ').trim();
  return flat.length > PROGRESS_TEXT_LIMIT ? `${flat.slice(0, PROGRESS_TEXT_LIMIT).trimEnd()}…` : flat;
};

/** Every 👀 a job still shows, including the single one saved by older versions. */
const pendingReactions = (job: Job): string[] => [...new Set([...(job.pendingReactions ?? []), ...(job.pendingReactionTs ? [job.pendingReactionTs] : [])])];

/** The job's 👀 list without the ones just removed. Messages that arrived meanwhile keep theirs. */
const withoutReactions = (job: Job, cleared: string[]): Partial<Job> => ({
  pendingReactionTs: null,
  pendingReactions: pendingReactions(job).filter((ts) => !cleared.includes(ts)),
});

/** The job's record of chat messages it has taken in, with one more. Bounded: retries come within minutes. */
const heardNow = (job: Job, ts: string): Partial<Job> => ({ heard: [...(job.heard ?? []).filter((seen) => seen !== ts), ts].slice(-50) });

/** A thread message waiting for the worker, with the chat message it came from. */
type HeardLine = ThreadLine & { ts: string };

/** Where a job's replies go. Stored as Slack's `channel` and `threadTs` until the stored shape changes. */
const targetOf = (job: Pick<Job, 'channel' | 'threadTs'>): Target => ({ conversation: job.channel, thread: job.threadTs });
const messageIn = (job: Pick<Job, 'channel'>, id: string): MessageRef => ({ conversation: job.channel, id });

/** What a job's worker was told, as saved with it: the pages it could read, and who could see the thread then. */
const heardIn = (job: Job): Heard => ({ ...(job.visibility ? { visibility: job.visibility } : {}), ...(job.knowledgeRead ? { knowledgeRead: job.knowledgeRead } : {}) });

/** What a post means for the owner's follow state, saved with its intent (REPLY-009). */
type OwnerFlags = { ownerFollows?: boolean; ownerAskOpen?: boolean };

/** The notice that stands in for worker words `deliver` refused. */
const refusalNotice = (refused: Refused): Notice => refused.why === 'withheld' ? { kind: 'withheld' }
  : refused.error.kind === 'setup' ? { kind: 'setup-problem', problem: refused.error.problem } : { kind: 'unconfirmed' };

export interface BotDeps {
  config: Config;
  /** The chat, for everything but the worker's words. */
  chat: ChatPort;
  /** The only way to write the worker's words: it checks who can see the target right before each write. */
  deliver: Deliver;
  store: ReturnType<typeof createStore>;
  loadIndex: () => string;
  /** The knowledge for a reply the given audience will see. Without it, every brief gets `loadIndex()` and no About me. */
  loadKnowledge?: (visibility: Visibility) => BriefKnowledge;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void; debug(message: string): void };
  t3?: { startThread: typeof startThread; sendToThread: typeof sendToThread; showThread: typeof showThread; findThreads?: typeof findThreads };
  questions?: { listQuestions: typeof listQuestions; answerQuestion: typeof answerQuestion };
  /** Brings the base branch up to date before a worktree is made from it. */
  fetchBase?: () => Promise<unknown>;
  share?: typeof shareImages;
  reviewRequest?: typeof handleReviewRequest;
  timing?: { quietMs: number; retryMs: number };
  events?: BotEvents;
  /** Time and timers. Tests pass a fake one and move it forward instead of sleeping. */
  clock?: Clock;
}

/**
 * The bot's side of a chat thread: starts a worker for a request, hands it what people say next,
 * and posts what it answers. Everything the chat sees goes through here.
 */
export const createBot = ({
  config, chat, deliver, store, loadIndex, loadKnowledge, logger,
  t3 = { startThread, sendToThread, showThread, findThreads },
  questions = { listQuestions, answerQuestion },
  fetchBase = () => run('git', ['-C', config.project, 'fetch', config.remote, '--quiet']),
  share = shareImages,
  reviewRequest = handleReviewRequest,
  timing = { quietMs: FOLLOW_UP_QUIET_MS, retryMs: FOLLOW_UP_RETRY_MS },
  events = () => {},
  clock = systemClock,
}: BotDeps) => {
  const { allJobs, getJob, putJob } = store;
  const now = (): number => clock.now();
  /** Everything the bot is doing for a job or a batch right now, so tests and shutdown can wait for it. */
  const inFlight = createTracker();

  /**
   * Changes a job from its latest saved state, in one step. A job read before an `await` may be stale by the time
   * it is written back, which would undo what a poll or another message saved in between.
   */
  const updateJob = (key: string, change: (job: Job) => Partial<Job>): void => {
    const job = getJob(key);
    if (job) putJob(key, { ...job, ...change(job) });
  };

  /** Paths a reply may name. Inside these, a local path is shown from the repository root. */
  const pathRoots = { repos: [config.project, ...config.repositories.map((repo) => repo.path)], worktrees: [join(homedir(), '.t3/worktrees')] };

  /** A person's name as the chat shows it, safe to use as a speaker label. */
  const displayName = async (user: PersonId): Promise<string> => speakerName(await chat.displayName(user));

  /** The label a message carries to the worker. Only the configured owner's ID gets the owner marker. */
  const speaker = async (user: string): Promise<string> =>
    user === config.owner ? `${config.ownerName} (your owner)` : displayName(user);

  /** The message with the bot's own mention removed and other mentions as names, so the worker sees who was addressed. */
  const read = (text: string): Promise<InboundText> =>
    chat.read(text, async (user) => (user === config.owner ? config.ownerName : displayName(user)));
  const toReadable = async (text: string): Promise<string> => (await read(text)).text;

  const messageContent = async (text: string, files: IncomingFile[] = [], limit = MAX_ATTACHMENTS): Promise<string> =>
    [await toReadable(text), await chat.receiveFiles(files, limit)].filter(Boolean).join('\n\n');

  /**
   * The messages before the mention when the bot is called into an existing thread, so a brainstorm or a review
   * request arrives with its discussion. When too long, the oldest are dropped and the cut is stated.
   */
  /** `withoutBot`: leave out this bot's own messages (a fresh session after knowledge was taken back). */
  const threadContext = async (msg: IncomingMessage, { withoutBot = false }: { withoutBot?: boolean } = {}): Promise<string> => {
    if (msg.threadTs === msg.messageTs) return NO_THREAD;
    const history = await chat.history({ conversation: msg.channel, thread: msg.threadTs }, msg.messageTs);
    if (!history) return `(${config.name} could not read the earlier messages in this thread. Say so if you need them.)`;

    const nameOf = async (from: (typeof history.lines)[number]['from']): Promise<string> => {
      switch (from.kind) {
        case 'self': return config.name;
        case 'person': return speaker(from.id);
        case 'bot': return from.name ? `${speakerName(from.name)} (bot)` : 'unknown';
        case 'unknown': return 'unknown';
      }
    };

    const context: { preview: string; text: string; files: IncomingFile[] }[] = [];
    for (const m of history.lines) {
      // The earlier worker's replies, cards and files may carry what was taken back: a fresh session doesn't get them.
      if (withoutBot && (m.from.kind === 'self' || m.from.kind === 'bot')) continue;
      // A meeting sent in a thread (SERRA-62) was turned away, not read: its text and files never reach a worker.
      if (meetingRequest(m.text).trigger) continue;
      const text = await toReadable(m.text);
      const files = m.files;
      if (!text && !files.length) continue;
      const speaker = await nameOf(m.from);
      // Reserve room for rendered paths, failure explanations and inspection instructions before selecting context.
      const attachmentBudget = files.length ? ' '.repeat(700 + files.length * (1_000 + config.profileDir.length)) : '';
      context.push({ preview: `${speaker}: ${text}${attachmentBudget}`, text: `${speaker}: ${text}`, files });
    }
    if (context.length === 0) return NO_THREAD;
    // Select context before downloading, and spend a single five-file budget on its newest attachments.
    const count = newestThatFit(context.map((line) => line.preview)).length;
    const selected = count ? context.slice(-count) : [];
    const lines: string[] = [];
    let remaining = MAX_ATTACHMENTS;
    for (const item of selected.toReversed()) {
      const attachments = await chat.receiveFiles(item.files, remaining);
      remaining = Math.max(0, remaining - item.files.length);
      lines.unshift([item.text, attachments].filter(Boolean).join('\n'));
    }
    const dropped = context.length - selected.length;
    const cut =
      dropped > 0 || history.more ? `(${dropped} older messages left out, and more may exist. Ask if you need them.)\n` : '';
    return quoteThread(cut + lines.join('\n'));
  };

  /** The acknowledgement on a message (Slack: 👀): the bot has it, and it goes away with the reply. */
  const setEyes = (channel: string, ts: string, on: boolean): Promise<void> => chat.acknowledge({ conversation: channel, id: ts }, on);

  /** The chat's native "working on it" status is best effort: the acknowledgement still shows work if it's unavailable. */
  const loading = new Map<string, { on: boolean; at: number }>();
  const setLoading = async (channel: string, threadTs: string, on: boolean, force = false): Promise<void> => {
    const key = slackKey(channel, threadTs);
    const previous = loading.get(key);
    if (!on && previous?.on === false) return;
    if (!force && (on ? previous?.on && now() - previous.at < LOADING_REFRESH_MS : !previous?.on)) return;
    loading.set(key, { on, at: now() });
    await chat.setWorking({ conversation: channel, thread: threadTs }, on);
  };

  const finishLoading = async (key: string, job: Job): Promise<void> => {
    await setLoading(job.channel, job.threadTs, false, job.loadingRequested === true);
    updateJob(key, () => ({ loadingRequested: false }));
  };

  /** Removes the 👀 from the messages a reply answers, and returns which ones, to take them off the job. */
  const clearEyes = async (job: Job): Promise<string[]> => {
    const cleared = pendingReactions(job);
    for (const ts of cleared) await setEyes(job.channel, ts, false);
    return cleared;
  };

  const notify = (channel: string, threadTs: string, notice: Notice): Promise<unknown> =>
    chat.notice({ conversation: channel, thread: threadTs }, notice);

  const refuse = (msg: IncomingMessage): Promise<void> => notify(msg.channel, msg.threadTs, { kind: 'refused' }).then(() => undefined);

  /**
   * The error itself goes to the log and the app (the `failure` event). It can be raw `t3` or `git` output, so the
   * thread gets a short reason (`shortError`: no command output, no local paths) only through `deliver`, when the chat
   * confirms that the owner alone can see it: their own DM. Anywhere else the owner gets a fixed sentence pointing at the app, and teammates a plain one.
   */
  const reportFailure = async (channel: string, threadTs: string, key: string, error: unknown, user?: string): Promise<void> => {
    await setLoading(channel, threadTs, false, getJob(key)?.loadingRequested === true);
    updateJob(key, () => ({ loadingRequested: false }));
    const message = errorMessage(error);
    logger.error(`Failed handling ${key}: ${message}`);
    events('failure', { key, error: message.slice(0, 500) });
    const post = async (): Promise<void> => {
      if (user === config.owner) {
        const detail = await deliver({ target: { conversation: channel, thread: threadTs }, requester: user, hearing: { kind: 'owner-only' } },
          { op: 'send', out: { kind: 'failure-detail', line: shortError(error) } });
        if (detail.ok) return;
      }
      await notify(channel, threadTs, { kind: 'failed', owner: user === config.owner });
    };
    await post().catch((failure: unknown) => logger.error(`Could not report the failure in ${key}: ${errorMessage(failure)}`));
  };

  /**
   * Who will see the bot's reply in this thread, for its brief. A thread the chat won't describe counts as outside:
   * the brief then carries only what may be said there.
   */
  const replyVisibility = async (msg: Pick<IncomingMessage, 'channel' | 'threadTs' | 'user'>): Promise<Visibility> => {
    const looked = await chat.audience({ conversation: msg.channel, thread: msg.threadTs }, msg.user);
    if (looked.ok) return looked.value;
    logger.warn(`Could not tell who can see ${msg.channel}, so its brief carries only what outsiders may hear.`);
    return 'external';
  };

  /**
   * The T3 thread an interrupted start already made for this request, or null. Only a thread no job follows, with this
   * title, made since the attempt: and, when the request's permalink is known, one whose brief names it. Without a
   * permalink a single candidate is taken; two are too ambiguous, so a new thread starts.
   */
  const earlierThread = async (title: string, attemptedAt: string, permalink: string | undefined): Promise<string | null> => {
    if (!t3.findThreads) return null;
    const followed = new Set(allJobs().map(([, job]) => job.t3ThreadId));
    const since = new Date(Date.parse(attemptedAt) - 60_000).toISOString();
    const candidates = (await t3.findThreads(config.project, title, since, config.t3Bin)).filter((id) => !followed.has(id));
    if (!permalink) return candidates.length === 1 ? candidates[0]! : null;
    for (const id of candidates) {
      const { messages } = await t3.showThread(id, config.t3Bin, RECENT_MESSAGES);
      if (messages.some((message) => message.role === 'user' && message.text?.includes(permalink))) return id;
    }
    return null;
  };

  const startJob = async (msg: IncomingMessage, request: string, summary: string, trigger?: MessageTrigger): Promise<void> => {
    const [requester, permalink, thread, visibility] = await Promise.all([
      trigger ? Promise.resolve(msg.botId ? `Automated alert from bot ${msg.botId}` : `Automatically triggered message from user ${msg.user}`) : speaker(msg.user),
      chat.permalink({ conversation: msg.channel, id: msg.messageTs }),
      threadContext(msg),
      replyVisibility(msg),
    ]);

    await fetchBase();
    const knowledge = loadKnowledge ? loadKnowledge(visibility) : null;
    // Proposals this thread's worker writes land in a folder Serra stamps with who started the thread, so the owner sees
    // where a proposal came from without taking the worker's word for it.
    const proposalsFolder = loadKnowledge ? threadProposalsFolder(msg.channel, msg.threadTs) : undefined;
    if (proposalsFolder) {
      try {
        stampProposalsFolder(config.knowledgeDir, proposalsFolder, { who: requester, owner: !trigger && msg.user === config.owner, via: 'slack', ...(permalink ? { link: permalink } : {}) });
      } catch (error) { logger.warn(`Could not record where ${msg.channel}:${msg.threadTs}'s proposals come from: ${errorMessage(error)}`); }
    }
    const input = jobThreadInput(config, {
      // The branch and title come from what the person wrote, not the request with its attachment notes.
      summary,
      brief: fillBrief(config, knowledge ?? loadIndex(), { request, requester, permalink: permalink ?? 'link unavailable', thread,
        ...(proposalsFolder ? { proposalsFolder } : {}),
        ...(trigger ? { triggerInstructions: trigger.instructions } : {}) }),
      now: new Date(now()),
    });
    // A replay of a held request whose start was cut off: its thread may exist already (INTAKE-010).
    const earlier = msg.attemptedAt
      ? await earlierThread(input.title, msg.attemptedAt, permalink ?? undefined).catch((error: unknown) => {
        logger.warn(`Couldn't look for a thread started before the restart for ${msg.channel}:${msg.threadTs}: ${errorMessage(error)}`);
        return null;
      })
      : null;
    if (earlier) logger.info(`Carrying on in T3 thread ${earlier}, started for ${msg.channel}:${msg.threadTs} before a restart.`);
    const t3ThreadId = earlier ?? await t3.startThread(input, config.t3Bin);

    putJob(slackKey(msg.channel, msg.threadTs), {
      t3ThreadId,
      channel: msg.channel,
      threadTs: msg.threadTs,
      requester: msg.user,
      pendingReactionTs: null,
      pendingReactions: [msg.messageTs],
      loadingRequested: true,
      nextTurnWaits: true,
      heard: [msg.messageTs],
      lastPostedRunId: null,
      phase: { state: 'following' },
      ownerFollows: msg.user === config.owner,
      ...(knowledge ? { visibility, knowledgeRead: knowledge.read, knowledgeDir: knowledge.readDir } : {}),
      branch: input.branch,
      createdAt: new Date(now()).toISOString(),
      lastActivityAt: new Date(now()).toISOString(),
    });
    logger.info(`Started T3 thread ${t3ThreadId} for ${msg.channel}:${msg.threadTs}`);
    events('job_started', { key: slackKey(msg.channel, msg.threadTs), t3ThreadId, requester: msg.user });
  };

  /** One job's chat-facing work runs one step at a time, so a poll and a follow-up can't both post the same run. */
  const jobQueues = new Map<string, Promise<unknown>>();
  const exclusive = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = inFlight.track((jobQueues.get(key) ?? Promise.resolve()).then(work, work));
    jobQueues.set(key, next.catch(() => undefined));
    return next;
  };

  /** Takes the "still working" line away once its run has a reply. */
  const clearProgress = async (key: string, job: Job): Promise<void> => {
    if (job.phase.state === 'idle' && job.phase.leftover) {
      await chat.remove(messageIn(job, job.phase.leftover.ts));
      updateJob(key, (latest) => (latest.phase.state === 'idle' ? { phase: settle() } : {}));
      return;
    }
    const run = seenRun(job.phase);
    if (!run?.progress) return;
    await chat.remove(messageIn(job, run.progress.ts));
    updateJob(key, (latest) => ({ phase: withProgress(latest.phase, run.id, undefined) }));
  };

  /**
   * Where the worker's words for this job go. `deliver` checks right before each write that every page the worker
   * read is for whoever can see the thread then.
   */
  const deliveryFor = (job: Job): Delivery => ({ target: targetOf(job), requester: job.requester, hearing: { kind: 'thread', heard: heardIn(job) } });

  /**
   * Posts a run's reply, at least once and rarely twice. The intent is saved first, the post carries the run ID (Slack:
   * message metadata), and the run is recorded as posted as soon as the chat accepts it. A restart that finds the
   * intent still saved looks for that run in the thread (`chat.findReply`) before posting again, so only a crash while
   * the chat is answering the post, followed by a failed thread read, can post it twice. Nothing is ever lost.
   *
   * `out` is the worker's reply, written through `deliver`; when it refuses (or `out` is null), the notice goes in its
   * place: `notice`, or the one for the refusal. Returns the posted message's ID and whether a notice took its place.
   */
  const postReply = async (key: string, job: Job, runId: string, thread: Pick<T3Thread, 'activeRunId'>, out: WorkerOut | null, notice: Notice | null,
    inPlaceOf: InPlaceOf, { byWorker, owner = {}, ownerIfNotice = owner }: { byWorker: boolean; owner?: OwnerFlags; ownerIfNotice?: OwnerFlags }): Promise<{ id: string | undefined; notice: boolean }> => {
    const text = out && 'markdown' in out ? out.markdown.slice(0, INTENT_TEXT) : undefined;
    updateJob(key, () => ({ delivering: { runId, at: new Date(now()).toISOString(), ...(text === undefined ? {} : { text }), ...owner } }));
    let instead = notice;
    let id: string | undefined;
    if (out) {
      const sent = await deliver(deliveryFor(job), { op: 'send', out });
      if (sent.ok) id = sent.value;
      else {
        instead = refusalNotice(sent);
        if (sent.why === 'unconfirmed' && sent.error.kind === 'setup') {
          logger.error(`The chat won't say who can see ${key} (${sent.error.code}): update the chat app's permissions (docs/configuration.md) and reinstall it.`);
          events('failure', { key, error: `The chat won't say who can see this thread (${sent.error.code}). Update the chat app's permissions and reinstall it; until then replies there are held.` });
        }
      }
    }
    const flags = instead ? ownerIfNotice : owner;
    if (instead) {
      // A restart that finds this notice posted restores what a notice means for the owner, not what the reply would have.
      if (out) updateJob(key, (latest) => (latest.delivering ? { delivering: { ...latest.delivering, ...flags } } : {}));
      id = await chat.notice(targetOf(job), instead, inPlaceOf);
    }
    updateJob(key, (latest) => ({ lastPostedRunId: runId, delivering: undefined, phase: replied(latest.phase, thread.activeRunId), ...turnOver(latest, runId, byWorker), ...flags }));
    return { id, notice: instead !== null };
  };

  /**
   * A run that was never seen going (it started and ended between polls) answered the turn Serra sent last: that
   * turn's `nextTurnWaits` is spent, and must not carry over to a later run started in T3.
   */
  const turnOver = (job: Job, runId: string, byWorker: boolean): Partial<Job> =>
    !byWorker && seenRun(job.phase)?.id !== runId && job.nextTurnWaits !== undefined ? { nextTurnWaits: undefined } : {};

  /**
   * Posts the worker's review request in the code-review channel through `deliver`: only when everyone there may hear
   * what this thread's worker was told, and whoever sees this thread now may too, checked right before it's sent.
   * Otherwise it's the owner's to check and post.
   */
  const postReview = (job: Job, channel: string, link: string): PostReview => async (markdown) => {
    const target: Target = { conversation: channel, thread: null };
    const sent = await deliver({ target, requester: config.owner, hearing: { kind: 'elsewhere', heard: heardIn(job), source: { target: targetOf(job), requester: job.requester } } },
      { op: 'send', out: { kind: 'review', markdown, from: config.name, link } });
    if (!sent.ok) return sent.why === 'withheld' ? { ok: false, refused: true } : { ok: false, error: 'I couldn\'t confirm who can see the review channel or this thread just now' };
    return { ok: true, link: await chat.permalink({ conversation: channel, id: sent.value }) };
  };

  /** Uploads one file the reply attaches into the job's thread, through `deliver`. */
  const uploadFor = (job: Job): Upload => async (file) => {
    const sent = await deliver(deliveryFor(job), { op: 'upload', file });
    return sent.ok ? sent.value : 'refused';
  };

  /**
   * Posts a finished run's reply. A run the worker started on its own (following CI or a bot's review) edits one
   * status message instead, unless it needs someone: a `Needs` line, a review request, an upload or a first cc.
   */
  const postRunResult = async (key: string, job: Job, thread: T3Thread, reply: string, byWorker: boolean, runId: string): Promise<void> => {
    // A reply the worker wrote with knowledge the owner has since taken back isn't posted: it may repeat that text.
    // When the chat can't say who sees the thread, nothing is posted yet: the next poll tries again.
    const check = !QUIET.test(reply) && loadKnowledge ? await revocation(job) : null;
    const setup = check?.unknown ? check.setup : undefined;
    const problem = setup?.problem;
    if (check?.unknown && !setup) {
      logger.warn(`Could not confirm who can see ${key}; the reply waits for the next check.`);
      return;
    }
    if (setup) {
      // Asking again won't help: the owner is told what to fix, and the thread gets a notice instead of the reply.
      logger.error(`The chat won't say who can see ${key} (${setup.code}): update the chat app's permissions (docs/configuration.md) and reinstall it.`);
      events('failure', { key, error: `The chat won't say who can see this thread (${setup.code}). Update the chat app's permissions and reinstall it; until then replies there are held.` });
    }
    /** A notice in place of the reply (a setup problem, or a withheld answer): it isn't the run's result. */
    let replaced: Notice | null = problem ? { kind: 'setup-problem', problem } : check && check.revoked.length > 0 ? { kind: 'withheld' } : null;
    const seen = seenRun(job.phase);
    const runMs = seen?.id === runId ? now() - Date.parse(seen.at) : undefined;
    const measured = { key, runId, byWorker, runMs, jobAgeMs: now() - Date.parse(job.createdAt), ...(replaced ? { notice: true } : {}) };
    await clearProgress(key, job);
    // The bot stopped while posting this run's reply (REPLY-009): if the thread has it, it isn't posted again.
    const recovered = job.delivering?.runId === runId
      ? await chat.findReply(targetOf(job), { runId, at: job.delivering.at, ...(job.delivering.text === undefined ? {} : { text: job.delivering.text }) })
      : null;
    if (recovered) {
      const cleared = await clearEyes(job);
      const { ownerFollows, ownerAskOpen } = job.delivering ?? {};
      updateJob(key, (latest) => ({ lastPostedRunId: runId, delivering: undefined, phase: replied(latest.phase, thread.activeRunId), ...withoutReactions(latest, cleared),
        ...turnOver(latest, runId, byWorker), ...(ownerFollows === undefined ? {} : { ownerFollows }), ...(ownerAskOpen === undefined ? {} : { ownerAskOpen }),
        ...(byWorker ? { statusTs: recovered } : { statusTs: undefined }), lastActivityAt: new Date(now()).toISOString() }));
      await finishLoading(key, job);
      logger.info(`The reply to ${runId} in ${key} was posted before a restart; not posting it again.`);
      events('reply', { ...measured, kind: byWorker ? 'status_posted' : 'reply', recovered: true });
      return;
    }
    if (!replaced && QUIET.test(reply)) {
      // Nothing to say: the 👀 goes away, which tells the thread the message was seen.
      const cleared = await clearEyes(job);
      updateJob(key, (latest) => ({ lastPostedRunId: runId, delivering: undefined, phase: replied(latest.phase, thread.activeRunId), ...turnOver(latest, runId, byWorker), ...withoutReactions(latest, cleared) }));
      await finishLoading(key, job);
      events('reply', { ...measured, kind: 'quiet' });
      return;
    }
    /** The worker's reply as it will be posted, or null when a notice takes its place. */
    let markdown: string | null = null;
    let reviewPosted = false;
    let uploaded = false;
    if (!replaced) {
      const chatThread = await chat.permalink(messageIn(job, job.threadTs));
      const review = await reviewRequest(reply, {
        ...(config.reviewChannel ? { post: postReview(job, config.reviewChannel, chatThread ?? thread.link) } : {}),
        repositories: config.reviewRepos,
        ...(config.githubLogin ? { githubLogin: config.githubLogin } : {}),
        alreadyPosted: job.reviewRequestedPrs ?? [],
      });
      // A review request is its own post in another channel: recorded as soon as it is out, so no retry or restart posts it twice.
      const postedFor = review.postedFor;
      if (postedFor) updateJob(key, (latest) => ({ reviewRequestedPrs: [...new Set([...(latest.reviewRequestedPrs ?? []), postedFor])] }));
      reviewPosted = postedFor !== null;
      // Images go up first, so they sit in the thread just above the reply that refers to them. Checked again right
      // before uploading (each upload, through `deliver`) and before posting: who can see the thread, and what its
      // worker was told, can change meanwhile. The chat can't say who sees the thread before anything is uploaded: the
      // reply waits for the next check. A review request already posted is recorded first, so the retry doesn't post it twice.
      const before = loadKnowledge ? await revocation(job) : null;
      if (before?.unknown) {
        logger.warn(`Could not confirm who can see ${key} before uploading; the reply waits for the next check.`);
        return;
      }
      if (before && before.revoked.length > 0) replaced = { kind: 'withheld' };
      else {
        const shared = await share(review.reply, uploadFor(job));
        uploaded = shared !== review.reply;
        markdown = localLinksToText(shared, pathRoots).trim() || '(No reply text. Check the T3 thread.)';
      }
    }
    // The owner is pinged for a new blocker, and cc'd once so they follow a thread someone else started. Not on every reply.
    const blocked = markdown !== null && needsOwner(markdown, config.ownerName);
    const ownerFollows = job.ownerFollows ?? job.requester === config.owner;
    const notice = ownerNotice({ blocked, askOpen: job.ownerAskOpen ?? false, ownerFollows });
    /** How a notice standing in for the reply tells the owner: a notice is never a blocker. */
    const noticeNotify = ownerNotice({ blocked: false, askOpen: job.ownerAskOpen ?? false, ownerFollows });

    // Someone still has a 👀 on their message: this reply may be all they get, so it is a real post.
    const someonePending = pendingReactions(job).length > 0;
    if (byWorker && !someonePending && !blocked && !reviewPosted && !uploaded && notice === 'none') {
      const out: WorkerOut | null = markdown === null ? null : { kind: 'status', markdown, link: thread.link, runId, updatedAt: now() };
      let edited = false;
      let withheld = false;
      if (job.statusTs) {
        const ref = messageIn(job, job.statusTs);
        // A status message someone deleted can't be edited: a new one takes its place.
        const revised = out ? await deliver(deliveryFor(job), { op: 'revise', ref, out }).catch((error: unknown) => {
          logger.debug(`Editing the status message in ${key} failed: ${errorMessage(error)}`);
          return null;
        }) : null;
        if (revised?.ok) edited = true;
        else if (revised || replaced) {
          const instead = revised && !revised.ok ? refusalNotice(revised) : replaced;
          if (instead) {
            edited = await chat.replaceWithNotice(ref, instead, 'status');
            withheld = edited;
          }
        }
      }
      // A new post in place of a failed edit is checked again first, by `deliver`: time has passed.
      const posted = edited ? null : await postReply(key, job, runId, thread, out, replaced, { runId, frame: 'status' }, { byWorker });
      const statusTs = edited ? job.statusTs : posted?.id;
      updateJob(key, (latest) => ({
        lastPostedRunId: runId,
        delivering: undefined,
        ...turnOver(latest, runId, byWorker),
        phase: replied(latest.phase, thread.activeRunId),
        ...(statusTs ? { statusTs } : {}),
        lastActivityAt: new Date(now()).toISOString(),
      }));
      await finishLoading(key, job);
      events('reply', { ...measured, ...(replaced || withheld || posted?.notice ? { notice: true } : {}), kind: edited ? 'status_edited' : 'status_posted' });
      return;
    }

    const ownerAfter = (told: OwnerNotify, needs: boolean, latest: Job) => ({
      ownerFollows: ownerFollows || told !== 'none' || latest.ownerFollows === true,
      // The owner may have answered while this reply was being posted.
      ownerAskOpen: needs && (told === 'callout' || latest.ownerAskOpen === true),
    });
    const out: WorkerOut | null = markdown === null ? null : { kind: 'reply', markdown, link: thread.link, notify: notice, runId };
    const posted = await postReply(key, job, runId, thread, out, replaced, { runId, frame: 'reply', link: t3LinkOf(thread.link), notify: noticeNotify },
      { byWorker, owner: out ? ownerAfter(notice, blocked, job) : ownerAfter(noticeNotify, false, job), ownerIfNotice: ownerAfter(noticeNotify, false, job) });
    // A notice that took the reply's place is no blocker, and tells the owner as a notice does.
    const [told, needs] = posted.notice ? [noticeNotify, false] : [notice, blocked];
    const cleared = await clearEyes(job);
    updateJob(key, (latest) => ({
      lastPostedRunId: runId,
      phase: replied(latest.phase, thread.activeRunId),
      ...withoutReactions(latest, cleared),
      ...ownerAfter(told, needs, latest),
      // The next status update goes below this reply, not into a message further up.
      statusTs: undefined,
      lastActivityAt: new Date(now()).toISOString(),
    }));
    await finishLoading(key, job);
    events('reply', { ...measured, ...(posted.notice ? { notice: true } : {}), kind: 'reply', needsOwner: needs, reviewRequested: reviewPosted });
    if (told === 'callout') events('needs_owner', { key });
  };

  /**
   * A run someone is waiting on that has gone on for a few minutes shows the worker's latest note in one line,
   * edited as the note changes, so the thread isn't just 👀 for half an hour. The line goes when the reply comes.
   */
  const showProgress = async (key: string, job: Job, next: Extract<PollStep, { do: 'follow' }>, messages: T3Message[]): Promise<void> => {
    const { runId } = next;
    if (next.firstSight) {
      // A line left from an earlier run goes first: it belongs to the run being replaced.
      await clearProgress(key, job);
      // The first sight of a run binds the turn Serra sent to it. A run the worker started on its own leaves that
      // turn for the run that answers it.
      // `pollJob` left any wait before following a run: the run seen replaces what the job followed.
      updateJob(key, () => ({ phase: seeRun({ id: runId, at: new Date(now()).toISOString(), waits: next.waits }),
        ...(next.byWorker ? {} : { nextTurnWaits: undefined }) }));
      return;
    }
    const run = seenRun(job.phase);
    if (!run || now() - Date.parse(run.at) < PROGRESS_AFTER_MS || !next.waits) return;
    const note = latestNote(runId, messages);
    if (!note) return;
    const text = `⏳ Still on it: ${oneParagraph(localLinksToText(note, pathRoots))}`;
    if (run.progress?.text === text) return;
    // A progress note is the worker's own words: none from a thread whose knowledge was taken back, checked by
    // `deliver` right before it goes out.
    const out: WorkerOut = { kind: 'progress', text };
    if (run.progress) {
      const ts = run.progress.ts;
      const revised = await deliver(deliveryFor(job), { op: 'revise', ref: messageIn(job, ts), out })
        .catch((error: unknown) => { logger.debug(`Editing the progress line in ${key} failed: ${errorMessage(error)}`); return null; });
      if (revised && !revised.ok) return;
      updateJob(key, (latest) => ({ phase: withProgress(latest.phase, runId, { ts, text }) }));
      return;
    }
    const sent = await deliver(deliveryFor(job), { op: 'send', out });
    if (!sent.ok) return;
    updateJob(key, (latest) => ({ phase: withProgress(latest.phase, runId, { ts: sent.value, text }) }));
    // Posting any message clears Slack's native status, even when it is only a progress update.
    await setLoading(job.channel, job.threadTs, true, true);
    events('progress_shown', { key, runId, afterMs: now() - Date.parse(run.at) });
  };

  const mayAnswer = (job: Job, user: string): boolean => config.allowed.has(user) && (user === config.owner || user === job.requester);

  /**
   * Takes a question card down: it shows the answers chosen, through `deliver`, since the questions are the worker's
   * words. A card closed because its thread's knowledge was taken back, or that `deliver` refuses, gets fixed copy.
   */
  const clearQuestion = async (key: string, job: Job, answeredBy?: string, state = cardOf(job), closed = false): Promise<void> => {
    if (!state) return;
    updateJob(key, (latest) => ({ phase: stopWaiting(latest.phase) }));
    const ref = messageIn(job, state.ts);
    if (!closed) {
      const revised = await deliver(deliveryFor(job), { op: 'revise', ref, out: { kind: 'answered', card: state, ...(answeredBy ? { by: answeredBy } : {}) } })
        .catch((error: unknown) => { logger.debug(`Updating the question in ${key} failed: ${errorMessage(error)}`); return null; });
      if (revised === null || revised.ok) return;
      // Not knowing who can see the thread isn't knowledge taken back: the card says only that it's over.
      if (revised.why === 'unconfirmed') {
        await chat.replaceWithNotice(ref, { kind: 'question-over', answered: answeredBy !== undefined });
        return;
      }
    }
    await chat.replaceWithNotice(ref, { kind: 'question-closed' });
  };

  const showQuestion = async (key: string, job: Job, thread: T3Thread, request: T3QuestionRequest): Promise<void> => {
    if (cardOf(job)?.requestId === request.requestId) return;
    if (cardOf(job)) await clearQuestion(key, job);
    // A question card is the worker's own words too: a thread whose knowledge was taken back gets a stop instead,
    // checked before the card would be posted. When the chat can't say who sees the thread, the card waits.
    const check = loadKnowledge ? await revocation(job) : null;
    if (check?.unknown) return;
    if (check && check.revoked.length > 0) {
      await questions.answerQuestion(job.t3ThreadId, request.requestId, Object.fromEntries(request.questions.map((item) => [item.id, 'Stop here: some knowledge you used has been made private. Do nothing more.'])), config.t3Bin)
        .catch((error: unknown) => logger.warn(`Could not stop the question in ${job.t3ThreadId}: ${errorMessage(error)}`));
      await notify(job.channel, job.threadTs, { kind: 'withheld' });
      updateJob(key, () => ({ lastActivityAt: new Date(now()).toISOString() }));
      return;
    }
    const state: QuestionCard = { ...request, ts: '', index: 0, answers: {}, nonce: randomBytes(16).toString('hex'), runId: thread.activeRunId ?? thread.latestRunId };
    const recipient = config.allowed.has(job.requester) ? job.requester : config.owner;
    // Checked again by `deliver` right before the card goes out. Refused, the next poll decides again.
    const posted = await deliver(deliveryFor(job), { op: 'send', out: { kind: 'question', card: state, to: recipient } });
    if (!posted.ok) return;
    updateJob(key, (latest) => ({ phase: waitFor(latest.phase, { ...state, ts: posted.value }), ownerFollows: latest.ownerFollows || recipient === config.owner }));
    events('question_shown', { key, requestId: request.requestId, count: request.questions.length });
  };

  const questionFeedback = (job: Job, hint: Extract<Notice, { kind: 'question-hint' }>['hint']): Promise<unknown> =>
    notify(job.channel, job.threadTs, { kind: 'question-hint', hint });

  /** Recheck T3 before accepting a selection: another client may already have answered the form. */
  const submitAnswer = async (key: string, job: Job, answer: QuestionAnswer, user: string, messageTs?: string): Promise<void> => {
    const state = cardOf(job);
    if (!state) return;
    const pending = (await questions.listQuestions(job.t3ThreadId, config.t3Bin)).find((request) => request.requestId === state.requestId);
    if (!pending || JSON.stringify(pending.questions) !== JSON.stringify(state.questions)) {
      await clearQuestion(key, job);
      await questionFeedback(job, 'changed');
      return;
    }
    const question = state.questions[state.index]!;
    const answers = { ...state.answers, [question.id]: answer };
    const rememberReply = (latest: Job): Partial<Job> => messageTs
      ? { answeredQuestionMessages: [...(latest.answeredQuestionMessages ?? []), messageTs].slice(-20) } : {};
    // When the chat can't say who sees the thread, the form doesn't move on: the next question is the worker's words.
    const check = loadKnowledge ? await revocation(job) : null;
    if (check?.unknown) {
      await (check.setup ? notify(job.channel, job.threadTs, { kind: 'setup-problem', problem: check.setup.problem }) : questionFeedback(job, 'unconfirmed'));
      return;
    }
    // The next question is the worker's own words too: a thread whose knowledge was taken back shows none, and the
    // answers so far go to a fresh thread.
    const answered = typeof answer === 'string' ? answer : answer.join(', ');
    // The fresh thread isn't told the question or the choice: both are the earlier worker's words, written with knowledge
    // that's no longer available.
    const typed = typeof answer === 'string' && !question.options.some((option) => (option.value ?? option.label) === answer);
    const note = `Answered a question from the earlier session${typed ? `: "${answered}"` : ''}. The question isn't repeated here because it used knowledge that's no longer available: ask again if you still need it.`;
    // On a restart, the old card is closed and the old session told to stop before anything else (see restartIfRevoked).
    if (await restartIfRevoked(key, { ...job, phase: waitFor(job.phase, state) }, [{ speaker: user === config.owner ? `${config.ownerName} (your owner)` : await displayName(user), text: note, audience: 'bot', ts: messageTs ?? job.threadTs }])) {
      updateJob(key, rememberReply);
      return;
    }
    if (state.index + 1 < state.questions.length) {
      const next = { ...state, answers, index: state.index + 1, nonce: randomBytes(16).toString('hex') };
      const recipient = config.allowed.has(job.requester) ? job.requester : config.owner;
      const out: WorkerOut = { kind: 'question', card: next, to: recipient };
      // Save only after the edit succeeds, so a failed edit leaves usable choices and can be retried. The next question
      // is the worker's words: `deliver` checks it first, and a card it refuses is closed with fixed copy.
      /** A refused card: withheld closes the form with fixed copy; unconfirmed keeps it as it is, to answer again. */
      const refusedCard = async (refused: Refused): Promise<void> => {
        if (refused.why === 'withheld') await clearQuestion(key, job, user, { ...state, answers }, true);
        else if (refused.error.kind === 'setup') await notify(job.channel, job.threadTs, { kind: 'setup-problem', problem: refused.error.problem });
        else await questionFeedback(job, 'unconfirmed');
      };
      try {
        const revised = await deliver(deliveryFor(job), { op: 'revise', ref: messageIn(job, state.ts), out });
        if (!revised.ok) return await refusedCard(revised);
      } catch (error) {
        if (!(error instanceof MessageGone)) throw error;
        // A new card in place of one someone deleted.
        const posted = await deliver(deliveryFor(job), { op: 'send', out });
        if (!posted.ok) return await refusedCard(posted);
        next.ts = posted.value;
      }
      updateJob(key, (latest) => ({ phase: waitFor(latest.phase, next), ...rememberReply(latest) }));
      return;
    }
    await questions.answerQuestion(job.t3ThreadId, state.requestId, answers, config.t3Bin);
    updateJob(key, rememberReply);
    await clearQuestion(key, job, user, { ...state, answers });
    updateJob(key, (latest) => ({ phase: follow(latest.phase), loadingRequested: true, lastActivityAt: new Date(now()).toISOString() }));
    await setLoading(job.channel, job.threadTs, true);
    events('question_answered', { key, requestId: state.requestId, user });
  };

  const handleQuestionAction = async (action: QuestionInteraction): Promise<void> => {
    const found = allJobs().find(([, job]) => job.channel === action.channel && cardOf(job)?.ts === action.messageTs);
    if (!found) return;
    const [key] = found;
    await exclusive(key, async () => {
      const job = getJob(key);
      const card = job ? cardOf(job) : undefined;
      if (!job || !card || card.nonce !== action.nonce || !mayAnswer(job, action.user)) return;
      const answer = choiceAnswer(card.questions[card.index]!, action.indices);
      if (answer === null) {
        await questionFeedback(job, 'choose');
        return;
      }
      await submitAnswer(key, job, answer, action.user).catch(async (error: unknown) => {
        logger.error(`Answering question in ${key} failed: ${errorMessage(error)}`);
        await questionFeedback(job, 'not-sent');
      });
    });
  };

  /** Secrets, approvals and forms the chat cannot display stay in T3. Queued follow-ups wait for their resolution. */
  const postWaitingNotice = async (key: string, job: Job, thread: T3Thread): Promise<void> => {
    await setLoading(job.channel, job.threadTs, false, job.loadingRequested === true);
    await notify(job.channel, job.threadTs, { kind: 'waiting-in-t3', link: t3LinkOf(thread.link) });
    updateJob(key, (latest) => ({ phase: waitFor(latest.phase), ownerFollows: true, lastActivityAt: new Date(now()).toISOString() }));
    logger.info(`T3 thread ${job.t3ThreadId} is waiting on a request; told the owner in ${key}`);
    events('waiting_in_t3', { key, t3ThreadId: job.t3ThreadId });
    events('needs_owner', { key });
  };

  /**
   * One poll of one job: `step` (lifecycle.ts) decides from the saved job and what T3 shows; this performs it through
   * the chat and T3, and saves the phase it leads to.
   */
  const pollJob = async (key: string): Promise<void> => {
    const job = getJob(key);
    if (!job) return;
    const observed = await t3.showThread(job.t3ThreadId, config.t3Bin, RECENT_MESSAGES);
    const { thread, messages } = observed;
    let next = step(job, observed);
    if (next.do === 'post' && next.missed) {
      // A reply to someone that the worker's next run (following CI, say) started before the bot saw it finish.
      await postRunResult(key, job, thread, next.text, false, next.runId);
      next = step(getJob(key) ?? job, observed, { missed: false });
    }
    const latest = getJob(key) ?? job;

    if (next.do === 'wait') {
      await setLoading(latest.channel, latest.threadTs, false);
      const requests = await questions.listQuestions(job.t3ThreadId, config.t3Bin).catch((error: unknown) => {
        logger.debug(`Reading questions in ${key} failed: ${errorMessage(error)}`);
        return null;
      });
      const shown = waitStep(latest.phase, requests, canShowQuestion);
      if (shown.do === 'card') await showQuestion(key, latest, thread, shown.request);
      else if (shown.do === 'in-t3') {
        if (shown.closeCard) await clearQuestion(key, latest);
        for (const unsupported of shown.unsupported) {
          const options = unsupported.questions.flatMap((question) => question.options);
          const limits = {
            questionCount: unsupported.questions.length,
            maxQuestionChars: Math.max(0, ...unsupported.questions.map((question) => question.question.length)),
            maxOptionCount: Math.max(0, ...unsupported.questions.map((question) => question.options.length)),
            maxLabelChars: Math.max(0, ...options.map((option) => option.label.length)),
            maxDescriptionChars: Math.max(0, ...options.map((option) => option.description.length)),
          };
          logger.warn(`Question ${unsupported.requestId} in ${key} exceeds the chat's display limits; using the T3 link.`);
          events('question_fallback', { key, requestId: unsupported.requestId, reason: 'display_limits', ...limits });
        }
        await postWaitingNotice(key, getJob(key) ?? latest, thread);
      }
      return;
    }
    // T3 no longer waits on anyone: a card still up is closed, and the job is followed as before.
    if (cardOf(latest)) await clearQuestion(key, latest);
    else if (latest.phase.state === 'waiting') updateJob(key, (current) => ({ phase: stopWaiting(current.phase) }));
    const saved = getJob(key) ?? latest;

    switch (next.do) {
      case 'follow':
        await setLoading(saved.channel, saved.threadTs, saved.loadingRequested === true || next.waits);
        await showProgress(key, saved, next, messages);
        return;
      case 'post':
        await postRunResult(key, saved, thread, next.text, next.byWorker, next.runId);
        return;
      case 'settle':
        // Nothing runs and every run is posted: a progress line or a seen run left from earlier is over too.
        await clearProgress(key, saved);
        await finishLoading(key, saved);
        updateJob(key, () => ({ phase: settle() }));
        return;
    }
  };

  /**
   * `revokedAt` (`hearing.ts`) for who can see the thread now, asked of the chat: a channel shared with another company
   * since is outside. `unknown` when the chat can't say (`setup` when it won't until the owner fixes the app). Checked
   * before a turn and before work that ends in a post; `deliver` checks again right before each write.
   */
  const revocation = async (job: Job): Promise<{ visibility: Visibility; knowledge: BriefKnowledge; revoked: string[]; unknown: boolean; setup?: { problem: SetupProblem; code: string } }> => {
    const current = await chat.audience(targetOf(job), job.requester, { fresh: true });
    if (current.ok) return { ...revokedAt(loadKnowledge!, job, current.value), unknown: false };
    const visibility = job.visibility ?? 'external';
    const knowledge = loadKnowledge!(visibility);
    // The owner may hear anything they ever had: a thread only they could see stays theirs.
    if (visibility === 'owner') return { visibility, knowledge, revoked: [], unknown: false };
    return { visibility, knowledge, revoked: ['(who can see this thread is unknown)'], unknown: true,
      ...(current.error.kind === 'setup' ? { setup: { problem: current.error.problem, code: current.error.code } } : {}) };
  };

  /**
   * When a page this thread's brief allowed has since been restricted, retired or removed, the old T3 thread still has
   * its text in context. The next turn then starts a fresh thread, briefed from the knowledge as it is now, with the
   * chat thread so far as context. Returns true when it did.
   */
  const restartIfRevoked = async (key: string, job: Job, lines: HeardLine[]): Promise<boolean> => {
    if (!loadKnowledge) return false;
    const { visibility, knowledge, revoked, unknown } = await revocation(job);
    // Not knowing who sees the thread is no reason to restart: what's said to the worker isn't posted anywhere.
    if (unknown) return false;
    // A snapshot folder cleaned up after a long pause leaves the worker nothing to open: that thread starts fresh too.
    const folderGone = job.knowledgeDir !== undefined && !existsSync(job.knowledgeDir);
    if (revoked.length === 0 && !folderGone) {
      // A thread from before Serra recorded what its worker read keeps no record: today's pages aren't what it read.
      if (!job.visibility) updateJob(key, () => ({ visibility }));
      return false;
    }
    // An open question card is the old worker's words: it's closed with fixed copy, and the old session told to stop,
    // before the thread's history is read for the fresh brief, so the question never reaches it.
    const open = cardOf(job);
    if (open) {
      await questions.answerQuestion(job.t3ThreadId, open.requestId, Object.fromEntries(open.questions.map((item) => [item.id, 'Stop here: this thread moved to a fresh session. Do nothing more.'])), config.t3Bin)
        .catch((error: unknown) => logger.warn(`Could not close the question in the earlier T3 thread ${job.t3ThreadId}: ${errorMessage(error)}`));
      await clearQuestion(key, job, undefined, open, true);
    }
    // The old run's progress line is the old worker's words too: it goes now, with the card.
    await clearProgress(key, getJob(key) ?? job);
    const first = lines[0]!;
    const thread = await threadContext({ channel: job.channel, threadTs: job.threadTs, messageTs: first.ts, user: job.requester, text: '', direct: false }, { withoutBot: true });
    await fetchBase();
    // The fresh thread starts from the old thread's branch, so committed work carries on, and is told where it was.
    const earlier = job.branch
      ? `\n\nEarlier work in this thread is on the branch \`${job.branch}\`, which this worktree starts from. Carry on from it, and keep using its PR if it has one.`
      : `\n\nThis thread started before Serra recorded branches, so earlier work may be on a branch this worktree doesn't start from: look for it with \`git branch --list '${config.id}/*'\` and its PR with \`gh pr list --author @me\`, and carry on from there.`;
    const input = jobThreadInput(config, {
      summary: 'continued with updated knowledge',
      brief: fillBrief(config, knowledge, { proposalsFolder: threadProposalsFolder(job.channel, job.threadTs), request: `${followUpMessage(lines)}${earlier}\n\nThe thread's earlier messages from ${config.name} are left out here, because some knowledge they used is no longer available.`, requester: 'People in the thread', permalink: 'link unavailable', thread }),
      now: new Date(now()),
    });
    const t3ThreadId = await t3.startThread({ ...input, ...(job.branch ? { baseRef: job.branch } : {}) }, config.t3Bin);
    updateJob(key, () => ({ t3ThreadId, visibility, knowledgeRead: knowledge.read, knowledgeDir: knowledge.readDir, branch: input.branch, lastPostedRunId: null, nextTurnWaits: lines.some((line) => line.audience === 'bot'), delivering: undefined, phase: { state: 'following' } }));
    await notify(job.channel, job.threadTs, { kind: 'fresh-session' });
    logger.info(`${folderGone ? 'The knowledge folder this thread read was cleaned up' : `Knowledge this thread used was taken back (${revoked.length} page(s))`}; continued ${key} in a fresh T3 thread ${t3ThreadId}`);
    events('knowledge_revoked', { key, t3ThreadId });
    return true;
  };

  const followUps = createBatcher<HeardLine>({
    clock,
    quietMs: timing.quietMs,
    retryMs: timing.retryMs,
    busy: async (key) => {
      const job = getJob(key);
      if (!job) return false;
      const { thread } = await t3.showThread(job.t3ThreadId, config.t3Bin);
      return thread.activeRunId !== null || (thread.pendingRequestCount ?? 0) > 0;
    },
    flush: (key, lines) => exclusive(key, async () => {
      // Post the finished turn's reply before starting the next one, or the next run would hide it.
      await pollJob(key);
      const job = getJob(key);
      if (!job) return;
      const loadingRequested = lines.some((line) => line.audience === 'bot');
      if (loadingRequested) await setLoading(job.channel, job.threadTs, true);
      if (!(await restartIfRevoked(key, job, lines))) await t3.sendToThread(job.t3ThreadId, followUpMessage(lines), config.t3Bin);
      // The reply just posted took every 👀 with it. These messages are only now with the worker, so they get theirs back.
      const waiting = lines.filter((line) => line.audience !== 'others').map((line) => line.ts);
      for (const ts of waiting) await setEyes(job.channel, ts, true);
      updateJob(key, (latest) => ({ phase: follow(latest.phase), loadingRequested, nextTurnWaits: loadingRequested, lastActivityAt: new Date(now()).toISOString(), pendingReactionTs: null, pendingReactions: [...new Set([...pendingReactions(latest), ...waiting])] }));
      logger.info(`Forwarded ${lines.length} thread message(s) to T3 thread ${getJob(key)?.t3ThreadId ?? job.t3ThreadId}`);
    }),
    onError: async (key, error) => {
      const job = getJob(key);
      if (!job) return;
      const cleared = await clearEyes(job);
      updateJob(key, (latest) => withoutReactions(latest, cleared));
      await reportFailure(job.channel, job.threadTs, key, error, job.requester);
    },
  });

  /** A message in a thread the bot already owns: a turn for the worker, or context it gets with its next turn. */
  const continueJob = async (key: string, msg: IncomingMessage, allowed: boolean): Promise<void> => {
    const said: Audience = msg.direct ? 'bot' : audienceOf(chat.parse(msg.text), { userId: chat.self(), name: config.name });
    if (!allowed && said === 'bot') return refuse(msg);
    if (!(await toReadable(msg.text)) && !(allowed && msg.files?.length)) return;
    const job = getJob(key);
    if (job?.answeredQuestionMessages?.includes(msg.messageTs)) return;
    const card = job ? cardOf(job) : undefined;
    if (job && card && mayAnswer(job, msg.user) && said !== 'others' && !msg.files?.length) {
      const answer = typedAnswer(card.questions[card.index]!, await toReadable(msg.text));
      if (answer === null) await questionFeedback(job, 'invalid-answer');
      else await submitAnswer(key, job, answer, msg.user, msg.messageTs).catch(async (error: unknown) => {
        logger.error(`Answering question in ${key} failed: ${errorMessage(error)}`);
        await questionFeedback(job, 'not-sent');
      });
      return;
    }
    // Someone outside the allowlist can't give the worker a turn. What they say is context, like the rest of the thread.
    const audience: Audience = allowed ? (said === 'open' && msg.files?.length ? 'bot' : said) : 'others';
    if (audience !== 'others') await setEyes(msg.channel, msg.messageTs, true);
    if (audience === 'bot') {
      updateJob(key, () => ({ loadingRequested: true }));
      if (getJob(key)?.phase.state !== 'waiting') await setLoading(msg.channel, msg.threadTs, true);
    }
    const text = await messageContent(msg.text, allowed ? msg.files : []);
    const line: HeardLine = { speaker: await speaker(msg.user), text, audience, ts: msg.messageTs };

    // The owner writing in the thread answers any open ask, and means they see its replies.
    const ownerWrote: Partial<Job> = msg.user === config.owner ? { ownerAskOpen: false, ownerFollows: true } : {};
    if (audience === 'others') {
      // People talking to each other. The worker hears it with its next turn and isn't asked to answer.
      updateJob(key, (job) => ({ ...ownerWrote, ...heardNow(job, msg.messageTs) }));
      followUps.add(key, line, { wake: false });
      return;
    }
    updateJob(key, (job) => ({ ...ownerWrote, ...heardNow(job, msg.messageTs), pendingReactionTs: null, pendingReactions: [...pendingReactions(job), msg.messageTs], lastActivityAt: new Date(now()).toISOString() }));
    followUps.add(key, line);
  };

  /** Threads where the bot answered a ping: who pinged, and until when. In memory: losing it on a restart only costs an @mention. */
  const pingThreads = new Map<string, { user: string; until: number }>();
  const pingedBy = (key: string): string | undefined => {
    const ping = pingThreads.get(key);
    if (ping && ping.until < now()) pingThreads.delete(key);
    return pingThreads.get(key)?.user;
  };

  /**
   * A mention, DM, configured alert, or request after a ping starts a job.
   * Automatic root-message retries never become follow-ups.
   */
  const handle = async (msg: IncomingMessage): Promise<void> => {
    const key = slackKey(msg.channel, msg.threadTs);
    await exclusive(key, async () => {
      if (msg.user === chat.self()) return;
      const automatic = Boolean(msg.botId || msg.automaticTrigger);
      const trigger = automatic ? matchMessageTrigger(config.messageTriggers, msg.channel,
        msg.botId ? { botId: msg.botId } : { userId: msg.user }) : undefined;
      // Revalidate automatic sources; matching a rule never grants human allowlist membership.
      if (automatic && (!trigger || msg.threadTs !== msg.messageTs || (msg.botId && msg.user !== msg.botId))) return;
      const allowed = config.allowed.has(msg.user);
      const existing = getJob(key);
      if (existing) {
        // Slack delivered it again, or a held request is replayed after a crash: the job has it already.
        if (trigger || existing.heard?.includes(msg.messageTs)) return;
        await continueJob(key, msg, allowed).catch((error: unknown) => reportFailure(msg.channel, msg.threadTs, key, error, msg.user));
        return;
      }
      const followsPing = !msg.direct && !trigger;
      if (followsPing) {
        // After "are you there?" / "I'm here", the pinger's next message is the request, with or without an @mention.
        if (pingedBy(key) !== msg.user || audienceOf(chat.parse(msg.text), { userId: chat.self(), name: config.name }) === 'others') return;
      } else if (!trigger && !allowed) return refuse(msg);
      const said = await toReadable(msg.text);
      if (!said && !(trigger ? false : msg.files?.length)) return;

      // Only human pings receive the immediate acknowledgment instead of an investigation.
      if (!trigger) {
        if (followsPing && !msg.files?.length && (isPing(said, config.name) || ACKNOWLEDGEMENT.test(said))) return;
        if (!followsPing && !msg.files?.length && isPing(said, config.name)) {
          await notify(msg.channel, msg.threadTs, { kind: 'here' });
          pingThreads.set(key, { user: msg.user, until: now() + PING_THREAD_MS });
          events('ping_answered', { key, user: msg.user });
          return;
        }
        pingThreads.delete(key);
      }

      await setEyes(msg.channel, msg.messageTs, true);
      await setLoading(msg.channel, msg.threadTs, true);
      const content = trigger ? Promise.resolve(said) : messageContent(msg.text, msg.files);
      await content.then((request) => startJob(msg, request, said || 'files', trigger)).catch(async (error: unknown) => {
        await setEyes(msg.channel, msg.messageTs, false);
        await reportFailure(msg.channel, msg.threadTs, key, error, msg.user);
      });
    });
  };

  let polling = false;
  const lastIdleCheck = new Map<string, number>();

  /** Watched jobs every poll; idle ones every IDLE_POLL_MS until FOLLOW_UP_MS after their last activity. */
  const isDue = (key: string, job: Job, now: number): boolean => {
    if (followed(job.phase)) return true;
    if (now - Date.parse(job.lastActivityAt ?? job.createdAt) > FOLLOW_UP_MS) return false;
    if (now - (lastIdleCheck.get(key) ?? 0) < IDLE_POLL_MS) return false;
    lastIdleCheck.set(key, now);
    return true;
  };

  /**
   * Posts each finished run's last reply. A job stays watched for one more poll after posting,
   * so a follow-up queued while the run was busy is still picked up. Idle jobs are still checked now and then,
   * because a worker following CI on its PR starts runs of its own.
   */
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const at = now();
      for (const [key, job] of allJobs()) {
        if (!isDue(key, job, at)) continue;
        await exclusive(key, () => pollJob(key)).catch((error: unknown) => {
          logger.error(`Polling ${key} (T3 thread ${job.t3ThreadId}) failed: ${errorMessage(error)}`);
        });
      }
    } finally {
      polling = false;
    }
  };

  const reconcileJob = async (key: string): Promise<void> => {
    const job = getJob(key);
    // A message waiting to reach the worker keeps its 👀 and loading: it is about to start a run.
    if (!job || followUps.holds(key)) return;
    // A seen run that was posted tells nothing more.
    const seen = seenRun(job.phase);
    if (seen && seen.id === job.lastPostedRunId && !seen.progress) updateJob(key, (latest) => ({ phase: forgetRun(latest.phase) }));
    // A line an older build left for a run nobody follows needs no answer from T3: it goes first. The job is still
    // checked against T3, as one that looked running.
    const leftover = job.phase.state === 'idle' && job.phase.leftover !== undefined;
    if (leftover) await clearProgress(key, job);
    const saved = getJob(key) ?? job;
    if (!leftover && !looksRunning({ ...saved, pendingReactions: pendingReactions(saved) })) return;
    const { thread } = await t3.showThread(saved.t3ThreadId, config.t3Bin);
    // Going or waiting in T3: the poll follows it from here.
    if (thread.activeRunId || (thread.pendingRequestCount ?? 0) > 0) {
      updateJob(key, (latest) => ({ phase: follow(latest.phase) }));
      return;
    }
    // A finished run that was never posted is posted by the next poll, which clears the rest: always for a job the bot
    // was following, and for one it wasn't unless the thread went quiet so long ago that a reply would come from nowhere.
    const unposted = thread.latestRunId !== null && thread.latestRunId !== saved.lastPostedRunId;
    if (unposted && (followed(saved.phase) || now() - Date.parse(saved.lastActivityAt ?? saved.createdAt) <= FOLLOW_UP_MS)) {
      updateJob(key, (latest) => ({ phase: follow(latest.phase) }));
      return;
    }
    // Nothing runs in T3 for this thread: what's left is from a run nobody followed to its end. A card still up waits
    // for nothing any more.
    await clearProgress(key, saved);
    if (cardOf(saved)) await clearQuestion(key, getJob(key) ?? saved);
    const cleared = await clearEyes(saved);
    await finishLoading(key, saved);
    updateJob(key, (latest) => ({ ...withoutReactions(latest, cleared), phase: settle() }));
    logger.info(`${key} was saved as running, but T3 thread ${saved.t3ThreadId} isn't: cleared it.`);
    events('job_reconciled', { key, t3ThreadId: saved.t3ThreadId, unposted });
  };

  /**
   * Checks every job saved as running against T3, however old, and clears what nothing runs any more: the 👀, Slack's
   * loading status, the progress line and the seen run. Run at start, it cleans up after runs that ended while the bot
   * was stopped and state carried over from an older install. A thread T3 can't read is left as it is.
   */
  const reconcile = async (): Promise<void> => {
    for (const [key] of allJobs()) {
      await exclusive(key, () => reconcileJob(key)).catch((error: unknown) => {
        logger.warn(`Checking whether ${key} still runs in T3 failed: ${errorMessage(error)}`);
      });
    }
  };

  /** Whether a plain channel message belongs to a thread the bot owns. */
  const ownsThread = (channel: string, threadTs: string): boolean =>
    getJob(slackKey(channel, threadTs)) !== undefined || pingedBy(slackKey(channel, threadTs)) !== undefined;

  const reloader = createProfileReloader(config);
  /**
   * Look at `profile.json` again and apply the sections that take effect now (people and message triggers).
   * The daemon calls it when the file changes. An invalid file is logged once and the running config stays.
   */
  const reloadProfile = (): void => {
    let result;
    try { result = reloader(); } catch (error) {
      result = { status: 'invalid' as const, error: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === 'invalid') {
      logger.warn(`profile.json not reloaded, keeping the running settings: ${result.error}`);
      events('profile_invalid', { error: result.error.slice(0, 500) });
    } else if (result.status === 'applied') {
      const { applied, restartNeeded } = result;
      if (applied.length) logger.info(`profile.json reloaded: ${applied.join(', ')} applied now.`);
      if (restartNeeded.length) logger.info(`profile.json changes that apply after a restart: ${restartNeeded.join(', ')}.`);
      events('profile_reloaded', { applied, restartNeeded });
    }
  };

  /** A job in this thread is running now (its worker is being followed). Its messages still reach it while new work is paused. */
  const runningIn = (channel: string, threadTs: string): boolean => { const job = getJob(slackKey(channel, threadTs)); return job !== undefined && followed(job.phase); };

  /** Resolves once nothing the bot started is still running: no job step, no batch being checked or handed over. */
  const idle = async (): Promise<void> => {
    do { await inFlight.idle(); await followUps.idle(); } while (inFlight.size > 0);
  };

  /** Tells a request's thread that handling it failed, as a failed start would. For errors thrown past `handle`. */
  const reportUnhandled = (msg: IncomingMessage, error: unknown): Promise<void> =>
    reportFailure(msg.channel, msg.threadTs, slackKey(msg.channel, msg.threadTs), error, msg.user);

  return { handle, poll, reconcile, handleQuestionAction, ownsThread, runningIn, reloadProfile, drain: () => followUps.drain(), idle, reportUnhandled };
};
