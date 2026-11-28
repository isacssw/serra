import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeRoot, defaultProfileRoot } from '../config.ts';
import { pinnedRequest } from '../gateway/client.ts';
import { runServerUpdate, updateProblem } from '../gateway/update.ts';
import { localMoveHost, settleLapsed, type MoveHost } from '../moves/host.ts';
import { secretPort } from '../moves/secret-port.ts';
import { installService } from '../setup.ts';
import { run } from '../t3.ts';
import { serverEngines } from '../gateway/engines.ts';
import { eventLog } from '../gateway/events.ts';
import { listenAddresses } from '../gateway/listen.ts';
import { startGateway, type Gateway } from '../gateway/server.ts';
import {
  addDevice, clearGatewayRuntime, closePairing, DEFAULT_GATEWAY_PORT, formatCode, gatewayCert, listDevices, openPairing,
  PAIRING_MINUTES, pairingState, revokeDevice, runningGateway, serverIdentity, serverWords, writeGatewayRuntime,
} from '../gateway/state.ts';
import { processAlive } from '../lock.ts';
import { isRecord } from '../lib/guards.ts';
import type { Command, CommandContext } from '../manage.ts';
import { diagnoseHost, formatHostChecks } from '../server-doctor.ts';
import { GATEWAY_LABEL, gatewayUnit, systemdDriver } from '../service.ts';

const USAGE = [
  'pnpm bot server doctor',
  'pnpm bot server gateway [--port 47820] [--listen 100.x.y.z] [--install]',
  'pnpm bot server pair',
  'pnpm bot server devices [revoke <id or name>]',
  'pnpm bot server update --to <version>',
];

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** The profiles folder this server serves: `--root`, else `~/.local/share/serra`. */
const rootOf = ({ option }: CommandContext): string => {
  const root = option('--root');
  if (root !== undefined && !isAbsolute(root)) throw new Error('--root needs an absolute folder');
  return resolve(root ?? defaultProfileRoot);
};

const version = (): string => {
  try {
    const info: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
    return isRecord(info) && typeof info.version === 'string' ? info.version : '';
  } catch { return ''; }
};

/** Every value of a repeatable flag. */
const all = (args: readonly string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag && args[index + 1] && !args[index + 1]!.startsWith('--') ? [args[index + 1]!] : []));

const stamp = (line: string): string => `${new Date().toISOString()} ${line}`;

/** This server's side of moves and restores (SB-34): bots run as systemd user services, tokens live in `.env`. */
const serverMoves = (root: string, name: string, log: (line: string) => void): MoveHost => localMoveHost({
  root,
  name,
  install: async (dir) => {
    const outcome = await installService(dir, { node: process.execPath, log: (line) => log(stamp(`${basename(dir)}: ${line}`)) });
    if (!outcome.ok) throw new Error(`It didn’t start on ${name}: ${outcome.error}`);
  },
  // A server has no Trash: what leaves it waits in backups/.trash (ux-rules E9).
  trash: async (path) => {
    const trash = join(root, 'backups', '.trash');
    mkdirSync(trash, { recursive: true, mode: 0o700 });
    renameSync(path, join(trash, `${basename(path)}@${new Date().toISOString().replace(/[:.]/g, '-')}`));
  },
  secrets: secretPort({ keychain: process.platform === 'darwin' }),
});

/** The gateway's own systemd unit is running: the only setup in which it can restart itself for an update. */
const gatewayService = async (): Promise<boolean> => {
  try { return (await run('systemctl', ['--user', 'is-active', GATEWAY_LABEL], { timeoutMs: 10_000 })).trim() === 'active'; } catch { return false; }
};

/** Runs the gateway until SIGINT or SIGTERM. Listens again when a Tailscale address comes or goes. */
const runGateway = async (context: CommandContext, root: string): Promise<void> => {
  const { args, option, log } = context;
  const portText = option('--port');
  const port = portText === undefined ? DEFAULT_GATEWAY_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port needs a number from 1 to 65535');
  const only = all(args, '--listen');
  const events = eventLog();
  const identity = serverIdentity(root);
  let gateway: Gateway | null = null;
  const moves = serverMoves(root, identity.name, log);
  const update = {
    problem: (to: string) => updateProblem({ root, code: codeRoot, current: version(), version: to }),
    launch: async (to: string) => {
      if (!(await gatewayService())) throw new Error(`Update ${identity.name} from its terminal: serra server update --to ${to}`);
      const entry = fileURLToPath(new URL('../manage.ts', import.meta.url));
      // Its own unit: restarting the gateway must not stop the update that restarts it.
      await run('systemd-run', ['--user', '--collect', `--unit=serra-update-${Date.now()}`, process.execPath, entry, 'server', 'update', '--to', to, '--root', root], { timeoutMs: 30_000 });
    },
  };
  const start = async (): Promise<void> => {
    const addresses = listenAddresses(only);
    const engines = serverEngines({ root, runtime: { version: version(), platform: process.platform }, events });
    gateway = await startGateway({ root, addresses, port, engines, events, version: version(), moves, update, log: (line) => log(stamp(line)) });
    writeGatewayRuntime(root, { pid: process.pid, port: gateway.port, addresses: [...addresses], startedAt: new Date().toISOString() });
  };
  await start();
  log(stamp(`Serra gateway for ${identity.name} (${identity.id}). Pair a Mac: serra server pair`));
  let stopping = false;
  const stopped = new Promise<void>((done) => {
    const stop = (): void => { stopping = true; done(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  // A Mac that went away mid-move: a lapsed hold starts its profile here again (E16), stale arrivals go.
  const settleMoves = (): void => {
    settleLapsed(moves, root).then((resumed) => {
      for (const id of resumed) { log(stamp(`${id}: its move stopped, so it runs here again`)); events.publish(null, 'profiles', null); }
    }, (error: unknown) => { log(stamp(`couldn’t settle moves: ${String(error)}`)); });
  };
  settleMoves();
  // Tailscale can come up after the gateway: look again every minute.
  const watch = setInterval(() => {
    settleMoves();
    if (only.length || !gateway) return;
    const now = listenAddresses();
    if (now.join(',') === gateway.addresses.join(',')) return;
    const old = gateway;
    gateway = null;
    void old.close().then(start).catch((error: unknown) => { log(stamp(`couldn’t listen again: ${String(error)}`)); });
  }, 60_000);
  await stopped;
  clearInterval(watch);
  if (stopping) await (gateway as Gateway | null)?.close();
  clearGatewayRuntime(root);
};

/** Writes the gateway's systemd user unit and starts it (Linux). No root: the user's own manager. */
const installGateway = async (root: string, log: (text: string) => void): Promise<void> => {
  if (process.platform !== 'linux') throw new Error('--install sets up a systemd user service, on Linux. On a Mac, the app runs the profiles.');
  const entry = fileURLToPath(new URL('../manage.ts', import.meta.url));
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(join(root, 'gateway'), { recursive: true, mode: 0o700 });
  const path = join(unitDir, `${GATEWAY_LABEL}.service`);
  writeFileSync(path, gatewayUnit({ node: process.execPath, entry, root }), { mode: 0o644 });
  await systemdDriver().start(path);
  log(`The gateway runs as ${GATEWAY_LABEL}. Logs: ${join(root, 'gateway/gateway.log')}`);
};

const needGateway = (root: string) => {
  const running = runningGateway(root, processAlive);
  if (!running) throw new Error('Serra’s gateway isn’t running here. Start it: serra server gateway');
  return running;
};

/** `serra server pair`: a code and three words for the owner, then waits for the Mac. */
const pairInteractive = async (root: string, log: (text: string) => void): Promise<void> => {
  const running = needGateway(root);
  const identity = serverIdentity(root);
  const code = openPairing(root);
  const words = serverWords(root, code);
  const tailnet = running.addresses.filter((address) => address !== '127.0.0.1');
  const port = running.port === DEFAULT_GATEWAY_PORT ? '' : `:${running.port}`;
  log([
    '',
    `  Pair a Mac with ${identity.name}`,
    '',
    `  Code     ${formatCode(code)}`,
    `  Words    ${words.join(' · ')}`,
    `  Address  ${[`${identity.name}${port}`, ...tailnet.map((address) => `${address}${port}`)].join('  or  ')}`,
    '',
    `  In Serra: Add… › Server. The code works once, for ${PAIRING_MINUTES} minutes.`,
    '',
  ].join('\n'));
  if (tailnet.length === 0) log('  This server has no Tailscale address, so only SSH reaches it: pair from the Mac over SSH.\n');
  let cancelled = false;
  const cancel = (): void => { cancelled = true; };
  process.once('SIGINT', cancel);
  try {
    for (;;) {
      if (cancelled) { closePairing(root); log('Stopped. The code no longer works.'); return; }
      const state = pairingState(root);
      if (state.state === 'paired') { closePairing(root); log(`Paired with ${state.device}.`); return; }
      if (state.state === 'closed') { closePairing(root); throw new Error('The code expired or ran out of tries. Run serra server pair again.'); }
      await sleep(500);
    }
  } finally { process.off('SIGINT', cancel); }
};

/**
 * `serra server pair --ssh`: what the Mac reads over its own SSH connection. SSH is the proof, so there is no code;
 * the token is printed once, as JSON on stdout, and never to a terminal.
 */
const pairOverSsh = (root: string, device: string | undefined, log: (text: string) => void): void => {
  if (process.stdout.isTTY) throw new Error('--ssh is how the Mac pairs over SSH. To pair by hand, run serra server pair.');
  const running = needGateway(root);
  const identity = serverIdentity(root);
  const { cert, fingerprint } = gatewayCert(root, identity.name);
  const added = addDevice(root, device ?? 'A Mac');
  log(JSON.stringify({ server: identity, cert, fingerprint, port: running.port, token: added.token, deviceId: added.device.id }));
};

/** `serra server update --to <version>`: this checkout to that release, checked, or back as it was. */
const updateServer = async (root: string, to: string | undefined, log: (text: string) => void): Promise<void> => {
  if (!to) throw new Error(`Use: serra server update --to <version>. This server runs ${version() || 'an unknown version'}.`);
  const problem = updateProblem({ root, code: codeRoot, current: version(), version: to.replace(/^v/, '') });
  if (problem) throw new Error(problem);
  const identity = serverIdentity(root);
  const { cert, fingerprint } = gatewayCert(root, identity.name);
  const outcome = await runServerUpdate({
    root, code: codeRoot, version: to.replace(/^v/, ''), log: (line) => log(stamp(line)),
    exec: (cmd, args, options) => run(cmd, args, { timeoutMs: options?.timeoutMs ?? 120_000 }),
    restart: async () => { await run('systemctl', ['--user', 'restart', GATEWAY_LABEL], { timeoutMs: 60_000 }); },
    answers: async () => {
      // The restarted gateway, on this computer, with its own certificate: what version does it say?
      for (let tries = 0; tries < 30; tries += 1) {
        await sleep(2000);
        const running = runningGateway(root, processAlive);
        if (!running) continue;
        try {
          const reply = await pinnedRequest({ host: '127.0.0.1', port: running.port }, { cert, fingerprint }, { path: '/.well-known/serra', timeoutMs: 5000 });
          if (reply.status === 200 && isRecord(reply.body) && typeof reply.body.version === 'string') return reply.body.version;
        } catch { /* not up yet */ }
      }
      return null;
    },
  });
  if (outcome.state !== 'done') throw new Error(outcome.message ?? 'It wasn’t updated.');
  log(`Updated to ${outcome.to}.`);
};

const command: Command = {
  summary: 'This computer as a Serra server: check it, run the gateway, pair a Mac, list or revoke devices, update it.',
  usage: USAGE,
  profile: false,
  async run(context) {
    const { args, log, flag, option } = context;
    const [, action, ...rest] = args;
    const root = rootOf(context);
    switch (action ?? '') {
      case 'doctor': {
        const checks = await diagnoseHost();
        log(formatHostChecks(checks));
        if (checks.some((check) => check.state === 'fail')) throw new Error('Fix the items marked FAIL, then run this again.');
        return;
      }
      case 'gateway':
        if (flag('--install')) { await installGateway(root, log); return; }
        await runGateway(context, root);
        return;
      case 'pair':
        if (flag('--ssh')) pairOverSsh(root, option('--device'), log);
        else await pairInteractive(root, log);
        return;
      case 'update':
        await updateServer(root, option('--to'), log);
        return;
      case 'devices': {
        if (rest[0] === 'revoke') {
          const which = rest[1];
          if (!which || which.startsWith('--')) throw new Error('Use: serra server devices revoke <id or name>');
          const revoked = revokeDevice(root, which);
          log(`Revoked ${revoked.name}. It can’t reach this server any more.`);
          return;
        }
        if (!existsSync(join(root, 'devices.json'))) { log('No Mac is paired yet. Run serra server pair.'); return; }
        const devices = listDevices(root);
        if (!devices.length) { log('No Mac is paired yet. Run serra server pair.'); return; }
        for (const device of devices) log(`${device.id}  ${device.name}  added ${device.addedAt.slice(0, 10)}  ${device.lastUsed ? `last used ${device.lastUsed.slice(0, 16).replace('T', ' ')}` : 'not used yet'}`);
        return;
      }
      default:
        throw new Error(`Use: ${USAGE.join(' | ')}`);
    }
  },
};
export default command;
