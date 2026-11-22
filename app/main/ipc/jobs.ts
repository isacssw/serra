// Jobs screen (APP-12), on APP-7's read service and worktree cleanup. Only parses input and calls `src/`.
import { applyWorktreeCleanup, planWorktreeCleanup, profileT3Bin, runCommand, type Runner } from '../../../src/cleanup.ts';
import { listJobs, t3ThreadLookup, type ThreadInfo, type ThreadLookup } from '../../../src/jobs.ts';
import { readSecret, slackWorkspace } from '../../../src/secrets.ts';
import { createSlackNames, slackMentions, slackPlainText, type SlackNameLookup, type SlackNames } from '../../../src/slack-names.ts';
import { t3TaskState } from '../../../src/tasks.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

export interface JobsDeps {
  /** Runs `t3`, `git` and `gh`. Tests pass a fake. */
  run?: Runner;
  now?: () => Date;
  /** Only worktrees inside this folder are removed (default: `~/.t3/worktrees`). */
  worktreesRoot?: string;
  /** Slack name lookups (APP-29). Tests pass a fake token and lookup; the default reads the bot token's source. */
  slackNames?: { token?: (profileDir: string) => Promise<string | undefined>; lookup?: (token: string) => Promise<SlackNameLookup>; ttlMs?: number; log?: (message: string) => void };
}

/** How long a thread without a PR is remembered before T3 is asked again: its worker may open one any minute. */
export const THREAD_RECHECK_MS = 30_000;

/**
 * A thread lookup that remembers what T3 answered, per binary. The list reloads on every daemon event, so a thread
 * costs one `t3 thread show` per app run once T3 reports its PR, and one every `THREAD_RECHECK_MS` until then: title
 * and link don't change, but a PR appears once the worker opens it. Misses aren't remembered: T3 may be starting up.
 */
export const cachedLookup = (cache: Map<string, { info: ThreadInfo; until: number }>, t3Bin: string, run: Runner, now: () => number = Date.now): ThreadLookup => {
  const lookup = t3ThreadLookup(t3Bin, run);
  return async (threadId) => {
    const key = `${t3Bin}\0${threadId}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.info;
    const info = await lookup(threadId);
    if (info && (info.title || info.link)) cache.set(key, { info, until: info.pr ? Infinity : now() + THREAD_RECHECK_MS });
    // T3 not answering this time keeps what it said before.
    return info ?? hit?.info ?? null;
  };
};

const cleanupDays = (days: unknown): number | undefined => {
  if (days === undefined) return undefined;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) throw new Error('days needs a number of days, like 3');
  return days;
};

type Row = Awaited<ReturnType<Handlers<'jobs'>['list']>>[number];

/**
 * Adds the Slack names already known to each row, and asks for the rest in the background. A row whose names aren't
 * known yet keeps its raw IDs; when they arrive, the `jobs` push makes the screen list again. The requester may be a
 * bot (an alert from an integration), named through `bots.info`. Title, question and error are Slack text (a T3
 * title is the request's first line), so their mrkdwn is shown as plain text, with mentions named too.
 */
const withNames = (rows: Row[], names: SlackNames): Row[] => {
  const texts = rows.flatMap((row) => [row.title, row.ownerQuestion ?? '', row.error ?? '']).join('\n');
  const mentioned = slackMentions(texts);
  void names.request({
    users: [...rows.map((row) => row.requester), ...mentioned.users],
    channels: [...rows.map((row) => row.channel), ...mentioned.channels],
  });
  const plain = (text: string): string => slackPlainText(text, { user: names.userName, channel: names.channelName });
  return rows.map((row) => {
    const requesterName = names.userName(row.requester);
    const channelName = names.channelName(row.channel);
    return {
      ...row,
      title: plain(row.title),
      ...(row.ownerQuestion ? { ownerQuestion: plain(row.ownerQuestion) } : {}),
      ...(row.error ? { error: plain(row.error) } : {}),
      ...(requesterName ? { requesterName } : {}),
      ...(channelName ? { channelName } : {}),
    };
  });
};

export const jobsHandlers = (context: HandlerContext, { run = runCommand, now = () => new Date(), worktreesRoot, slackNames = {} }: JobsDeps = {}): Handlers<'jobs'> => {
  const threads = new Map<string, { info: ThreadInfo; until: number }>();
  // One cache per profile: another profile may be another Slack workspace.
  const namesByProfile = new Map<string, SlackNames>();
  const namesFor = (profileDir: string): SlackNames => {
    let names = namesByProfile.get(profileDir);
    if (!names) {
      names = createSlackNames({
        token: () => (slackNames.token ?? ((dir) => readSecret(dir, 'SLACK_BOT_TOKEN')))(profileDir),
        ...(slackNames.lookup ? { lookup: slackNames.lookup } : {}),
        ...(slackNames.ttlMs ? { ttlMs: slackNames.ttlMs } : {}),
        // Only the newest profile's names refresh the screen; a switch away makes the old cache quiet.
        onResolved: () => { if (context.profileDirOrNull() === profileDir) context.push?.('jobs', null); },
        log: slackNames.log ?? console.error,
      });
      namesByProfile.set(profileDir, names);
    }
    return names;
  };
  return {
    // Works from the files whether or not the daemon runs. Slack links use the workspace the last token check saved.
    list: async () => {
      const profileDir = context.profileDir();
      const slackUrl = slackWorkspace(profileDir)?.url;
      // A profile.json that doesn't load still lists the jobs, just without T3 titles and links.
      const t3Bin = (() => { try { return profileT3Bin(profileDir); } catch { return undefined; } })();
      const { jobs } = await listJobs(profileDir, {
        now: now(),
        ...(slackUrl ? { slackUrl } : {}),
        // Tasks started in the app, and Slack jobs saved as running, are read from T3 on every reload: T3 says what runs.
        ...(t3Bin ? { threads: cachedLookup(threads, t3Bin, run, () => now().getTime()), tasks: t3TaskState(t3Bin, run), runs: t3TaskState(t3Bin, run) } : {}),
      });
      return withNames(jobs, namesFor(profileDir));
    },
    // The dry run never removes anything. Apply runs every check again, so a worktree that changed since is kept.
    cleanupWorktrees: async (options) => {
      if (typeof options !== 'object' || options === null || typeof options.apply !== 'boolean') {
        throw new Error('cleanupWorktrees needs { apply: true | false }.');
      }
      const days = cleanupDays(options.days);
      const service = options.apply ? applyWorktreeCleanup : planWorktreeCleanup;
      const report = await service(context.profileDir(), {
        run, now: now(), ...(days === undefined ? {} : { days }), ...(worktreesRoot ? { worktreesRoot } : {}),
      });
      return report.verdicts;
    },
  };
};
