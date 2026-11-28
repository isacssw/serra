import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { restartBot, startBot, stopBot } from '../src/bot-service.ts';
import { activate, prepareRelease, rollback } from '../src/deploy.ts';
import { gatewayUnit, hasServiceHost, serviceHost, serviceUnit, systemdDriver, systemdHost, type ServiceDriver } from '../src/service.ts';
import { createProfile } from '../src/setup.ts';

const spec = { directory: '/home/you/.local/share/serra/friday', release: '/home/you/.local/share/serra/friday/releases/r1', label: 'dev.serra.friday', node: '/home/you/.local/share/serra/runtime/node-v24/bin/node' };

test('each supported system gets its own service manager, and others are told to run in the foreground', () => {
  assert.equal(serviceHost('darwin').kind, 'launchd');
  assert.equal(serviceHost('darwin').fileName('dev.serra.friday'), 'dev.serra.friday.plist');
  assert.equal(serviceHost('linux').kind, 'systemd');
  assert.equal(serviceHost('linux').fileName('dev.serra.friday'), 'dev.serra.friday.service');
  assert.throws(() => serviceHost('win32'), /needs macOS or Linux.*foreground/);
  assert.deepEqual(['darwin', 'linux', 'win32', 'freebsd'].map((p) => hasServiceHost(p as NodeJS.Platform)), [true, true, false, false]);
});

test('the systemd unit lives in the user config folder, and XDG_CONFIG_HOME moves it', () => {
  assert.equal(systemdHost('/home/you', {}).dir, '/home/you/.config/systemd/user');
  assert.equal(systemdHost('/home/you', { XDG_CONFIG_HOME: '/home/you/cfg' }).dir, '/home/you/cfg/systemd/user');
});

test('the gateway unit serves the profiles folder it was installed for, on the port and addresses it was given', () => {
  const unit = gatewayUnit({ node: '/usr/bin/node', entry: '/home/you/serra/src/manage.ts', root: '/srv/serra', flags: ['--port', '47821', '--listen', '100.64.0.2'] }, '/home/you');
  const exec = unit.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.match(exec ?? '', /"server" "gateway" "--root" "\/srv\/serra" "--port" "47821" "--listen" "100\.64\.0\.2"$/);
  assert.match(unit, /\/srv\/serra\/gateway\/gateway\.log/);
});

test('the systemd unit runs the release daemon for the profile, restarts it and logs to the profile', () => {
  const unit = serviceUnit(spec, '/home/you');
  assert.match(unit, /^ExecStart="\/home\/you\/.local\/share\/serra\/runtime\/node-v24\/bin\/node" ".*\/releases\/r1\/src\/index.ts" "--profile" "\/home\/you\/.local\/share\/serra\/friday"$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/you\/.local\/share\/serra\/friday\/releases\/r1$/m);
  assert.match(unit, /^Environment="HOME=\/home\/you" "PATH=\/home\/you\/.local\/share\/serra\/runtime\/node-v24\/bin:/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^TimeoutStopSec=75$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/you\/.local\/share\/serra\/friday\/logs\/bot.log$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  // Never a system unit: no User=, no root-only settings.
  assert.doesNotMatch(unit, /^User=|^ExecStartPre=\+/m);
});

test('the systemd unit quotes paths so spaces, quotes, % and $ reach the daemon unchanged', () => {
  const unit = serviceUnit({ ...spec, directory: '/home/you/My "Bots" 100% $HOME' }, '/home/you');
  assert.match(unit, /"--profile" "\/home\/you\/My \\"Bots\\" 100%% \$\$HOME"$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/you\/My "Bots" 100%% \$HOME\/logs\/bot.log$/m);
  assert.throws(() => serviceUnit({ ...spec, directory: '/home/you/a\nExecStartPre=/bin/evil' }), /line break/);
});

/** A fake `systemctl --user`: answers `show` from `state`, records every call, fails as told. */
const fakeSystemctl = (state: { active: string; pid: number }, fail?: RegExp) => {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push([cmd, ...args].join(' '));
    if (fail?.test(args.join(' '))) throw new Error(`systemctl --user exited 1: Failed to connect to bus: No medium found`);
    if (args[1] === 'show') return `ActiveState=${state.active}\nMainPID=${state.pid}\n`;
    if (args[1] === 'stop') state.active = 'inactive';
    if (args[1] === 'start') state.active = 'active';
    return '';
  };
  return { calls, driver: systemdDriver({ run }) };
};

test('the systemd driver reads loaded from the unit state, and stopping a stopped unit does nothing', async () => {
  const unit = fakeSystemctl({ active: 'inactive', pid: 0 });
  assert.equal(await unit.driver.loaded('dev.serra.friday'), false);
  await unit.driver.stop('dev.serra.friday');
  assert.deepEqual(unit.calls, Array(2).fill('systemctl --user show dev.serra.friday.service --property=ActiveState --property=MainPID'));
  const running = fakeSystemctl({ active: 'activating', pid: 0 });
  assert.equal(await running.driver.loaded('dev.serra.friday'), true);
});

test('the systemd driver enables the unit as it starts it, stops it by name, and disables a removed one', async () => {
  const unit = fakeSystemctl({ active: 'active', pid: 0 });
  await unit.driver.stop('dev.serra.friday');
  await unit.driver.start('/home/you/.config/systemd/user/dev.serra.friday.service');
  await unit.driver.forget!('/home/you/.config/systemd/user/dev.serra.friday.service');
  assert.deepEqual(unit.calls.filter((call) => !call.includes(' show ')), [
    'systemctl --user stop dev.serra.friday.service',
    'systemctl --user daemon-reload',
    'systemctl --user enable dev.serra.friday.service',
    'systemctl --user start dev.serra.friday.service',
    'systemctl --user disable dev.serra.friday.service',
    'systemctl --user daemon-reload',
  ]);
});

test('without a systemd user manager the driver says to run in the foreground', async () => {
  const unit = fakeSystemctl({ active: 'inactive', pid: 0 }, /show/);
  await assert.rejects(unit.driver.loaded('dev.serra.friday'), /systemd user services aren’t available here.*foreground/);
});

/** A profile with a prepared release, as `setup` and `prepare` leave it. */
const profile = async (t: TestContext, id: string, root: string, host = serviceHost()) => {
  const directory = join(root, 'profile'); const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', project]); execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'git@github.com:acme/project.git']);
  createProfile(directory, {
    version: 1, bot: { id, name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: project, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  // The "node" the unit runs: marks the daemon ready with its own PID, then waits like a daemon does.
  const node = join(root, 'bin/node');
  mkdirSync(join(root, 'bin'));
  writeFileSync(node, '#!/bin/sh\nmkdir -p "$3/logs"\nprintf \'{"pid":%s}\' "$$" > "$3/ready.json"\nexec sleep 3600\n');
  chmodSync(node, 0o755);
  const plan = await prepareRelease(directory, { install: false, node, host });
  mkdirSync(join(plan.release, 'node_modules/@slack/bolt'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { directory, plan };
};

test('activation on Linux installs the systemd unit the release carries, and a failed start removes it again', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'serra-systemd-')));
  const units = join(root, 'units');
  const events: string[] = [];
  let failReady = true;
  const driver: ServiceDriver = {
    loaded: async () => false, stop: async () => { events.push('stop'); }, start: async (path) => { events.push(`start ${path}`); },
    ready: async () => { if (failReady) throw new Error('bad app token'); }, forget: async (path) => { events.push(`forget ${path}`); },
  };
  const host = systemdHost(root, { XDG_CONFIG_HOME: join(root, 'config') }, driver);
  const { directory, plan } = await profile(t, 'friday', root, host);
  assert.match(readFileSync(join(plan.release, 'service.unit'), 'utf8'), /^ExecStart=.*src\/index.ts/m);
  const options = { host, launchAgentsDir: units, preflight: async () => {} };
  const installed = join(units, 'dev.serra.friday.service');
  await assert.rejects(activate(directory, options), /previous installation restored.*bad app token/);
  assert.equal(existsSync(installed), false);
  assert.deepEqual(events, ['stop', `start ${installed}`, 'stop', `forget ${installed}`]);
  failReady = false;
  await activate(directory, options);
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(join(plan.release, 'service.unit'), 'utf8'));
  await assert.rejects(rollback(directory, options), /first release/);
});

test('a release prepared for macOS is refused on Linux before anything stops', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'serra-systemd-')));
  const mac = serviceHost('darwin');
  const { directory } = await profile(t, 'friday', root, { ...mac, driver: { loaded: async () => false, stop: async () => {}, start: async () => {}, ready: async () => {} } });
  const events: string[] = [];
  const driver: ServiceDriver = { loaded: async () => false, stop: async () => { events.push('stop'); }, start: async () => {}, ready: async () => {} };
  await assert.rejects(activate(directory, { host: systemdHost(root, {}, driver), launchAgentsDir: join(root, 'units'), preflight: async () => {} }), /for another system/);
  assert.deepEqual(events, []);
});

// With a real systemd user manager (CI's Linux job sets SERRA_SYSTEMD_TEST=1): activate, stop, start and restart
// through `systemctl --user`, with a stand-in daemon, then remove the unit.
test('the bot runs as a real systemd user service', { skip: process.platform !== 'linux' || process.env.SERRA_SYSTEMD_TEST !== '1' }, async (t) => {
  const id = `citest-${process.pid}`;
  const label = `dev.serra.${id}`;
  const root = realpathSync(mkdtempSync(join(homedir(), '.serra-systemd-test-')));
  const host = serviceHost();
  const { directory } = await profile(t, id, root, host);
  const unit = join(host.dir, host.fileName(label));
  t.after(async () => {
    await host.driver.stop(label).catch(() => {});
    rmSync(unit, { force: true });
    await host.driver.forget?.(unit).catch(() => {});
  });
  const systemctl = (...args: string[]): string => {
    try { return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8' }).trim(); }
    catch (error) { return String((error as { stdout?: string }).stdout ?? '').trim(); }
  };
  await activate(directory, { preflight: async () => {} });
  assert.equal(await host.driver.loaded(label), true);
  assert.equal(systemctl('is-enabled', `${label}.service`), 'enabled');
  const first = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as { pid: number };
  await stopBot(directory);
  assert.equal(await host.driver.loaded(label), false);
  await startBot(directory);
  await host.driver.ready(directory);
  await assert.rejects(startBot(directory), /already running/);
  await restartBot(directory);
  const last = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as { pid: number };
  assert.notEqual(last.pid, first.pid);
  assert.equal(await host.driver.loaded(label), true);
});
