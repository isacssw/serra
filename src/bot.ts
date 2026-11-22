import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { webApi } from '@slack/bolt';
import { fillBrief, needsOwner, NO_THREAD } from './brief.ts';
import { stampProposalsFolder, threadProposalsFolder } from './proposals.ts';
import type { BriefKnowledge } from './knowledge.ts';
import { mayUse, type Visibility } from './owner-model.ts';
import type { Config, MessageTrigger } from './config.ts';
import { audienceOf, createBatcher, followUpMessage, isPing, mentionedUsers, NO_MENTION_HINT, ownerNotice, readable, speakerName, type Audience, type ThreadLine } from './conversation.ts';
import { shareImages } from './images.ts';
import { MAX_ATTACHMENTS, receiveAttachments } from './attachments.ts';
import { incomingFiles } from './incoming.ts';
import { matchMessageTrigger } from './message-triggers.ts';
import { localLinksToText } from './links.ts';
import { createProfileReloader } from './profile-reload.ts';
import { handleReviewRequest } from './review.ts';
import { slackKey, type createStore } from './state.ts';
import { jobThreadInput, run, sendToThread, showThread, startThread } from './t3.ts';
import { answerQuestion, listQuestions, type T3QuestionRequest } from './t3-questions.ts';
import { answeredMessage, closedMessage, canShowQuestion, choiceAnswer, questionMessage, typedAnswer, type QuestionAnswer, type QuestionInteraction, type SlackQuestion } from './questions.ts';
import type { IncomingFile, IncomingMessage, Job, T3Message, T3Thread } from './types.ts';

type SlackClient = webApi.WebClient;

/** A job nobody is waiting on is still checked this often, so runs the worker starts itself (a PR watch) get posted. */
const IDLE_POLL_MS = 2 * 60_000;
/** How long after its last activity an idle job is still checked. */
const FOLLOW_UP_MS = 14 * 24 * 60 * 60_000;
/** A worker's reply that starts with this line has nothing for Slack: a background check-in, or a message that wasn't for the bot. */
const QUIET = /^\s*\(quiet\)\s*(\n|$)/i;
/** How long a thread must be silent before what was said goes to the worker, so quick messages become one turn. */
const FOLLOW_UP_QUIET_MS = 4_000;
/** How often to look again while the worker is still busy with its current turn. */
const FOLLOW_UP_RETRY_MS = 5_000;
const SLACK_TEXT_LIMIT = 11_000;
const SLACK_FALLBACK_LIMIT = 3_000;
const THREAD_CONTEXT_LIMIT = 20_000;
/** How many of a thread's latest messages a poll reads: enough to see what started the run and its latest note. */
const RECENT_MESSAGES = 40;
/** A run someone is waiting on shows what it is doing once it has gone on this long. */
const PROGRESS_AFTER_MS = 3 * 60_000;
const PROGRESS_TEXT_LIMIT = 300;
/** Slack expires its native status after two minutes; refresh it before then. */
const LOADING_REFRESH_MS = 60_000;
/** After answering a ping, how long the next message from the same person counts as the request, mention or not. */
const PING_THREAD_MS = 30 * 60_000;
/** Posted instead of a reply written with knowledge the owner has since taken back. */
const WITHHELD = 'Some of what I knew for this answer has since been made private, so I won\'t post it. Ask again and I\'ll answer with what I may share now.';
/** Posted instead of a reply when Slack refuses, for good, to say who can see the thread: a setup problem. */
const setupNotice = (code: string): string => `I can't check who can see this thread: my Slack app is missing a permission (${code}). I've told my owner how to fix it, and I'll answer here once it's done.`;
/** Posted instead of a reply when Slack can't confirm who can see the thread right before posting. */
const UNCONFIRMED = 'I couldn\'t confirm who can see this thread just now, so I haven\'t posted my answer here. Ask again in a minute and I\'ll try again.';
/** Replies to "I'm here" that aren't a request. */
const ACKNOWLEDGEMENT = /^(?:thanks?|thx|ty|cheers|nvm|never ?mind|sorted|all good|cool|great|nice|perfect|np|ok(?:ay)?|k|👍)[\s!.,]*$/iu;

/** What the bot records for each thing it does in Slack, one JSON line each, to measure how it behaves. */
export type BotEvents = (name: string, fields: Record<string, unknown>) => void;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

const truncate = (text: string): string =>
  text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT)}\n\n…(truncated, full report in T3)` : text;

const replyText = (thread: T3Thread, last: T3Message | undefined): string =>
  last?.role === 'assistant' && last.runId === thread.latestRunId
    ? (last.text ?? '')
    : `The run ended without a reply (status: ${thread.status}).`;

/**
 * Whether the worker started a run on its own, to follow CI or a bot's review, rather than for a message
 * from Slack. Such runs have no user message. When the messages read don't reach back to the run's start,
 * it can't be told, and the run counts as someone's: their reply is never hidden in an edit.
 */
const startedByWorker = (runId: string, messages: T3Message[]): boolean => {
  const reachesStart = messages.length < RECENT_MESSAGES || messages[0]?.runId !== runId;
  return reachesStart && !messages.some((message) => message.role === 'user' && message.runId === runId);
};

/** Whether someone in Slack is waiting on this run: it answers them, and they @mentioned the bot or asked it in a DM. */
const someoneWaits = (runId: string, messages: T3Message[]): boolean => {
  if (startedByWorker(runId, messages)) return false;
  const asked = messages.find((message) => message.role === 'user' && message.runId === runId);
  return !asked?.text?.includes(NO_MENTION_HINT);
};

/** The worker's latest note in a run that is still going, such as "Reproducing the bug locally first." */
const latestNote = (runId: string, messages: T3Message[]): string | undefined =>
  messages.findLast((message) => message.role === 'assistant' && message.runId === runId && message.text?.trim())?.text?.trim();

/**
 * A run that answered someone and finished, but was never posted because the worker started another run
 * before the next poll. Runs are read in order; only those after the last posted one count.
 */
const missedReply = (messages: T3Message[], lastPosted: string | null, current: string): { runId: string; text: string } | null => {
  const runs = [...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : [])))];
  const from = lastPosted === null ? -1 : runs.indexOf(lastPosted);
  // The last posted run is out of the window read: what came after it can't be told apart, so nothing is guessed.
  if (lastPosted !== null && from === -1) return null;
  for (const runId of runs.slice(from + 1).toReversed()) {
    if (runId === current || !messages.some((message) => message.role === 'user' && message.runId === runId)) continue;
    const text = messages.findLast((message) => message.role === 'assistant' && message.runId === runId)?.text;
    return text === undefined ? null : { runId, text };
  }
  return null;
};

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

/**
 * Forgets the run the bot saw going once a reply is posted, unless it is the run going now. Left behind, a seen run
 * that never matches the last posted one keeps the job listed as running forever: a run that started and ended
 * between two polls is posted without ever being seen (SERRA-54).
 */
const seenOver = (job: Job, thread: Pick<T3Thread, 'activeRunId'>): Partial<Job> =>
  job.runSeen && job.runSeen.runId !== thread.activeRunId ? { runSeen: undefined } : {};

/** A thread message waiting for the worker, with the Slack message it came from. */
type Heard = ThreadLine & { ts: string };

export interface BotDeps {
  config: Config;
  client: SlackClient;
  /** The bot's own Slack member ID, read when a message arrives: it is only known after Slack auth. */
  botUserId: () => string;
  store: ReturnType<typeof createStore>;
  loadIndex: () => string;
  /** The knowledge for a reply the given audience will see. Without it, every brief gets `loadIndex()` and no About me. */
  loadKnowledge?: (visibility: Visibility) => BriefKnowledge;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void; debug(message: string): void };
  t3?: { startThread: typeof startThread; sendToThread: typeof sendToThread; showThread: typeof showThread };
  questions?: { listQuestions: typeof listQuestions; answerQuestion: typeof answerQuestion };
  /** Brings the base branch up to date before a worktree is made from it. */
  fetchBase?: () => Promise<unknown>;
  share?: typeof shareImages;
  receive?: typeof receiveAttachments;
  reviewRequest?: typeof handleReviewRequest;
  timing?: { quietMs: number; retryMs: number };
  events?: BotEvents;
  now?: () => number;
}

/**
 * The bot's side of a Slack thread: starts a worker for a request, hands it what people say next,
 * and posts what it answers. Everything Slack sees goes through here.
 */
export const createBot = ({
  config, client, botUserId, store, loadIndex, loadKnowledge, logger,
  t3 = { startThread, sendToThread, showThread },
  questions = { listQuestions, answerQuestion },
  fetchBase = () => run('git', ['-C', config.project, 'fetch', config.remote, '--quiet']),
  share = shareImages,
  receive = receiveAttachments,
  reviewRequest = handleReviewRequest,
  timing = { quietMs: FOLLOW_UP_QUIET_MS, retryMs: FOLLOW_UP_RETRY_MS },
  events = () => {},
  now = Date.now,
}: BotDeps) => {
  const { allJobs, getJob, putJob } = store;

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

  const displayNames = new Map<string, string>();

  /** A person's name as Slack shows it. A failed lookup isn't remembered, so the next message tries again. */
  const displayName = async (user: string): Promise<string> => {
    const known = displayNames.get(user);
    if (known) return known;
    const profile = await client.users.info({ user }).catch(() => null);
    const name = speakerName(profile?.user?.real_name || profile?.user?.name || user);
    if (profile?.user) displayNames.set(user, name);
    return name;
  };

  /** The label a message carries to the worker. Only the configured owner's Slack ID gets the owner marker. */
  const speaker = async (user: string): Promise<string> =>
    user === config.owner ? `${config.ownerName} (your owner)` : displayName(user);

  /** The message with the bot's own mention removed and other mentions as names, so the worker sees who was addressed. */
  const toReadable = async (text: string): Promise<string> => {
    const names = new Map<string, string>();
    for (const user of mentionedUsers(text)) {
      if (user !== botUserId()) names.set(user, user === config.owner ? config.ownerName : await displayName(user));
    }
    return readable(text, botUserId(), names);
  };

  const messageContent = async (text: string, files: IncomingFile[] = [], limit = MAX_ATTACHMENTS): Promise<string> =>
    [await toReadable(text), await receive(client, files, config.profileDir, config.botToken, { limit })].filter(Boolean).join('\n\n');

  /**
   * The messages before the mention when the bot is called into an existing thread, so a brainstorm or a review
   * request arrives with its discussion. When too long, the oldest are dropped and the cut is stated.
   */
  /** `withoutBot`: leave out this bot's own messages (a fresh session after knowledge was taken back). */
  const threadContext = async (msg: IncomingMessage, { withoutBot = false }: { withoutBot?: boolean } = {}): Promise<string> => {
    if (msg.threadTs === msg.messageTs) return NO_THREAD;
    const replies = await client.conversations
      .replies({ channel: msg.channel, ts: msg.threadTs, limit: 200 })
      .catch((error: unknown) => {
        logger.warn(`Reading thread ${msg.channel}:${msg.threadTs} failed: ${errorMessage(error)}`);
        return null;
      });
    if (!replies?.messages) return `(${config.name} could not read the earlier messages in this thread. Say so if you need them.)`;

    const nameOf = async (user: string | undefined, botName: string | undefined): Promise<string> => {
      if (!user) return botName ? `${speakerName(botName)} (bot)` : 'unknown';
      if (user === botUserId()) return config.name;
      return speaker(user);
    };

    const context: { preview: string; text: string; files: IncomingFile[] }[] = [];
    for (const m of replies.messages) {
      if (!m.ts || Number(m.ts) >= Number(msg.messageTs)) continue;
      // The earlier worker's replies, cards and files may carry what was taken back: a fresh session doesn't get them.
      if (withoutBot && (m.user === botUserId() || (m.bot_id && !m.user))) continue;
      const text = await toReadable(m.text ?? '');
      const files = incomingFiles(m.files);
      if (!text && !files.length) continue;
      const speaker = await nameOf(m.user, m.bot_profile?.name);
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
      const attachments = await receive(client, item.files, config.profileDir, config.botToken, { limit: remaining });
      remaining = Math.max(0, remaining - item.files.length);
      lines.unshift([item.text, attachments].filter(Boolean).join('\n'));
    }
    const dropped = context.length - selected.length;
    const cut =
      dropped > 0 || replies.has_more ? `(${dropped} older messages left out, and more may exist. Ask if you need them.)\n` : '';
    return quoteThread(cut + lines.join('\n'));
  };

  /** 👀 on a message is the acknowledgement: it means the bot has it, and it goes away with the reply. */
  const setEyes = async (channel: string, timestamp: string, on: boolean): Promise<void> => {
    const args = { channel, timestamp, name: 'eyes' };
    await (on ? client.reactions.add(args) : client.reactions.remove(args)).catch((error: unknown) => {
      logger.debug(`eyes ${on ? 'add' : 'remove'} on ${channel}:${timestamp} failed: ${errorMessage(error)}`);
    });
  };

  /** Native Slack loading is best-effort: the existing 👀 still acknowledges work if the API is unavailable. */
  const loading = new Map<string, { on: boolean; at: number }>();
  const setLoading = async (channel: string, threadTs: string, on: boolean, force = false): Promise<void> => {
    const key = slackKey(channel, threadTs);
    const previous = loading.get(key);
    if (!on && previous?.on === false) return;
    if (!force && (on ? previous?.on && now() - previous.at < LOADING_REFRESH_MS : !previous?.on)) return;
    loading.set(key, { on, at: now() });
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status: on ? 'is looking into it…' : '',
      ...(on ? { loading_messages: ['Looking into it'] } : {}),
    }).catch((error: unknown) => {
      logger.debug(`Loading status in ${key} failed: ${errorMessage(error)}`);
    });
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

  const reply = async (channel: string, threadTs: string, text: string): Promise<void> => {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text, unfurl_links: false });
  };

  const refuse = (msg: IncomingMessage): Promise<void> =>
    reply(msg.channel, msg.threadTs, `Sorry, I only take requests from people <@${config.owner}> has added.`);

  /**
   * The error itself goes to the log. Teammates get a plain sentence: a stack of paths and exit codes means nothing
   * to them. The owner, who can act on it, also gets the first line of the error when they asked.
   */
  const reportFailure = async (channel: string, threadTs: string, key: string, error: unknown, user?: string): Promise<void> => {
    await setLoading(channel, threadTs, false, getJob(key)?.loadingRequested === true);
    updateJob(key, () => ({ loadingRequested: false }));
    const message = errorMessage(error);
    logger.error(`Failed handling ${key}: ${message}`);
    events('failure', { key, error: message.slice(0, 500) });
    const text = user === config.owner
      ? `Something went wrong on my side.\n\`${message.split('\n')[0]!.slice(0, 300)}\``
      : `Something went wrong on my side, so I couldn't pick this up. <@${config.owner}> will take a look.`;
    await reply(channel, threadTs, text)
      .catch((failure: unknown) => logger.error(`Could not report the failure in ${key}: ${errorMessage(failure)}`));
  };

  /** Whether a channel is shared with another company, remembered for a few minutes: it rarely changes. */
  const sharedChannels = new Map<string, { external: boolean; until: number }>();
  const VISIBILITY_TTL_MS = 10 * 60 * 1000;

  /**
   * Who will see the bot's reply in this thread. A DM is the owner's own, or a teammate's. A channel shared with
   * another company, or one Slack won't describe, counts as outside: the brief then carries only what may be said there.
   */
  /** `fresh`: ask Slack again, whatever is cached. */
  const replyVisibility = async (msg: IncomingMessage, { fresh = false }: { fresh?: boolean } = {}): Promise<Visibility> => {
    if (msg.channel.startsWith('D')) return msg.user === config.owner ? 'owner' : dmVisibility(msg.user, fresh);
    const known = sharedChannels.get(msg.channel);
    // Before anything is posted, Slack is asked again: a channel can be shared outside a minute after the job started.
    if (!fresh && known && known.until > now()) return known.external ? 'external' : 'team';
    const looked = await lookUpChannel(msg);
    if (looked) return looked;
    logger.warn(`Could not tell who can see ${msg.channel}, so its brief carries only what outsiders may hear.`);
    return 'external';
  };

  /**
   * Who can see a thread right now, asked of Slack twice, or null when Slack can't say. Before a post, null means
   * nothing goes out: not knowing isn't the same as knowing it's safe, and not the same as something made private.
   */
  /**
   * Slack errors that asking again won't fix: the app lacks a scope or its token is bad. A lookup that fails this way
   * is a setup problem for the owner, not a blip to wait out, so a reply isn't held for ever.
   */
  const PERMANENT_SLACK_ERRORS = new Set(['missing_scope', 'not_allowed_token_type', 'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'no_permission']);
  const setupProblems = new Map<string, string>();
  const noteSetupProblem = (key: string, error: unknown): void => {
    const code = (error as { data?: { error?: string } })?.data?.error ?? errorMessage(error);
    if (PERMANENT_SLACK_ERRORS.has(code)) setupProblems.set(key, code); else setupProblems.delete(key);
  };
  const setupProblemFor = (job: Job): string | undefined => setupProblems.get(job.channel.startsWith('D') ? job.requester : job.channel);

  const visibilityNow = async (job: Job): Promise<Visibility | null> => {
    const msg = { channel: job.channel, threadTs: job.threadTs, messageTs: job.threadTs, user: job.requester, text: '', direct: false };
    if (msg.channel.startsWith('D')) {
      if (msg.user === config.owner) return 'owner';
      const looked = await lookUpDmVisibility(msg.user) ?? await lookUpDmVisibility(msg.user);
      if (looked) dmPeople.set(msg.user, { visibility: looked, until: now() + VISIBILITY_TTL_MS });
      return looked;
    }
    return await lookUpChannel(msg) ?? await lookUpChannel(msg);
  };

  const lookUpChannel = async (msg: IncomingMessage): Promise<Visibility | null> => {
    try {
      const { channel } = await client.conversations.info({ channel: msg.channel });
      const shared = channel as { is_im?: boolean; is_ext_shared?: boolean; is_pending_ext_shared?: boolean } | undefined;
      if (!shared) throw new Error('Slack returned no channel');
      if (shared.is_im) return msg.user === config.owner ? 'owner' : 'team';
      // Team only on Slack's word: it says the channel isn't shared outside. Anything else counts as outside.
      const external = shared.is_ext_shared !== false || shared.is_pending_ext_shared === true;
      sharedChannels.set(msg.channel, { external, until: now() + VISIBILITY_TTL_MS });
      setupProblems.delete(msg.channel);
      return external ? 'external' : 'team';
    } catch (error) {
      logger.debug(`Looking up ${msg.channel} failed: ${errorMessage(error)}`);
      noteSetupProblem(msg.channel, error);
      return null;
    }
  };

  /**
   * A teammate's DM is team only when Slack says they're in the owner's workspace: a Slack Connect user from another
   * company, or one Slack won't describe, counts as outside.
   */
  // Where someone works rarely changes: cached like a channel's while a brief is built. Checks before a post ask again.
  const dmPeople = new Map<string, { visibility: Visibility; until: number }>();
  const dmVisibility = async (user: string, fresh = false): Promise<Visibility> => {
    const known = dmPeople.get(user);
    if (!fresh && known && known.until > now()) return known.visibility;
    const visibility = await lookUpDmVisibility(user);
    // A failed lookup counts as outside and isn't cached: the next check asks again.
    if (visibility) dmPeople.set(user, { visibility, until: now() + VISIBILITY_TTL_MS });
    return visibility ?? 'external';
  };
  const lookUpDmVisibility = async (user: string): Promise<Visibility | null> => {
    try {
      const [person, owner] = await Promise.all([client.users.info({ user }), client.users.info({ user: config.owner })]);
      const them = person.user as { team_id?: string; is_stranger?: boolean } | undefined;
      const home = (owner.user as { team_id?: string } | undefined)?.team_id;
      return them?.team_id && home && them.team_id === home && !them.is_stranger ? 'team' : 'external';
    } catch (error) {
      logger.warn(`Could not tell where ${user} works, so their DM's brief carries only what outsiders may hear: ${errorMessage(error)}`);
      noteSetupProblem(user, error);
      return null;
    }
  };

  const startJob = async (msg: IncomingMessage, request: string, summary: string, trigger?: MessageTrigger): Promise<void> => {
    const [requester, permalink, thread, visibility] = await Promise.all([
      trigger ? Promise.resolve(msg.botId ? `Automated alert from bot ${msg.botId}` : `Automatically triggered message from user ${msg.user}`) : speaker(msg.user),
      client.chat.getPermalink({ channel: msg.channel, message_ts: msg.messageTs }).catch(() => null),
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
        stampProposalsFolder(config.knowledgeDir, proposalsFolder, { who: requester, owner: !trigger && msg.user === config.owner, via: 'slack', ...(permalink?.permalink ? { link: permalink.permalink } : {}) });
      } catch (error) { logger.warn(`Could not record where ${msg.channel}:${msg.threadTs}'s proposals come from: ${errorMessage(error)}`); }
    }
    const input = jobThreadInput(config, {
      // The branch and title come from what the person wrote, not the request with its attachment notes.
      summary,
      brief: fillBrief(config, knowledge ?? loadIndex(), { request, requester, permalink: permalink?.permalink ?? 'link unavailable', thread,
        ...(proposalsFolder ? { proposalsFolder } : {}),
        ...(trigger ? { triggerInstructions: trigger.instructions } : {}) }),
      now: new Date(now()),
    });
    const t3ThreadId = await t3.startThread(input, config.t3Bin);

    putJob(slackKey(msg.channel, msg.threadTs), {
      t3ThreadId,
      channel: msg.channel,
      threadTs: msg.threadTs,
      requester: msg.user,
      pendingReactionTs: null,
      pendingReactions: [msg.messageTs],
      loadingRequested: true,
      lastPostedRunId: null,
      watching: true,
      ownerFollows: msg.user === config.owner,
      ...(knowledge ? { visibility, knowledgeRead: knowledge.read, knowledgeDir: knowledge.readDir } : {}),
      branch: input.branch,
      createdAt: new Date(now()).toISOString(),
      lastActivityAt: new Date(now()).toISOString(),
    });
    logger.info(`Started T3 thread ${t3ThreadId} for ${msg.channel}:${msg.threadTs}`);
    events('job_started', { key: slackKey(msg.channel, msg.threadTs), t3ThreadId, requester: msg.user });
  };

  /** One job's Slack-facing work runs one step at a time, so a poll and a follow-up can't both post the same run. */
  const jobQueues = new Map<string, Promise<unknown>>();
  const exclusive = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (jobQueues.get(key) ?? Promise.resolve()).then(work, work);
    jobQueues.set(key, next.catch(() => undefined));
    return next;
  };

  /** Takes the "still working" line away once its run has a reply. */
  const clearProgress = async (key: string, job: Job): Promise<void> => {
    if (!job.progress) return;
    await client.chat.delete({ channel: job.channel, ts: job.progress.ts }).catch((error: unknown) => {
      logger.debug(`Removing the progress line in ${key} failed: ${errorMessage(error)}`);
    });
    updateJob(key, () => ({ progress: undefined }));
  };

  /** A status message's fields, swapped for the withheld notice when the thread's knowledge was taken back since. */
  const withheldIfRevoked = async (job: Job, body: string): Promise<{ text?: string; blocks?: unknown[] }> => {
    const checked = await stillMayPost(job, body);
    return checked === body ? {} : { text: checked, blocks: [{ type: 'markdown', text: checked }] };
  };

  /**
   * `text`, or a notice in its place: withheld when the thread's knowledge was taken back for who can see it now,
   * unconfirmed when Slack can't say who that is.
   */
  const stillMayPost = async (job: Job, text: string): Promise<string> => {
    if (text === WITHHELD || text === UNCONFIRMED || text.startsWith('I can\'t check who can see this thread') || !loadKnowledge) return text;
    const { revoked, unknown } = await revocation(job);
    return unknown ? UNCONFIRMED : revoked.length > 0 ? WITHHELD : text;
  };

  /**
   * Posts a finished run's reply. A run the worker started on its own (following CI or a bot's review) edits one
   * status message instead, unless it needs someone: a `Needs` line, a review request, an upload or a first cc.
   */
  const postRunResult = async (key: string, job: Job, thread: T3Thread, reply: string, byWorker: boolean, runId: string): Promise<void> => {
    // A reply the worker wrote with knowledge the owner has since taken back isn't posted: it may repeat that text.
    // When Slack can't say who sees the thread, nothing is posted yet: the next poll tries again.
    const check = !QUIET.test(reply) && loadKnowledge ? await revocation(job) : null;
    const problem = check?.unknown ? setupProblemFor(job) : undefined;
    if (check?.unknown && !problem) {
      logger.warn(`Could not confirm who can see ${key}; the reply waits for the next check.`);
      return;
    }
    if (problem) {
      // Asking again won't help: the owner is told what to fix, and the thread gets a notice instead of the reply.
      logger.error(`Slack won't say who can see ${key} (${problem}): update the Slack app's scopes (docs/configuration.md) and reinstall it.`);
      events('failure', { key, error: `Slack won't say who can see this thread (${problem}). Update the Slack app's scopes and reinstall it; until then replies there are held.` });
    }
    const text = problem ? setupNotice(problem) : check && check.revoked.length > 0 ? WITHHELD : reply;
    const runMs = job.runSeen?.runId === runId ? now() - Date.parse(job.runSeen.at) : undefined;
    const measured = { key, runId, byWorker, runMs, jobAgeMs: now() - Date.parse(job.createdAt) };
    await clearProgress(key, job);
    if (QUIET.test(text)) {
      // Nothing to say: the 👀 goes away, which tells the thread the message was seen.
      const cleared = await clearEyes(job);
      updateJob(key, (latest) => ({ lastPostedRunId: runId, ...seenOver(latest, thread), ...withoutReactions(latest, cleared) }));
      await finishLoading(key, job);
      events('reply', { ...measured, kind: 'quiet' });
      return;
    }
    const slackThread = await client.chat
      .getPermalink({ channel: job.channel, message_ts: job.threadTs })
      .then((result) => result.permalink)
      .catch(() => undefined);
    // A review request goes to another channel: only when everyone there may hear what this thread's worker was told,
    // checked right before it's sent. Otherwise it's the owner's to check and post.
    const reviewMayHear = async (): Promise<boolean> => {
      if (!loadKnowledge || !config.reviewChannel) return true;
      // The review channel's audience must be confirmed by Slack, and every page the worker read must be for it and
      // for whoever sees this thread now.
      const destination = await visibilityNow({ ...job, channel: config.reviewChannel, requester: config.owner });
      if (destination === null) return false;
      const forDestination = await revocation({ ...job, visibility: destination });
      return !forDestination.unknown && forDestination.revoked.length === 0 && (await revocation(job)).revoked.length === 0;
    };
    const review = await reviewRequest(client, text, {
      channel: config.reviewChannel,
      mayPost: reviewMayHear,
      owner: config.owner,
      botName: config.name,
      repositories: config.reviewRepos,
      githubLogin: config.githubLogin,
      alreadyPosted: job.reviewRequestedPrs ?? [],
      sourceLink: slackThread ?? thread.link,
    });
    // Images go up first, so they sit in the thread just above the reply that refers to them. Checked again right
    // before uploading and before posting: who can see the thread, and what its worker was told, can change meanwhile.
    // Slack can't say who sees the thread before anything is uploaded: the reply waits for the next check. A review
    // request already posted is recorded first, so the retry doesn't post it twice.
    const toShare = await stillMayPost(job, review.reply);
    if (toShare === UNCONFIRMED) {
      if (review.postedFor) updateJob(key, (latest) => ({ reviewRequestedPrs: [...(latest.reviewRequestedPrs ?? []), review.postedFor!] }));
      logger.warn(`Could not confirm who can see ${key} before uploading; the reply waits for the next check.`);
      return;
    }
    const shared = await share(client, toShare, { channel: job.channel, threadTs: job.threadTs, mayPost: async () => (await revokedFor(job)).length === 0 });
    const uploaded = shared !== toShare;
    const prepared = truncate(localLinksToText(shared, pathRoots).trim() || '(No reply text. Check the T3 thread.)');
    const body = await stillMayPost(job, prepared);
    // The owner is pinged for a new blocker, and cc'd once so they follow a thread someone else started. Not on every reply.
    const blocked = needsOwner(body, config.ownerName);
    const ownerFollows = job.ownerFollows ?? job.requester === config.owner;
    const notice = ownerNotice({ blocked, askOpen: job.ownerAskOpen ?? false, ownerFollows });
    const reviewPosted = review.postedFor !== null && review.postedFor !== undefined;

    // Someone still has a 👀 on their message: this reply may be all they get, so it is a real post.
    const someonePending = pendingReactions(job).length > 0;
    if (byWorker && !someonePending && !blocked && !reviewPosted && !uploaded && notice === 'none') {
      const blocks = [
        { type: 'markdown', text: body },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `<!date^${Math.floor(now() / 1000)}^Updated {time}|Updated> · <${thread.link}|T3 thread>` }] },
      ];
      const message = { channel: job.channel, text: body.slice(0, SLACK_FALLBACK_LIMIT), blocks, unfurl_links: false };
      // A status message someone deleted can't be edited: a new one takes its place.
      const edited = job.statusTs
        ? await client.chat.update({ ...message, ts: job.statusTs }).then(() => true, (error: unknown) => {
          logger.debug(`Editing the status message in ${key} failed: ${errorMessage(error)}`);
          return false;
        })
        : false;
      // A new post in place of a failed edit is checked again first: time has passed.
      const statusTs = edited ? job.statusTs : (await client.chat.postMessage({ ...message, ...(await withheldIfRevoked(job, body)), thread_ts: job.threadTs })).ts;
      updateJob(key, (latest) => ({
        lastPostedRunId: runId,
        ...seenOver(latest, thread),
        ...(statusTs ? { statusTs } : {}),
        watching: true,
        waitingInT3: false,
        lastActivityAt: new Date(now()).toISOString(),
      }));
      await finishLoading(key, job);
      events('reply', { ...measured, kind: edited ? 'status_edited' : 'status_posted' });
      return;
    }

    const ownerCallout = notice === 'callout'
      ? [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: `<@${config.owner}> this one needs you.` } }]
      : [];
    await client.chat.postMessage({
      channel: job.channel,
      thread_ts: job.threadTs,
      text: body.slice(0, SLACK_FALLBACK_LIMIT),
      blocks: [
        ...ownerCallout,
        { type: 'markdown', text: body },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${notice === 'cc' ? `cc <@${config.owner}> · ` : ''}<${thread.link}|T3 thread>` }] },
      ],
      unfurl_links: false,
    });
    const cleared = await clearEyes(job);
    updateJob(key, (latest) => ({
      lastPostedRunId: runId,
      ...seenOver(latest, thread),
      ...withoutReactions(latest, cleared),
      ownerFollows: ownerFollows || notice !== 'none' || latest.ownerFollows === true,
      // The owner may have answered while this reply was being posted.
      ownerAskOpen: blocked && (notice === 'callout' || latest.ownerAskOpen === true),
      watching: true,
      waitingInT3: false,
      // The next status update goes below this reply, not into a message further up.
      statusTs: undefined,
      lastActivityAt: new Date(now()).toISOString(),
      ...(review.postedFor ? { reviewRequestedPrs: [...(latest.reviewRequestedPrs ?? []), review.postedFor] } : {}),
    }));
    await finishLoading(key, job);
    events('reply', { ...measured, kind: 'reply', needsOwner: blocked, reviewRequested: reviewPosted });
    if (notice === 'callout') events('needs_owner', { key });
  };

  /**
   * A run someone is waiting on that has gone on for a few minutes shows the worker's latest note in one line,
   * edited as the note changes, so the thread isn't just 👀 for half an hour. The line goes when the reply comes.
   */
  const showProgress = async (key: string, job: Job, thread: T3Thread, messages: T3Message[]): Promise<void> => {
    const runId = thread.activeRunId;
    if (!runId) return;
    if (job.progress && job.progress.runId !== runId) await clearProgress(key, job);
    if (job.runSeen?.runId !== runId) {
      updateJob(key, () => ({ runSeen: { runId, at: new Date(now()).toISOString() } }));
      return;
    }
    if (now() - Date.parse(job.runSeen.at) < PROGRESS_AFTER_MS || !someoneWaits(runId, messages)) return;
    const note = latestNote(runId, messages);
    if (!note) return;
    const text = `⏳ Still on it: ${oneParagraph(localLinksToText(note, pathRoots))}`;
    if (job.progress?.runId === runId && job.progress.text === text) return;
    const message = { channel: job.channel, text, blocks: [{ type: 'markdown', text }], unfurl_links: false };
    if (job.progress && job.progress.runId !== runId) await clearProgress(key, job);
    // A progress note is the worker's own words: none from a thread whose knowledge was taken back, checked last.
    if ((await revokedFor(job)).length > 0) return;
    if (job.progress?.runId === runId) {
      const ts = job.progress.ts;
      await client.chat.update({ ...message, ts }).catch((error: unknown) => logger.debug(`Editing the progress line in ${key} failed: ${errorMessage(error)}`));
      updateJob(key, () => ({ progress: { ts, runId, text } }));
      return;
    }
    const posted = await client.chat.postMessage({ ...message, thread_ts: job.threadTs });
    if (posted.ts) updateJob(key, () => ({ progress: { ts: posted.ts!, runId, text } }));
    // Posting any message clears Slack's native status, even when it is only a progress update.
    await setLoading(job.channel, job.threadTs, true, true);
    events('progress_shown', { key, runId, afterMs: now() - Date.parse(job.runSeen.at) });
  };

  const mayAnswer = (job: Job, user: string): boolean => config.allowed.has(user) && (user === config.owner || user === job.requester);

  const clearQuestion = async (key: string, job: Job, answeredBy?: string, state = job.question, closed?: boolean): Promise<void> => {
    if (!state) return;
    updateJob(key, () => ({ question: undefined, waitingInT3: false }));
    // However the card closes, a thread whose knowledge was taken back never shows its questions or answers again.
    closed ??= (await revokedFor(job)).length > 0;
    // A card closed because its thread's knowledge was taken back gets fixed copy: the question is the worker's words.
    await client.chat.update({ channel: job.channel, ts: state.ts, ...(closed ? closedMessage() : answeredMessage(state, answeredBy)) })
      .catch((error: unknown) => logger.debug(`Updating the question in ${key} failed: ${errorMessage(error)}`));
  };

  const showQuestion = async (key: string, job: Job, thread: T3Thread, request: T3QuestionRequest): Promise<void> => {
    if (job.question?.requestId === request.requestId) return;
    if (job.question) await clearQuestion(key, job);
    // A question card is the worker's own words too: a thread whose knowledge was taken back gets a stop instead,
    // checked right before the card would be posted. When Slack can't say who sees the thread, the card waits.
    const check = loadKnowledge ? await revocation(job) : null;
    if (check?.unknown) return;
    if (check && check.revoked.length > 0) {
      await questions.answerQuestion(job.t3ThreadId, request.requestId, Object.fromEntries(request.questions.map((item) => [item.id, 'Stop here: some knowledge you used has been made private. Do nothing more.'])), config.t3Bin)
        .catch((error: unknown) => logger.warn(`Could not stop the question in ${job.t3ThreadId}: ${errorMessage(error)}`));
      await reply(job.channel, job.threadTs, WITHHELD);
      updateJob(key, () => ({ lastActivityAt: new Date(now()).toISOString() }));
      return;
    }
    const state: SlackQuestion = { ...request, ts: '', index: 0, answers: {}, nonce: randomBytes(16).toString('hex'), runId: thread.activeRunId ?? thread.latestRunId };
    const recipient = config.allowed.has(job.requester) ? job.requester : config.owner;
    const posted = await client.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, ...questionMessage(state, recipient), unfurl_links: false });
    if (!posted.ts) throw new Error('Slack returned no question message');
    updateJob(key, (latest) => ({ question: { ...state, ts: posted.ts! }, waitingInT3: true, ownerFollows: latest.ownerFollows || recipient === config.owner }));
    events('question_shown', { key, requestId: request.requestId, count: request.questions.length });
  };

  const questionFeedback = (job: Job, text: string): Promise<void> => reply(job.channel, job.threadTs, text);

  /** Recheck T3 before accepting a selection: another client may already have answered the form. */
  const submitAnswer = async (key: string, job: Job, answer: QuestionAnswer, user: string, messageTs?: string): Promise<void> => {
    const state = job.question;
    if (!state) return;
    const pending = (await questions.listQuestions(job.t3ThreadId, config.t3Bin)).find((request) => request.requestId === state.requestId);
    if (!pending || JSON.stringify(pending.questions) !== JSON.stringify(state.questions)) {
      await clearQuestion(key, job);
      await questionFeedback(job, 'That question changed or was already answered in T3. I’ll check for the next one.');
      return;
    }
    const question = state.questions[state.index]!;
    const answers = { ...state.answers, [question.id]: answer };
    const rememberReply = (latest: Job): Partial<Job> => messageTs
      ? { answeredQuestionMessages: [...(latest.answeredQuestionMessages ?? []), messageTs].slice(-20) } : {};
    // When Slack can't say who sees the thread, the form doesn't move on: the next question is the worker's words.
    if (loadKnowledge && (await revocation(job)).unknown) {
      const problem = setupProblemFor(job);
      await questionFeedback(job, problem ? setupNotice(problem) : 'I couldn\u2019t confirm who can see this thread just now, so I haven\u2019t taken that answer. Please answer again in a minute.');
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
    if (await restartIfRevoked(key, { ...job, question: state }, [{ speaker: user === config.owner ? `${config.ownerName} (your owner)` : await displayName(user), text: note, audience: 'bot', ts: messageTs ?? job.threadTs }])) {
      updateJob(key, rememberReply);
      return;
    }
    if (state.index + 1 < state.questions.length) {
      const next = { ...state, answers, index: state.index + 1, nonce: randomBytes(16).toString('hex') };
      const recipient = config.allowed.has(job.requester) ? job.requester : config.owner;
      // Save only after the edit succeeds, so a failed edit leaves usable choices and can be retried.
      try {
        await client.chat.update({ channel: job.channel, ts: state.ts, ...questionMessage(next, recipient) });
      } catch (error) {
        const code = (error as { data?: { error?: string } })?.data?.error;
        if (code !== 'message_not_found' && errorMessage(error) !== 'message_not_found') throw error;
        // A new card in place of a failed edit is the worker's words again: checked first.
        if ((await revokedFor(job)).length > 0) {
          await clearQuestion(key, job, user, { ...state, answers }, true);
          return;
        }
        const posted = await client.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, ...questionMessage(next, recipient), unfurl_links: false });
        if (!posted.ts) throw new Error('Slack returned no question message');
        next.ts = posted.ts;
      }
      updateJob(key, (latest) => ({ question: next, ...rememberReply(latest) }));
      return;
    }
    await questions.answerQuestion(job.t3ThreadId, state.requestId, answers, config.t3Bin);
    updateJob(key, rememberReply);
    await clearQuestion(key, job, user, { ...state, answers });
    updateJob(key, () => ({ watching: true, loadingRequested: true, lastActivityAt: new Date(now()).toISOString() }));
    await setLoading(job.channel, job.threadTs, true);
    events('question_answered', { key, requestId: state.requestId, user });
  };

  const handleQuestionAction = async (action: QuestionInteraction): Promise<void> => {
    const found = allJobs().find(([, job]) => job.channel === action.channel && job.question?.ts === action.messageTs);
    if (!found) return;
    const [key] = found;
    await exclusive(key, async () => {
      const job = getJob(key);
      if (!job?.question || job.question.nonce !== action.nonce || !mayAnswer(job, action.user)) return;
      if (action.actionId === 'serra_question_multi') return; // Selection changes aren't submitted until the button is pressed.
      const answer = choiceAnswer(job.question.questions[job.question.index]!, action.indices);
      if (answer === null) {
        await questionFeedback(job, 'Choose an answer before submitting.');
        return;
      }
      await submitAnswer(key, job, answer, action.user).catch(async (error: unknown) => {
        logger.error(`Answering question in ${key} failed: ${errorMessage(error)}`);
        await questionFeedback(job, 'I couldn’t send that answer to T3. Please try again, or answer in T3.');
      });
    });
  };

  /** Secrets, approvals and forms Slack cannot display stay in T3. Queued follow-ups wait for their resolution. */
  const postWaitingNotice = async (key: string, job: Job, thread: T3Thread): Promise<void> => {
    await setLoading(job.channel, job.threadTs, false, job.loadingRequested === true);
    const text = `<@${config.owner}> I'm waiting for you in T3: <${thread.link}|answer it there>. `
      + `It needs an action there, such as a token, an approval, or a question Slack cannot display. Messages here reach me once it's answered.`;
    await client.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, text, unfurl_links: false });
    updateJob(key, () => ({ waitingInT3: true, ownerFollows: true, lastActivityAt: new Date(now()).toISOString() }));
    logger.info(`T3 thread ${job.t3ThreadId} is waiting on a request; told the owner in ${key}`);
    events('waiting_in_t3', { key, t3ThreadId: job.t3ThreadId });
    events('needs_owner', { key });
  };

  const pollJob = async (key: string): Promise<void> => {
    const job = getJob(key);
    if (!job) return;
    const { thread, messages } = await t3.showThread(job.t3ThreadId, config.t3Bin, RECENT_MESSAGES);
    const current = thread.activeRunId ?? thread.latestRunId;
    // A reply to someone that the worker's next run (following CI, say) started before the bot saw it finish.
    const missed = current ? missedReply(messages, job.lastPostedRunId, current) : null;
    if (missed && current !== job.lastPostedRunId) {
      await postRunResult(key, job, thread, missed.text, false, missed.runId);
    }
    const latest = getJob(key) ?? job;

    if ((thread.pendingRequestCount ?? 0) > 0) {
      await setLoading(latest.channel, latest.threadTs, false);
      const requests = await questions.listQuestions(job.t3ThreadId, config.t3Bin).catch((error: unknown) => {
        logger.debug(`Reading questions in ${key} failed: ${errorMessage(error)}`);
        return null;
      });
      const request = requests?.find(canShowQuestion);
      if (request) await showQuestion(key, latest, thread, request);
      else if (requests !== null) {
        if (latest.question) await clearQuestion(key, latest);
        if (!(getJob(key) ?? latest).waitingInT3) {
          for (const unsupported of requests) {
            const options = unsupported.questions.flatMap((question) => question.options);
            const limits = {
              questionCount: unsupported.questions.length,
              maxQuestionChars: Math.max(0, ...unsupported.questions.map((question) => question.question.length)),
              maxOptionCount: Math.max(0, ...unsupported.questions.map((question) => question.options.length)),
              maxLabelChars: Math.max(0, ...options.map((option) => option.label.length)),
              maxDescriptionChars: Math.max(0, ...options.map((option) => option.description.length)),
            };
            logger.warn(`Question ${unsupported.requestId} in ${key} exceeds Slack display limits; using the T3 link.`);
            events('question_fallback', { key, requestId: unsupported.requestId, reason: 'display_limits', ...limits });
          }
          await postWaitingNotice(key, getJob(key) ?? latest, thread);
        }
      } else if (!latest.question && !latest.waitingInT3) await postWaitingNotice(key, latest, thread);
      return;
    }
    if (latest.question) await clearQuestion(key, latest);

    if (thread.activeRunId) {
      if (latest.waitingInT3) updateJob(key, () => ({ waitingInT3: false }));
      await setLoading(latest.channel, latest.threadTs, latest.loadingRequested === true || someoneWaits(thread.activeRunId, messages));
      await showProgress(key, getJob(key) ?? latest, thread, messages);
      return;
    }

    const runId = thread.latestRunId;
    if (runId !== null && runId !== latest.lastPostedRunId) {
      const byWorker = startedByWorker(runId, messages);
      const last = messages.at(-1);
      // A run the worker started that wrote nothing has nothing to tell anyone; it mustn't overwrite the status message.
      const silent = byWorker && !(last?.role === 'assistant' && last.runId === runId);
      await postRunResult(key, latest, thread, silent ? '(quiet)' : replyText(thread, last), byWorker, runId);
      return;
    }
    // Nothing runs and every run is posted: a progress line or a seen run left from earlier is over too.
    await clearProgress(key, latest);
    await finishLoading(key, latest);
    updateJob(key, () => ({ watching: false, waitingInT3: false, runSeen: undefined }));
  };

  /**
   * Pages this thread's brief allowed that the owner has since restricted, retired or removed. A thread from before
   * Serra recorded its pages was briefed with every page there was, including any removed since, which can't be
   * checked: unless only the owner sees it, it counts as revoked. Every path that shows worker text checks this first.
   */
  const WIDTH: Record<Visibility, number> = { owner: 0, team: 1, external: 2 };
  const revocation = async (job: Job): Promise<{ visibility: Visibility; knowledge: BriefKnowledge; revoked: string[]; unknown: boolean }> => {
    // Who sees the thread now, not only when it started: a channel shared with another company since is outside.
    const current = await visibilityNow(job);
    const unknown = current === null;
    const visibility = current === null ? job.visibility ?? 'external' : job.visibility && WIDTH[job.visibility] >= WIDTH[current] ? job.visibility : current;
    const knowledge = loadKnowledge!(visibility);
    // The owner may hear anything they ever had, removed pages included: nothing of theirs is withheld from them.
    if (visibility === 'owner') return { visibility, knowledge, revoked: [], unknown: false };
    // Slack can't say who sees the thread: nothing the worker wrote goes out until it can.
    if (unknown) return { visibility, knowledge, revoked: ['(who can see this thread is unknown)'], unknown };
    if (!job.knowledgeRead) return { visibility, knowledge, revoked: ['(pages from before Serra recorded them)'], unknown };
    // A page is revoked for this audience when the version the worker read wasn't for them, or when the page as it is
    // now isn't (narrowed, retired or removed since).
    return { visibility, knowledge, revoked: Object.entries(job.knowledgeRead).filter(([page, audience]) => !mayUse(audience, visibility) || !knowledge.pages.includes(page)).map(([page]) => page), unknown };
  };

  const revokedFor = async (job: Job): Promise<string[]> => (loadKnowledge ? (await revocation(job)).revoked : []);

  /**
   * When a page this thread's brief allowed has since been restricted, retired or removed, the old T3 thread still has
   * its text in context. The next turn then starts a fresh thread, briefed from the knowledge as it is now, with the
   * chat thread so far as context. Returns true when it did.
   */
  const restartIfRevoked = async (key: string, job: Job, lines: Heard[]): Promise<boolean> => {
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
    if (job.question) {
      const open = job.question;
      await questions.answerQuestion(job.t3ThreadId, open.requestId, Object.fromEntries(open.questions.map((item) => [item.id, 'Stop here: this thread moved to a fresh session. Do nothing more.'])), config.t3Bin)
        .catch((error: unknown) => logger.warn(`Could not close the question in the earlier T3 thread ${job.t3ThreadId}: ${errorMessage(error)}`));
      await clearQuestion(key, job, undefined, open, true);
    }
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
    updateJob(key, () => ({ t3ThreadId, visibility, knowledgeRead: knowledge.read, knowledgeDir: knowledge.readDir, branch: input.branch, lastPostedRunId: null, runSeen: undefined, watching: true, question: undefined, waitingInT3: false }));
    await reply(job.channel, job.threadTs, 'Some knowledge this thread used has changed, so I\'m carrying on in a fresh session.');
    logger.info(`${folderGone ? 'The knowledge folder this thread read was cleaned up' : `Knowledge this thread used was taken back (${revoked.length} page(s))`}; continued ${key} in a fresh T3 thread ${t3ThreadId}`);
    events('knowledge_revoked', { key, t3ThreadId });
    return true;
  };

  const followUps = createBatcher<Heard>({
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
      updateJob(key, (latest) => ({ watching: true, loadingRequested, lastActivityAt: new Date(now()).toISOString(), pendingReactionTs: null, pendingReactions: [...new Set([...pendingReactions(latest), ...waiting])] }));
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
    const said: Audience = msg.direct ? 'bot' : audienceOf(msg.text, { userId: botUserId(), name: config.name });
    if (!allowed && said === 'bot') return refuse(msg);
    if (!(await toReadable(msg.text)) && !(allowed && msg.files?.length)) return;
    const job = getJob(key);
    if (job?.answeredQuestionMessages?.includes(msg.messageTs)) return;
    if (job?.question && mayAnswer(job, msg.user) && said !== 'others' && !msg.files?.length) {
      const answer = typedAnswer(job.question.questions[job.question.index]!, await toReadable(msg.text));
      if (answer === null) await questionFeedback(job, 'Please choose one of the offered answers, or reply with its label or number.');
      else await submitAnswer(key, job, answer, msg.user, msg.messageTs).catch(async (error: unknown) => {
        logger.error(`Answering question in ${key} failed: ${errorMessage(error)}`);
        await questionFeedback(job, 'I couldn’t send that answer to T3. Please try again, or answer in T3.');
      });
      return;
    }
    // Someone outside the allowlist can't give the worker a turn. What they say is context, like the rest of the thread.
    const audience: Audience = allowed ? (said === 'open' && msg.files?.length ? 'bot' : said) : 'others';
    if (audience !== 'others') await setEyes(msg.channel, msg.messageTs, true);
    if (audience === 'bot') {
      updateJob(key, () => ({ loadingRequested: true }));
      if (!getJob(key)?.waitingInT3) await setLoading(msg.channel, msg.threadTs, true);
    }
    const text = await messageContent(msg.text, allowed ? msg.files : []);
    const line: Heard = { speaker: await speaker(msg.user), text, audience, ts: msg.messageTs };

    // The owner writing in the thread answers any open ask, and means they see its replies.
    const ownerWrote: Partial<Job> = msg.user === config.owner ? { ownerAskOpen: false, ownerFollows: true } : {};
    if (audience === 'others') {
      // People talking to each other. The worker hears it with its next turn and isn't asked to answer.
      updateJob(key, () => ownerWrote);
      followUps.add(key, line, { wake: false });
      return;
    }
    updateJob(key, (job) => ({ ...ownerWrote, pendingReactionTs: null, pendingReactions: [...pendingReactions(job), msg.messageTs], lastActivityAt: new Date(now()).toISOString() }));
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
      if (msg.user === botUserId()) return;
      const automatic = Boolean(msg.botId || msg.automaticTrigger);
      const trigger = automatic ? matchMessageTrigger(config.messageTriggers, msg.channel,
        msg.botId ? { botId: msg.botId } : { userId: msg.user }) : undefined;
      // Revalidate automatic sources; matching a rule never grants human allowlist membership.
      if (automatic && (!trigger || msg.threadTs !== msg.messageTs || (msg.botId && msg.user !== msg.botId))) return;
      const allowed = config.allowed.has(msg.user);
      if (getJob(key)) {
        if (trigger) return;
        await continueJob(key, msg, allowed).catch((error: unknown) => reportFailure(msg.channel, msg.threadTs, key, error, msg.user));
        return;
      }
      const followsPing = !msg.direct && !trigger;
      if (followsPing) {
        // After "are you there?" / "I'm here", the pinger's next message is the request, with or without an @mention.
        if (pingedBy(key) !== msg.user || audienceOf(msg.text, { userId: botUserId(), name: config.name }) === 'others') return;
      } else if (!trigger && !allowed) return refuse(msg);
      const said = await toReadable(msg.text);
      if (!said && !(trigger ? false : msg.files?.length)) return;

      // Only human pings receive the immediate acknowledgment instead of an investigation.
      if (!trigger) {
        if (followsPing && !msg.files?.length && (isPing(said, config.name) || ACKNOWLEDGEMENT.test(said))) return;
        if (!followsPing && !msg.files?.length && isPing(said, config.name)) {
          await reply(msg.channel, msg.threadTs, "I'm here. What do you need?");
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
    if (job.watching) return true;
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

  /** What the Jobs screen reads as running (`classify` in jobs.ts), from the saved job alone. */
  const looksRunning = (job: Job): boolean => job.loadingRequested === true || pendingReactions(job).length > 0
    || job.progress !== undefined || (job.runSeen !== undefined && job.runSeen.runId !== job.lastPostedRunId);

  const reconcileJob = async (key: string): Promise<void> => {
    const job = getJob(key);
    // A message waiting to reach the worker keeps its 👀 and loading: it is about to start a run.
    if (!job || followUps.holds(key)) return;
    // A seen run that was posted tells nothing more.
    if (job.runSeen && job.runSeen.runId === job.lastPostedRunId) updateJob(key, () => ({ runSeen: undefined }));
    const saved = getJob(key) ?? job;
    if (!looksRunning(saved)) return;
    const { thread } = await t3.showThread(saved.t3ThreadId, config.t3Bin);
    // Going or waiting in T3: the poll follows it from here.
    if (thread.activeRunId || (thread.pendingRequestCount ?? 0) > 0) {
      if (!saved.watching) updateJob(key, () => ({ watching: true }));
      return;
    }
    // A finished run that was never posted is posted by the next poll, which clears the rest: always for a job the bot
    // was following, and for one it wasn't unless the thread went quiet so long ago that a reply would come from nowhere.
    const unposted = thread.latestRunId !== null && thread.latestRunId !== saved.lastPostedRunId;
    if (unposted && (saved.watching || now() - Date.parse(saved.lastActivityAt ?? saved.createdAt) <= FOLLOW_UP_MS)) {
      if (!saved.watching) updateJob(key, () => ({ watching: true }));
      return;
    }
    // Nothing runs in T3 for this thread: the flags are left from a run nobody followed to its end.
    await clearProgress(key, saved);
    const cleared = await clearEyes(saved);
    await finishLoading(key, saved);
    updateJob(key, (latest) => ({ ...withoutReactions(latest, cleared), runSeen: undefined, watching: false, waitingInT3: false }));
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
  const runningIn = (channel: string, threadTs: string): boolean => getJob(slackKey(channel, threadTs))?.watching === true;

  return { handle, poll, reconcile, handleQuestionAction, ownsThread, runningIn, reloadProfile, drain: () => followUps.drain() };
};
