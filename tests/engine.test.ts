// The engine (src/handlers) on its own, the way a server runs it: no Electron and nothing from app/, just a core
// context over profile folders. Linux CI runs this file with the rest of the core.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeMethods } from '../src/api.ts';
import type { CoreContext, HostPort } from '../src/handlers/context.ts';
import { createEngine, invokeHandler } from '../src/handlers/index.ts';
import { SETUP_INCOMPLETE, SetupIncomplete } from '../src/setup-incomplete.ts';
import { stoppedStatusSource } from '../src/status-source.ts';
import { testProfile } from './fakes/profile.ts';

/** A headless engine's context: the profile in use, what it was asked to select, and a host that records what it did. */
const headless = (profileDir: string | null, host: Partial<HostPort> = {}) => {
  let current = profileDir;
  const selected: { dir: string | null; setupFinished: boolean }[] = [];
  const opened: string[] = [];
  const context: CoreContext = {
    profileDirOrNull: () => current,
    profileDir: () => {
      if (!current) throw new SetupIncomplete();
      return current;
    },
    selectProfile: (dir, options) => { selected.push({ dir, setupFinished: options?.setupFinished === true }); current = dir; },
    status: stoppedStatusSource(),
    runtime: { version: '0.0.0', platform: 'linux' },
    host: { openPath: async (path) => { opened.push(path); }, ...host },
  };
  return { context, selected, opened };
};

test('the engine answers every namespace of the API but the Mac’s own (app, servers), with no app around', async (t) => {
  const { root } = testProfile(t);
  const engine = createEngine(headless(root).context);
  const own = (name: string): boolean => name === 'app' || name === 'servers' || name === 'moves';
  const namespaces = Object.keys(bridgeMethods).filter((name) => !own(name));
  assert.deepEqual(Object.keys(engine).sort(), namespaces.sort());
  for (const [namespace, methods] of Object.entries(bridgeMethods)) {
    if (own(namespace)) continue;
    for (const method of methods) assert.equal(typeof Reflect.get(Reflect.get(engine, namespace), method), 'function', `${namespace}.${method}`);
  }
  // A few reads across the screens, straight from the profile's files.
  assert.equal((await engine.settings.read()).bot.name, 'Friday');
  assert.match(await engine.brief.read('brief'), /\S/);
  assert.ok(Array.isArray(await engine.pages.list()));
  assert.deepEqual(await engine.proposals.list(), []);
  assert.equal((await engine.meetings.settings()).enabled, false);
  assert.deepEqual(await engine.diagnostics.logTail(10), []);
  assert.ok((await engine.setup.progress()).steps.length > 0);
});

test('an engine given a profiles folder finds and lists profiles there, never in ~/.local/share/serra', async (t) => {
  // The packaged smoke test runs on a Mac that may have its own bots: it gives the engine a throwaway folder.
  const { root: made } = testProfile(t);
  const profileRoot = mkdtempSync(join(tmpdir(), 'serra-profiles-'));
  t.after(() => rmSync(profileRoot, { recursive: true, force: true }));
  cpSync(made, join(profileRoot, 'friday'), { recursive: true });
  const engine = createEngine({ ...headless(null).context, profileRoot });
  const detection = await engine.setup.detect();
  assert.equal(detection.profileRoot, profileRoot);
  assert.deepEqual(detection.others.map((profile) => profile.profileDir), [join(profileRoot, 'friday')]);
  assert.deepEqual((await engine.profiles.list()).profiles.map((profile) => [profile.ref, profile.name]), [['local/friday', 'Friday']]);
});

test('a call comes back as a value or a message: never a stack, no profile as setup, nothing outside the API', async (t) => {
  const { root } = testProfile(t);
  const engine = createEngine(headless(root).context);
  const read = await invokeHandler(engine, 'settings', 'read', []);
  assert.equal(read.ok, true);
  const refused = await invokeHandler(engine, 'settings', 'saveSection', ['nope', 1]);
  assert.ok(!refused.ok && /^Unknown profile section: nope\./.test(refused.error) && !refused.error.includes(' at '), JSON.stringify(refused));
  assert.deepEqual(Object.keys(refused).sort(), ['error', 'ok']);
  // Without a profile the window shows its setup state, so the code goes with the message.
  const none = await invokeHandler(createEngine(headless(null).context), 'settings', 'read', []);
  assert.deepEqual(none, { ok: false, error: new SetupIncomplete().message, code: SETUP_INCOMPLETE });
  // Only the API's own methods can be called: not `app`, which the Mac app answers, and nothing else on an object.
  for (const [namespace, method] of [['app', 'info'], ['settings', 'toString'], ['settings', 'constructor'], ['__proto__', 'toString'], ['jobs', 'nope']] as const) {
    assert.deepEqual(await invokeHandler(engine, namespace, method, []), { ok: false, error: `No handler for ${namespace}.${method}.` });
  }
});

test('the engine reaches the person’s computer only through context.host', async (t) => {
  const { root } = testProfile(t);
  const agent = { name: 'Local agent', command: '/Users/you/bin/agent', args: ['--acp'] };
  // No dialog to ask in: a command the window asked to add is not added.
  const bare = headless(root);
  await assert.rejects(Promise.resolve(createEngine(bare.context).meetings.addAcpAgent(agent)), /Not added/);
  assert.equal(existsSync(join(root, 'agent-backend.json')), false);
  // With one, the owner sees the exact command, and only their yes adds it.
  const asked: string[] = [];
  const answered = headless(root, { confirm: async ({ detail }) => { asked.push(detail); return true; } });
  const engine = createEngine(answered.context);
  const view = await engine.meetings.addAcpAgent(agent);
  assert.match(asked[0] ?? '', /\/Users\/you\/bin\/agent --acp/);
  assert.ok(view.agents.some((entry) => entry.name === 'Local agent'));
  // Opening a file is the host's: the engine names it, the host opens it.
  await engine.meetings.openAgentBackendConfig();
  assert.deepEqual(answered.opened, [join(root, 'agent-backend.json')]);
  assert.match(readFileSync(join(root, 'agent-backend.json'), 'utf8'), /Local agent/);
});

test('the engine selects a profile through the core context, which keeps it', async (t) => {
  const first = testProfile(t).root;
  const second = testProfile(t).root;
  const { context, selected } = headless(first);
  const engine = createEngine(context);
  const detection = await engine.setup.useProfile(second);
  assert.deepEqual(selected, [{ dir: second, setupFinished: false }]);
  assert.equal(detection.selected?.profileDir, second);
  assert.equal(context.profileDir(), second);
});
