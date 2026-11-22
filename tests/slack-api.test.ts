import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotice } from '../src/bot.ts';
import { comparableSlackText } from '../src/slack-api.ts';
import { slackStoredText } from './fakes/slack.ts';

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

test('[REPLY-009] Serra\'s fixed notices are never recognised by their text: the same notice is posted many times', () => {
  assert.equal(isNotice('Some of what I knew for this answer has since been made private, so I won\'t post it. Ask again and I\'ll answer with what I may share now.'), true);
  assert.equal(isNotice('I couldn\'t confirm who can see this thread just now, so I haven\'t posted my answer here. Ask again in a minute and I\'ll try again.'), true);
  assert.equal(isNotice('I can\'t check who can see this thread: my Slack app is missing a permission (missing_scope).'), true);
  assert.equal(isNotice('Done.'), false);
});
