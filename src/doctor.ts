import { accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webApi } from '@slack/bolt';
import { loadConfig, type Config } from './config.ts';
import { fillBrief } from './brief.ts';
import { createKnowledge } from './knowledge.ts';
import { createStore } from './state.ts';
import { run } from './t3.ts';
import { secretSource, sourceLabel } from './secrets.ts';
import type { SecretName } from './contracts.ts';

export interface Diagnostic { name: string; ok: boolean; detail: string }

export interface DiagnoseOptions {
  /** Skip the checks that reach T3, GitHub and Slack over the network. */
  offline?: boolean;
  /**
   * Where the Node the bot runs on is. Inside the app `process.versions.node` is Electron's bundled Node, so the
   * app passes the release's Node binary here (see `findNode` in `releases.ts`); the check then runs it for its
   * version. When absent, the check reports the Node running this code, as the CLI does.
   */
  nodeBinary?: () => Promise<string>;
  /**
   * The Slack account check: given the bot token and the owner's member ID, returns the line to show or throws.
   * Defaults to Slack's `auth.test` and `users.info`. Tests (and the first-run wizard's test) pass a fake.
   */
  slack?: SlackAccountCheck;
}

export type SlackAccountCheck = (botToken: string, owner: string) => Promise<string>;

const slackAccount: SlackAccountCheck = async (botToken, owner) => {
  const client = new webApi.WebClient(botToken, { retryConfig: { retries: 0 }, timeout: 15_000 });
  const auth = await client.auth.test();
  if (!auth.user_id) throw new Error('Slack returned no bot user ID');
  await client.users.info({ user: owner });
  return `@${auth.user} in ${auth.team}; owner found. App-token connection is checked at startup.`;
};

const nodeProblem = (version: string): string | null => {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < 22 || major === 23 || (major === 22 && minor < 18) ? 'Use Node 22.18+ on the 22.x line, or Node 24+' : null;
};

/** Read-only connectivity checks. Never opens a Socket Mode connection or starts a T3 thread. */
export const diagnose = async (config: Config, { offline = false, nodeBinary, slack = slackAccount }: DiagnoseOptions = {}): Promise<Diagnostic[]> => {
  const results: Diagnostic[] = [];
  const check = async (name: string, work: () => string | Promise<string>): Promise<void> => {
    try { results.push({ name, ok: true, detail: await work() }); }
    catch (error) { results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  await check('Node', async () => {
    if (!nodeBinary) {
      const problem = nodeProblem(process.versions.node);
      if (problem) throw new Error(problem);
      return process.versions.node;
    }
    const path = await nodeBinary();
    const version = (await run(path, ['-p', 'process.versions.node'], { timeoutMs: 5_000 })).trim();
    const problem = nodeProblem(version);
    if (problem) throw new Error(`${path} is Node ${version}. ${problem}`);
    return `${version} (${path}, the Node the bot runs on)`;
  });
  await check('Tokens', () => {
    if (!/^xoxb-.+/.test(config.botToken) || !/^xapp-.+/.test(config.appToken) || /replace-me|\.\.\./.test(config.botToken + config.appToken)) throw new Error('Set real xoxb and xapp tokens in the profile .env or with pnpm bot secrets set');
    const from = (name: SecretName): string => sourceLabel(secretSource(config.profileDir, name));
    return `Both token types present (bot token from ${from('SLACK_BOT_TOKEN')}, app token from ${from('SLACK_APP_TOKEN')}); values hidden`;
  });
  await check('Profile storage', () => {
    accessSync(dirname(config.statePath), constants.W_OK);
    createStore(config.statePath);
    return 'Writable; job state parses';
  });
  await check('Knowledge and brief', () => {
    const knowledge = createKnowledge(config.knowledgeDir);
    const report = knowledge.checkKnowledge();
    // An index over its cap doesn't stop jobs, so it doesn't fail doctor (or the install preflight that runs it).
    const blocking = report.problems.filter((problem) => problem !== report.indexOverCap);
    if (blocking.length) throw new Error(blocking.join('; '));
    fillBrief(config, knowledge.loadIndex(), { request: 'Diagnostic only', requester: 'doctor', permalink: 'none', thread: 'none' });
    const tidy = report.indexOverCap ? `. Jobs still run, but tidy it: ${report.indexOverCap}` : '';
    return `${report.pages.length} pages, ${report.unverified.length} drafts${tidy}`;
  });
  await check('Git repository and base', async () => {
    await run('git', ['-C', config.project, 'rev-parse', '--show-toplevel']);
    await run('git', ['-C', config.project, 'remote', 'get-url', config.remote]);
    await run('git', ['-C', config.project, 'rev-parse', '--verify', `${config.baseRef}^{commit}`]);
    return `${config.project}, ${config.baseRef}`;
  });
  for (const repo of config.repositories) {
    await check(`Repository ${repo.name}`, async () => {
      await run('git', ['-C', repo.path, 'rev-parse', '--verify', `${repo.baseRef}^{commit}`]);
      return repo.path;
    });
  }
  await check('Git author', async () => {
    const name = (await run('git', ['-C', config.project, 'var', 'GIT_AUTHOR_IDENT'])).trim();
    if (!name) throw new Error('Set git user.name and user.email in the project');
    return 'An author identity is configured';
  });
  await check('T3 executable', async () => { await run(config.t3Bin, ['thread', 'start', '--help']); return config.t3Bin; });
  await check('GitHub CLI', async () => { await run('gh', ['--version']); return 'Installed'; });
  if (!offline) {
    await check('T3 connection and project', async () => {
      await run(config.t3Bin, ['thread', 'list', '--project', config.project, '--json'], { timeoutMs: 15_000 });
      return 'Server reachable; project registered';
    });
    await check('GitHub account', async () => {
      const login = (await run('gh', ['api', 'user', '--jq', '.login'])).trim();
      if (config.githubLogin && login.toLowerCase() !== config.githubLogin.toLowerCase()) throw new Error(`Expected ${config.githubLogin}; gh uses ${login}`);
      return login;
    });
    await check('Slack account', () => slack(config.botToken, config.owner));
  }
  return results;
};

export const assertHealthy = async (config: Config): Promise<void> => {
  const failed = (await diagnose(config)).filter((check) => !check.ok);
  if (failed.length) throw new Error(failed.map((check) => `${check.name}: ${check.detail}`).join('\n'));
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const results = await diagnose(loadConfig(), { offline: process.argv.includes('--offline') });
    for (const check of results) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    console.log('Doctor did not connect a Slack listener, create work, or post messages.');
    if (results.some((check) => !check.ok)) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
