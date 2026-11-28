import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBridge, type InvokeResult } from '../app/main/bridge.ts';
import { registerHandlers, type IpcRegistrar } from '../app/main/router.ts';
import { secretsHandlers } from '../src/handlers/secrets.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../src/status-source.ts';
import {
  ago, draftFor, isDirty, saveRequest, sourceDetail, statusLine, statusPill,
} from '../app/renderer/screens/secrets.logic.ts';
import type { Profile } from '../src/config.ts';
import type { SecretStatus } from '../src/contracts.ts';
import type { SecretTools, SlackVerify } from '../src/secrets.ts';
import { createProfile } from '../src/setup.ts';
import { createHandlers, engineContext, type AppContext } from './fakes/app-context.ts';

const BOT = 'xoxb-1111-2222-fixturevalue';
const APP = 'xapp-1-A111-2222-fixturevalue';
const NEW_BOT = 'xoxb-3333-4444-typedvalue';
const REF = 'op://Vault/serra/bot-token';
const APP_PAGE = 'file:///Users/you/serra/app/out/renderer/index.html';

const profile = (): Profile => ({
  version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
  project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
});

const script = (path: string, body: string): string => {
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return path;
};

/** A profile with `.env` tokens, plus fake `security` and `op` backed by JSON files. */
const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-app-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'profile');
  createProfile(dir, profile());
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const keychain = join(root, 'keychain.json');
  writeFileSync(keychain, '{}');
  const security = script(join(bin, 'security'), `
const fs = require('node:fs');
const items = JSON.parse(fs.readFileSync(${JSON.stringify(keychain)}, 'utf8'));
const opt = (args, flag) => args[args.indexOf(flag) + 1];
let args = process.argv.slice(2);
if (args[0] === '-i') {
  args = (fs.readFileSync(0, 'utf8').trim().match(/"[^"]*"|\\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
  items[opt(args, '-s') + '/' + opt(args, '-a')] = opt(args, '-w');
  fs.writeFileSync(${JSON.stringify(keychain)}, JSON.stringify(items));
  process.exit(0);
}
const key = opt(args, '-s') + '/' + opt(args, '-a');
if (!(key in items)) { process.stderr.write('security: The specified item could not be found in the keychain.\\n'); process.exit(44); }
process.stdout.write(args.includes('-w') ? items[key] + '\\n' : 'class: "genp"\\n');
`);
  const op = script(join(bin, 'op'), `
const ref = process.argv[process.argv.length - 1];
if (ref !== ${JSON.stringify(REF)}) { process.stderr.write('[ERROR] could not read secret: not found\\n'); process.exit(1); }
process.stdout.write(${JSON.stringify(BOT)});
`);
  const tools: Partial<SecretTools> = { security, op, timeoutMs: 5_000 };
  return { dir, tools, keychain: () => JSON.parse(readFileSync(keychain, 'utf8')) as Record<string, string> };
};

const context = (dir: string): AppContext => ({
  profileDir: () => dir,
  profileDirOrNull: () => dir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

/** Slack accepts the fixture tokens and rejects everything else with `invalid_auth`, as `auth.test` does. */
const verify: SlackVerify = async (_name, token) => {
  if (token === BOT || token === APP) return { url: 'https://acme.slack.com/' };
  throw Object.assign(new Error('An API error occurred: invalid_auth'), { data: { ok: false, error: 'invalid_auth' } });
};

/**
 * The real IPC path: registered handlers, the window-side bridge and structured clone. Every response and every
 * error message the window receives is recorded.
 */
const wire = (dir: string, tools: Partial<SecretTools>) => {
  const ctx = context(dir);
  const handlers = { ...createHandlers(ctx), secrets: secretsHandlers(engineContext(ctx), { tools, verify }) };
  const channels = new Map<string, Parameters<IpcRegistrar['handle']>[1]>();
  registerHandlers({ handle: (channel, listener) => { channels.set(channel, listener); } }, handlers, (url) => url === APP_PAGE);
  const seen: string[] = [];
  const bridge = createBridge(async (channel, args): Promise<InvokeResult> => {
    const handler = channels.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    const result = structuredClone(await handler({ senderFrame: { url: APP_PAGE } }, ...structuredClone(args)));
    seen.push(JSON.stringify(result));
    return result;
  }, () => () => {});
  return { bridge, seen };
};

const assertNoValues = (seen: string[]) => {
  assert.ok(seen.length > 0);
  for (const response of seen) {
    for (const value of [BOT, APP, NEW_BOT, '1111-2222', '3333-4444']) assert.ok(!response.includes(value), `a bridge response contains a token value: ${response}`);
    assert.doesNotMatch(response, /x(?:oxb|app)-\w/, `a bridge response contains something token-shaped: ${response}`);
  }
};

test('no bridge response contains a secret value: list, set, check, and their errors', async (t) => {
  const f = fixture(t);
  const { bridge, seen } = wire(f.dir, f.tools);

  const listed = await bridge.secrets.list();
  assert.deepEqual(listed.map((s) => [s.name, s.source.kind, s.set]), [['SLACK_BOT_TOKEN', 'env', true], ['SLACK_APP_TOKEN', 'env', true]]);
  assert.equal((await bridge.secrets.check('SLACK_APP_TOKEN')).error, null);

  // Keychain with a typed value: stored through `security`, sent back only as a source.
  const stored = await bridge.secrets.setSource('SLACK_BOT_TOKEN', { kind: 'keychain', service: '', account: '' }, NEW_BOT);
  assert.deepEqual(stored.source, { kind: 'keychain', service: 'dev.serra.friday', account: 'SLACK_BOT_TOKEN' });
  assert.equal(stored.set, true);
  assert.equal(f.keychain()['dev.serra.friday/SLACK_BOT_TOKEN'], NEW_BOT);

  // Slack rejects the typed value: the window gets the failure text, not the token.
  const rejected = await bridge.secrets.check('SLACK_BOT_TOKEN');
  assert.match(rejected.error ?? '', /invalid_auth/);

  // 1Password reference that resolves and passes.
  const op = await bridge.secrets.setSource('SLACK_BOT_TOKEN', { kind: '1password', reference: REF });
  assert.deepEqual(op.source, { kind: '1password', reference: REF });
  const passed = await bridge.secrets.check('SLACK_BOT_TOKEN');
  assert.equal(passed.error, null);
  assert.ok(passed.verifiedAt);

  // Refusals carry a reason and never the value that came with them.
  await assert.rejects(bridge.secrets.setSource('SLACK_BOT_TOKEN', { kind: '1password', reference: REF }, NEW_BOT), (error: Error) => {
    seen.push(error.message);
    return /Only a Keychain source stores a value/.test(error.message);
  });
  await assert.rejects(bridge.secrets.setSource('SLACK_APP_TOKEN', { kind: 'keychain', service: '', account: '' }, NEW_BOT), (error: Error) => {
    seen.push(error.message);
    return /isn't a real xapp- token/.test(error.message);
  });
  await assert.rejects(bridge.secrets.setSource('SLACK_BOT_TOKEN', { kind: 'keychain', service: '', account: '' }, `${NEW_BOT} extra`), (error: Error) => {
    seen.push(error.message);
    return true;
  });
  await assert.rejects(bridge.secrets.check('NOT_A_TOKEN' as 'SLACK_BOT_TOKEN'), /Unknown token/);

  seen.push(JSON.stringify(await bridge.secrets.list()));
  assertNoValues(seen);
});

test('check shows the auth.test failure text for a bad token', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, '.env'), `SLACK_BOT_TOKEN=xoxb-9999-revoked\nSLACK_APP_TOKEN=${APP}\n`);
  const { bridge, seen } = wire(f.dir, f.tools);
  const status = await bridge.secrets.check('SLACK_BOT_TOKEN');
  assert.equal(status.error, 'Slack rejected SLACK_BOT_TOKEN: invalid_auth');
  assert.equal(status.verifiedAt, null);
  assert.deepEqual(statusLine(status, new Date()), { tone: 'error', text: 'Slack rejected SLACK_BOT_TOKEN: invalid_auth' });
  assert.ok(seen.every((response) => !response.includes('9999-revoked')));
});

test('a keychain source without a value must point at an existing item', async (t) => {
  const f = fixture(t);
  const { bridge } = wire(f.dir, f.tools);
  await assert.rejects(bridge.secrets.setSource('SLACK_APP_TOKEN', { kind: 'keychain', service: '', account: '' }), /No Keychain item for service dev\.serra\.friday/);
  await assert.rejects(bridge.secrets.setSource('SLACK_APP_TOKEN', { kind: '1password', reference: 'not-a-reference' }), /op:\/\/vault\/item\/field/);
});

// ---------------------------------------------------------------------------------------------------------------
// secrets.logic.ts
// ---------------------------------------------------------------------------------------------------------------

const NOW = new Date('2026-11-19T10:00:00.000Z');
const status = (overrides: Partial<SecretStatus> = {}): SecretStatus =>
  ({ name: 'SLACK_BOT_TOKEN', source: { kind: 'env' }, set: true, verifiedAt: null, error: null, ...overrides });

test('ago: minutes, hours and days', () => {
  assert.equal(ago('2026-11-19T09:59:30.000Z', NOW), 'just now');
  assert.equal(ago('2026-11-19T09:58:00.000Z', NOW), '2 min ago');
  assert.equal(ago('2026-11-19T07:00:00.000Z', NOW), '3 h ago');
  assert.equal(ago('2026-11-15T10:00:00.000Z', NOW), '4 d ago');
  assert.equal(ago('not a date', NOW), 'at an unknown time');
});

test('status line: verified, unchecked, missing and the last error', () => {
  assert.deepEqual(statusLine(status({ verifiedAt: '2026-11-19T09:58:00.000Z' }), NOW), { tone: 'ok', text: 'set · verified 2 min ago' });
  assert.deepEqual(statusLine(status(), NOW), { tone: 'unverified', text: 'set · not checked yet' });
  assert.deepEqual(statusLine(status({ set: false }), NOW), { tone: 'unset', text: 'not set in the profile .env' });
  assert.deepEqual(statusLine(status({ set: false, source: { kind: 'keychain', service: 's', account: 'a' } }), NOW), { tone: 'unset', text: 'no Keychain item yet' });
  assert.deepEqual(statusLine(status({ error: 'Slack rejected SLACK_BOT_TOKEN: invalid_auth', verifiedAt: '2026-11-19T09:58:00.000Z' }), NOW),
    { tone: 'error', text: 'Slack rejected SLACK_BOT_TOKEN: invalid_auth' });
});

test('save request: 1Password reference, Keychain default or kept item, .env, and form errors', () => {
  const env = status();
  assert.deepEqual(saveRequest(env, { kind: '1password', reference: ` ${REF} `, value: '' }), { source: { kind: '1password', reference: REF } });
  assert.deepEqual(saveRequest(env, { kind: '1password', reference: 'vault/item', value: '' }), { error: 'A 1Password reference looks like op://vault/item/field' });
  assert.deepEqual(saveRequest(env, { kind: 'keychain', reference: '', value: ` ${NEW_BOT}\n` }), { source: { kind: 'keychain', service: '', account: '' }, value: NEW_BOT });
  assert.deepEqual(saveRequest(env, { kind: 'keychain', reference: '', value: '' }), { source: { kind: 'keychain', service: '', account: '' } });
  assert.deepEqual(saveRequest(env, { kind: 'keychain', reference: '', value: APP }), { error: 'A Slack bot token starts with xoxb-' });
  const kept = status({ source: { kind: 'keychain', service: 'custom', account: 'bot' } });
  assert.deepEqual(saveRequest(kept, { kind: 'keychain', reference: '', value: NEW_BOT }), { source: { kind: 'keychain', service: 'custom', account: 'bot' }, value: NEW_BOT });
  assert.deepEqual(saveRequest(kept, { kind: 'env', reference: '', value: '' }), { source: { kind: 'env' } });
});

test('draft and dirty: a draft never starts with a value, and only real changes enable Save', () => {
  const op = status({ source: { kind: '1password', reference: REF } });
  assert.deepEqual(draftFor(op), { kind: '1password', reference: REF, value: '' });
  assert.equal(isDirty(op, draftFor(op)), false);
  assert.equal(isDirty(op, { ...draftFor(op), reference: 'op://Vault/other/field' }), true);
  assert.equal(isDirty(op, { ...draftFor(op), kind: 'keychain' }), true);
  const keychain = status({ source: { kind: 'keychain', service: 's', account: 'a' } });
  assert.equal(isDirty(keychain, draftFor(keychain)), false);
  assert.equal(isDirty(keychain, { ...draftFor(keychain), value: NEW_BOT }), true);
});

test('status pill: 1-3 words, with the detail kept for the meta line and tooltip', () => {
  assert.deepEqual(statusPill(status({ error: 'Slack rejected SLACK_BOT_TOKEN: invalid_auth' }), NOW), { tone: 'error', label: 'Token invalid', detail: 'Rejected by Slack' });
  assert.equal(statusPill(status({ error: "Couldn't reach Slack: offline" }), NOW).label, 'Slack unreachable');
  assert.equal(statusPill(status({ error: 'op: not signed in' }), NOW).label, 'Check failed');
  assert.deepEqual(statusPill(status({ set: false }), NOW), { tone: 'unset', label: 'Not set', detail: 'Not in the profile .env' });
  assert.deepEqual(statusPill(status({ verifiedAt: '2026-11-19T09:58:00.000Z' }), NOW), { tone: 'ok', label: 'Verified', detail: 'Checked 2 min ago' });
  assert.equal(statusPill(status(), NOW).label, 'Not checked');
});

test('source detail: the Keychain item goes in the tooltip, not on the page', () => {
  assert.equal(sourceDetail(status({ source: { kind: 'keychain', service: 'dev.serra.bot', account: 'SLACK_BOT_TOKEN' } })), 'Keychain item dev.serra.bot / SLACK_BOT_TOKEN');
  assert.equal(sourceDetail(status({ source: { kind: 'keychain', service: '', account: '' } })), 'The bot’s default Keychain item');
  assert.equal(sourceDetail(status({ source: { kind: '1password', reference: 'op://v/i/f' } })), 'op://v/i/f');
});
