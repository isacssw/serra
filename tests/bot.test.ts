import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBot, type BotDeps } from '../src/bot.ts';
import type { MessageTrigger } from '../src/config.ts';
import { incomingMessage } from '../src/incoming.ts';
import { createStore } from '../src/state.ts';
import { fakeClock } from './fakes/clock.ts';
import { BOT, OWNER, SAM, testProfile } from './fakes/profile.ts';
import { createFakeSlack } from './fakes/slack.ts';
import { createFakeT3 } from './fakes/t3.ts';
import { receiveAttachments } from '../src/attachments.ts';
import type { IncomingFile, IncomingMessage } from '../src/types.ts';
import type { T3QuestionRequest } from '../src/t3-questions.ts';
import { questionInteraction } from '../src/questions.ts';
import { addAllowedUser, PROFILE_SETTINGS, updateProfileSection } from '../src/profile-settings.ts';
import { watchProfile } from '../src/profile-reload.ts';
import { listJobs } from '../src/jobs.ts';


/** A bot wired to the shared recording Slack and scriptable T3 (tests/fakes), on a fake clock the test moves by hand. */
const fixture = (t: TestContext, receive?: BotDeps['receive'], { allowErrors = false, failStart, statusError, failAnswer, ...profile }: { branchPattern?: string; allowErrors?: boolean; messageTriggers?: MessageTrigger[]; failStart?: () => boolean; statusError?: () => boolean; failAnswer?: () => boolean } = {}) => {
  const { config } = testProfile(t, profile);
  const clock = fakeClock('2026-11-18T10:00:00Z');
  const slack = createFakeSlack({ botUserId: BOT, names: { [OWNER]: 'Alex Doe', [SAM]: 'Sam' }, now: () => clock.now() });
  const worker = createFakeT3({
    failStart: () => (failStart?.() ? new Error('Worker startup unavailable') : null),
    failAnswer: () => (failAnswer?.() ? new Error('Question service unavailable') : null),
  });

  /** Posts, edits, deletes and turns sent to T3, in order. */
  const log: string[] = [];
  const statuses: { channel_id: string; thread_ts: string; status: string; loading_messages?: string[] }[] = [];
  let loadingVisible = false;
  slack.before('assistant.threads.setStatus', (args) => {
    statuses.push(args as typeof statuses[number]);
    if (statusError?.()) throw new Error('method_not_supported_for_channel_type');
    loadingVisible = args.status !== '';
  });
  // Slack clears native loading when a message is posted.
  slack.before('chat.postMessage', (args) => { loadingVisible = false; log.push(`post: ${String(args.text)}`); });
  slack.before('chat.update', (args) => { if (!slack.deleted.includes(String(args.ts))) log.push(`edit: ${String(args.text)}`); });
  slack.before('chat.delete', (args) => { log.push(`delete: ${String(args.ts)}`); });
  /** What `conversations.replies` shows for any thread: tests add people's earlier messages here. */
  const history: { ts: string; user?: string; text?: string; files?: IncomingFile[] }[] = [];
  slack.client.conversations.replies = async () => ({ ok: true, messages: history as NonNullable<Awaited<ReturnType<typeof slack.client.conversations.replies>>['messages']> });
  const downloads: string[] = [];
  const errors: string[] = [];
  const recordedEvents: { name: string; fields: Record<string, unknown> }[] = [];
  const t3: NonNullable<BotDeps['t3']> = {
    ...worker.t3,
    sendToThread: async (id, message) => { log.push('send'); await worker.t3.sendToThread(id, message); },
  };
  const quiet = (): void => {};
  const deps: BotDeps = {
    config, client: slack.client, botUserId: () => BOT, store: createStore(config.statePath), loadIndex: () => 'index', t3,
    logger: { info: quiet, warn: quiet, error: (message) => { if (allowErrors || failStart || failAnswer) errors.push(message); else assert.fail(message); }, debug: quiet },
    questions: worker.questions,
    fetchBase: async () => {}, share: async (_client, text) => text, reviewRequest: async (_client, text) => ({ reply: text, postedFor: null }),
    receive: receive ?? ((client, files, profileDir, token, options) => receiveAttachments(client, files, profileDir, token, { ...options,
      fetchFile: async (url) => { downloads.push(String(url)); return new Response('fixture file bytes'); },
    })),
    timing: { quietMs: 15, retryMs: 5 },
    clock,
    events: (name, fields) => { recordedEvents.push({ name, fields }); },
  };
  let bot = createBot(deps);
  clock.settleWith(() => bot.idle());
  const restart = () => { bot = createBot({ ...deps, store: createStore(config.statePath) }); return bot; };
  const ingest = async (event: unknown): Promise<void> => {
    // Slack never gives two messages one ts: later `say` calls follow on from an ingested 100.NNN.
    const ts = /^100\.(\d{3})$/.exec(String((event as { ts?: unknown }).ts))?.[1];
    if (ts) msgClock = Math.max(msgClock, Number(ts));
    const msg = incomingMessage(event, 'message', BOT, bot.ownsThread, { messageTriggers: config.messageTriggers, botId: 'BSELF' });
    if (msg) await bot.handle(msg);
  };

  let msgClock = 0;
  const say = (user: string, text: string, direct = false, files?: IncomingFile[]): Promise<void> => {
    const ts = `100.${String(++msgClock).padStart(3, '0')}`;
    const msg: IncomingMessage = { channel: 'C1', threadTs: '100.001', messageTs: ts, user, text, direct, files };
    return bot.handle(msg);
  };
  const poll = (): Promise<void> => bot.poll();
  /** The worker ends its turn with this reply, and the bot polls. */
  const workerReplies = async (text: string): Promise<void> => { worker.reply(text); await poll(); };
  /** A note the worker writes while its run goes on, like "Reproducing the bug first." */
  const workerNotes = (text: string): void => { worker.note(text); };
  /** The worker ends its turn with `text` while no bot is polling. */
  const workerRepliesUnwatched = (text: string): void => { worker.reply(text); };
  /** The worker starts a run of its own, as it does to follow CI, and ends it with `text`. */
  const backgroundRun = async (text: string): Promise<void> => {
    worker.startRun(); await poll();
    worker.reply(text); await poll();
  };
  /** Moves the clock, firing the timers due meanwhile: for tests about how long something has gone on. */
  const advance = (ms: number): Promise<void> => clock.advance(ms);
  /** The worker answers someone and, before the bot's next poll, starts a run of its own. */
  const workerRepliesThenStartsRun = async (text: string): Promise<void> => { worker.reply(text); worker.startRun(); await poll(); };
  const backgroundRunWithoutReply = async (): Promise<void> => { worker.startRun(); await poll(); worker.endSilently(); await poll(); };
  const posts = (): { text: string; blocks: string; ts: string; channel: string; thread_ts?: string }[] =>
    slack.posted.map((post) => ({ text: String(post.text), blocks: JSON.stringify(post.blocks ?? []), ts: post.ts, channel: String(post.channel), ...(typeof post.thread_ts === 'string' ? { thread_ts: post.thread_ts } : {}) }));
  const ownerPings = (): number => posts().filter((post) => post.blocks.includes(`<@${OWNER}>`)).length;
  /** The running turn stops on n requests in T3's UI (questions pushed to `questionRequests` count among them), or 0. */
  const waitsInT3 = (n: number): void => { worker.waitOnOther(Math.max(0, n - worker.questionsOf().length)); };
  return {
    get bot() { return bot; }, say, workerReplies, workerRepliesThenStartsRun, workerNotes, workerRepliesUnwatched, backgroundRun, backgroundRunWithoutReply, advance, waitsInT3,
    get posts() { return posts(); },
    get edits() { return slack.edited.map((edit) => ({ ts: String(edit.ts), text: String(edit.text), blocks: JSON.stringify(edit.blocks ?? []) })); },
    deleted: slack.deleted,
    get eyes() { return new Set(slack.withReaction('eyes').map((at) => at.split(':')[1]!)); },
    get sends() { return worker.sends.map((send) => send.message); },
    get started() { return worker.started.map((input) => ({ branch: input.branch, title: input.title })); },
    get questionRequests() { return worker.questionsOf(); },
    log, ownerPings, history, downloads, config, ingest, restart, errors, statuses, answered: worker.answered, recordedEvents,
    clock, slack, worker,
    loadingVisible: () => loadingVisible, brief: () => (worker.threadIds().length ? worker.brief() : ''),
    /** Lets quiet timers fire and everything they started finish: the batcher's 15 ms quiet time and its retries. */
    settle: () => clock.advance(60),
  };

};

test('a busy thread: people talking to each other get no reply and the owner is pinged once', async (t) => {
  const f = fixture(t);

  await f.say(SAM, `<@${BOT}> can you give me the latest plan names from the pricing admin page`, true);
  assert.equal(f.posts.length, 0, 'the 👀 is the acknowledgement, not a message');
  assert.equal(f.eyes.size, 1);
  assert.match(f.brief(), /Sam asked/);

  await f.workerReplies('Starter is the only plan in the seed data.\n\nNeeds Alex: paste the list from the admin tab.');
  assert.equal(f.posts.length, 1); assert.equal(f.ownerPings(), 1); assert.equal(f.eyes.size, 0);

  // Alex asks Sam, not the bot. Sam answers Alex in two quick messages.
  await f.say(OWNER, `can you open the pricing admin page <@${SAM}>? let me know`);
  await f.settle();
  assert.equal(f.sends.length, 0, 'a message addressed to someone else starts no turn');
  await f.say(SAM, 'not yet…');
  await f.say(SAM, 'it shows an error');
  await f.settle();
  assert.equal(f.sends.length, 1, 'two quick messages are one turn');
  assert.match(f.sends[0]!, /Alex \(your owner\) wrote, to someone else:\n> can you open the pricing admin page @Sam\? let me know/);
  assert.match(f.sends[0]!, /Sam wrote:\n> not yet…\n\nSam wrote:\n> it shows an error/);
  assert.match(f.sends[0]!, /reply with only `\(quiet\)`/);
  assert.equal(f.eyes.size, 2);

  await f.workerReplies('(quiet)');
  assert.equal(f.posts.length, 1, 'a quiet turn posts nothing');
  assert.equal(f.eyes.size, 0, 'and the 👀 goes away');

  await f.say(OWNER, 'friday, give me the exact role name for pricing');
  await f.settle();
  assert.equal(f.sends.length, 2, 'the bot is called by name, without an @');
  await f.workerReplies('`pricing-admin`, in `roles.ts`.');
  assert.equal(f.posts.length, 2);

  await f.say(OWNER, `done, you should be able to open it <@${SAM}>`);
  await f.say(SAM, 'i can open it now, thanks!');
  await f.settle();
  await f.workerReplies('(quiet)');

  // One reply per message would have posted 9 times and pinged the owner 5 times here.
  assert.equal(f.posts.length, 2);
  assert.equal(f.ownerPings(), 1);
  assert.equal(f.sends.length, 3);
});

test('a message sent while the worker is busy waits, and the finished reply is posted before the next turn starts', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> how does scoring work?`, true);
  await f.say(SAM, 'also, is it the same for teams?');
  await f.settle();
  assert.equal(f.sends.length, 0, 'held until the first turn ends');

  await f.workerReplies('Scoring works like this.');
  await f.settle();
  assert.deepEqual(f.log, ['post: Scoring works like this.', 'send']);
  assert.equal(f.eyes.size, 1, 'the follow-up keeps its 👀 until it is answered');

  await f.workerReplies('Yes, teams score the same way.');
  assert.equal(f.posts.length, 2); assert.equal(f.eyes.size, 0);
});

test('the owner is cc\'d once on a teammate\'s thread and not pinged again for an ask still waiting', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> change the banner copy`, true);
  await f.workerReplies('Done: PR opened.');
  assert.match(f.posts[0]!.blocks, /cc <@UOWNER>/);

  await f.say(SAM, `<@${BOT}> and the footer?`, true); await f.settle();
  await f.workerReplies('Footer changed too.');
  assert.doesNotMatch(f.posts[1]!.blocks, /UOWNER/);

  await f.say(SAM, `<@${BOT}> ship it to production`, true); await f.settle();
  await f.workerReplies('Needs Alex: approve the deploy.');
  await f.say(SAM, `<@${BOT}> any news?`, true); await f.settle();
  await f.workerReplies('Still waiting.\n\nNeeds Alex: approve the deploy.');
  assert.equal(f.ownerPings(), 2, 'one cc and one callout');

  // Alex answers, the worker hits something new, and that is a new ask.
  await f.say(OWNER, 'friday approved, go'); await f.settle();
  await f.workerReplies('Needs Alex: the deploy needs your 2FA code.');
  assert.equal(f.ownerPings(), 3);
  assert.equal(f.recordedEvents.filter((event) => event.name === 'needs_owner').length, 2, 'one needs_owner event per callout, none for a cc');
});

test('someone outside the allowlist is refused when they ask, and is only context when they chat in the thread', async (t) => {
  const f = fixture(t);
  await f.say('USTRANGER', `<@${BOT}> delete the database`, true);
  assert.match(f.posts[0]!.text, /only take requests/);
  assert.equal(f.sends.length, 0);

  const g = fixture(t);
  await g.say(SAM, `<@${BOT}> rename the button`, true);
  await g.workerReplies('Renamed.');
  await g.say('USTRANGER', 'nice, can it also be blue?'); await g.settle();
  assert.equal(g.sends.length, 0, 'no turn for someone who is not allowed');
  assert.equal(g.posts.length, 1, 'and no refusal for chatting in the thread');
  await g.say(SAM, 'yes make it blue'); await g.settle();
  assert.match(g.sends[0]!, /USTRANGER wrote, to someone else:\n> nice, can it also be blue\?/);
});

test('a run waiting on a T3 prompt tells the owner in Slack once, and again for a new prompt', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> add the hidden fields to the HubSpot forms`, true);
  await f.bot.poll();
  assert.equal(f.posts.length, 0, 'a busy run posts nothing');

  f.waitsInT3(1);
  await f.bot.poll();
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!.text, /<@UOWNER> I'm waiting for you in T3: <https:\/\/t3\.test\/t3-1\|answer it there>/);
  await f.bot.poll();
  assert.equal(f.posts.length, 1, 'the same wait is told once');
  assert.deepEqual(f.recordedEvents.filter((event) => event.name === 'needs_owner').map((event) => event.fields), [{ key: 'C1:100.001' }]);

  f.waitsInT3(0);
  await f.bot.poll();
  f.waitsInT3(1);
  await f.bot.poll();
  assert.equal(f.posts.length, 2, 'a second prompt in the same run is told again');

  f.waitsInT3(0);
  await f.workerReplies('Done: the fields are on both forms.');
  assert.equal(f.posts.length, 3);
  assert.equal(f.eyes.size, 0);
});

test('the brief tells the worker to use native questions and keep secrets out of Slack', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> what does the scoring service do?`, true);
  assert.match(f.brief(), /use a question tool/);
  assert.match(f.brief(), /request_user_input_async/);
  assert.match(f.brief(), /Never ask for a token, password or API key in Slack/);
  assert.match(f.brief(), /request_secret/);
});

const upload = (id: string): IncomingFile => ({ id, name: `${id}.png`, mimetype: 'image/png', url_private: `https://files.slack.com/private/${id}.png` });

test('file-only initial requests and follow-ups reach the worker and return a reply', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}>`, true, [upload('F1')]);
  assert.match(f.brief(), /F1\.png/);
  assert.match(f.brief(), /local path/);
  assert.match(f.brief(), /image-viewing tool/);
  assert.equal(f.eyes.size, 1);
  await f.workerReplies('I can see the screenshot. What should I change?');
  await f.say(SAM, '', false, [upload('F2')]);
  await f.settle();
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0]!, /F2\.png/);
  assert.doesNotMatch(f.sends[0]!, /Nobody @mentioned you/);
  await f.workerReplies('The second screenshot shows the error.');
  assert.equal(f.posts.length, 2);
  assert.equal(f.eyes.size, 0);
  assert.equal(f.downloads.length, 2);
});

test('attachment messages preserve audience and allowlist boundaries', async (t) => {
  const f = fixture(t);
  await f.say('USTRANGER', `<@${BOT}>`, true, [upload('F0')]);
  assert.equal(f.downloads.length, 0);
  await f.say(SAM, `<@${BOT}> examine this`, true);
  await f.workerReplies('Ready.');
  await f.say('USTRANGER', '', false, [upload('F1')]);
  await f.say(OWNER, `for you <@${SAM}>`, false, [upload('F2')]);
  await f.settle();
  assert.equal(f.downloads.length, 1, 'unallowed file-only context is not downloaded');
  assert.equal(f.sends.length, 0, 'files addressed to another person do not wake the worker');
  await f.say(SAM, 'now compare it');
  await f.settle();
  assert.match(f.sends[0]!, /Alex \(your owner\) wrote, to someone else:/);
  assert.match(f.sends[0]!, /F2\.png/);
});

test('joining a thread includes file-only history and bounds downloads across all history', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 8; index++) f.history.push({ ts: `99.${index}`, user: SAM, files: [upload(`F${index}`)] });
  // The original request starts a thread, then we emulate a later first mention using bot.handle directly.
  await f.bot.handle({ channel: 'C1', threadTs: '99.0', messageTs: '100.0', user: SAM, text: `<@${BOT}> inspect these`, direct: true });
  assert.equal(f.downloads.length, 5);
  assert.deepEqual(f.downloads, [7, 6, 5, 4, 3].map((index) => upload(`F${index}`).url_private));
  assert.equal((f.brief().match(/local path/g) ?? []).length, 5);
  assert.match(f.brief(), /F0\.png.*unavailable/);
  assert.match(f.brief(), /download limit reached/);
  assert.ok(f.brief().indexOf('F0.png') < f.brief().indexOf('F7.png'), 'history remains oldest first');
});

test('attachment failure keeps text and file metadata so the worker can explain it', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> check this log`, true, [{ name: 'logs.txt', url_private: 'https://external.test/logs' }]);
  assert.match(f.brief(), /check this log/);
  assert.match(f.brief(), /logs\.txt.*unavailable/);
  assert.equal(f.downloads.length, 0);
  await f.workerReplies('Please upload the log directly; I could not retrieve it.');
  assert.equal(f.posts.length, 1);
});

test('uploads are acknowledged before downloading and empty mentions leave no reaction', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => { started = resolve; });
  const f = fixture(t, async (_client, files) => { if (!files.length) return ''; started(); await gate; return 'Attached file: local path /tmp/example.png'; });
  await f.say(SAM, `<@${BOT}>`, true);
  assert.equal(f.eyes.size, 0);
  const work = f.say(SAM, '', true, [upload('F1')]);
  await downloading;
  assert.equal(f.eyes.size, 1, 'acknowledged while the download is still pending');
  assert.equal(f.loadingVisible(), true, 'native loading starts before downloading');
  release();
  await work;
  await f.workerReplies('Received.');
  assert.equal(f.eyes.size, 0);
});

test('attachments outside the retained history window are never downloaded', async (t) => {
  const f = fixture(t);
  f.history.push({ ts: '98.0', user: SAM, files: [upload('FOLD')] });
  f.history.push({ ts: '99.0', user: SAM, text: 'x'.repeat(19_000) });
  await f.bot.handle({ channel: 'C1', threadTs: '98.0', messageTs: '100.0', user: SAM, text: `<@${BOT}> summarize`, direct: true });
  assert.equal(f.downloads.length, 0);
  assert.doesNotMatch(f.brief(), /FOLD/);
  assert.match(f.brief(), /1 older messages left out/);
});

test('"are you there?" is answered at once without a worker, and the next message in that thread is the request', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> Hey , are you there ?`, true);
  assert.equal(f.started.length, 0, 'no worker and no worktree for a ping');
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!.text, /I'm here/);
  assert.equal(f.eyes.size, 0);
  assert.ok(f.bot.ownsThread('C1', '100.001'), 'the thread is followed, so a reply without an @mention arrives');

  await f.say(OWNER, `<@${SAM}> are you joining standup?`);
  assert.equal(f.started.length, 0, 'people talking to each other still start nothing');

  await f.say(SAM, 'yes, can you explain how scoring works?');
  assert.equal(f.started.length, 1, 'the request after the ping starts the job, no @mention needed');
  assert.match(f.brief(), /can you explain how scoring works/);

  const g = fixture(t);
  await g.say('USTRANGER', `<@${BOT}> are you there?`, true);
  assert.match(g.posts[0]!.text, /only take requests/, 'someone outside the allowlist is still refused');

  // Only the person who pinged is followed, and "ok" or "thanks" after "I'm here" starts nothing.
  const h = fixture(t);
  await h.say(SAM, `<@${BOT}> you there?`, true);
  await h.say(OWNER, 'lunch?');
  await h.say(SAM, 'ok');
  await h.say(SAM, 'thanks!');
  await h.say(SAM, 'are you there?');
  assert.equal(h.started.length, 0);
  assert.equal(h.posts.length, 1, 'answered once');
  await h.advance(31 * 60_000);
  await h.say(SAM, 'can you check the build?');
  assert.equal(h.started.length, 0, 'after 30 minutes the thread needs an @mention again');
  assert.equal(h.bot.ownsThread('C1', '100.001'), false);
});

test('the task branch follows the profile pattern and the T3 title leaves out attachment notes', async (t) => {
  const f = fixture(t, undefined, { branchPattern: 'TEAM-{DDMM}/{slug}-{stamp}' });
  await f.say(SAM, `<@${BOT}> fix the banner copy`, true, [upload('F1')]);
  assert.match(f.started[0]!.branch, /^TEAM-1811\/fix-the-banner-copy-[a-z0-9]+$/);
  assert.equal(f.started[0]!.title, 'Friday: fix the banner copy');

  const g = fixture(t);
  await g.say(SAM, `<@${BOT}> fix the banner copy`, true);
  assert.match(g.started[0]!.branch, /^friday\/fix-the-banner-copy-[a-z0-9]+$/, 'profiles without a pattern keep the old names');
});

test('runs the worker starts on its own edit one status message instead of posting each update', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> fix the flaky test`, true);
  await f.workerReplies('PR #1 is open. Following CI.');
  assert.equal(f.posts.length, 1);

  await f.backgroundRun('(quiet)');
  assert.equal(f.posts.length, 1, 'a quiet background run posts nothing');

  await f.backgroundRun('Fixed CodeRabbit finding 1 in PR #1.');
  assert.equal(f.posts.length, 2, 'the first update is a new message');
  const status = f.posts[1]!.ts;
  assert.match(f.posts[1]!.blocks, /Updated/);

  await f.backgroundRun('Fixed CodeRabbit finding 2 in PR #1.');
  await f.backgroundRun('PR #1: all checks passed.');
  assert.equal(f.posts.length, 2, 'later updates edit it');
  assert.deepEqual(f.edits.map((edit) => edit.ts), [status, status]);
  assert.match(f.edits.at(-1)!.text, /all checks passed/);

  await f.backgroundRun('CI fails on a migration.\n\nNeeds Alex: approve running the migration.');
  assert.equal(f.posts.length, 3, 'an update that needs someone is always a new message');
  assert.equal(f.ownerPings(), 2, 'the earlier cc and this callout');

  await f.say(SAM, `<@${BOT}> thanks, anything left?`, true); await f.settle();
  await f.workerReplies('Nothing left.');
  await f.backgroundRun('PR #1 merged.');
  assert.equal(f.posts.length, 5, 'after a reply to someone, the next update starts a new status message below it');
  assert.equal(f.edits.length, 2);
});

test('a status message someone deleted is replaced by a new one', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> fix it`, true);
  await f.workerReplies('PR open.');
  await f.backgroundRun('Update 1.');
  f.deleted.push(f.posts.at(-1)!.ts);
  await f.backgroundRun('Update 2.');
  assert.equal(f.posts.length, 3);
  assert.match(f.posts.at(-1)!.text, /Update 2/);
});

test('a long run someone waits on shows one progress line, edited as it goes and removed with the reply', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> why does the leaderboard double count?`, true);
  await f.bot.poll();
  f.workerNotes('Reproducing the double count locally first.');
  await f.bot.poll();
  assert.equal(f.posts.length, 0, 'nothing in the first minutes: the 👀 is enough');

  await f.advance(3 * 60_000);
  await f.bot.poll();
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!.text, /Still on it: Reproducing the double count locally first\./);
  await f.bot.poll();
  assert.equal(f.posts.length, 1, 'the same note is shown once');

  f.workerNotes('Found it: the cron job runs twice.\n\nNow writing the fix.');
  await f.bot.poll();
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.edits.map((edit) => edit.text), ['⏳ Still on it: Found it: the cron job runs twice.']);

  await f.workerReplies('The cron job ran twice. PR #2 fixes it.');
  assert.deepEqual(f.deleted, [f.posts[0]!.ts], 'the progress line goes');
  assert.equal(f.posts.length, 2);
  assert.match(f.posts[1]!.text, /PR #2 fixes it/);
  assert.equal(f.eyes.size, 0);
});

test('no progress line for a background run or for a turn nobody @mentioned the bot in', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> fix it`, true);
  await f.workerReplies('PR open.');

  await f.say(SAM, 'nice, the team will look tomorrow'); await f.settle();
  await f.bot.poll();
  f.workerNotes('Reading the new message.');
  await f.advance(10 * 60_000);
  await f.bot.poll();
  assert.equal(f.posts.length, 1, 'nobody is waiting on an un-mentioned turn');
  await f.workerReplies('(quiet)');
});

test('[REPLY-005] a failure in a channel shows nobody the raw error: teammates get a plain sentence, the owner a pointer to Jobs', async (t) => {
  const f = fixture(t, async () => { throw new Error('t3 thread start exited 1: /Users/you/.t3 something broke\nstack…'); }, { allowErrors: true });
  await f.say(SAM, `<@${BOT}> look at this`, true, [upload('F1')]);
  assert.doesNotMatch(f.posts[0]!.text, /exited|\/Users/);
  assert.match(f.posts[0]!.text, /couldn't pick this up. <@UOWNER> will take a look/);

  // The owner asked, but the channel's other members see the thread too: the detail stays in the log and the app.
  await f.say(OWNER, `<@${BOT}> look at this`, true, [upload('F2')]);
  assert.doesNotMatch(f.posts[1]!.text, /exited|\/Users|stack/);
  assert.match(f.posts[1]!.text, /details are in Serra's Jobs and log/);
  assert.ok(f.recordedEvents.some((event) => event.name === 'failure' && /something broke/.test(String(event.fields.error))), 'the app gets the detail');
});

test('a long reply to someone is never mistaken for a background update when its start is out of reach', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> refactor the scorer`, true);
  await f.workerReplies('Started.');
  await f.say(SAM, `<@${BOT}> and add tests`, true); await f.settle();
  for (let note = 0; note < 45; note++) f.workerNotes(`note ${note}`);
  await f.workerReplies('Tests added.');
  assert.equal(f.posts.length, 2);
  assert.equal(f.edits.length, 0);
  assert.match(f.posts[1]!.text, /Tests added/);
});

test('a background run that wrote nothing leaves the status message alone', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> fix it`, true);
  await f.workerReplies('PR open.');
  await f.backgroundRun('Checks running.');
  const before = { posts: f.posts.length, edits: f.edits.length };
  await f.backgroundRunWithoutReply();
  assert.deepEqual({ posts: f.posts.length, edits: f.edits.length }, before);
});

test('a reply to someone is posted even when the worker starts its own run before the bot sees it finish', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> open a PR for the copy fix`, true);
  await f.workerReplies('PR #3 is open.');
  await f.say(SAM, `<@${BOT}> is CI green?`, true); await f.settle();
  await f.workerRepliesThenStartsRun('Not yet, two checks are still running.');
  assert.equal(f.posts.length, 2, 'the answer is posted while the next run is going');
  assert.match(f.posts[1]!.text, /two checks are still running/);
  assert.equal(f.eyes.size, 0);
  await f.workerReplies('CI is green on PR #3.');
  assert.equal(f.posts.length, 3, 'the worker\'s own run then starts a status message');
  assert.match(f.posts[2]!.blocks, /Updated/);
});

test('a progress line from a finished run goes when the worker starts its own next run', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate the outage`, true);
  await f.bot.poll();
  f.workerNotes('Reading the logs.');
  await f.advance(4 * 60_000);
  await f.bot.poll();
  assert.equal(f.posts.length, 1);
  await f.workerRepliesThenStartsRun('Root cause: an expired cert.');
  assert.deepEqual(f.deleted, [f.posts[0]!.ts]);
  assert.match(f.posts[1]!.text, /expired cert/);
});

const alertTrigger: MessageTrigger = { channel: 'C1', botId: 'BALERTS', instructions: 'Investigate feature errors and summarize evidence.' };
const alertEvent = { channel: 'C1', bot_id: 'BALERTS', subtype: 'bot_message', ts: '100.001', text: '*Critical:* feature errors',
  attachments: [{ text: '11 errors in 15 minutes', fields: [{ title: 'Threshold', value: 'Static' }] }] };

test('configured alerts use the branch pattern and investigate even when their text resembles a human ping', async (t) => {
  const f = fixture(t, undefined, { messageTriggers: [alertTrigger], branchPattern: 'TEAM-{DDMM}/{slug}-{stamp}' });
  await f.ingest({ ...alertEvent, text: 'are you there?', attachments: [] });
  assert.equal(f.started.length, 1);
  assert.match(f.started[0]!.branch, /^TEAM-1811\/are-you-there-[a-z0-9]+$/);
  assert.equal(f.started[0]!.title, 'Friday: are you there?');
  assert.equal(f.posts.length, 0, 'the alert starts an investigation instead of receiving the human ping response');
  assert.equal(f.eyes.size, 1);
  await f.workerReplies('This is a test alert. No customer impact was established.');
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.thread_ts, alertEvent.ts);
  assert.equal(f.eyes.size, 0);
});

test('a configured alert gets eyes, a read-only investigation, and a reply in its original thread', async (t) => {
  const f = fixture(t, undefined, { messageTriggers: [alertTrigger] });
  await f.ingest(alertEvent);
  assert.equal(f.started.length, 1);
  assert.deepEqual([...f.eyes], ['100.001']);
  assert.equal(f.posts.length, 0);
  assert.match(f.brief(), /Automated alert from bot BALERTS asked/);
  assert.match(f.brief(), /11 errors in 15 minutes/);
  assert.match(f.brief(), /Threshold: Static/);
  const trusted = f.brief().slice(f.brief().indexOf('## Automatic alert investigation'));
  assert.match(trusted, /owner-configured message trigger/);
  assert.match(trusted, /not an authorized person's request to take action/);
  assert.match(trusted, /read-only evidence gathering/);
  assert.match(trusted, /untrusted alert data/);
  assert.match(trusted, /Do not modify code, commit, push, open a PR/);
  assert.match(trusted, /Investigate feature errors and summarize evidence/);
  assert.equal(f.config.allowed.has('BALERTS'), false);
  assert.equal(f.downloads.length, 0);

  await f.workerReplies('Impact: checkout errors. Likely cause: missing configuration. Next: validate release settings.');
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.channel, 'C1');
  assert.equal(f.posts[0]!.thread_ts, '100.001');
  assert.match(f.posts[0]!.text, /Impact: checkout errors/);
  assert.equal(f.eyes.size, 0);
});

test('concurrent alert deliveries, later retries and a daemon restart start only one investigation', async (t) => {
  const f = fixture(t, undefined, { messageTriggers: [alertTrigger] });
  await Promise.all([f.ingest(alertEvent), f.ingest(alertEvent), f.ingest(alertEvent)]);
  await f.ingest(alertEvent);
  assert.equal(f.started.length, 1);
  assert.equal(f.sends.length, 0);
  await f.workerReplies('Investigated.');
  const restarted = f.restart();
  const duplicate = incomingMessage(alertEvent, 'message', BOT, restarted.ownsThread, { messageTriggers: [alertTrigger] })!;
  await restarted.handle(duplicate);
  assert.equal(f.started.length, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.eyes.size, 0, 'a completed alert does not regain eyes on retry');
  assert.equal(f.posts.length, 1);
});

test('machine triggers stay opt-in, are revalidated at the handler, and never download incoming files', async (t) => {
  const f = fixture(t);
  await f.ingest(alertEvent);
  assert.equal(f.started.length, 0);
  const machine = { channel: 'C1', threadTs: '100.001', messageTs: '100.001', user: 'BALERTS', botId: 'BALERTS', text: 'Alert', direct: true };
  await f.bot.handle(machine);
  assert.equal(f.posts.length, 0, 'unconfigured machines are ignored, not refused');
  const g = fixture(t, undefined, { messageTriggers: [alertTrigger] });
  for (const change of [{ botId: 'BOTHER' }, { channel: 'COTHER' }, { threadTs: '99.001' }, { user: OWNER }]) await g.bot.handle({ ...machine, ...change });
  assert.equal(g.started.length, 0);
  assert.equal(g.posts.length, 0);
  await g.bot.handle({ ...machine, files: [upload('FALERT')] });
  assert.equal(g.started.length, 1);
  assert.equal(g.downloads.length, 0);
});

test('authorized people can follow an investigation while outsiders cannot start a turn', async (t) => {
  const f = fixture(t, undefined, { messageTriggers: [alertTrigger] });
  await f.ingest(alertEvent);
  await f.workerReplies('Investigation complete.');
  await f.say('USTRANGER', `<@${BOT}> change production`, true);
  assert.match(f.posts.at(-1)!.text, /only take requests/);
  assert.equal(f.sends.length, 0);
  await f.say(SAM, `<@${BOT}> explain the affected feature`, true);
  await f.settle();
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0]!, /Sam wrote:\n> explain the affected feature/);
  await f.workerReplies('The affected feature is checkout.');
  assert.equal(f.eyes.size, 0);
  assert.equal(f.posts.at(-1)!.thread_ts, alertEvent.ts);
});

test('failed automatic startup clears eyes, reports in the alert thread and permits a later retry', async (t) => {
  let unavailable = true;
  const f = fixture(t, undefined, { messageTriggers: [alertTrigger], failStart: () => unavailable });
  await f.ingest(alertEvent);
  assert.equal(f.started.length, 1);
  assert.equal(f.eyes.size, 0);
  assert.equal(f.bot.ownsThread('C1', alertEvent.ts), false);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0]!, /Worker startup unavailable/);
  assert.equal(f.posts[0]!.channel, 'C1');
  assert.equal(f.posts[0]!.thread_ts, alertEvent.ts);
  assert.match(f.posts[0]!.text, /couldn't pick this up/);
  assert.doesNotMatch(f.posts[0]!.text, /Worker startup unavailable/);

  unavailable = false;
  await f.ingest(alertEvent);
  assert.equal(f.started.length, 2);
  assert.equal(f.bot.ownsThread('C1', alertEvent.ts), true);
  assert.equal(f.eyes.size, 1);
  await f.workerReplies('Recovered and investigated.');
  assert.equal(f.eyes.size, 0);
  assert.match(f.posts.at(-1)!.text, /Recovered and investigated/);
});

test('a human trigger starts one read-only investigation without granting followup permission', async (t) => {
  const f = fixture(t, undefined, { messageTriggers: [{ channel: 'C1', userId: 'USTRANGER', instructions: 'Investigate human reports.' }] });
  const event = { channel: 'C1', user: 'USTRANGER', ts: '100.001', text: 'are you there?', files: [upload('FHUMAN')] };
  await Promise.all([f.ingest(event), f.ingest(event)]);
  assert.equal(f.started.length, 1);
  assert.equal(f.posts.length, 0, 'automatic messages bypass the conversational ping response');
  assert.equal(f.eyes.size, 1);
  assert.equal(f.downloads.length, 0);
  assert.match(f.brief(), /Automatically triggered message from user USTRANGER asked/);
  assert.match(f.brief(), /Investigate human reports/);
  assert.match(f.brief(), /Do not modify code, commit, push, open a PR/);
  assert.equal(f.config.allowed.has('USTRANGER'), false);
  await f.workerReplies('Findings from the human report.');
  assert.equal(f.posts[0]!.thread_ts, event.ts);
  assert.equal(f.eyes.size, 0);
  const restarted = f.restart();
  const duplicate = incomingMessage(event, 'message', BOT, restarted.ownsThread, { messageTriggers: f.config.messageTriggers })!;
  await restarted.handle(duplicate);
  assert.equal(f.started.length, 1);
  assert.equal(f.sends.length, 0);
  await f.say('USTRANGER', `<@${BOT}> now change production`, true);
  assert.match(f.posts.at(-1)!.text, /only take requests/);
  assert.equal(f.sends.length, 0);
  await f.say(SAM, `<@${BOT}> explain the findings`, true);
  await f.settle();
  assert.equal(f.sends.length, 1);
});

test('channel-wide triggers handle people and bots with sender-specific instruction precedence', async (t) => {
  const wildcard = { channel: 'C1', botId: '', userId: '', instructions: 'General channel investigation.' };
  const rules = [wildcard, { ...alertTrigger, instructions: 'Specific bot investigation.' },
    { channel: 'C1', userId: SAM, instructions: 'Specific human investigation.' }];
  for (const [event, expected, rejected] of [
    [{ ...alertEvent }, 'Specific bot investigation.', 'General channel investigation.'],
    [{ ...alertEvent, bot_id: 'BOTHER' }, 'General channel investigation.', 'Specific bot investigation.'],
    [{ channel: 'C1', user: SAM, ts: '100.001', text: 'Please investigate' }, 'Specific human investigation.', 'General channel investigation.'],
    [{ channel: 'C1', user: 'USTRANGER', ts: '100.001', text: 'Please investigate' }, 'General channel investigation.', 'Specific human investigation.'],
  ] as const) {
    const f = fixture(t, undefined, { messageTriggers: rules });
    await f.ingest(event);
    assert.equal(f.started.length, 1);
    assert.ok(f.brief().includes(expected));
    assert.ok(!f.brief().includes(rejected));
    assert.doesNotMatch(f.brief(), /bot undefined/);
  }
});

test('human automatic markers are revalidated, and explicit mentions retain ordinary permissions', async (t) => {
  const f = fixture(t, undefined, { messageTriggers: [{ channel: 'C1', userId: 'USTRANGER', instructions: 'Investigate.' }] });
  const automatic: IncomingMessage = { channel: 'C1', user: 'USTRANGER', threadTs: '100.001', messageTs: '100.001', text: 'Report', direct: true, automaticTrigger: true };
  for (const change of [{ user: 'UOTHER' }, { channel: 'COTHER' }, { threadTs: '99' }, { user: BOT }]) {
    await f.bot.handle({ ...automatic, ...change });
  }
  assert.equal(f.started.length, 0);
  assert.equal(f.posts.length, 0);
  await f.bot.handle({ ...automatic, automaticTrigger: undefined, text: `<@${BOT}> change production` });
  assert.equal(f.started.length, 0);
  assert.match(f.posts[0]!.text, /only take requests/);
  const g = fixture(t, undefined, { messageTriggers: [{ channel: 'C1', instructions: 'Only investigate.' }] });
  const mention = incomingMessage({ channel: 'C1', user: SAM, ts: '100.001', text: `<@${BOT}> implement this change` }, 'app_mention', BOT,
    g.bot.ownsThread, { messageTriggers: g.config.messageTriggers })!;
  await g.bot.handle(mention);
  assert.equal(g.started.length, 1);
  assert.doesNotMatch(g.brief(), /Automatic alert investigation/);
  assert.match(g.brief(), /Sam asked/);
});


test('native loading refreshes without duplicate poll calls and clears for replies and quiet turns', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate the failing build`, true);
  assert.deepEqual(f.statuses, [{ channel_id: 'C1', thread_ts: '100.001', status: 'is looking into it…', loading_messages: ['Looking into it'] }]);
  await f.bot.poll();
  await f.advance(59_999);
  await f.bot.poll();
  assert.equal(f.statuses.length, 1);
  await f.advance(1);
  await f.bot.poll();
  assert.equal(f.statuses.length, 2, 'refreshes before Slack expires it');
  await f.workerReplies('The build is fixed.');
  assert.equal(f.statuses.at(-1)!.status, '');
  assert.equal(f.loadingVisible(), false);

  await f.say(SAM, `<@${BOT}> anything else?`, true);
  assert.equal(f.loadingVisible(), true);
  await f.settle();
  await f.workerReplies('(quiet)');
  assert.equal(f.statuses.at(-1)!.status, '');
  assert.equal(f.loadingVisible(), false, 'quiet turns explicitly clear the indicator');
});

test('native loading clears while T3 waits for input and resumes afterwards, including after restart', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> fix the build`, true);
  f.waitsInT3(1);
  await f.bot.poll();
  assert.equal(f.loadingVisible(), false);
  const count = f.statuses.length;
  await f.bot.poll();
  assert.equal(f.statuses.length, count, 'waiting polls do not repeat status calls');
  await f.say(SAM, `<@${BOT}> also check lint`, true);
  assert.equal(f.loadingVisible(), false, 'queued messages do not suggest a paused worker is processing');
  const restarted = f.restart();
  f.waitsInT3(0);
  await restarted.poll();
  assert.equal(f.loadingVisible(), true);
  await f.workerReplies('Fixed.');
  await f.settle();
  await f.workerReplies('Lint passes.');
});

test('native loading resumes for queued requests after the preceding reply clears it', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> fix build`, true);
  await f.say(SAM, `<@${BOT}> and lint`, true);
  await f.workerReplies('Build fixed.');
  await f.settle();
  assert.equal(f.loadingVisible(), true);
  assert.equal(f.statuses.at(-1)!.status, 'is looking into it…');
  await f.workerReplies('Lint fixed.');
  assert.equal(f.loadingVisible(), false);
});

test('progress posts restore native loading until the actual reply', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate the outage`, true);
  await f.bot.poll();
  f.workerNotes('Tracing the failing request.');
  await f.advance(3 * 60_000);
  await f.bot.poll();
  assert.equal(f.posts.length, 1);
  assert.equal(f.loadingVisible(), true, 'a progress post must not leave the loading indicator cleared');
  await f.workerReplies('Fixed the failing request.');
  assert.equal(f.loadingVisible(), false);
});

test('loading failures preserve eyes, worker replies, and throttle repeated status attempts', async (t) => {
  const f = fixture(t, undefined, { statusError: () => true });
  await f.say(SAM, `<@${BOT}> fix the build`, true);
  assert.equal(f.eyes.size, 1);
  await f.bot.poll();
  await f.bot.poll();
  assert.equal(f.statuses.length, 1);
  await f.advance(60_000);
  await f.bot.poll();
  assert.equal(f.statuses.length, 2);
  await f.workerReplies('Build fixed.');
  assert.equal(f.eyes.size, 0);
  assert.equal(f.posts.at(-1)!.text, 'Build fixed.');
  assert.equal(f.statuses.at(-1)!.status, '');
});

test('loading stays absent for unauthorized messages, pings, chatter and worker background runs', async (t) => {
  const f = fixture(t);
  await f.say('USTRANGER', `<@${BOT}> run this`, true);
  await f.say(SAM, `<@${BOT}> are you there?`, true);
  assert.equal(f.statuses.length, 0);
  await f.say(SAM, `<@${BOT}> fix the build`, true);
  await f.workerReplies('PR is open.');
  const count = f.statuses.length;
  await f.say(OWNER, `<@${SAM}> have you seen it?`);
  await f.say(SAM, 'yes, thanks');
  await f.settle();
  await f.bot.poll();
  await f.workerReplies('(quiet)');
  await f.backgroundRun('Checks pass.');
  assert.equal(f.statuses.length, count);
});

test('startup and incoming attachment failures explicitly clear native loading', async (t) => {
  const f = fixture(t, undefined, { failStart: () => true });
  await f.say(SAM, `<@${BOT}> fix the build`, true);
  assert.deepEqual(f.statuses.map((body) => body.status), ['is looking into it…', '']);
  assert.equal(f.loadingVisible(), false);
  const g = fixture(t, async () => { throw new Error('download failed'); }, { allowErrors: true });
  await g.say(SAM, `<@${BOT}> inspect this`, true, [upload('F1')]);
  assert.equal(g.statuses.at(-1)!.status, '');
  assert.equal(g.loadingVisible(), false);
});

const nativeQuestion = (id = 'request-1'): T3QuestionRequest => ({ requestId: id, questions: [{
  id: 'scope', header: 'Scope', question: 'Which area should I investigate?',
  options: [{ label: 'Frontend', description: 'Browser behavior', value: 'front' }, { label: 'Backend', description: 'API behavior', value: 'back' }],
}] });
const savedQuestion = (f: ReturnType<typeof fixture>) => createStore(f.config.statePath).allJobs()[0]![1].question!;
const choose = async (f: ReturnType<typeof fixture>, index: number, user = SAM, bot = f.bot): Promise<void> => {
  const state = savedQuestion(f);
  const action = questionInteraction({ type: 'block_actions', channel: { id: 'C1' }, user: { id: user }, message: { ts: state.ts },
    actions: [{ action_id: `serra_question_choice_${index}`, block_id: `sq:${state.nonce}:choices`, value: state.nonce }] });
  assert.ok(action);
  await bot.handleQuestionAction(action);
};

test('a native question is posted once, a choice resumes T3, and duplicate clicks do not answer twice', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate the bug`, true);
  f.questionRequests.push(nativeQuestion()); f.waitsInT3(1);
  await f.bot.poll(); await f.bot.poll();
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!.blocks, /serra_question_choice_0/);
  assert.match(f.posts[0]!.blocks, /<@USAM>/, 'ask the original requester');
  assert.equal(f.loadingVisible(), false);
  const state = savedQuestion(f);
  const action = { channel: 'C1', messageTs: state.ts, user: SAM, nonce: state.nonce, actionId: 'serra_question_choice_1', indices: [1] };
  await Promise.all([f.bot.handleQuestionAction(action), f.bot.handleQuestionAction(action)]);
  assert.deepEqual(f.answered, [{ threadId: 't3-1', requestId: 'request-1', answers: { scope: 'back' } }]);
  assert.equal(f.loadingVisible(), true);
  assert.equal(savedQuestion(f), undefined);
  assert.match(f.edits.at(-1)!.text, /Answer sent/);
  assert.doesNotMatch(f.edits.at(-1)!.blocks, /serra_question_choice/);
  await f.workerReplies('The API handler is fixed.');
  assert.equal(f.posts.at(-1)!.text, 'The API handler is fixed.');
  assert.equal(f.loadingVisible(), false);
});

test('typed replies answer native questions directly instead of queueing behind the paused run', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  f.questionRequests.push(nativeQuestion()); f.waitsInT3(1); await f.bot.poll();
  await f.say(SAM, 'Start with the upload endpoint');
  assert.deepEqual(f.answered[0]!.answers, { scope: 'Start with the upload endpoint' });
  assert.equal(f.sends.length, 0);
  await f.workerReplies('Found it.');
  assert.equal(f.posts.at(-1)!.text, 'Found it.');
});

test('only the owner or original requester can answer; forged and stale choices are rejected', async (t) => {
  const f = fixture(t);
  await f.say(OWNER, `<@${BOT}> investigate`, true);
  f.questionRequests.push(nativeQuestion()); f.waitsInT3(1); await f.bot.poll();
  await choose(f, 0, SAM);
  await choose(f, 0, 'USTRANGER');
  assert.equal(f.answered.length, 0);
  const state = savedQuestion(f);
  await f.bot.handleQuestionAction({ channel: 'COTHER', messageTs: state.ts, user: OWNER, nonce: state.nonce, actionId: 'serra_question_choice_0', indices: [0] });
  await f.bot.handleQuestionAction({ channel: 'C1', messageTs: state.ts, user: OWNER, nonce: 'forged', actionId: 'serra_question_choice_0', indices: [0] });
  assert.equal(f.answered.length, 0);
  await choose(f, 99, OWNER);
  assert.equal(f.answered.length, 0);
  await choose(f, 0, OWNER);
  assert.equal(f.answered.length, 1);
});

test('multiple questions accumulate answers on one card and survive a daemon restart', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  const request = nativeQuestion();
  request.questions.push({ id: 'details', header: 'Details', question: 'Anything else?', options: [] });
  f.questionRequests.push(request); f.waitsInT3(1); await f.bot.poll();
  const first = savedQuestion(f);
  await choose(f, 0);
  assert.equal(f.answered.length, 0);
  const next = savedQuestion(f);
  assert.equal(next.ts, first.ts);
  assert.notEqual(next.nonce, first.nonce);
  assert.equal(next.index, 1);
  assert.deepEqual(next.answers, { scope: 'front' });
  const restarted = f.restart();
  await restarted.handle({ channel: 'C1', threadTs: '100.001', messageTs: '101.0', user: OWNER, text: 'Please also inspect mobile', direct: true });
  assert.deepEqual(f.answered[0]!.answers, { scope: 'front', details: 'Please also inspect mobile' });
  assert.equal(savedQuestion(f), undefined);
});

test('multi-select requires Submit and sends the saved option values together', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  const request = nativeQuestion(); request.questions[0]!.multiSelect = true;
  f.questionRequests.push(request); f.waitsInT3(1); await f.bot.poll();
  const state = savedQuestion(f);
  await f.bot.handleQuestionAction({ channel: 'C1', messageTs: state.ts, user: SAM, nonce: state.nonce, actionId: 'serra_question_multi', indices: [0, 1] });
  assert.equal(f.answered.length, 0);
  await f.bot.handleQuestionAction({ channel: 'C1', messageTs: state.ts, user: SAM, nonce: state.nonce, actionId: 'serra_question_submit', indices: [0, 1] });
  assert.deepEqual(f.answered[0]!.answers, { scope: ['front', 'back'] });
});

test('questions answered externally expire; changed forms cannot consume an old choice', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  f.questionRequests.push(nativeQuestion()); f.waitsInT3(1); await f.bot.poll();
  f.questionRequests[0]!.questions[0]!.options.reverse();
  await choose(f, 0);
  assert.equal(f.answered.length, 0);
  assert.equal(savedQuestion(f), undefined);
  await f.bot.poll();
  assert.ok(savedQuestion(f));
  f.questionRequests.splice(0); f.waitsInT3(0); await f.bot.poll();
  assert.equal(savedQuestion(f), undefined);
  assert.match(f.edits.at(-1)!.text, /no longer waiting/);
});

test('an answer transport failure keeps the question usable for retry', async (t) => {
  let failing = true;
  const f = fixture(t, undefined, { failAnswer: () => failing });
  await f.say(SAM, `<@${BOT}> investigate`, true);
  f.questionRequests.push(nativeQuestion()); f.waitsInT3(1); await f.bot.poll();
  await choose(f, 1);
  assert.ok(savedQuestion(f)); assert.equal(f.answered.length, 0);
  assert.match(f.posts.at(-1)!.text, /Please try again/);
  failing = false; await choose(f, 1);
  assert.equal(f.answered.length, 1);
});

test('oversized forms, approvals and secrets retain the T3-only fallback', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  const request = nativeQuestion(); request.questions[0]!.question = 'x'.repeat(2_501);
  f.questionRequests.push(request); f.waitsInT3(1); await f.bot.poll();
  assert.equal(savedQuestion(f), undefined);
  assert.match(f.posts[0]!.text, /answer it there/);
  assert.equal(f.answered.length, 0);
  await f.bot.poll();
  const fallback = f.recordedEvents.filter((event) => event.name === 'question_fallback');
  assert.equal(fallback.length, 1, 'record the reason once per fallback notice');
  assert.equal(fallback[0]!.fields.maxQuestionChars, 2_501);
  assert.equal(fallback[0]!.fields.reason, 'display_limits');
  assert.ok(!JSON.stringify(fallback).includes('x'.repeat(100)), 'diagnostics record sizes, never question content');
});

test('an async question is shown even after its originating run stops', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  f.questionRequests.push(nativeQuestion()); f.waitsInT3(1);
  await f.workerReplies('I have a question.');
  assert.ok(savedQuestion(f), 'pending questions are read even with no active run');
  assert.match(f.posts[0]!.blocks, /serra_question_choice/);
  await choose(f, 0);
  assert.equal(f.answered.length, 1);
});

test('retried thread messages cannot answer the next question or start a duplicate follow-up', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  const request = nativeQuestion();
  request.questions.push({ id: 'details', header: 'Details', question: 'Anything else?', options: [] });
  f.questionRequests.push(request); f.waitsInT3(1); await f.bot.poll();
  const message: IncomingMessage = { channel: 'C1', threadTs: '100.001', messageTs: '101.0', user: SAM, text: 'Backend', direct: true };
  await f.bot.handle(message); await f.bot.handle(message);
  assert.equal(f.answered.length, 0);
  assert.equal(savedQuestion(f).index, 1);
  await f.bot.handle({ ...message, messageTs: '102.0', text: 'Mobile too' });
  const restarted = f.restart();
  await restarted.handle(message);
  await restarted.handle({ ...message, messageTs: '102.0', text: 'Mobile too' });
  assert.equal(f.answered.length, 1);
  assert.equal(f.sends.length, 0);
});

test('a deleted question card is replaced when a typed reply advances the form', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  const request = nativeQuestion(); request.questions.push({ id: 'details', header: 'Details', question: 'Anything else?', options: [] });
  f.questionRequests.push(request); f.waitsInT3(1); await f.bot.poll();
  const first = savedQuestion(f); f.deleted.push(first.ts);
  await f.say(SAM, 'Frontend');
  const next = savedQuestion(f);
  assert.notEqual(next.ts, first.ts);
  assert.equal(next.index, 1);
  assert.equal(f.posts.at(-1)!.text, 'Anything else?');
  await f.say(SAM, 'Mobile too');
  assert.deepEqual(f.answered[0]!.answers, { scope: 'front', details: 'Mobile too' });
});

test('long native option labels render in Slack and submit their complete original value', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> investigate`, true);
  const request = nativeQuestion();
  const labels = ['A'.repeat(130), 'B'.repeat(115), 'C'.repeat(88)];
  request.questions[0]!.options = labels.map((label) => ({ label, description: label }));
  f.questionRequests.push(request); f.waitsInT3(1); await f.bot.poll();
  assert.ok(savedQuestion(f), 'a long label must not make the entire question fall back to T3');
  for (const label of labels) assert.ok(f.posts[0]!.blocks.includes(label), 'full choice text remains visible');
  assert.doesNotMatch(f.posts[0]!.text, /answer it there/);
  await choose(f, 1);
  assert.deepEqual(f.answered[0]!.answers, { scope: labels[1] });
  assert.equal(f.recordedEvents.filter((event) => event.name === 'question_fallback').length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Hot reload of profile.json (people and message triggers)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Watch the fixture's profile like the daemon does. `reloaded()` resolves after the next reload the watcher runs.
 *
 * Resolves once the watcher is live. On macOS `fs.watch` returns before its FSEvents stream has started, so a write
 * made straight after it can go unreported, and these tests then timed out now and again under load. Rewriting
 * profile.json unchanged until a reload comes through proves the stream runs; reloading unchanged contents records
 * nothing, so a late extra reload from this can't change what a test sees.
 */
const watched = async (t: TestContext, f: ReturnType<typeof fixture>) => {
  let waiting: (() => void)[] = [];
  const watcher = watchProfile(f.config.profileDir, () => {
    f.bot.reloadProfile();
    const done = waiting; waiting = []; for (const resolve of done) resolve();
  }, { debounceMs: 20 });
  t.after(watcher.close);
  const reloaded = (timeoutMs = 3000): Promise<void> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('profile.json change was not seen')), timeoutMs);
    waiting.push(() => { clearTimeout(timeout); resolve(); });
  });
  const path = join(f.config.profileDir, 'profile.json');
  const contents = readFileSync(path);
  for (let attempt = 1; ; attempt++) {
    const live = reloaded(200);
    writeFileSync(path, contents);
    try { await live; break; } catch (error) { if (attempt === 25) throw error; }
  }
  return { reloaded };
};

const reloads = (f: ReturnType<typeof fixture>, name: string) => f.recordedEvents.filter((event) => event.name === name);

test('a person added to profile.json is accepted on their next message, with no restart', async (t) => {
  const f = fixture(t);
  const w = await watched(t, f);
  await f.say('UNEWPERSON', `<@${BOT}> rename the button`, true);
  assert.match(f.posts[0]!.text, /only take requests/);
  assert.equal(f.started.length, 0);

  const seen = w.reloaded();
  const change = addAllowedUser(f.config.profileDir, 'UNEWPERSON');
  assert.equal(change.appliesWhen, 'now');
  await seen;

  const thread = { channel: 'C1', threadTs: '300.001', messageTs: '300.001', user: 'UNEWPERSON', text: `<@${BOT}> rename the button`, direct: true };
  await f.bot.handle(thread);
  assert.equal(f.started.length, 1, 'the new person starts a job');
  assert.equal(f.posts.length, 1, 'and is not refused again');
  assert.deepEqual(reloads(f, 'profile_reloaded').map((event) => event.fields), [{ applied: ['allowedUsers'], restartNeeded: [] }]);
  assert.ok(f.config.profile.allowedUsers.includes('UNEWPERSON'));
  assert.ok(f.config.allowed.has(OWNER), 'the owner stays allowed');
});

test('an invalid profile.json is logged once and the running people and triggers stay in force', async (t) => {
  const f = fixture(t, undefined, { messageTriggers: [alertTrigger] });
  const w = await watched(t, f);
  const path = join(f.config.profileDir, 'profile.json');
  const good = readFileSync(path, 'utf8');
  const broken = good.replace(`"${SAM}"`, '"not-a-member-id"');

  let seen = w.reloaded();
  writeFileSync(path, broken);
  await seen;
  // More change events for the same broken contents add nothing.
  seen = w.reloaded();
  writeFileSync(path, broken);
  await seen;
  f.bot.reloadProfile();
  assert.equal(reloads(f, 'profile_invalid').length, 1);
  assert.match(String(reloads(f, 'profile_invalid')[0]!.fields.error), /Invalid allowed Slack member ID/);
  assert.equal(reloads(f, 'profile_reloaded').length, 0);

  await f.say(SAM, `<@${BOT}> rename the button`, true);
  assert.equal(f.started.length, 1, 'people allowed before the bad edit still are');
  assert.equal(f.config.messageTriggers.length, 1);

  // Truncated JSON, as an editor might leave it for a moment, is just as harmless.
  seen = w.reloaded();
  writeFileSync(path, good.slice(0, 40));
  await seen;
  assert.equal(reloads(f, 'profile_invalid').length, 2);
  assert.ok(f.config.allowed.has(SAM));

  seen = w.reloaded();
  writeFileSync(path, good);
  await seen;
  assert.equal(reloads(f, 'profile_reloaded').length, 1, 'fixing the file is reported');
  assert.equal(reloads(f, 'profile_invalid').length, 2);
});

test('message triggers added to profile.json apply to the next alert', async (t) => {
  const f = fixture(t);
  const w = await watched(t, f);
  await f.ingest(alertEvent);
  assert.equal(f.started.length, 0, 'unconfigured alerts are ignored');

  const seen = w.reloaded();
  updateProfileSection(f.config.profileDir, 'messageTriggers', [alertTrigger]);
  await seen;
  await f.ingest({ ...alertEvent, ts: '100.002' });
  assert.equal(f.started.length, 1);
  assert.match(f.brief(), /Investigate feature errors/);

  const removed = w.reloaded();
  updateProfileSection(f.config.profileDir, 'messageTriggers', undefined);
  await removed;
  await f.ingest({ ...alertEvent, ts: '100.003' });
  assert.equal(f.started.length, 1, 'a removed trigger stops at once');
  assert.deepEqual(f.config.messageTriggers, []);
});

test('sections that apply after a restart are reported, not applied', async (t) => {
  const f = fixture(t);
  const w = await watched(t, f);
  const seen = w.reloaded();
  updateProfileSection(f.config.profileDir, 'worker', { model: 'fixture-model' });
  await seen;
  assert.equal(f.config.workerModel, undefined);
  assert.equal(f.config.profile.worker, undefined);
  assert.deepEqual(reloads(f, 'profile_reloaded').map((event) => event.fields), [{ applied: [], restartNeeded: ['worker'] }]);
  f.bot.reloadProfile();
  assert.equal(reloads(f, 'profile_reloaded').length, 1, 'the same pending restart is reported once');
});

test('[PROFILE-002] a person added in Settings can ask at once, while a new branch pattern waits for the restart Settings says it needs', async (t) => {
  const f = fixture(t);
  assert.equal(PROFILE_SETTINGS.allowedUsers.appliesWhen, 'now');
  assert.equal(PROFILE_SETTINGS.branchPattern.appliesWhen, 'after restart');
  addAllowedUser(f.config.profileDir, 'UNEW');
  updateProfileSection(f.config.profileDir, 'branchPattern', 'TEAM-{DDMM}/{slug}-{stamp}');
  f.bot.reloadProfile();
  assert.deepEqual(reloads(f, 'profile_reloaded').map((event) => event.fields), [{ applied: ['allowedUsers'], restartNeeded: ['branchPattern'] }]);

  await f.say('UNEW', `<@${BOT}> rename the pricing page`, true);
  assert.equal(f.started.length, 1, 'the person added a moment ago starts a job, with no restart');
  assert.doesNotMatch(f.started[0]!.branch, /^TEAM-/, 'the branch still follows the pattern the bot started with');
});

// SERRA-54: jobs shown as running in Serra that aren't running in T3.
const savedJob = (f: ReturnType<typeof fixture>) => createStore(f.config.statePath).allJobs()[0]!;
const listedGroup = async (f: ReturnType<typeof fixture>): Promise<string | undefined> =>
  (await listJobs(f.config.profileDir, { doneTodayOnly: false })).jobs[0]?.group;

test('a run that starts and ends between two polls is posted and leaves the job done, not running', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> how does scoring work?`, true);
  await f.bot.poll();
  assert.equal(savedJob(f)[1].runSeen?.runId, 'run-1', 'the first run was seen going');
  await f.workerReplies('Scoring works like this.');

  // The follow-up's run starts and ends before the bot polls again: it is never seen going.
  await f.say(SAM, `<@${BOT}> and for teams?`, true);
  await f.settle();
  await f.workerReplies('Teams score the same way.');

  const [, job] = savedJob(f);
  assert.equal(job.lastPostedRunId, 'run-2');
  assert.equal(job.runSeen, undefined, 'the run seen earlier is forgotten once its successor is posted');
  assert.equal(await listedGroup(f), 'done');
});

test('a run still going keeps its seen run when an earlier reply is posted', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> how does scoring work?`, true);
  await f.workerRepliesThenStartsRun('Scoring works like this.');
  await f.bot.poll();
  const [, job] = savedJob(f);
  assert.equal(job.lastPostedRunId, 'run-1');
  assert.equal(job.runSeen?.runId, 'run-2', 'the run going now is still being timed');
  assert.equal(await listedGroup(f), 'running');
});

test('at start, a stale migrated job that T3 is not running is cleared: 👀, loading, progress line and seen run', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> how does scoring work?`, true);
  await f.workerReplies('Scoring works like this.');
  // As an older install left it: the legacy single 👀, loading, a progress line, a run seen that was never posted,
  // and so long ago that the poll no longer looks at it.
  const [key, job] = savedJob(f);
  const longAgo = new Date(Date.parse('2026-11-18T10:00:00Z') - 60 * 24 * 60 * 60_000).toISOString();
  createStore(f.config.statePath).putJob(key, {
    ...job, pendingReactionTs: '100.050', pendingReactions: undefined, loadingRequested: true, watching: false,
    progress: { ts: '200.900', runId: 'run-0', text: '⏳ Still on it' }, runSeen: { runId: 'run-0', at: longAgo },
    createdAt: longAgo, lastActivityAt: longAgo,
  });
  f.eyes.add('100.050');
  const bot = f.restart();
  await bot.poll();
  assert.equal(await listedGroup(f), 'running', 'the poll alone never gets to it');

  await bot.reconcile();
  const [, after] = savedJob(f);
  assert.equal(after.loadingRequested, false);
  assert.equal(after.pendingReactionTs, null);
  assert.deepEqual(after.pendingReactions, []);
  assert.equal(after.progress, undefined);
  assert.equal(after.runSeen, undefined);
  assert.equal(after.lastPostedRunId, 'run-1', 'what was posted is kept');
  assert.ok(!f.eyes.has('100.050'), 'the 👀 left in Slack is removed');
  assert.ok(f.deleted.includes('200.900'), 'the progress line left in Slack is removed');
  assert.ok(f.recordedEvents.some((event) => event.name === 'job_reconciled' && event.fields.key === key));
  assert.equal(await listedGroup(f), 'done');
});

test('at start, a job T3 is still running, or whose finished run is unposted, is followed instead of cleared', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> how does scoring work?`, true);
  const [key, job] = savedJob(f);
  // Saved as idle by a bot that stopped mid-run.
  createStore(f.config.statePath).putJob(key, { ...job, watching: false });
  const bot = f.restart();
  await bot.reconcile();
  assert.equal(savedJob(f)[1].watching, true, 'the run going in T3 is followed again');
  assert.equal(savedJob(f)[1].loadingRequested, true, 'and keeps its loading status');
  assert.equal(f.eyes.size, 1);

  // It finished while nobody watched: it is followed, and the next poll posts it, which clears the rest.
  f.workerRepliesUnwatched('Scoring works like this.');
  createStore(f.config.statePath).putJob(key, { ...savedJob(f)[1], watching: false });
  const again = f.restart();
  await again.reconcile();
  assert.equal(savedJob(f)[1].watching, true);
  assert.equal(savedJob(f)[1].loadingRequested, true, 'its reply is still owed');
  assert.equal(f.posts.length, 0, 'reconciling posts nothing itself');
  await again.poll();
  assert.deepEqual(f.posts.map((post) => post.text), ['Scoring works like this.']);
  assert.equal(f.eyes.size, 0);
  assert.equal(await listedGroup(f), 'done');
});

test('at start, a followed job whose run finished while the bot was stopped is posted, however old the thread', async (t) => {
  const f = fixture(t);
  await f.say(SAM, `<@${BOT}> how does scoring work?`, true);
  f.workerRepliesUnwatched('Scoring works like this.');
  const [key, job] = savedJob(f);
  const longAgo = new Date(Date.parse('2026-11-18T10:00:00Z') - 60 * 24 * 60 * 60_000).toISOString();
  createStore(f.config.statePath).putJob(key, { ...job, createdAt: longAgo, lastActivityAt: longAgo });
  const bot = f.restart();
  await bot.reconcile();
  assert.equal(savedJob(f)[1].watching, true, 'a reply the bot was following is still owed');
  await bot.poll();
  assert.deepEqual(f.posts.map((post) => post.text), ['Scoring works like this.']);
});
