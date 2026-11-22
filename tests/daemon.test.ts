import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, LogLevel } from '@slack/bolt';
import { startDaemon } from '../src/daemon.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { HELD_REQUESTS, holdRequest, pauseIntake, readHeld, resumeIntake } from '../src/intake.ts';
import { fakeClock } from './fakes/clock.ts';
import { startTestDaemon, TestReceiver } from './fakes/daemon.ts';
import { BOT, OWNER, SAM, testProfile } from './fakes/profile.ts';
import { writeMeetingSettings } from '../src/meeting-settings.ts';
import { createFakeSlack } from './fakes/slack.ts';

const mention = (ts: string, text: string): Record<string, unknown> => ({
  type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: `Ev${ts}`, event_time: 1,
  authorizations: [{ team_id: 'THOME', user_id: BOT, is_bot: true }],
  event: { type: 'app_mention', user: SAM, text: `<@${BOT}> ${text}`, ts, channel: 'C1', event_ts: ts, team: 'THOME' },
});

test('[SETUP-002] a repository the service may not read stops the daemon before it touches Slack, with the macOS fix', async (t) => {
  const { config } = testProfile(t);
  const slack = createFakeSlack();
  const receiver = new TestReceiver();
  const app = new App({ token: 'xoxb-test', botId: 'BBOT', botUserId: BOT, receiver, tokenVerificationEnabled: false, logLevel: LogLevel.ERROR });
  let started = false;
  const released: string[] = [];
  await assert.rejects(startDaemon({
    config, app: { event: app.event.bind(app), message: app.message.bind(app), action: app.action.bind(app), stop: app.stop.bind(app),
      start: async () => { started = true; return app.start(); } },
    client: slack.client, logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.INFO, setName() {} },
    knowledge: createKnowledge(config.knowledgeDir), clock: fakeClock(), statusSocket: false, watchProfile: false,
    lock: (path) => () => { released.push(path); },
    checkAccess: async () => { throw new Error(`Can't read the repository ${config.project} (Operation not permitted). Allow "node" in System Settings › Privacy & Security › Files and Folders.`); },
  }), /Files and Folders/);
  assert.deepEqual(slack.calls, [], 'no Slack call, not even auth.test');
  assert.equal(started, false, 'the app never connects');
  assert.equal(existsSync(join(config.profileDir, 'ready.json')), false, 'and never says it is ready');
  assert.deepEqual(released, [`${config.statePath}.lock`], 'the profile lock is let go');
});

test('[INTAKE-010] a held request replayed after its job was saved, but before it left the file, starts nothing twice', async (t) => {
  const h = await startTestDaemon(t);
  await h.deliver(mention('1700000100.000100', 'rename the pricing page'));
  assert.equal(h.t3.started.length, 1);
  // The crash came after the job was saved and before the request left held-requests.jsonl.
  holdRequest(h.config.profileDir, { channel: 'C1', threadTs: '1700000100.000100', messageTs: '1700000100.000100', user: SAM, text: `<@${BOT}> rename the pricing page`, direct: true });
  await h.restart();
  await h.advance(60_000);
  assert.equal(readHeld(h.config.profileDir).length, 0, 'the replayed request is let go');
  assert.equal(h.t3.started.length, 1, 'no second T3 thread');
  assert.equal(h.t3.sends.length, 0, 'and nothing sent to the worker as a follow-up');
});

test('[SVC-004] stopping the daemon removes its ready marker and stops polling', async (t) => {
  const h = await startTestDaemon(t);
  assert.ok(existsSync(join(h.config.profileDir, 'ready.json')));
  await h.stop();
  assert.equal(existsSync(join(h.config.profileDir, 'ready.json')), false);
  assert.equal(h.clock.pending(), 0, 'no timer left behind');
});

test('[INTAKE-010] a held-requests file the daemon cannot write is logged and tried again on the next poll, without stopping the daemon', async (t) => {
  const h = await startTestDaemon(t);
  pauseIntake(h.config.profileDir, 'app-update', { now: h.clock.now() });
  await h.deliver(mention('1700000100.000100', 'rename the pricing page'));
  assert.equal(readHeld(h.config.profileDir).length, 1);
  resumeIntake(h.config.profileDir);
  chmodSync(h.config.profileDir, 0o500);
  try {
    await h.advance(15_000);
  } finally { chmodSync(h.config.profileDir, 0o700); }
  assert.ok(h.logs.some((line) => /Releasing held requests failed/.test(line)), 'the failure is logged');
  assert.equal(h.t3.started.length, 0, 'nothing starts while its record can\'t be written');
  await h.advance(15_000);
  assert.equal(h.t3.started.length, 1, 'the next poll starts it');
  assert.equal(readHeld(h.config.profileDir).length, 0);
});

test('[REPLY-008] a review request posted just before a crash is recorded at once, so the restarted bot doesn\'t post it again', async (t) => {
  const pr = 'https://github.com/acme/project/pull/12';
  let h: Awaited<ReturnType<typeof startTestDaemon>> | null = null;
  h = await startTestDaemon(t, { bot: {
    reviewRequest: async (text, options) => {
      if (options.alreadyPosted.includes(pr)) return { reply: text, postedFor: null };
      await h!.slack.client.chat.postMessage({ channel: 'CREVIEW', text: `Review ${pr}` });
      // The reply to the thread, posted next, reaches Slack and then the daemon dies.
      h!.slack.hangAfter('chat.postMessage');
      return { reply: `${text}\n\nReview request posted.`, postedFor: pr };
    },
  } });
  await h.deliver(mention('1700000100.000100', 'open a PR for the fix'));
  h.t3.reply(`PR is up: ${pr}`);
  await h.advance(15_000);
  assert.deepEqual(h.state()['C1:1700000100.000100']?.reviewRequestedPrs, [pr]);
  await h.crash();
  await h.advance(15_000);
  assert.equal(h.slack.callsTo('chat.postMessage').filter((args) => args.channel === 'CREVIEW').length, 1, 'one review request');
  assert.equal(h.slack.callsTo('chat.postMessage').filter((args) => args.channel === 'C1').length, 1, 'one reply');
});

test('[INTAKE-008] a request that can\'t be held for an update is handled at once and logged, never lost', async (t) => {
  const h = await startTestDaemon(t);
  pauseIntake(h.config.profileDir, 'app-update', { now: h.clock.now() });
  // The held-requests file can't be written: something else is in its place.
  mkdirSync(join(h.config.profileDir, HELD_REQUESTS));
  await h.deliver(mention('1700000100.000100', 'rename the pricing page'));
  assert.ok(h.logs.some((line) => /Couldn't hold a request in C1 for after the update, so handling it now/.test(line)), 'the failure is logged');
  assert.equal(h.t3.started.length, 1, 'the request started instead of being lost');
  assert.deepEqual(h.slack.reactionsOn('C1', '1700000100.000100'), ['eyes'], 'and shows 👀, not the hourglass');
});

const dm = (ts: string, text: string): Record<string, unknown> => ({
  type: 'event_callback', team_id: 'THOME', api_app_id: 'A1', event_id: `Ev${ts}`, event_time: 1,
  authorizations: [{ team_id: 'THOME', user_id: BOT, is_bot: true }],
  event: { type: 'message', channel_type: 'im', user: OWNER, text, ts, channel: 'D1', event_ts: ts, team: 'THOME' },
});

test('[SERRA-62] a meeting in the owner\'s DM goes to the extractor, never to T3, and isn\'t held during an update', async (t) => {
  const prompts: string[] = [];
  const h = await startTestDaemon(t, { meetings: { extractor: { extract: async (prompt) => { prompts.push(prompt); return '<meeting-digest>{"items":[],"reply":[{"kind":"action","text":"Sam sends the notes"}]}</meeting-digest>'; } } } });
  writeMeetingSettings(h.config.profileDir, true);
  pauseIntake(h.config.profileDir, 'bot-update', { now: h.clock.now() });
  await h.deliver(dm('1700000200.000100', 'remember this meeting\nSam: we ship retries at 3. TRANSCRIPT-PHRASE'));
  assert.equal(h.t3.started.length, 0, 'no T3 thread');
  assert.equal(readHeld(h.config.profileDir).length, 0, 'not held for after the update: refused instead');
  assert.equal(prompts.length, 0);
  resumeIntake(h.config.profileDir);
  await h.deliver(dm('1700000300.000100', 'remember this meeting\nSam: we ship retries at 3. TRANSCRIPT-PHRASE'));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /TRANSCRIPT-PHRASE/);
  assert.equal(h.t3.started.length, 0);
  assert.ok(h.slack.callsTo('chat.postMessage').some((call) => /Sam sends the notes/.test(String(call.text))), 'the digest is posted');
  // A reply in the meeting's thread is turned away, not sent to a worker.
  await h.deliver({ ...dm('1700000301.000100', 'and one more thing'), event: { ...(dm('1700000301.000100', 'and one more thing').event as object), thread_ts: '1700000300.000100' } });
  assert.equal(h.t3.started.length + h.t3.sends.length, 0);
});

test('[SERRA-62] a meeting request held by an older Serra is dropped at start, never replayed to a worker', async (t) => {
  const h = await startTestDaemon(t);
  writeMeetingSettings(h.config.profileDir, true);
  holdRequest(h.config.profileDir, { channel: 'D1', threadTs: '1700000400.000100', messageTs: '1700000400.000100', user: OWNER, text: 'remember this meeting\nSam: TRANSCRIPT', direct: true, im: true });
  await h.restart();
  await h.advance(60_000);
  assert.equal(h.t3.started.length, 0);
  assert.equal(readHeld(h.config.profileDir).length, 0);
  assert.ok(h.slack.callsTo('chat.postMessage').some((call) => /Send it again/.test(String(call.text))));
});
