import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig, type Profile } from '../src/config.ts';
import { runCli } from '../src/manage.ts';
import {
  checkSecret, readSecretsFile, resolveConfiguredSecretSync, scrub, SECRETS_FILE, secretStatus, setSecret, slackWorkspace,
  type SecretTools, type SlackVerify,
} from '../src/secrets.ts';
import { createProfile } from '../src/setup.ts';

const BOT = 'xoxb-1111-2222-fixturevalue';
const APP = 'xapp-1-A111-2222-fixturevalue';

const profile = (): Profile => ({
  version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
  project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
});

/** A node script run as a binary. Plain JS: it runs outside the repo, without type stripping. */
const script = (path: string, body: string): string => {
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return path;
};

/**
 * Fake `security` and `op` backed by JSON files. `security -i` reads `add-generic-password` lines on stdin like the
 * real one; `find-generic-password` exits 44 for a missing item.
 */
const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'profile');
  createProfile(dir, profile());
  writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const keychain = join(root, 'keychain.json');
  const vault = join(root, 'vault.json');
  const calls = join(root, 'calls.log');
  writeFileSync(keychain, '{}');
  writeFileSync(vault, '{}');
  const security = script(join(bin, 'security'), `
const fs = require('node:fs');
const store = ${JSON.stringify(keychain)};
fs.appendFileSync(${JSON.stringify(calls)}, 'security ' + process.argv.slice(2).join(' ') + '\\n');
const items = JSON.parse(fs.readFileSync(store, 'utf8'));
const opt = (args, flag) => args[args.indexOf(flag) + 1];
let args = process.argv.slice(2);
if (args[0] === '-i') {
  const line = fs.readFileSync(0, 'utf8').trim();
  args = (line.match(/"[^"]*"|\\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
  if (args[0] !== 'add-generic-password') { process.stderr.write('unknown command\\n'); process.exit(1); }
  items[opt(args, '-s') + '/' + opt(args, '-a')] = opt(args, '-w');
  fs.writeFileSync(store, JSON.stringify(items));
  process.exit(0);
}
const key = opt(args, '-s') + '/' + opt(args, '-a');
if (!(key in items)) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); process.exit(44); }
process.stdout.write(args.includes('-w') ? items[key] + '\\n' : 'keychain: "login.keychain-db"\\nclass: "genp"\\n');
`);
  const op = script(join(bin, 'op'), `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, 'op ' + process.argv.slice(2).join(' ') + '\\n');
const items = JSON.parse(fs.readFileSync(${JSON.stringify(vault)}, 'utf8'));
const ref = process.argv[process.argv.length - 1];
if (!(ref in items)) { process.stderr.write('[ERROR] could not read secret ' + JSON.stringify(ref) + ': not found\\n'); process.exit(1); }
process.stdout.write(items[ref]);
`);
  const tools: Partial<SecretTools> = { security, op, timeoutMs: 5_000 };
  return {
    dir, bin, tools,
    keychain: () => JSON.parse(readFileSync(keychain, 'utf8')) as Record<string, string>,
    putVault: (ref: string, value: string) => writeFileSync(vault, JSON.stringify({ ...JSON.parse(readFileSync(vault, 'utf8')), [ref]: value })),
    calls: () => { try { return readFileSync(calls, 'utf8'); } catch { return ''; } },
  };
};

const passing: SlackVerify = async (name) => (name === 'SLACK_BOT_TOKEN' ? { url: 'https://acme.slack.com/', team: 'Acme' } : {});

test('a profile with only .env still loads its tokens and never runs security or op', (t) => {
  const f = fixture(t);
  const config = loadConfig({ profileDir: f.dir, env: {} });
  assert.equal(config.botToken, BOT);
  assert.equal(config.appToken, APP);
  assert.equal(f.calls(), '');
});

test('setSecret stores a Keychain value through stdin, never argv, and loadConfig resolves it', async (t) => {
  const f = fixture(t);
  const status = await setSecret(f.dir, 'SLACK_BOT_TOKEN', { kind: 'keychain', service: 'dev.serra.friday', account: 'SLACK_BOT_TOKEN' }, BOT, { tools: f.tools });
  assert.deepEqual(status, { name: 'SLACK_BOT_TOKEN', source: { kind: 'keychain', service: 'dev.serra.friday', account: 'SLACK_BOT_TOKEN' }, set: true, verifiedAt: null, error: null });
  assert.equal(f.keychain()['dev.serra.friday/SLACK_BOT_TOKEN'], BOT);
  assert.doesNotMatch(f.calls(), /fixturevalue/, 'the value must not be on any command line');
  const saved = readFileSync(join(f.dir, SECRETS_FILE), 'utf8');
  assert.doesNotMatch(saved, /fixturevalue/);
  assert.equal(statSync(join(f.dir, SECRETS_FILE)).mode & 0o777, 0o600);
  assert.equal(resolveConfiguredSecretSync(f.dir, 'SLACK_BOT_TOKEN', { security: f.tools.security!, op: f.tools.op!, timeoutMs: 5_000 }), BOT);
  // .env no longer matters for that token.
  writeFileSync(join(f.dir, '.env'), `SLACK_APP_TOKEN=${APP}\n`);
  const path = process.env.PATH;
  process.env.PATH = `${f.bin}${delimiter}${path}`;
  t.after(() => { process.env.PATH = path; });
  const config = loadConfig({ profileDir: f.dir, env: {} });
  assert.equal(config.botToken, BOT);
  assert.equal(config.appToken, APP);
});

test('a 1Password reference resolves through op; a bad one fails without the value', async (t) => {
  const f = fixture(t);
  for (const reference of ['op://Private/Serra', 'op://Private//bot', 'op://Private/Serra/bot\nx', 'op://Private/Serra/ bot']) {
    await assert.rejects(setSecret(f.dir, 'SLACK_BOT_TOKEN', { kind: '1password', reference }, undefined, { tools: f.tools }), /op:\/\/vault\/item\/field/);
  }
  f.putVault('op://Private/Serra Bot/bot token', BOT);
  const status = await setSecret(f.dir, 'SLACK_BOT_TOKEN', { kind: '1password', reference: 'op://Private/Serra Bot/bot token' }, undefined, { tools: f.tools });
  assert.equal(status.set, true);
  assert.equal(f.calls(), '', 'pointing at a reference must not open 1Password');
  const tools = { ...f.tools } as SecretTools;
  assert.equal(resolveConfiguredSecretSync(f.dir, 'SLACK_BOT_TOKEN', tools), BOT);
  await assert.rejects(setSecret(f.dir, 'SLACK_APP_TOKEN', { kind: '1password', reference: 'op://Private/Serra/app' }, APP, { tools: f.tools }), /Only a Keychain source stores a value/);
  await setSecret(f.dir, 'SLACK_APP_TOKEN', { kind: '1password', reference: 'op://Private/Serra/missing' }, undefined, { tools: f.tools });
  const checked = await checkSecret(f.dir, 'SLACK_APP_TOKEN', { tools: f.tools, verify: passing });
  assert.match(checked.error!, /1Password \(op\) failed: \[ERROR\] could not read secret/);
});

test('a hanging tool times out and a missing binary says so; neither leaks the value', async (t) => {
  const f = fixture(t);
  const hang = script(join(f.bin, 'hang'), `process.stdout.write(${JSON.stringify(BOT)}); setTimeout(() => {}, 60_000);\n`);
  writeFileSync(join(f.dir, SECRETS_FILE), JSON.stringify({ version: 1, sources: { SLACK_BOT_TOKEN: { kind: '1password', reference: 'op://Private/Serra/bot' } } }));
  const started = Date.now();
  assert.throws(() => resolveConfiguredSecretSync(f.dir, 'SLACK_BOT_TOKEN', { security: hang, op: hang, timeoutMs: 300 }), (error: Error) => {
    assert.match(error.message, /didn't answer within 300 ms/);
    assert.doesNotMatch(error.message, /fixturevalue/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000);
  const timedOut = await checkSecret(f.dir, 'SLACK_BOT_TOKEN', { tools: { op: hang, timeoutMs: 300 }, verify: passing });
  assert.match(timedOut.error!, /didn't answer/);
  const missing = await checkSecret(f.dir, 'SLACK_BOT_TOKEN', { tools: { op: join(f.bin, 'no-such-op') }, verify: passing });
  assert.match(missing.error!, /1Password \(op\) isn't installed or isn't on PATH/);
  assert.throws(() => resolveConfiguredSecretSync(f.dir, 'SLACK_BOT_TOKEN', { security: 'x', op: join(f.bin, 'no-such-op'), timeoutMs: 1_000 }), /isn't installed/);
  assert.doesNotMatch(readFileSync(join(f.dir, SECRETS_FILE), 'utf8'), /fixturevalue/);
});

test('a tool that fails while echoing the value has it scrubbed from the error', async (t) => {
  const f = fixture(t);
  const leaky = script(join(f.bin, 'leaky'), `process.stdout.write('plain-secret-123'); process.stderr.write('oops plain-secret-123 and ${BOT}\\n'); process.exit(2);\n`);
  writeFileSync(join(f.dir, SECRETS_FILE), JSON.stringify({ version: 1, sources: { SLACK_BOT_TOKEN: { kind: 'keychain', service: 'svc', account: 'acct' } } }));
  assert.throws(() => resolveConfiguredSecretSync(f.dir, 'SLACK_BOT_TOKEN', { security: leaky, op: leaky, timeoutMs: 5_000 }), (error: Error) => {
    assert.match(error.message, /Keychain \(security\) failed: oops \[hidden\] and \[hidden\]/);
    return true;
  });
  // A source that resolves to something that isn't a token is refused without echoing it.
  const odd = script(join(f.bin, 'odd'), `process.stdout.write('not-a-token-value');\n`);
  assert.throws(() => resolveConfiguredSecretSync(f.dir, 'SLACK_BOT_TOKEN', { security: odd, op: odd, timeoutMs: 5_000 }), (error: Error) => {
    assert.match(error.message, /isn't a real xoxb- token/);
    assert.doesNotMatch(error.message, /not-a-token-value/);
    return true;
  });
  assert.equal(scrub(`token ${APP} here`), 'token [hidden] here');
});

test('loadConfig resolves tokens lazily: a broken source fails only where a token is used', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, SECRETS_FILE), JSON.stringify({ version: 1, sources: { SLACK_APP_TOKEN: { kind: 'keychain', service: 'svc', account: 'acct' } } }));
  const config = loadConfig({ profileDir: f.dir, env: {} });
  assert.equal(config.serviceLabel, 'dev.serra.friday');
  assert.equal(config.botToken, BOT);
  // The `security` on this machine (or none) has no such item; either way the error names the source.
  const path = process.env.PATH;
  process.env.PATH = f.bin;
  t.after(() => { process.env.PATH = path; });
  assert.throws(() => config.appToken, /Can't read SLACK_APP_TOKEN from Keychain/);
  // The process environment still overrides everything.
  assert.equal(loadConfig({ profileDir: f.dir, env: { SLACK_APP_TOKEN: 'xapp-from-env' } }).appToken, 'xapp-from-env');
});

test('checkSecret runs Slack verification, records when it passed and the workspace URL, never the value', async (t) => {
  const f = fixture(t);
  const seen: string[] = [];
  const verify: SlackVerify = async (name, token) => { seen.push(`${name}=${token}`); return passing(name, token); };
  const now = new Date('2026-11-19T10:00:00.000Z');
  const ok = await checkSecret(f.dir, 'SLACK_BOT_TOKEN', { tools: f.tools, verify, now });
  assert.deepEqual(ok, { name: 'SLACK_BOT_TOKEN', source: { kind: 'env' }, set: true, verifiedAt: now.toISOString(), error: null });
  assert.deepEqual(seen, [`SLACK_BOT_TOKEN=${BOT}`]);
  assert.deepEqual(slackWorkspace(f.dir), { url: 'https://acme.slack.com', team: 'Acme', checkedAt: now.toISOString() });

  const rejecting: SlackVerify = async () => { throw Object.assign(new Error(`An API error occurred: invalid_auth for ${BOT}`), { data: { ok: false, error: 'invalid_auth' } }); };
  const bad = await checkSecret(f.dir, 'SLACK_BOT_TOKEN', { tools: f.tools, verify: rejecting });
  assert.equal(bad.error, 'Slack rejected SLACK_BOT_TOKEN: invalid_auth');
  assert.equal(bad.verifiedAt, now.toISOString(), 'keeps when it last passed');
  const thrown: SlackVerify = async () => { throw new Error(`socket hang up near ${BOT}`); };
  const leaked = await checkSecret(f.dir, 'SLACK_BOT_TOKEN', { tools: f.tools, verify: thrown });
  assert.equal(leaked.error, "Couldn't reach Slack: socket hang up near [hidden]");

  const statuses = await secretStatus(f.dir, { tools: f.tools });
  assert.deepEqual(statuses.map((s) => [s.name, s.set, s.error !== null]), [['SLACK_BOT_TOKEN', true, true], ['SLACK_APP_TOKEN', true, false]]);
  assert.doesNotMatch(JSON.stringify(statuses) + readFileSync(join(f.dir, SECRETS_FILE), 'utf8'), /fixturevalue/);
  // Changing the source clears the old check.
  await setSecret(f.dir, 'SLACK_BOT_TOKEN', { kind: 'keychain', service: 'svc', account: 'acct' }, BOT, { tools: f.tools });
  assert.equal(readSecretsFile(f.dir).checks.SLACK_BOT_TOKEN, undefined);
});

test('secretStatus reports a missing Keychain item and placeholder .env tokens as not set', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-replace-me\n');
  await assert.rejects(setSecret(f.dir, 'SLACK_APP_TOKEN', { kind: 'keychain', service: 'svc', account: 'acct' }, undefined, { tools: f.tools }), /No Keychain item for service svc, account acct/);
  writeFileSync(join(f.dir, SECRETS_FILE), JSON.stringify({ version: 1, sources: { SLACK_APP_TOKEN: { kind: 'keychain', service: 'svc', account: 'acct' } } }));
  const statuses = await secretStatus(f.dir, { tools: f.tools });
  assert.deepEqual(statuses.map((s) => [s.name, s.source.kind, s.set, s.error]), [['SLACK_BOT_TOKEN', 'env', false, null], ['SLACK_APP_TOKEN', 'keychain', false, null]]);
  await assert.rejects(setSecret(f.dir, 'SLACK_BOT_TOKEN', { kind: 'keychain', service: '-x', account: 'a' }, BOT, { tools: f.tools }), /Keychain service/);
  await assert.rejects(setSecret(f.dir, 'SLACK_BOT_TOKEN', { kind: 'keychain', service: 's', account: 'a' }, 'xapp-wrong-kind', { tools: f.tools }), /isn't a real xoxb- token/);
  await setSecret(f.dir, 'SLACK_APP_TOKEN', { kind: 'env' }, undefined, { tools: f.tools });
  assert.deepEqual(readSecretsFile(f.dir).sources, {});
});

test('pnpm bot secrets lists sources and sets a 1Password reference without printing a value', async (t) => {
  const f = fixture(t);
  const lines: string[] = [];
  const errors: string[] = [];
  const cli = (...args: string[]) => runCli([...args, '--profile', f.dir], { log: (text) => lines.push(text), error: (text) => errors.push(text) });
  assert.equal(await cli('secrets'), 0);
  assert.deepEqual(lines, ['SLACK_BOT_TOKEN  .env  set, not checked', 'SLACK_APP_TOKEN  .env  set, not checked']);
  lines.length = 0;
  assert.equal(await cli('secrets', 'set', 'SLACK_APP_TOKEN', '--1password', 'op://Private/Serra/app'), 0);
  assert.match(lines.join('\n'), /SLACK_APP_TOKEN  1Password op:\/\/Private\/Serra\/app  set, not checked\nSLACK_APP_TOKEN now comes from 1Password. Applies after restart/);
  assert.equal(await cli('secrets', 'set', 'SLACK_APP_TOKEN', '--keychain', '--env'), 1);
  assert.equal(await cli('secrets', 'set', 'NOPE', '--env'), 1);
  assert.match(errors.join('\n'), /exactly one of[\s\S]*Unknown token: NOPE/);
  assert.doesNotMatch(lines.join('\n') + errors.join('\n'), /fixturevalue/);
});
