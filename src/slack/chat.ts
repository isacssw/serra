/**
 * Slack as a chat: the `ChatPort` the core calls freely and the `WorkerWriter` only `deliver` holds. Everything that
 * knows Slack lives here: who can see a channel or a DM, the copy of Serra's notices, Block Kit, mention markup, the
 * 👀 and the native loading status, and how a reply is found again after a restart.
 */
import { basename } from 'node:path';
import type { Clock } from '../clock.ts';
import { errorMessage } from '../lib/errors.ts';
import { isRecord } from '../lib/guards.ts';
import { MessageGone, type Audience, type ChatError, type ChatPort, type HistoryLine, type InPlaceOf, type Notice, type Replacement, type OwnerNotify, type PersonId, type Result, type Target, type WorkerOut } from '../chat/port.ts';
import { clearedFor, type Cleared, type WorkerWriter } from '../chat/writer.ts';
import { comparableSlackText, slackErrorCode, type SlackApi } from './api.ts';
import { receiveAttachments } from './attachments.ts';
import { incomingFiles } from './incoming.ts';
import { answeredMessage, closedMessage, overMessage, questionMessage, type Blocks } from './questions.ts';

/** A message's content, without where it goes. */
type Rendered = { text: string; blocks?: Blocks; unfurl_links?: boolean };
type Logger = { info(message: string): void; warn(message: string): void; error(message: string): void; debug(message: string): void };

/** Serra's own cap on a reply, well inside Slack's. */
const SLACK_TEXT_LIMIT = 11_000;
/** A message's plain `text` (notifications, and clients that can't show blocks). */
const SLACK_FALLBACK_LIMIT = 3_000;
/** How long who can see a channel, or where a DM's person works, is reused while a brief is built. */
const VISIBILITY_TTL_MS = 10 * 60 * 1000;
/** How old an answer about who can see a thread may be when worker words are written on it. */
const CLEARED_TTL_MS = 60_000;
/** Marks a reply Serra posts with the run it answers, so a restart can find it in the thread instead of posting it again. */
const REPLY_EVENT = 'serra_reply';
/**
 * How far before the saved intent a reply found by its text may be: room for Slack's clock and this machine's to
 * differ, and too little for the previous run's reply (a poll at least 15 s earlier) to be taken for this one.
 */
const TEXT_MATCH_SKEW_S = 5;
/**
 * Slack errors that asking again won't fix: the app lacks a scope or its token is bad. A lookup that fails this way
 * is a setup problem for the owner, not a blip to wait out, so a reply isn't held for ever.
 */
const PERMANENT_SLACK_ERRORS = new Set(['missing_scope', 'not_allowed_token_type', 'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'no_permission']);
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

const WITHHELD = 'Some of what I knew for this answer has since been made private, so I won\'t post it. Ask again and I\'ll answer with what I may share now.';
const SETUP_NOTICE_START = 'I can\'t check who can see this thread';
const UNCONFIRMED = 'I couldn\'t confirm who can see this thread just now, so I haven\'t posted my answer here. Ask again in a minute and I\'ll try again.';
/** Serra's fixed notices, posted the same way many times: never recognised by text. */
const isNotice = (text: string): boolean => text === WITHHELD || text === UNCONFIRMED || text.startsWith(SETUP_NOTICE_START);

/** Feedback on an answer to a question card. */
const QUESTION_HINTS: Record<Extract<Notice, { kind: 'question-hint' }>['hint'], string> = {
  'choose': 'Choose an answer before submitting.',
  'invalid-answer': 'Please choose one of the offered answers, or reply with its label or number.',
  'changed': 'That question changed or was already answered in T3. I’ll check for the next one.',
  'not-sent': 'I couldn’t send that answer to T3. Please try again, or answer in T3.',
  'unconfirmed': 'I couldn\u2019t confirm who can see this thread just now, so I haven\u2019t taken that answer. Please answer again in a minute.',
};

const truncate = (text: string): string =>
  text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT)}\n\n…(truncated, full report in T3)` : text;

const isDm = (conversation: string): boolean => conversation.startsWith('D');

const BAD_TOKEN = new Set(['not_allowed_token_type', 'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked']);
const chatError = (error: unknown): ChatError => {
  const code = slackErrorCode(error);
  if (!PERMANENT_SLACK_ERRORS.has(code)) return { kind: 'retry' };
  return { kind: 'setup', problem: BAD_TOKEN.has(code) ? 'bad-token' : 'missing-permission', code };
};

export interface SlackChatOptions {
  client: SlackApi;
  /** The owner's Slack member ID: their DM is theirs alone, and they are who notices mention. */
  owner: PersonId;
  /** The bot's own Slack member ID, known only after Slack auth. */
  botUserId: () => string;
  /** For downloading files people attach. */
  botToken: string;
  profileDir: string;
  logger: Logger;
  clock: Pick<Clock, 'now'>;
  receive?: typeof receiveAttachments;
}

export const createSlackChat = ({ client, owner, botUserId, botToken, profileDir, logger, clock, receive = receiveAttachments }: SlackChatOptions):
  { chat: ChatPort; writer: WorkerWriter; sawDm: (conversation: string, person: PersonId) => void } => {
  const now = (): number => clock.now();
  const mention = (person: PersonId): string => `<@${person}>`;

  const noticeText = (notice: Notice): string => {
    switch (notice.kind) {
      case 'here': return 'I\'m here. What do you need?';
      case 'refused': return `Sorry, I only take requests from people ${mention(owner)} has added.`;
      case 'failed': return notice.owner
        ? 'Something went wrong on my side, so I couldn\'t pick this up. The details are in Serra\'s Jobs and log.'
        : `Something went wrong on my side, so I couldn't pick this up. ${mention(owner)} will take a look.`;
      case 'withheld': return WITHHELD;
      case 'unconfirmed': return UNCONFIRMED;
      case 'setup-problem': return `${SETUP_NOTICE_START}: ${notice.problem === 'bad-token' ? 'my Slack app\'s token isn\'t accepted' : 'my Slack app is missing a permission'}. I've told my owner how to fix it, and I'll answer here once it's done.`;
      case 'fresh-session': return 'Some knowledge this thread used has changed, so I\'m carrying on in a fresh session.';
      case 'waiting-in-t3': return `${mention(owner)} I'm waiting for you in T3: ${notice.link ? `<${notice.link}|answer it there>` : 'answer it there'}. `
        + 'It needs an action there, such as a token, an approval, or a question Slack cannot display. Messages here reach me once it\'s answered.';
      case 'question-hint': return QUESTION_HINTS[notice.hint];
    }
  };

  // Who can see a thread. -------------------------------------------------------------------------------------------

  /** Whether a channel is shared with another company, remembered for a few minutes: it rarely changes. */
  const sharedChannels = new Map<string, { external: boolean; until: number }>();
  /** Where a DM's person works, remembered the same way. Checks before a post ask again. */
  const dmPeople = new Map<string, { visibility: Audience; until: number }>();

  /** A channel or group DM: DMs never come here, since describing one needs `im:read`. */
  const lookUpChannel = async (conversation: string): Promise<Result<Audience>> => {
    try {
      const { channel } = await client.conversations.info({ channel: conversation });
      if (!channel) throw new Error('Slack returned no channel');
      // Team only on Slack's word: it says the channel isn't shared outside. Anything else counts as outside.
      const external = channel.is_ext_shared !== false || channel.is_pending_ext_shared === true;
      sharedChannels.set(conversation, { external, until: now() + VISIBILITY_TTL_MS });
      return { ok: true, value: external ? 'external' : 'team' };
    } catch (error) {
      logger.debug(`Looking up ${conversation} failed: ${errorMessage(error)}`);
      return { ok: false, error: chatError(error) };
    }
  };

  /**
   * A teammate's DM is team only when Slack says they're in the owner's workspace: a Slack Connect user from another
   * company, or one Slack won't describe, counts as outside.
   */
  const lookUpDm = async (user: PersonId): Promise<Result<Audience>> => {
    try {
      const [person, home] = await Promise.all([client.users.info({ user }), client.users.info({ user: owner })]);
      const team = home.user?.team_id;
      const value = person.user?.team_id && team && person.user.team_id === team && !person.user.is_stranger ? 'team' : 'external';
      dmPeople.set(user, { visibility: value, until: now() + VISIBILITY_TTL_MS });
      return { ok: true, value };
    } catch (error) {
      logger.warn(`Could not tell where ${user} works, so their DM's brief carries only what outsiders may hear: ${errorMessage(error)}`);
      return { ok: false, error: chatError(error) };
    }
  };

  /**
   * Whose each DM is, learned from the messages people send in it (`sawDm`). Asking Slack would need `im:read`, which
   * the app doesn't request.
   */
  const dmOwners = new Map<string, PersonId>();
  /**
   * The owner's DM is theirs alone, unless a message in it came from someone else: then it is that person's DM. A DM
   * not seen since the start counts as the owner's, as their requests say.
   */
  const ownDm = (conversation: string): Promise<Result<Audience>> | Result<Audience> => {
    const other = dmOwners.get(conversation);
    return other !== undefined && other !== owner ? audience({ conversation, thread: null }, other, { fresh: true }) : { ok: true, value: 'owner' };
  };

  /**
   * Who will see the bot's reply in this thread. A DM is the owner's own (no lookup: see `ownDm`), or a teammate's
   * (where they work, from `users.info`). A channel shared with another company counts as outside. `fresh` skips the
   * cache and asks again once after a failure that may pass, since a channel can be shared outside a minute after the
   * job started; a setup error is final at once.
   */
  const audience = async (target: Target, requester: PersonId, { fresh = false }: { fresh?: boolean } = {}): Promise<Result<Audience>> => {
    const conversation = target.conversation;
    if (isDm(conversation)) {
      if (requester === owner) return ownDm(conversation);
      const known = dmPeople.get(requester);
      if (!fresh && known && known.until > now()) return { ok: true, value: known.visibility };
      const looked = await lookUpDm(requester);
      return looked.ok || !fresh || looked.error.kind === 'setup' ? looked : lookUpDm(requester);
    }
    const known = sharedChannels.get(conversation);
    if (!fresh && known && known.until > now()) return { ok: true, value: known.external ? 'external' : 'team' };
    const looked = await lookUpChannel(conversation);
    return looked.ok || !fresh || looked.error.kind === 'setup' ? looked : lookUpChannel(conversation);
  };

  // Rendering. ------------------------------------------------------------------------------------------------------

  const inThread = (target: Target): { channel: string; thread_ts?: string } =>
    target.thread === null ? { channel: target.conversation } : { channel: target.conversation, thread_ts: target.thread };
  const replyMetadata = (runId: string) => ({ event_type: REPLY_EVENT, event_payload: { run_id: runId } });

  /** A run's reply: a callout for a new blocker, the reply, and a footer with a cc and the T3 link. */
  const replyFrame = (body: string, link: string | null, notify: OwnerNotify): Rendered => ({
    text: body.slice(0, SLACK_FALLBACK_LIMIT),
    blocks: [
      ...(notify === 'callout' ? [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: `${mention(owner)} this one needs you.` } }] : []),
      { type: 'markdown', text: body },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${notify === 'cc' ? `cc ${mention(owner)} · ` : ''}${link ? `<${link}|T3 thread>` : 'T3 thread'}` }] },
    ],
    unfurl_links: false,
  });

  /** The message for worker words, without where it goes. */
  const render = (out: WorkerOut): Rendered => {
    switch (out.kind) {
      case 'reply': return replyFrame(truncate(out.markdown), out.link, out.notify);
      case 'status': {
        const body = truncate(out.markdown);
        return { text: body.slice(0, SLACK_FALLBACK_LIMIT), blocks: [
          { type: 'markdown', text: body },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `<!date^${Math.floor(out.updatedAt / 1000)}^Updated {time}|Updated> · <${out.link}|T3 thread>` }] },
        ], unfurl_links: false };
      }
      case 'progress': return { text: out.text, blocks: [{ type: 'markdown', text: out.text }], unfurl_links: false };
      case 'question': return { ...questionMessage(out.card, out.to), unfurl_links: false };
      case 'answered': return answeredMessage(out.card, out.by);
      case 'review': return { text: out.markdown.slice(0, SLACK_FALLBACK_LIMIT), blocks: [
        { type: 'markdown', text: out.markdown },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Prepared by ${out.from} for ${mention(owner)} · <${out.link}|request thread>` }] },
      ], unfurl_links: false };
      case 'failure-detail': return { text: `Something went wrong on my side.\n\`${out.line}\``, unfurl_links: false };
    }
  };

  /** A notice as a message, in the thread or in the frame of the reply it stands in for. */
  const renderNotice = (notice: Replacement, inPlaceOf?: InPlaceOf): Rendered => {
    if (notice.kind === 'question-closed') return closedMessage();
    if (notice.kind === 'question-over') return overMessage(notice.answered);
    const text = noticeText(notice);
    if (inPlaceOf?.frame === 'reply') return replyFrame(text, inPlaceOf.link, inPlaceOf.notify);
    if (inPlaceOf?.frame === 'status') return { text, blocks: [{ type: 'markdown', text }], unfurl_links: false };
    return { text, unfurl_links: false };
  };

  // The port. -------------------------------------------------------------------------------------------------------

  const displayNames = new Map<string, string>();
  const parse = (text: string): { mentions: PersonId[]; prose: string } => ({
    mentions: [...new Set([...text.matchAll(MENTION)].flatMap((match) => (match[1] ? [match[1]] : [])))],
    prose: text.replace(MENTION, ' '),
  });

  const chat: ChatPort = {
    self: botUserId,

    async displayName(person) {
      const known = displayNames.get(person);
      if (known) return known;
      const profile = await client.users.info({ user: person }).catch(() => null);
      const name = profile?.user?.real_name || profile?.user?.name || person;
      // A failed lookup isn't remembered, so the next message tries again.
      if (profile?.user) displayNames.set(person, name);
      return name;
    },

    parse,

    async read(text, nameOf) {
      const { mentions, prose } = parse(text);
      const names = new Map<string, string>();
      for (const person of mentions) if (person !== botUserId()) names.set(person, await nameOf(person));
      // The bot's own mention removed, everyone else's turned into `@Name`: dropping every mention loses who a
      // message was addressed to.
      const readable = text
        .replace(MENTION, (_mention, user: string) => (user === botUserId() ? '' : `@${names.get(user) ?? user}`))
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return { text: readable, mentions, prose };
    },

    async history(target, before) {
      const replies = await client.conversations
        .replies({ channel: target.conversation, ts: target.thread ?? before, limit: 200 })
        .catch((error: unknown) => {
          logger.warn(`Reading thread ${target.conversation}:${target.thread ?? ''} failed: ${errorMessage(error)}`);
          return null;
        });
      if (!replies?.messages) return null;
      const lines: HistoryLine[] = replies.messages.flatMap((m) => {
        if (!m.ts || Number(m.ts) >= Number(before)) return [];
        const from: HistoryLine['from'] = m.user === botUserId() ? { kind: 'self' }
          : m.user ? { kind: 'person', id: m.user }
            : m.bot_id ? { kind: 'bot', ...(m.bot_profile?.name ? { name: m.bot_profile.name } : {}) }
              : m.bot_profile?.name ? { kind: 'bot', name: m.bot_profile.name } : { kind: 'unknown' };
        return [{ id: m.ts, from, text: m.text ?? '', files: incomingFiles(m.files) }];
      });
      return { lines, more: replies.has_more === true };
    },

    receiveFiles: (files, limit) => receive(client, files, profileDir, botToken, { limit }),

    permalink: (ref) => client.chat.getPermalink({ channel: ref.conversation, message_ts: ref.id })
      .then((result) => result.permalink ?? null, () => null),

    async findReply(target, intent) {
      if (target.thread === null) return null;
      // Ten minutes before the intent was saved: room for Slack's clock and this machine's to disagree.
      const intentAt = Date.parse(intent.at) / 1000;
      const replies = await client.conversations.replies({ channel: target.conversation, ts: target.thread, include_all_metadata: true, oldest: (intentAt - 600).toFixed(6), limit: 200 })
        .catch((error: unknown) => {
          logger.warn(`Couldn't read ${target.conversation}:${target.thread ?? ''} to check for a reply posted before a restart: ${errorMessage(error)}`);
          return null;
        });
      // By the run ID Serra put in the message's metadata. When Slack leaves metadata out, by the reply's text: only a
      // message posted around the intent (not an identical earlier reply), and never Serra's fixed notices, which repeat.
      const byText = intent.text && !isNotice(intent.text) ? comparableSlackText(intent.text) : null;
      const mine = replies?.messages?.find((message) => message.user === botUserId() && (message.metadata
        ? message.metadata.event_type === REPLY_EVENT && isRecord(message.metadata.event_payload) && message.metadata.event_payload.run_id === intent.runId
        : byText !== null && Number(message.ts) >= intentAt - TEXT_MATCH_SKEW_S && comparableSlackText(message.text ?? '') === byText));
      return mine?.ts ?? null;
    },

    audience,

    async notice(target, notice, inPlaceOf) {
      const posted = await client.chat.postMessage({ ...inThread(target), ...renderNotice(notice, inPlaceOf), ...(inPlaceOf ? { metadata: replyMetadata(inPlaceOf.runId) } : {}) });
      return posted.ts;
    },

    async replaceWithNotice(ref, notice, frame) {
      return client.chat.update({ channel: ref.conversation, ts: ref.id, ...renderNotice(notice, frame === 'status' ? { runId: '', frame } : undefined) })
        .then(() => true, (error: unknown) => {
          logger.debug(`Replacing ${ref.conversation}:${ref.id} with a notice failed: ${errorMessage(error)}`);
          return false;
        });
    },

    async remove(ref) {
      await client.chat.delete({ channel: ref.conversation, ts: ref.id }).catch((error: unknown) => {
        logger.debug(`Removing ${ref.conversation}:${ref.id} failed: ${errorMessage(error)}`);
      });
    },

    /** 👀 on a message is the acknowledgement: it means the bot has it, and it goes away with the reply. */
    async acknowledge(ref, on) {
      const args = { channel: ref.conversation, timestamp: ref.id, name: 'eyes' };
      await (on ? client.reactions.add(args) : client.reactions.remove(args)).catch((error: unknown) => {
        logger.debug(`eyes ${on ? 'add' : 'remove'} on ${ref.conversation}:${ref.id} failed: ${errorMessage(error)}`);
      });
    },

    /** Native Slack loading is best effort: the 👀 still acknowledges work if the API is unavailable. */
    async setWorking(target, on) {
      if (target.thread === null) return;
      await client.assistant.threads.setStatus({
        channel_id: target.conversation,
        thread_ts: target.thread,
        status: on ? 'is looking into it…' : '',
        ...(on ? { loading_messages: ['Looking into it'] } : {}),
      }).catch((error: unknown) => {
        logger.debug(`Loading status in ${target.conversation}:${target.thread ?? ''} failed: ${errorMessage(error)}`);
      });
    },
  };

  // The writer. -----------------------------------------------------------------------------------------------------

  /**
   * A proof is for one conversation and a short while: worker words never go out on an old answer. `deliver` clears and
   * writes back to back, so this is a second net for a writer misused elsewhere.
   */
  const check = (proof: Cleared, conversation = proof.target.conversation): void => {
    if (proof.target.conversation !== conversation) throw new Error(`Cleared for ${proof.target.conversation}, not ${conversation}`);
    if (now() - proof.at > CLEARED_TTL_MS) throw new Error(`Who can see ${conversation} was checked too long ago to post on`);
  };

  const writer: WorkerWriter = {
    async clear(target, requester) {
      const looked = await audience(target, requester, { fresh: true });
      return looked.ok ? { ok: true, value: clearedFor(target, looked.value, now()) } : looked;
    },

    async send(proof, out) {
      check(proof);
      const runId = out.kind === 'reply' || out.kind === 'status' ? out.runId : null;
      const posted = await client.chat.postMessage({ ...inThread(proof.target), ...render(out), ...(runId ? { metadata: replyMetadata(runId) } : {}) });
      if (!posted.ts) throw new Error('Slack returned no message');
      return posted.ts;
    },

    async revise(proof, ref, out) {
      check(proof, ref.conversation);
      // An edit carries no thread and no reply metadata: the message keeps its own.
      const { text, blocks } = render(out);
      try {
        await client.chat.update({ channel: ref.conversation, ts: ref.id, text, ...(blocks ? { blocks } : {}), ...(out.kind === 'question' || out.kind === 'answered' ? {} : { unfurl_links: false }) });
      } catch (error) {
        if (slackErrorCode(error) === 'message_not_found') throw new MessageGone(ref);
        throw error;
      }
    },

    async upload(proof, file) {
      check(proof);
      if (proof.target.thread === null) return new Error('Files go into a thread');
      const result = await client
        .filesUploadV2({
          channel_id: proof.target.conversation,
          thread_ts: proof.target.thread,
          file: file.path,
          filename: basename(file.path),
          title: file.label,
          ...(file.altText ? { alt_text: file.altText } : {}),
        })
        .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
      return result instanceof Error ? result : null;
    },
  };

  /** A person wrote or clicked in a DM: it is theirs. The daemon calls this for every message it handles and every card click. */
  const sawDm = (conversation: string, person: PersonId): void => {
    if (isDm(conversation) && person !== botUserId()) dmOwners.set(conversation, person);
  };

  return { chat, writer, sawDm };
};
