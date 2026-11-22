import assert from 'node:assert/strict';
import test from 'node:test';
import { comparableSlackText } from '../src/slack/api.ts';
import { slackChat } from './fakes/chat.ts';
import { createFakeSlack, slackStoredText } from './fakes/slack.ts';

test('[REPLY-009] a reply and the text Slack stores for it compare equal, and different replies don\'t', () => {
  const replies = [
    'PR is up: https://github.com/acme/project/pull/12 & tests pass.',
    'retries < 3 > 0, and <https://t3.test/x|the T3 thread>',
    'Line one.\n\n  Line two.',
    'a&b <c> d',
  ];
  for (const reply of replies) assert.equal(comparableSlackText(slackStoredText(reply)), comparableSlackText(reply), reply);
  assert.notEqual(comparableSlackText('Done.'), comparableSlackText('Done!'));
  assert.equal(comparableSlackText('x'.repeat(900)).length, 500, 'a prefix is compared');
});

test('[REPLY-009] Serra\'s fixed notices are never recognised by their text: the same notice is posted many times', async () => {
  // A restart looks for a reply cut off mid-post. Without metadata, a notice already in the thread is not taken for it.
  const slack = createFakeSlack({ botUserId: 'UBOT', returnsMetadata: false, now: () => Date.parse('2026-11-18T10:00:00Z') });
  const { chat } = slackChat(slack.client, { owner: 'UOWNER', botToken: 'xoxb-1111-2222-fixturevalue', profileDir: '/tmp' }, { botUserId: 'UBOT' });
  const target = { conversation: 'C1', thread: '1700000000.000100' };
  await chat.notice(target, { kind: 'withheld' });
  await chat.notice(target, { kind: 'unconfirmed' });
  await chat.notice(target, { kind: 'setup-problem', problem: 'missing-permission' });
  const at = '2026-11-18T10:00:00.000Z';
  for (const text of slack.posted.map((post) => String(post.text))) assert.equal(await chat.findReply(target, { runId: 'run-2', at, text }), null, text);
  await slack.client.chat.postMessage({ channel: 'C1', thread_ts: target.thread, text: 'Done.' });
  assert.notEqual(await chat.findReply(target, { runId: 'run-2', at, text: 'Done.' }), null, 'a worker\'s reply is found by its text');
});
