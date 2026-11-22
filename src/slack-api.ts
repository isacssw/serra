/**
 * The Slack Web API methods the daemon calls, and nothing more. Bolt's `WebClient` satisfies this structurally, and
 * so does the recording fake in `tests/fakes/slack.ts`, with the compiler checking both: a test fake can't drift from
 * the calls the code really makes.
 */
import type { webApi } from '@slack/bolt';
import { isRecord } from './lib/guards.ts';

type WebClient = webApi.WebClient;

export interface SlackApi {
  auth: Pick<WebClient['auth'], 'test'>;
  chat: Pick<WebClient['chat'], 'postMessage' | 'update' | 'delete' | 'getPermalink'>;
  reactions: Pick<WebClient['reactions'], 'add' | 'remove'>;
  assistant: { threads: Pick<WebClient['assistant']['threads'], 'setStatus'> };
  users: Pick<WebClient['users'], 'info'>;
  conversations: Pick<WebClient['conversations'], 'info' | 'replies'>;
  files: Pick<WebClient['files'], 'info'>;
  filesUploadV2: WebClient['filesUploadV2'];
}

/**
 * Text made comparable with what Slack stores for it. Slack wraps bare links (`<url>`), keeps `<url|label>`, escapes
 * `&`, `<` and `>`, and may change white space: so both sides lose link brackets and labels' wrappers, entities are
 * unescaped and any bracket left is dropped, white space is collapsed, and only a prefix is kept.
 */
export const comparableSlackText = (text: string): string => text
  .replace(/<([^<>|]+)(?:\|[^<>]*)?>/g, '$1')
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  .replace(/[<>]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 500);

/** Slack's error code from a failed Web API call (`missing_scope`, `message_not_found`), else the error's message. */
export const slackErrorCode = (error: unknown): string => {
  const code = isRecord(error) && isRecord(error.data) ? error.data.error : undefined;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
};
