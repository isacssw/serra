import type { SlackApi } from './slack-api.ts';
import { run } from './t3.ts';

type SlackClient = Pick<SlackApi, 'chat'>;

const BLOCK = /<review-request>\s*([\s\S]*?)\s*<\/review-request>/i;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?![\w/-])/g;

export interface ReviewRequestOutcome {
  /** The reply with the block replaced by what happened to it. */
  reply: string;
  /** The PR whose review was requested, when a request was posted. */
  postedFor: string | null;
}

/** Slack text from a worker may not ping a channel or a group, whatever a bug report talked it into. */
const withoutBroadcasts = (text: string): string =>
  text
    .replace(/<!(here|channel|everyone)[^>]*>/gi, '@$1 (removed)')
    .replace(/<!subteam\^[^>]*>/gi, '(group mention removed)');

/** The current CLI account and PR author must both match the configured owner. */
const prProblem = async (url: string, expectedLogin: string | undefined, command: typeof run): Promise<string | null> => {
  const login = (await command('gh', ['api', 'user', '--jq', '.login'])).trim();
  if (expectedLogin && login.toLowerCase() !== expectedLogin.toLowerCase()) return 'gh is logged in as a different owner';
  const raw = await command('gh', ['pr', 'view', url, '--json', 'state,isDraft,author']).catch((error: unknown) => {
    throw new Error(`could not read ${url} with gh`, { cause: error });
  });
  const pr: unknown = JSON.parse(raw);
  if (typeof pr !== 'object' || pr === null) return `gh returned no PR for ${url}`;
  const { state, isDraft, author } = pr as { state?: unknown; isDraft?: unknown; author?: { login?: unknown } };
  if (state !== 'OPEN') return `${url} is not open (${String(state)})`;
  if (isDraft !== false) return `${url} is still a draft or has no draft status`;
  if (typeof author?.login !== 'string' || author.login.toLowerCase() !== login.toLowerCase()) return `${url} was not opened by the owner's GitHub account`;
  return null;
};

/**
 * Posts the worker's `<review-request>` block to the code-review channel, once per PR, after checking the PR
 * really is open, ready and the owner's. The destination is fixed here, so nothing in a request can redirect it.
 */
export const handleReviewRequest = async (
  client: SlackClient,
  text: string,
  opts: { channel?: string; mayPost?: () => Promise<boolean>; owner: string; botName: string; repositories: string[]; githubLogin?: string; alreadyPosted: string[]; sourceLink: string },
  command: typeof run = run,
): Promise<ReviewRequestOutcome> => {
  const match = BLOCK.exec(text);
  if (!match) return { reply: text, postedFor: null };
  const message = withoutBroadcasts(match[1] ?? '');
  const replace = (line: string): string => text.replace(BLOCK, () => line);
  const blocked = (reason: string): ReviewRequestOutcome => ({
    reply: replace(`Needs owner: I couldn't post the review request (${reason}). Here it is to paste:\n\n${message}`),
    postedFor: null,
  });

  if (!opts.channel) return blocked('review posting is disabled; configure a review channel to enable it');
  const prs = [...new Set(message.match(PR_URL) ?? [])];
  const pr = prs[0];
  if (!pr) return blocked('it has no GitHub PR link');
  const allowed = new Set(opts.repositories.map((repo) => repo.toLowerCase()));
  if (prs.some((url) => !allowed.has(new URL(url).pathname.split('/').slice(1, 3).join('/').toLowerCase()))) {
    return blocked('a PR is outside the configured review repositories');
  }
  if (opts.alreadyPosted.includes(pr)) return { reply: replace(`The review request for ${pr} was already posted.`), postedFor: null };

  for (const url of prs) {
    const problem = await prProblem(url, opts.githubLogin, command).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (problem) return blocked(problem);
  }

  // Checked last, right before sending: who may read the review channel, and what the worker was told, can change
  // while the PR is checked.
  if (opts.mayPost && !(await opts.mayPost())) return blocked('it was written with knowledge some people in the review channel may not hear: check it and post it yourself');
  const posted = await client.chat
    .postMessage({
      channel: opts.channel,
      text: message.slice(0, 3_000),
      blocks: [
        { type: 'markdown', text: message },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Prepared by ${opts.botName} for <@${opts.owner}> · <${opts.sourceLink}|request thread>` }],
        },
      ],
      unfurl_links: false,
    })
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (posted instanceof Error) return blocked(posted.message);
  if (!posted.ts) return blocked('Slack returned no message');
  const link = await client.chat
    .getPermalink({ channel: opts.channel, message_ts: posted.ts })
    .then((result) => result.permalink)
    .catch(() => undefined);
  return { reply: replace(`Review request posted${link ? `: ${link}` : ' in the code-review channel'}.`), postedFor: pr };
};
