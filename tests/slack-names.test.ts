// APP-29: Slack names instead of raw IDs (Jobs, notifications), the app task's brief (R13) and the Slack scopes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { createHandlers } from '../app/main/ipc/index.ts';
import { jobsHandlers } from '../app/main/ipc/jobs.ts';
import { profileSlackNames } from '../app/main/ipc/slack-names.ts';
import { notificationText } from '../app/main/notifications.logic.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { APP_TASK_CHANNEL_LABEL, channelChoices, rowParts, type JobRow } from '../app/renderer/screens/jobs.logic.ts';
import { fillBriefText, NO_THREAD, renderBrief } from '../src/brief.ts';
import { codeRoot, loadConfig } from '../src/config.ts';
import type { JobSummary } from '../src/contracts.ts';
import {
  answerNameRequests, channelLabel, createSlackNames, DM_LABEL, GROUP_DM_LABEL, slackMentions, slackPlainText, userLabel, type SlackNameLookup,
} from '../src/slack-names.ts';
import type { NamesAsk } from '../src/slack-names-store.ts';
import { taskBriefInput } from '../src/tasks.ts';

const TOKEN = 'xoxb-fixture-names-123';
const USERS: Record<string, string> = { U0EXAMPLE01: 'Sam Rivera', U0OTHER0001: 'Ada' };
const CHANNELS: Record<string, string> = { C0EXAMPLE01: '#billing-alerts', G0PRIVATE01: '#billing-dev' };
const BOTS: Record<string, string> = { B0MONITOR01: 'Acme Monitor' };

/** A fake Slack: answers from the tables above, counts calls, and can be told to fail or to wait. */
const fakeSlack = () => {
  const calls: string[] = [];
  const tokens: string[] = [];
  let failWith: string | null = null;
  let gate: Promise<void> | null = null;
  const lookup = async (token: string): Promise<SlackNameLookup> => {
    tokens.push(token);
    const answer = (table: Record<string, string>) => async (id: string): Promise<string | null> => {
      calls.push(id);
      if (gate) await gate;
      if (failWith) throw new Error(failWith);
      return table[id] ?? null;
    };
    return { user: answer(USERS), channel: answer(CHANNELS), bot: answer(BOTS) };
  };
  return {
    lookup, calls, tokens,
    fail: (code: string | null) => { failWith = code; },
    hold: () => { let release = (): void => {}; gate = new Promise((resolve) => { release = resolve; }); return () => { gate = null; release(); }; },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// src/slack-names.ts
// ---------------------------------------------------------------------------------------------------------------

test('labels: display name, then real name, then handle; channels as #name, DMs and group DMs by kind', () => {
  assert.equal(userLabel({ name: 'sam', real_name: 'Samantha Rivera', profile: { display_name: 'Sam Rivera', real_name: 'Samantha Rivera' } }), 'Sam Rivera');
  assert.equal(userLabel({ name: 'sam', real_name: 'Samantha Rivera', profile: { display_name: ' ' } }), 'Samantha Rivera');
  assert.equal(userLabel({ name: 'sam', profile: { real_name: 'Samantha' } }), 'Samantha');
  assert.equal(userLabel({ name: 'sam' }), 'sam');
  assert.equal(userLabel(undefined), null);
  assert.equal(channelLabel({ name: 'billing-alerts' }), '#billing-alerts');
  assert.equal(channelLabel({ is_im: true }), DM_LABEL);
  assert.equal(channelLabel({ is_mpim: true, name: 'mpdm-a--b-1' }), GROUP_DM_LABEL);
  assert.equal(channelLabel({}), null);
});

test('names come from the cache only: a miss is looked up in the background, then shown', async () => {
  const slack = fakeSlack();
  let resolved = 0;
  const names = createSlackNames({ token: async () => TOKEN, lookup: slack.lookup, onResolved: () => { resolved += 1; } });
  assert.equal(names.userName('U0EXAMPLE01'), undefined, 'nothing is known before a lookup, and nothing waits');
  assert.equal(await names.request({ users: ['U0EXAMPLE01', 'U0EXAMPLE01', '', 'Alex'], channels: ['C0EXAMPLE01', 'D0EXAMPLE01', 'app'] }), true);
  assert.equal(names.userName('U0EXAMPLE01'), 'Sam Rivera');
  assert.equal(names.channelName('C0EXAMPLE01'), '#billing-alerts');
  assert.equal(names.channelName('D0EXAMPLE01'), DM_LABEL, 'a DM needs no lookup (and no im:read)');
  assert.equal(names.userName('Alex'), undefined);
  assert.deepEqual(slack.calls.sort(), ['C0EXAMPLE01', 'U0EXAMPLE01'], 'each ID once; DMs, the app channel and names are never sent');
  assert.deepEqual(slack.tokens, [TOKEN]);
  assert.equal(resolved, 1);

  // Cached: no second lookup, no second refresh.
  assert.equal(await names.request({ users: ['U0EXAMPLE01'], channels: ['C0EXAMPLE01'] }), false);
  assert.equal(slack.calls.length, 2);
  assert.equal(resolved, 1);
});

test('names expire after the TTL and are looked up again, still shown meanwhile', async () => {
  const slack = fakeSlack();
  let now = 1_000_000;
  const names = createSlackNames({ token: async () => TOKEN, lookup: slack.lookup, ttlMs: 60_000, now: () => now });
  await names.request({ users: ['U0EXAMPLE01'] });
  now += 59_000;
  await names.request({ users: ['U0EXAMPLE01'] });
  assert.equal(slack.calls.length, 1, 'fresh within the TTL');
  now += 2_000;
  USERS.U0EXAMPLE01 = 'Sam R.';
  const release = slack.hold();
  const refreshing = names.request({ users: ['U0EXAMPLE01'] });
  assert.equal(names.userName('U0EXAMPLE01'), 'Sam Rivera', 'the stale name shows while it refreshes');
  release();
  assert.equal(await refreshing, true);
  assert.equal(names.userName('U0EXAMPLE01'), 'Sam R.');
  USERS.U0EXAMPLE01 = 'Sam Rivera';
});

test('a failed lookup leaves the raw ID, is logged once by error code, and waits before a retry', async () => {
  const slack = fakeSlack();
  const logs: string[] = [];
  let now = 0;
  const names = createSlackNames({ token: async () => TOKEN, lookup: slack.lookup, retryMs: 600_000, now: () => now, log: (line) => logs.push(line) });
  slack.fail('missing_scope');
  assert.equal(await names.request({ channels: ['C0EXAMPLE01'] }), false);
  assert.equal(names.channelName('C0EXAMPLE01'), undefined);
  await names.request({ channels: ['C0EXAMPLE01'] });
  assert.equal(slack.calls.length, 1, 'not retried before retryMs');
  now += 600_001;
  await names.request({ channels: ['C0EXAMPLE01'] });
  assert.equal(slack.calls.length, 2);
  assert.deepEqual(logs, ['[serra] could not look up Slack channel C0EXAMPLE01: missing_scope'], 'the same failure is logged once');
  slack.fail(null);
  now += 600_001;
  assert.equal(await names.request({ channels: ['C0EXAMPLE01'] }), true);
  assert.equal(names.channelName('C0EXAMPLE01'), '#billing-alerts');
});

test('no token: nothing is sent to Slack, one log line, and the error (which could name the token) is not repeated', async () => {
  const slack = fakeSlack();
  const logs: string[] = [];
  const names = createSlackNames({
    token: async () => { throw new Error(`SLACK_BOT_TOKEN ${TOKEN} isn't a real token`); },
    lookup: slack.lookup, log: (line) => logs.push(line),
  });
  assert.equal(await names.request({ users: ['U0EXAMPLE01', 'U0OTHER0001'], channels: ['C0EXAMPLE01'] }), false);
  assert.deepEqual(slack.calls, []);
  assert.equal(logs.length, 1);
  assert.ok(!logs.join('\n').includes('xoxb'), 'the token never reaches a log');
  assert.equal(names.userName('U0EXAMPLE01'), undefined);
});

test('concurrent requests for the same IDs look each up once', async () => {
  const slack = fakeSlack();
  const names = createSlackNames({ token: async () => TOKEN, lookup: slack.lookup });
  const release = slack.hold();
  const first = names.request({ users: ['U0EXAMPLE01', 'U0OTHER0001'] });
  const second = names.request({ users: ['U0EXAMPLE01', 'U0OTHER0001'] });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual([await first, await second], [true, false]);
  assert.deepEqual(slack.calls.sort(), ['U0EXAMPLE01', 'U0OTHER0001']);
});

// ---------------------------------------------------------------------------------------------------------------
// The Jobs list (app/main/ipc/jobs.ts) and screen logic
// ---------------------------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const NOW = new Date(2026, 10, 19, 15, 0, 0);
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * MINUTE).toISOString();

const jobsProfile = (t: TestContext): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'serra-names-jobs-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const example = JSON.parse(readFileSync(new URL('../examples/profile.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...example, t3Bin: join(dir, 'missing-t3') }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    'C0EXAMPLE01:1700000000.000001': { t3ThreadId: 'a', channel: 'C0EXAMPLE01', threadTs: '1700000000.000001', requester: 'U0EXAMPLE01', ownerAskOpen: true, createdAt: ago(30), lastActivityAt: ago(12) },
    'D0EXAMPLE01:1700000000.000002': { t3ThreadId: 'b', channel: 'D0EXAMPLE01', threadTs: '1700000000.000002', requester: 'U0OTHER0001', createdAt: ago(20), lastActivityAt: ago(5) },
  }));
  return dir;
};

const context = (profileDir: string, pushes: string[]): HandlerContext => ({
  profileDirOrNull: () => profileDir,
  profileDir: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
  push: (channel) => { pushes.push(channel); },
});

/** The bot's side in process: the daemon's resolver (`answerNameRequests`) on a fake Slack, as `jobsHandlers`' `ask`. */
const daemon = (slack: ReturnType<typeof fakeSlack>, asked: string[] = []) => (profileDir: string): NamesAsk => {
  const answer = answerNameRequests(createSlackNames({ token: async () => TOKEN, lookup: slack.lookup }));
  return async (ids) => { asked.push(profileDir); return { type: 'names', ...(await answer(ids)) }; };
};

test('jobs.list never waits for Slack: raw IDs first, then a push, then names', async (t) => {
  const dir = jobsProfile(t);
  const slack = fakeSlack();
  const pushes: string[] = [];
  const askedDirs: string[] = [];
  const handlers = jobsHandlers(context(dir, pushes), {
    run: async () => { throw new Error('no t3'); }, now: () => NOW,
    slackNames: { ask: daemon(slack, askedDirs), log: () => {} },
  });
  const release = slack.hold();
  const first = await handlers.list();
  assert.deepEqual(first.map((row) => [row.requester, row.requesterName, row.channel, row.channelName]), [
    ['U0EXAMPLE01', undefined, 'C0EXAMPLE01', undefined],
    ['U0OTHER0001', undefined, 'D0EXAMPLE01', DM_LABEL],
  ], 'the list came back while Slack was still answering');
  assert.deepEqual(pushes, []);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(pushes, ['jobs', 'names'], 'the screens are told to list again');
  assert.deepEqual(askedDirs, [dir], 'the bot of this profile was asked, once');

  const second = await handlers.list();
  assert.deepEqual(second.map((row) => [row.requesterName, row.channelName]), [['Sam Rivera', '#billing-alerts'], ['Ada', DM_LABEL]]);
  assert.ok(!JSON.stringify(second).includes('xoxb'), 'no token in what goes to the window');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(pushes, ['jobs', 'names'], 'cached names don\'t push again, so the screen never loops');
});

test('jobs.list with Slack refusing still lists every job, with raw IDs', async (t) => {
  const dir = jobsProfile(t);
  const slack = fakeSlack();
  slack.fail('invalid_auth');
  const pushes: string[] = [];
  const handlers = jobsHandlers(context(dir, pushes), {
    run: async () => { throw new Error('no t3'); }, now: () => NOW,
    slackNames: { ask: daemon(slack), log: () => {} },
  });
  await handlers.list();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const rows = await handlers.list();
  assert.deepEqual(rows.map((row) => [row.requester, row.requesterName]), [['U0EXAMPLE01', undefined], ['U0OTHER0001', undefined]]);
  assert.deepEqual(pushes, []);
});

test('settings.peopleNames never waits: known names now, a push when the bot finds the rest', async (t) => {
  const dir = jobsProfile(t);
  const slack = fakeSlack();
  const pushes: string[] = [];
  const asked: string[] = [];
  const ctx = context(dir, pushes);
  const { settings } = createHandlers(ctx, profileSlackNames(ctx, { ask: daemon(slack, asked), log: () => {} }));
  const release = slack.hold();
  assert.deepEqual(await settings.peopleNames(['U0EXAMPLE01', 'U0OTHER0001', 'U0EXAMPLE01', 'not an id', 'C0EXAMPLE01']), {}, 'nothing known yet');
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(pushes, ['jobs', 'names'], 'People is told to ask again');
  assert.deepEqual(slack.calls.sort(), ['U0EXAMPLE01', 'U0OTHER0001'], 'only member IDs, each once');
  assert.deepEqual(await settings.peopleNames(['U0EXAMPLE01', 'U0OTHER0001', 'U0NOBODY001']), { U0EXAMPLE01: 'Sam Rivera', U0OTHER0001: 'Ada' });
  await assert.rejects(async () => settings.peopleNames('U0EXAMPLE01' as unknown as string[]), /list of Slack member IDs/);
});

test('Jobs and People share one names cache: a name Jobs found shows in People without asking the bot again', async (t) => {
  const dir = jobsProfile(t);
  const slack = fakeSlack();
  const asked: string[] = [];
  const ctx = context(dir, []);
  const handlers = createHandlers(ctx, profileSlackNames(ctx, { ask: daemon(slack, asked), log: () => {} }));
  const rows = await handlers.jobs.list();
  assert.ok(rows.some((row) => row.requester === 'U0EXAMPLE01'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const calls = asked.length;
  const names = await handlers.settings.peopleNames(['U0EXAMPLE01']);
  assert.deepEqual(names, { U0EXAMPLE01: 'Sam Rivera' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked.length, calls, 'a fresh name is not asked for again');
  assert.ok(!JSON.stringify(names).includes('xoxb'), 'no token in what goes to the window');
});

const row = (fields: Partial<JobRow> = {}): JobRow => ({
  key: 'C0EXAMPLE01:1.0', group: 'running', requester: 'U0EXAMPLE01', channel: 'C0EXAMPLE01', title: 'Fix the invoice total',
  createdAt: ago(10), lastActivityAt: ago(1), links: {}, ...fields,
});

test('screen: a row shows names once known, raw IDs until then, and an app task says "Serra app"', () => {
  assert.deepEqual(rowParts(row()).requester, 'U0EXAMPLE01');
  assert.deepEqual(rowParts(row()).channel, 'C0EXAMPLE01');
  const named = rowParts(row({ requesterName: 'Sam Rivera', channelName: '#billing-alerts' }));
  assert.deepEqual([named.requester, named.channel], ['Sam Rivera', '#billing-alerts']);
  const task = rowParts(row({ requester: 'Sam Rivera', channel: 'app' }));
  assert.deepEqual([task.requester, task.channel], ['Sam Rivera', APP_TASK_CHANNEL_LABEL]);
});

test('screen: the channel filter shows names, keeps IDs as values, and sorts by what it shows', () => {
  const rows = [
    row({ channel: 'C0EXAMPLE01', channelName: '#billing-alerts' }),
    row({ channel: 'G0PRIVATE01' }),
    row({ channel: 'app' }),
    row({ channel: 'D0EXAMPLE01', channelName: DM_LABEL }),
  ];
  assert.deepEqual(channelChoices(rows, 'C9GONE00001'), [
    { value: 'C0EXAMPLE01', label: '#billing-alerts' },
    { value: 'C9GONE00001', label: 'C9GONE00001' },
    { value: 'D0EXAMPLE01', label: DM_LABEL },
    { value: 'G0PRIVATE01', label: 'G0PRIVATE01' },
    { value: 'app', label: APP_TASK_CHANNEL_LABEL },
  ]);
});

test('notifications say who asked and where once the names are known, and never show raw IDs', () => {
  const job: JobSummary = { ...row(), requesterName: 'Sam Rivera', channelName: '#billing-alerts' };
  const plan = { kind: 'needs-owner' as const, id: 'x', key: job.key };
  assert.equal(notificationText(plan, job).body, 'Sam Rivera in #billing-alerts · Fix the invoice total');
  assert.equal(notificationText(plan, { ...job, channelName: DM_LABEL }).body, 'Sam Rivera · Fix the invoice total');
  assert.equal(notificationText(plan, { ...job, requesterName: undefined, channelName: undefined }).body, 'Fix the invoice total');
  assert.equal(notificationText({ kind: 'failure', id: 'x', key: job.key, error: 'tests failed' }, job).body,
    'Sam Rivera in #billing-alerts · Fix the invoice total — tests failed');
});

// ---------------------------------------------------------------------------------------------------------------
// Slack scopes
// ---------------------------------------------------------------------------------------------------------------

test('both manifests ask for the scopes the name lookups need', () => {
  const json = JSON.parse(readFileSync(join(codeRoot, 'templates/manifest.json'), 'utf8')) as { oauth_config: { scopes: { bot: string[] } } };
  const yaml = readFileSync(join(codeRoot, 'manifest.yaml'), 'utf8');
  for (const scope of ['users:read', 'channels:read', 'groups:read', 'mpim:read']) {
    assert.ok(json.oauth_config.scopes.bot.includes(scope), `templates/manifest.json has ${scope}`);
    assert.match(yaml, new RegExp(`^\\s+- ${scope}$`, 'm'), `manifest.yaml has ${scope}`);
  }
  const yamlScopes = [...yaml.matchAll(/^ {6}- ([a-z_]+:[a-z_]+)$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(yamlScopes, [...json.oauth_config.scopes.bot].sort(), 'the two manifests ask for the same scopes');
});

// ---------------------------------------------------------------------------------------------------------------
// R13: the app task's brief
// ---------------------------------------------------------------------------------------------------------------

test('renderBrief leaves out an empty parenthesised field, and keeps every other placeholder as before', () => {
  assert.equal(renderBrief('{{A}} asked ({{B}}):', { A: 'Sam', B: '' }), 'Sam asked:');
  assert.equal(renderBrief('{{A}} asked ({{B}}):', { A: 'Sam', B: ' ' }), 'Sam asked:');
  assert.equal(renderBrief('{{A}} asked ({{B}}):', { A: 'Sam', B: 'https://x.slack.com/p1' }), 'Sam asked (https://x.slack.com/p1):');
  assert.equal(renderBrief('[{{B}}] ({{B}}', { B: '' }), '[] (');
  assert.equal(renderBrief('({{B}})', { B: 'x' }), '(x)');
  // Still one pass: a value that looks like a placeholder stays text.
  assert.equal(renderBrief('{{A}} ({{B}})', { A: '{{B}}', B: '' }), '{{B}}');
  assert.throws(() => renderBrief(' ({{NOPE}})', {}), /Unknown brief placeholder: NOPE/);
});

test('R13: an app task reads "<owner> asked:", with the configured owner name and no "None." placeholder', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-names-brief-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Sam Rivera', slackUserId: 'U0EXAMPLE01', githubLogin: 'sam' },
    project: { path: '/Users/you/acme-billing', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/billing' }, allowedUsers: [],
  }));
  const config = loadConfig({ profileDir: dir, env: {} });
  const template = readFileSync(join(codeRoot, 'templates/brief.md'), 'utf8');
  const brief = fillBriefText(template, config, 'index', taskBriefInput(config, 'Fix the invoice total'));
  assert.match(brief, /^Sam Rivera \(your owner\) asked:$/m);
  assert.ok(!brief.includes('(None. The owner') && !brief.includes('asked ()'), brief.split('\n')[2]);
  assert.match(brief, /Sam Rivera started this task in the Serra app, not in Slack/);
  // A Slack job keeps its link.
  const slack = fillBriefText(template, config, 'index', { request: 'hi', requester: 'Ada', permalink: 'https://acme.slack.com/archives/C1/p1', thread: NO_THREAD });
  assert.match(slack, /^Ada asked \(https:\/\/acme\.slack\.com\/archives\/C1\/p1\):$/m);
});

// ---------------------------------------------------------------------------------------------------------------
// Alerts: a bot as the requester, and Slack mrkdwn in the title
// ---------------------------------------------------------------------------------------------------------------

test('a bot ID is named through bots.info, and a lookup without bot support leaves it raw', async () => {
  const slack = fakeSlack();
  const names = createSlackNames({ token: async () => TOKEN, lookup: slack.lookup });
  assert.equal(names.userName('B0MONITOR01'), undefined);
  assert.equal(await names.request({ users: ['B0MONITOR01', 'U0EXAMPLE01'] }), true);
  assert.equal(names.userName('B0MONITOR01'), 'Acme Monitor');
  assert.equal(names.userName('U0EXAMPLE01'), 'Sam Rivera');

  const old = createSlackNames({ token: async () => TOKEN, lookup: async () => ({ user: async () => null, channel: async () => null }), log: () => {} });
  assert.equal(await old.request({ users: ['B0MONITOR01'] }), false);
  assert.equal(old.userName('B0MONITOR01'), undefined);
});

test('slackPlainText reads mrkdwn as plain text', () => {
  const names = { user: (id: string) => USERS[id], channel: (id: string) => CHANNELS[id] };
  assert.equal(slackPlainText(':red_circle: *[prod] acme-api* · `TypeError: Cannot read'), '🔴 [prod] acme-api · TypeError: Cannot read', 'a T3 title cut mid-code');
  assert.equal(slackPlainText('See <https://grafana.example/d/1|the dashboard> or <https://grafana.example/d/2>'), 'See the dashboard or https://grafana.example/d/2');
  assert.equal(slackPlainText('cc <@U0EXAMPLE01> in <#C0EXAMPLE01|billing-alerts> <!here>', names), 'cc @Sam Rivera in #billing-alerts @here');
  assert.equal(slackPlainText('cc <@U0UNKNOWN01> in <#C0UNKNOWN01>', names), 'cc @U0UNKNOWN01 in #C0UNKNOWN01', 'unknown IDs stay, without markup');
  assert.equal(slackPlainText('_italic_ ~gone~ *Error rate* > 5% (_last 10m_)'), 'italic gone Error rate > 5% (last 10m)');
  assert.equal(slackPlainText('2 * 3 = 6 in snake_case_name :not_an_emoji:'), '2 * 3 = 6 in snake_case_name', 'plain asterisks and underscores stay');
  assert.equal(slackPlainText('&lt;b&gt; &amp;lt; <!date^1700000000^{date}|Nov 14>'), '<b> &lt; Nov 14', 'entities decode once, after the markup');
  assert.deepEqual(slackMentions('<@U0EXAMPLE01> <@U0EXAMPLE01> <#C0EXAMPLE01|x> <https://a.example>'), { users: ['U0EXAMPLE01'], channels: ['C0EXAMPLE01'] });
});

test('jobs.list shows an alert as the bot\'s name with a readable title, and links the PR T3 recorded', async (t) => {
  const dir = jobsProfile(t);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    'C0EXAMPLE01:1700000000.000003': { t3ThreadId: 'hero', channel: 'C0EXAMPLE01', threadTs: '1700000000.000003', requester: 'B0MONITOR01', createdAt: ago(30), lastActivityAt: ago(2) },
  }));
  const slack = fakeSlack();
  const pushes: string[] = [];
  const t3 = async (_cmd: string, args: string[]): Promise<string> => JSON.stringify({ thread: {
    threadId: args.at(-1),
    title: 'Friday: :red_circle: *[prod] acme-api* · `TypeError: Cannot read',
    link: 'https://t3.example/hero',
    linkedPullRequest: null,
    pullRequests: [{ host: 'github.com', repository: 'acme/billing', number: 1, url: 'https://github.com/acme/billing/pull/1', source: 'created', state: 'open' }],
  } });
  const handlers = jobsHandlers(context(dir, pushes), { run: t3, now: () => NOW, slackNames: { ask: daemon(slack), log: () => {} } });
  await handlers.list();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [hero] = await handlers.list();
  assert.equal(hero!.requester, 'B0MONITOR01', 'the ID stays for the filter and the key');
  assert.equal(hero!.requesterName, 'Acme Monitor');
  assert.equal(hero!.title, '🔴 [prod] acme-api · TypeError: Cannot read');
  assert.equal(hero!.links.pr, 'https://github.com/acme/billing/pull/1');
  assert.equal(rowParts(hero!).requester, 'Acme Monitor');
  assert.equal(notificationText({ kind: 'needs-owner', id: 'n', key: hero!.key }, hero).body, 'Acme Monitor in #billing-alerts · 🔴 [prod] acme-api · TypeError: Cannot read');
});
