import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notificationPlanner, notificationTarget, notificationText, redact, targetScreen, type PlannedNotification,
} from '../app/main/notifications.logic.ts';
import { socketStatusSource, STOPPED, type StatusSubscriber } from '../src/status-source.ts';
import type { BotEvent, BotStatus, JobSummary, StatusMessage } from '../src/contracts.ts';

const START = Date.parse('2026-11-19T10:00:00.000Z');
const clock = () => {
  let now = START;
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
};
const at = (seconds: number): string => new Date(START + seconds * 1000).toISOString();
const up = (pid = 4242, startedAt = '2026-11-19T09:00:00.000Z'): BotStatus => (
  { state: 'up', pid, startedAt, slackConnected: true, counts: { needsYou: 0, running: 0 } }
);
const needsOwner = (key: string, seconds: number): BotEvent => ({ at: at(seconds), event: 'needs_owner', key });
const failure = (key: string, seconds: number, error = 'worker exited'): BotEvent => ({ at: at(seconds), event: 'failure', key, error });
const kinds = (plans: (PlannedNotification | null)[]): string[] => plans.filter((plan) => plan !== null).map((plan) => plan.kind);

test('each needs-owner and failure event notifies once', () => {
  const planner = notificationPlanner({ now: clock().now });
  const first = planner.event(needsOwner('C1:1.0', 1));
  assert.deepEqual(first, { kind: 'needs-owner', id: `needs-owner:C1:1.0:${at(1)}`, key: 'C1:1.0' });
  assert.equal(planner.event(needsOwner('C1:1.0', 1)), null, 'the same event again is not news');
  assert.deepEqual(kinds([planner.event(failure('C2:2.0', 2))]), ['failure']);
  assert.equal(planner.event(failure('C2:2.0', 2)), null);
  assert.equal(planner.event({ at: at(3), event: 'job_started', key: 'C3:3.0', t3ThreadId: 't', requester: 'U0123456789' }), null);
  assert.equal(planner.event({ at: at(4), event: 'reply', key: 'C3:3.0', kind: 'status_posted' }), null);
});

test('a job keeps one needs-owner notification until it moves on', () => {
  const planner = notificationPlanner({ now: clock().now });
  assert.deepEqual(kinds([planner.event({ at: at(1), event: 'reply', key: 'C1:1.0', kind: 'reply', needsOwner: true })]), []);
  assert.deepEqual(kinds([planner.event(needsOwner('C1:1.0', 1))]), ['needs-owner']);
  // waiting_in_t3 then needs_owner again for the same blocker: still the same ask.
  assert.equal(planner.event(needsOwner('C1:1.0', 5)), null);
  assert.equal(planner.event({ at: at(6), event: 'reply', key: 'C1:1.0', kind: 'status_edited' }), null);
  assert.equal(planner.event(needsOwner('C1:1.0', 7)), null, 'a progress edit is not an answer');
  // The bot answered without needing the owner: a later ask is a new one.
  planner.event({ at: at(8), event: 'reply', key: 'C1:1.0', kind: 'reply', needsOwner: false });
  assert.deepEqual(kinds([planner.event(needsOwner('C1:1.0', 9))]), ['needs-owner']);
  // Another job is its own ask.
  assert.deepEqual(kinds([planner.event(needsOwner('C2:2.0', 9))]), ['needs-owner']);
  // A failure repeats only after the job started again.
  assert.deepEqual(kinds([planner.event(failure('C1:1.0', 10)), planner.event(failure('C1:1.0', 11))]), ['failure']);
  planner.event({ at: at(12), event: 'job_started', key: 'C1:1.0', t3ThreadId: 't', requester: 'U0123456789' });
  assert.deepEqual(kinds([planner.event(failure('C1:1.0', 13))]), ['failure']);
});

test('reconnects do not repeat old events', () => {
  const planner = notificationPlanner({ now: clock().now });
  assert.equal(planner.event(needsOwner('C0:0.0', -60)), null, 'an event from before the app started is old');
  const live = [needsOwner('C1:1.0', 1), failure('C2:2.0', 2)];
  assert.deepEqual(kinds(live.map((event) => planner.event(event))), ['needs-owner', 'failure']);
  // The connection drops and comes back; whatever is sent again is old news.
  planner.status(STOPPED);
  planner.status(up());
  assert.deepEqual(kinds(live.map((event) => planner.event(event))), []);
  assert.equal(planner.event({ at: 'not a date', event: 'needs_owner', key: 'C9:9.0' }), null);
});

test('the daemon stopping notifies once per run, not for the launch state or a reconnect of the same run', () => {
  const planner = notificationPlanner({ now: clock().now });
  assert.equal(planner.status(STOPPED), null, 'stopped at launch is the starting point, not news');
  assert.equal(planner.status(up()), null);
  assert.deepEqual(planner.status(STOPPED), { kind: 'stopped', id: 'stopped:4242@2026-11-19T09:00:00.000Z' });
  assert.equal(planner.status(STOPPED), null);
  // The client reconnects to the same run (say the app missed a beat) and loses it again: no second notification.
  planner.status(up());
  assert.equal(planner.status(STOPPED), null);
  // A new run that stops is news again.
  planner.status(up(5151, '2026-11-19T10:05:00.000Z'));
  assert.deepEqual(kinds([planner.status(STOPPED)]), ['stopped']);
});

test('a stop or restart the app asked for does not notify, and a later crash still does', () => {
  const time = clock();
  const planner = notificationPlanner({ now: time.now, expectedStopMs: 60_000 });
  planner.status(up());
  planner.expectStop();
  assert.equal(planner.status(STOPPED), null, 'the app stopped it');
  planner.status(up(5151, '2026-11-19T10:01:00.000Z'));
  assert.deepEqual(kinds([planner.status(STOPPED)]), ['stopped'], 'the expectation is used up');

  // A restart whose stop the socket never saw: the new run clears the expectation, so a crash right after notifies.
  planner.status(up(6161, '2026-11-19T10:02:00.000Z'));
  planner.expectStop();
  planner.status(up(7171, '2026-11-19T10:02:05.000Z'));
  assert.deepEqual(kinds([planner.status(STOPPED)]), ['stopped']);

  // An expectation that runs out (the action never stopped the bot) doesn't hide a crash much later.
  planner.status(up(8181, '2026-11-19T10:03:00.000Z'));
  planner.expectStop();
  time.advance(61_000);
  assert.deepEqual(kinds([planner.status(STOPPED)]), ['stopped']);
});

test('switching profiles is not the daemon stopping', () => {
  const planner = notificationPlanner({ now: clock().now });
  planner.status(up());
  planner.reset();
  assert.equal(planner.status(STOPPED), null);
});

test('through the status source, a resubscribe after a reconnect notifies nothing twice', () => {
  // A fake subscriber that replays the same messages on each connection, the worst case for a reconnect.
  const messages: StatusMessage[] = [
    { type: 'status', status: up() },
    { type: 'event', event: needsOwner('C1:1.0', 1) },
    { type: 'event', event: failure('C2:2.0', 2) },
  ];
  const connections: ((message: StatusMessage) => void)[] = [];
  const subscribe: StatusSubscriber = (_profile, listener) => { connections.push(listener); return { close: () => {} }; };
  const source = socketStatusSource('/Users/you/serra-profile', subscribe);
  const planner = notificationPlanner({ now: clock().now });
  const shown: string[] = [];
  planner.status(source.current());
  source.subscribe({
    status: (status) => { const plan = planner.status(status); if (plan) shown.push(plan.id); },
    event: (event) => { const plan = planner.event(event); if (plan) shown.push(plan.id); },
  });
  const connect = (listener: (message: StatusMessage) => void): void => { for (const message of messages) listener(message); };
  connect(connections[0]!);
  connections[0]!({ type: 'status', status: STOPPED });
  connect(connections[0]!);
  assert.deepEqual(shown, [`needs-owner:C1:1.0:${at(1)}`, `failure:C2:2.0:${at(2)}`, 'stopped:4242@2026-11-19T09:00:00.000Z']);
  source.close();
});

const job: JobSummary = {
  key: 'C1:1.0', group: 'needs you', requester: 'U0123456789', channel: 'C0123456789', title: 'Fix the build',
  createdAt: at(0), lastActivityAt: at(1), links: {},
};

test('the text names the job and never carries a credential', () => {
  assert.deepEqual(notificationText({ kind: 'needs-owner', id: 'x', key: 'C1:1.0' }, job), { title: 'Serra needs you', body: 'Fix the build' });
  assert.deepEqual(notificationText({ kind: 'needs-owner', id: 'x', key: 'C1:1.0' }), { title: 'Serra needs you', body: 'A job is waiting for you.' });
  const failed = notificationText({ kind: 'failure', id: 'x', key: 'C1:1.0', error: 'auth failed with xoxb-fixture-123 and\ntoken=abc123' }, job);
  assert.equal(failed.title, 'A job failed');
  assert.equal(failed.body, 'Fix the build — auth failed with [hidden] and token=[hidden]');
  assert.ok(!/xoxb|abc123/.test(failed.body));
  assert.equal(notificationText({ kind: 'failure', id: 'x', key: 'k', error: 'x'.repeat(500) }).body.length, 140);
  assert.equal(notificationText({ kind: 'needs-owner', id: 'x', key: 'C1:1.0' }, { ...job, title: '' }).body, 'A job is waiting for you.');
  assert.equal(notificationText({ kind: 'stopped', id: 'x' }).title, 'Serra stopped');
  assert.equal(redact('xapp-1-A-fixture op://vault/item/field Bearer abc ghp_abc123'), '[hidden] [hidden] Bearer [hidden] [hidden]');
});

test('clicking opens the job or Diagnostics', () => {
  const target = notificationTarget({ kind: 'needs-owner', id: 'x', key: 'C1:1.0' });
  assert.equal(target, '/jobs/needs-you?job=C1%3A1.0');
  assert.equal(targetScreen(target), '/jobs/needs-you');
  assert.equal(notificationTarget({ kind: 'failure', id: 'x', key: 'C1:1.0', error: '' }), '/jobs/needs-you?job=C1%3A1.0');
  assert.equal(notificationTarget({ kind: 'stopped', id: 'x' }), '/settings/diagnostics');
  assert.equal(targetScreen('/settings/diagnostics'), '/settings/diagnostics');
});
