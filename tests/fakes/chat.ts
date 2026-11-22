/**
 * The bot's `chat` and `deliver` over a Slack client (usually the recording fake in `slack.ts`), wired as the daemon
 * wires them: the Slack adapter's writer goes straight to `deliver`. Tests then assert on Slack's wire calls.
 */
import { createDeliver } from '../../src/chat/deliver.ts';
import type { Clock } from '../../src/clock.ts';
import type { Audience, ChatPort, InPlaceOf, MessageRef, Notice, Result, Target, WorkerOut } from '../../src/chat/port.ts';
import { clearedFor, type WorkerWriter } from '../../src/chat/writer.ts';
import type { Heard } from '../../src/hearing.ts';
import type { BriefKnowledge } from '../../src/knowledge.ts';
import type { Config } from '../../src/config.ts';
import type { Upload } from '../../src/images.ts';
import type { SlackApi } from '../../src/slack/api.ts';
import { createSlackChat, type SlackChatOptions } from '../../src/slack/chat.ts';

const quiet = (): void => {};

export const slackChat = (client: SlackApi, config: Pick<Config, 'owner' | 'botToken' | 'profileDir'>,
  { botUserId, clock = { now: Date.now }, logger = { info: quiet, warn: quiet, error: quiet, debug: quiet }, receive, loadKnowledge }:
  { botUserId: string; clock?: Pick<Clock, 'now'>; logger?: SlackChatOptions['logger']; receive?: SlackChatOptions['receive'];
    /** The knowledge `deliver` checks pages against, as the bot's. Without it, nothing is withheld, as without knowledge. */
    loadKnowledge?: (visibility: Audience) => BriefKnowledge }) => {
  const { chat, writer } = createSlackChat({ client, owner: config.owner, botUserId: () => botUserId, botToken: config.botToken, profileDir: config.profileDir,
    logger, clock, ...(receive ? { receive } : {}) });
  return { chat, deliver: createDeliver(writer, loadKnowledge) };
};

/** Knowledge with one team page that stays available while `available()` says so: then it's withdrawn, as if retired. */
export const onePage = (available: () => boolean = () => true) => ({
  heard: { visibility: 'team', knowledgeRead: { 'workflows/release.md': 'team' } } satisfies Heard,
  loadKnowledge: (): BriefKnowledge => ({ index: '', pages: available() ? ['workflows/release.md'] : [], read: {}, readDir: '/tmp' }) as unknown as BriefKnowledge,
});

/**
 * Uploads into `target` the way the bot does, through `deliver` and the Slack adapter. `available` stands in for the
 * page the worker read: once false, the page is withdrawn and the next upload is refused.
 */
export const slackUpload = (client: SlackApi, target: Target, available: () => boolean = () => true): Upload => {
  const knowledge = onePage(available);
  const { deliver } = slackChat(client, { owner: 'U0123456789', botToken: 'xoxb-1111-2222-fixturevalue', profileDir: '/tmp' }, { botUserId: 'UBOT', loadKnowledge: knowledge.loadKnowledge });
  return async (file) => {
    const sent = await deliver({ target, requester: 'U0123456789', hearing: { kind: 'thread', heard: knowledge.heard } }, { op: 'upload', file });
    return sent.ok ? sent.value : 'refused';
  };
};

/**
 * A chat in memory: no Slack anywhere. It implements `ChatPort` and `WorkerWriter` and records what the core asked of
 * each, so a test shows the core works against the port alone, as a second adapter would.
 */
export const createFakeChat = ({ self = 'BOT', audiences = {} }: { self?: string; audiences?: Record<string, Audience> } = {}) => {
  let next = 0;
  const id = (): string => `m${++next}`;
  const notices: { target: Target; notice: Notice; inPlaceOf?: InPlaceOf }[] = [];
  const sent: { target: Target; out: WorkerOut; id: string }[] = [];
  const revised: { ref: MessageRef; out: WorkerOut }[] = [];
  const acknowledged: { ref: MessageRef; on: boolean }[] = [];
  const audienceOf = (target: Target): Result<Audience> => ({ ok: true, value: audiences[target.conversation] ?? 'team' });
  const chat: ChatPort = {
    self: () => self,
    displayName: async (person) => person,
    parse: (text) => ({ mentions: text.includes(`@${self}`) ? [self] : [], prose: text.replaceAll(`@${self}`, ' ') }),
    read: async (text) => ({ text: text.replaceAll(`@${self}`, '').trim(), mentions: text.includes(`@${self}`) ? [self] : [], prose: text }),
    history: async () => ({ lines: [], more: false }),
    receiveFiles: async () => '',
    permalink: async (ref) => `chat://${ref.conversation}/${ref.id}`,
    findReply: async () => null,
    audience: async (target) => audienceOf(target),
    notice: async (target, notice, inPlaceOf) => { notices.push({ target, notice, ...(inPlaceOf ? { inPlaceOf } : {}) }); return id(); },
    replaceWithNotice: async () => true,
    remove: async () => {},
    acknowledge: async (ref, on) => { acknowledged.push({ ref, on }); },
    setWorking: async () => {},
  };
  const writer: WorkerWriter = {
    clear: async (target) => { const looked = audienceOf(target); return looked.ok ? { ok: true, value: clearedFor(target, looked.value, Date.now()) } : looked; },
    send: async (proof, out) => { const message = id(); sent.push({ target: proof.target, out, id: message }); return message; },
    revise: async (_proof, ref, out) => { revised.push({ ref, out }); },
    upload: async () => null,
  };
  return { chat, writer, notices, sent, revised, acknowledged };
};
