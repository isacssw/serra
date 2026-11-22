import assert from 'node:assert/strict';
import test from 'node:test';
import { alertText, incomingMessage } from '../src/slack/incoming.ts';
import { matchMessageTrigger } from '../src/message-triggers.ts';

const event = { user: 'U1', channel: 'C1', ts: '2', thread_ts: '1', text: '', subtype: 'file_share', files: [{ id: 'F1' }] };
const owns = (channel: string, ts: string): boolean => channel === 'C1' && ts === '1';

test('file-only shares in owned threads and DMs preserve file metadata', () => {
  assert.deepEqual(incomingMessage(event, 'message', 'UBOT', owns), {
    channel: 'C1', messageTs: '2', threadTs: '1', user: 'U1', text: '', direct: false, files: [{ id: 'F1' }],
  });
  assert.equal(incomingMessage({ ...event, channel_type: 'im', thread_ts: undefined }, 'message', 'UBOT', () => false)?.direct, true);
  assert.equal(incomingMessage({ ...event, subtype: undefined }, 'message', 'UBOT', owns)?.files?.[0]?.id, 'F1');
});

test('mentions carry attachments once, through app_mention', () => {
  const mention = { ...event, text: '<@UBOT> inspect this' };
  assert.equal(incomingMessage(mention, 'message', 'UBOT', owns), null);
  assert.equal(incomingMessage(mention, 'app_mention', 'UBOT', owns)?.files?.[0]?.id, 'F1');
  assert.equal(incomingMessage({ ...mention, text: '<@UBOT|bot> inspect this' }, 'message', 'UBOT', owns), null);
});

test('unowned channels, bot uploads, edits and lifecycle subtypes remain ignored', () => {
  assert.equal(incomingMessage({ ...event, thread_ts: undefined }, 'message', 'UBOT', owns), null);
  assert.equal(incomingMessage(event, 'message', 'UBOT', () => false), null);
  for (const change of [{ bot_id: 'B1' }, { user: 'UBOT' }, { user: undefined }, { subtype: 'message_changed' }, { subtype: 'channel_join' }, { hidden: true }]) {
    assert.equal(incomingMessage({ ...event, ...change }, 'message', 'UBOT', owns), null);
  }
});

const trigger = { channel: 'CALERTS', botId: 'BALERTS', instructions: 'Investigate the incident and report evidence.' };
const alert = { channel: 'CALERTS', bot_id: 'BALERTS', ts: '100.001', subtype: 'bot_message', text: 'Critical alert' };
const options = { messageTriggers: [trigger], botId: 'BSELF' };

test('a configured channel and exact bot identity admit new alerts without mentions or a human user', () => {
  const expected = { channel: 'CALERTS', threadTs: alert.ts, messageTs: alert.ts, user: 'BALERTS', botId: 'BALERTS', text: 'Critical alert', direct: true };
  assert.deepEqual(incomingMessage(alert, 'message', 'UBOT', () => false, options), expected);
  assert.deepEqual(incomingMessage({ ...alert, subtype: undefined, user: 'UALERTS' }, 'message', 'UBOT', () => false, options), expected);
  assert.equal(incomingMessage(alert, 'message', 'UBOT', () => false), null, 'automatic work is disabled by default');
});

test('triggers exclude other sources, human spoofing, bot replies, edits, hidden messages, DMs and self', () => {
  for (const change of [
    { channel: 'COTHER' }, { bot_id: 'BOTHER' }, { bot_id: undefined, user: 'UOTHER', username: 'Sentry', subtype: undefined },
    { bot_id: 'BSELF' }, { user: 'UBOT' }, { thread_ts: '99.001' }, { thread_ts: alert.ts },
    { hidden: true }, { subtype: 'message_changed' }, { subtype: 'message_deleted' }, { subtype: 'thread_broadcast' },
    { channel_type: 'im' }, { channel_type: 'mpim' },
  ]) assert.equal(incomingMessage({ ...alert, ...change }, 'message', 'UBOT', () => false, options), null, JSON.stringify(change));
  assert.equal(incomingMessage(alert, 'app_mention', 'UBOT', () => false, options), null);
  assert.equal(incomingMessage({ ...alert, bot_id: 'BSELF' }, 'message', 'UBOT', () => false,
    { ...options, messageTriggers: [{ ...trigger, botId: 'BSELF' }] }), null, 'even a self trigger cannot cause a reply loop');
});

test('attachment-only alerts retain incident links, thresholds and legacy field labels without downloading assets', () => {
  const message = incomingMessage({ ...alert, text: '', attachments: [{
    title: 'Critical: feature errors', title_link: 'https://example.sentry.io/alerts/123',
    pretext: 'Incident started', text: 'count() was 11 in 15 minutes', fallback: 'Metric alert',
    fields: [{ title: 'Threshold', value: 'Static' }, { title: 'notes', value: 'Inspect checkout' }],
    image_url: 'https://images.example/chart.png',
  }], files: [{ id: 'F1', url_private: 'https://files.slack.com/alert.txt' }] }, 'message', 'UBOT', () => false, options);
  assert.match(message!.text, /<https:\/\/example\.sentry\.io\/alerts\/123\|Critical: feature errors>/);
  for (const content of ['Incident started', 'count() was 11 in 15 minutes', 'Threshold: Static', 'notes: Inspect checkout', 'Metric alert']) assert.ok(message!.text.includes(content));
  assert.equal(message!.files, undefined);
  assert.doesNotMatch(message!.text, /images\.example/);
});

test('block-only alerts retain sections, fields, context and adjacent rich-text spans', () => {
  const message = incomingMessage({ ...alert, text: '', blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: 'Error threshold exceeded' }, fields: [{ type: 'mrkdwn', text: '*Environment:* production' }] },
    { type: 'context', elements: [{ type: 'plain_text', text: 'Started at 10:00' }] },
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
      { type: 'text', text: 'See ' }, { type: 'link', text: 'incident', url: 'https://example.sentry.io/issues/123' }, { type: 'text', text: ' for details.' },
    ] }] },
  ] }, 'message', 'UBOT', () => false, options);
  assert.match(message!.text, /Error threshold exceeded/);
  assert.match(message!.text, /\*Environment:\* production/);
  assert.match(message!.text, /Started at 10:00/);
  assert.match(message!.text, /See <https:\/\/example\.sentry\.io\/issues\/123\|incident> for details\./);
  assert.equal(incomingMessage({ ...alert, text: '', attachments: [{}] }, 'message', 'UBOT', () => false, options), null);
  const long = alertText({ text: 'x'.repeat(30_000) });
  assert.ok(long.length < 20_100);
  assert.match(long, /Alert content truncated/);
});

test('specific human triggers admit only that sender and retain visible content without files', () => {
  const rules = { messageTriggers: [{ channel: 'C1', userId: 'U1', instructions: 'Investigate.' }] };
  const root = { ...event, thread_ts: undefined, text: 'Investigate this issue', attachments: [{ text: 'Supporting detail' }] };
  const accepted = incomingMessage(root, 'message', 'UBOT', owns, rules);
  assert.equal(accepted?.automaticTrigger, true);
  assert.equal(accepted?.user, 'U1');
  assert.equal(accepted?.botId, undefined);
  assert.match(accepted!.text, /Supporting detail/);
  assert.equal(accepted?.files, undefined);
  for (const change of [{ user: 'U2' }, { channel: 'COTHER' }, { subtype: 'message_changed' }, { hidden: true },
    { bot_id: 'B1', subtype: 'bot_message' }]) {
    assert.equal(incomingMessage({ ...root, ...change }, 'message', 'UBOT', owns, rules), null);
  }
});

test('empty sender triggers admit people and bots but retain self, thread, DM and mention boundaries', () => {
  const root = { ...event, text: 'Channel-wide message', thread_ts: undefined };
  for (const sender of [{}, { botId: '' }, { userId: '' }, { botId: ' ', userId: ' ' }]) {
    const rules = { messageTriggers: [{ channel: 'C1', instructions: 'Investigate.', ...sender }], botId: 'BSELF' };
    assert.equal(incomingMessage(root, 'message', 'UBOT', owns, rules)?.automaticTrigger, true);
    assert.equal(incomingMessage({ ...alert, channel: 'C1' }, 'message', 'UBOT', owns, rules)?.botId, 'BALERTS');
    for (const change of [{ user: 'UBOT' }, { hidden: true }, { subtype: 'message_changed' }, { thread_ts: '99' }, { channel_type: 'mpim' }]) {
      assert.equal(incomingMessage({ ...root, ...change }, 'message', 'UBOT', owns, rules), null);
    }
    assert.equal(incomingMessage({ ...alert, channel: 'C1', bot_id: 'BSELF' }, 'message', 'UBOT', owns, rules), null);
    assert.equal(incomingMessage({ ...root, channel_type: 'im' }, 'message', 'UBOT', owns, rules)?.automaticTrigger, undefined);
    assert.equal(incomingMessage(event, 'message', 'UBOT', owns, rules)?.automaticTrigger, undefined, 'owned replies stay ordinary followups');
    const mention = { ...root, text: '<@UBOT> investigate this' };
    assert.equal(incomingMessage(mention, 'message', 'UBOT', owns, rules), null);
    assert.equal(incomingMessage(mention, 'app_mention', 'UBOT', owns, rules)?.automaticTrigger, undefined);
  }
});

test('specific sender rules outrank channel-wide instructions independent of order and bot member IDs', () => {
  const wildcard = { channel: 'C1', instructions: 'General investigation.' };
  const person = { channel: 'C1', userId: 'U1', instructions: 'Human investigation.' };
  const bot = { channel: 'C1', botId: 'B1', instructions: 'Bot investigation.' };
  for (const rules of [[wildcard, person, bot], [bot, person, wildcard]]) {
    assert.equal(matchMessageTrigger(rules, 'C1', { userId: 'U1' }), person);
    assert.equal(matchMessageTrigger(rules, 'C1', { botId: 'B1', userId: 'U1' }), bot);
    assert.equal(matchMessageTrigger(rules, 'C1', { botId: 'B2', userId: 'U1' }), wildcard);
    assert.equal(matchMessageTrigger(rules, 'C1', { userId: 'U2' }), wildcard);
    assert.equal(matchMessageTrigger(rules, 'COTHER', { userId: 'U1' }), undefined);
  }
});
