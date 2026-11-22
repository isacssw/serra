/**
 * The bot's `chat` and `deliver` over a Slack client (usually the recording fake in `slack.ts`), wired as the daemon
 * wires them: the Slack adapter's writer goes straight to `deliver`. Tests then assert on Slack's wire calls.
 */
import { createDeliver } from '../../src/chat/deliver.ts';
import type { Clock } from '../../src/clock.ts';
import type { Target } from '../../src/chat/port.ts';
import type { Config } from '../../src/config.ts';
import type { Upload } from '../../src/images.ts';
import type { SlackApi } from '../../src/slack/api.ts';
import { createSlackChat, type SlackChatOptions } from '../../src/slack/chat.ts';

const quiet = (): void => {};

export const slackChat = (client: SlackApi, config: Pick<Config, 'owner' | 'botToken' | 'profileDir'>,
  { botUserId, clock = { now: Date.now }, logger = { info: quiet, warn: quiet, error: quiet, debug: quiet }, receive }:
  { botUserId: string; clock?: Pick<Clock, 'now'>; logger?: SlackChatOptions['logger']; receive?: SlackChatOptions['receive'] }) => {
  const { chat, writer } = createSlackChat({ client, owner: config.owner, botUserId: () => botUserId, botToken: config.botToken, profileDir: config.profileDir,
    logger, clock, ...(receive ? { receive } : {}) });
  return { chat, deliver: createDeliver(writer) };
};

/**
 * Uploads into `target` the way the bot does, through `deliver` and the Slack adapter. `may` stands in for the page
 * check: false refuses the upload.
 */
export const slackUpload = (client: SlackApi, target: Target, may: () => boolean | Promise<boolean> = () => true): Upload => {
  const { deliver } = slackChat(client, { owner: 'U0123456789', botToken: 'xoxb-1111-2222-fixturevalue', profileDir: '/tmp' }, { botUserId: 'UBOT' });
  return async (file) => {
    const sent = await deliver({ target, requester: 'U0123456789', may }, { op: 'upload', file });
    return sent.ok ? sent.value : 'refused';
  };
};
