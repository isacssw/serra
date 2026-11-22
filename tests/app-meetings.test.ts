// Settings › Meetings in the main process (SERRA-69): what the screen reads when it opens, and the one place a model
// call may start, the owner's Test button. Fakes only: no T3 run, no model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { meetingsHandlers } from '../app/main/ipc/meetings.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { writeProfileFile, type Profile } from '../src/config.ts';
import type { MeetingRunOptions } from '../src/meeting-runs.ts';
import { t3Providers } from '../src/t3-providers.ts';

const setup = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'serra-app-meetings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const profile: Profile = {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: join(root, 'project'), remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
    worker: { provider: 'cursor', model: 'composer-2' }, t3Bin: join(root, 'missing-t3'),
  };
  writeProfileFile(profileDir, profile);
  const context: HandlerContext = {
    profileDir: () => profileDir, profileDirOrNull: () => profileDir, prefs: memoryPrefs(), status: stoppedStatusSource(),
    runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
    openExternal: async () => {}, openPath: async () => {},
  };
  const made: MeetingRunOptions[] = [];
  const tested: string[] = [];
  const handlers = meetingsHandlers(context, {
    readProviders: () => t3Providers({ providerInstances: { cursor: { driver: 'cursor', enabled: true } } }),
    runs: (options) => {
      made.push(options);
      return {
        fetchTranscript: async () => { throw new Error('not in this test'); },
        extract: async () => { throw new Error('not in this test'); },
        checkSource: async (provider) => { tested.push(provider); return { provider, state: 'ready', detail: 'ok' }; },
      };
    },
  });
  return { handlers, made, tested, root };
};

test('opening Settings › Meetings reads files only: no T3 run, every source untested', async (t) => {
  const f = setup(t);
  const view = await f.handlers.sources();
  assert.equal(f.made.length, 0, 'no T3 run was even set up');
  assert.deepEqual(view.sources.map((entry) => [entry.provider, entry.state]), [['granola', 'untested'], ['google-meet', 'untested']]);
  assert.equal(view.runner.ready, false, 'the profile points at a t3 command that isn\'t there');
  assert.match(view.runner.detail, /can't find T3 Code/);
});

test('Test runs one check on the profile\'s T3 provider and model, and only for a known source', async (t) => {
  const f = setup(t);
  assert.deepEqual(await f.handlers.testSource('granola'), { provider: 'granola', state: 'ready', detail: 'ok' });
  assert.deepEqual(f.tested, ['granola']);
  assert.equal(f.made[0]!.provider, 'cursor');
  assert.equal(f.made[0]!.model, 'composer-2');
  assert.equal(f.made[0]!.t3Bin, join(f.root, 'missing-t3'));
  await assert.rejects(async () => f.handlers.testSource('zoom' as never), /Pick Granola or Google Meet/);
  assert.deepEqual(f.tested, ['granola']);
});
