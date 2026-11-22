/** A fresh profile folder per test, built by the same `createProfile` setup uses, removed after the test. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { loadConfig, type Config } from '../../src/config.ts';
import { createProfile } from '../../src/setup.ts';

export const OWNER = 'UOWNER';
export const SAM = 'USAM';
export const BOT = 'UBOT';

export type ProfileOverrides = Record<string, unknown>;

/** A profile for the bot "Friday" owned by Alex (`UOWNER`), with Sam (`USAM`) allowed. */
export const testProfile = (t: TestContext, overrides: ProfileOverrides = {}): { root: string; config: Config } => {
  const root = mkdtempSync(join(tmpdir(), 'serra-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createProfile(root, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
    project: { path: '/tmp/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [SAM], ...overrides,
  });
  writeFileSync(join(root, '.env'), 'SLACK_APP_TOKEN=xapp-a\nSLACK_BOT_TOKEN=xoxb-a');
  return { root, config: loadConfig({ profileDir: root, env: {} }) };
};
