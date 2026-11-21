import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { restartBot, startBot, stopBot } from '../src/bot-service.ts';
import type { ServiceDriver } from '../src/deploy.ts';

const LABEL = 'dev.serra.test-bot';

/** A profile with a service label, a LaunchAgents folder and a driver that records what it was asked to do. */
const fixture = (t: TestContext, { installed = true, loaded = true } = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'serra-bot-service-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profile');
  const launchAgentsDir = join(root, 'agents');
  mkdirSync(profileDir);
  mkdirSync(launchAgentsDir);
  const example = JSON.parse(readFileSync(new URL('../examples/profile.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(profileDir, 'profile.json'), JSON.stringify({ ...example, serviceLabel: LABEL }));
  const plist = join(launchAgentsDir, `${LABEL}.plist`);
  if (installed) writeFileSync(plist, 'plist');
  const calls: string[] = [];
  let isLoaded = loaded;
  const driver: ServiceDriver = {
    loaded: async (label) => { calls.push(`loaded ${label}`); return isLoaded; },
    stop: async (label) => { calls.push(`stop ${label}`); isLoaded = false; },
    start: async (path) => { calls.push(`start ${path}`); isLoaded = true; },
    ready: async (directory) => { calls.push(`ready ${directory}`); },
  };
  return { profileDir, plist, calls, options: { driver, launchAgentsDir } };
};

test('restart stops the running service, loads it again and waits for ready', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.profileDir, 'ready.json'), '{"pid":1}');
  await restartBot(f.profileDir, f.options);
  assert.deepEqual(f.calls, [`stop ${LABEL}`, `start ${f.plist}`, `ready ${f.profileDir}`]);
  assert.equal(existsSync(join(f.profileDir, 'ready.json')), false, 'an old ready marker must not count as the new daemon');
});

test('restart of a stopped bot starts it', async (t) => {
  const f = fixture(t, { loaded: false });
  await restartBot(f.profileDir, f.options);
  assert.ok(f.calls.includes(`start ${f.plist}`));
});

test('restart without an installed service refuses before stopping anything', async (t) => {
  const f = fixture(t, { installed: false });
  await assert.rejects(restartBot(f.profileDir, f.options), /isn't installed\. Activate a release first/);
  assert.deepEqual(f.calls, []);
});

test('start refuses a running bot and loads a stopped one', async (t) => {
  const running = fixture(t);
  await assert.rejects(startBot(running.profileDir, running.options), /already running/);
  const stopped = fixture(t, { loaded: false });
  await startBot(stopped.profileDir, stopped.options);
  assert.deepEqual(stopped.calls, [`loaded ${LABEL}`, `start ${stopped.plist}`]);
});

test('stop goes through the driver with the profile service label', async (t) => {
  const f = fixture(t);
  await stopBot(f.profileDir, f.options);
  assert.deepEqual(f.calls, [`stop ${LABEL}`]);
});

test('start, stop and restart wait out a release switch: they refuse while it holds the deployment lock', async (t) => {
  const f = fixture(t);
  // A live process (this one) holds the lock, as activate() does during a switch.
  writeFileSync(join(f.profileDir, 'deployment.lock'), String(process.pid));
  for (const action of [restartBot, stopBot, startBot]) {
    await assert.rejects(action(f.profileDir, f.options), /switching to another version/);
  }
  assert.deepEqual(f.calls, [], 'launchd was not touched');
  rmSync(join(f.profileDir, 'deployment.lock'));
  await stopBot(f.profileDir, f.options);
  assert.equal(existsSync(join(f.profileDir, 'deployment.lock')), false, 'the lock is released afterwards');
});
