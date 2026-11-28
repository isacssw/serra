/**
 * The background service the bot runs as: a launchd agent on macOS, a systemd user unit on Linux. A `ServiceHost` is
 * everything platform-specific about it (where the service file goes, what it says, how to start and stop it), so
 * `deploy.ts` (prepare, activate, rollback) and `bot-service.ts` (start, stop, restart) never name a platform.
 * Neither needs root: launchd's `gui/<uid>` domain and `systemctl --user` act only for the signed-in user.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isRecord, readJsonOrNull } from './lib/guards.ts';
import { processAlive } from './lock.ts';
import { run as runCommand } from './t3.ts';

/** Runs a command and returns its stdout, rejecting with its output when it exits non-zero. */
type Run = (cmd: string, args: string[], options?: { timeoutMs?: number }) => Promise<string>;

export interface ServiceDriver {
  /** Whether the service is loaded (launchd) or active (systemd). */
  loaded(label: string): Promise<boolean>;
  /** Stops the service and waits for its process to exit. A service that isn't there is already stopped. */
  stop(label: string): Promise<void>;
  /** Loads the installed service file at `path` and starts it. */
  start(path: string): Promise<void>;
  /** Waits until the daemon in `directory` reports ready. */
  ready(directory: string): Promise<void>;
  /** Forgets a service file that was just removed (systemd: disable it). Absent when removing the file is enough. */
  forget?(path: string): Promise<void>;
}

/** What the service runs: the release's daemon for the profile in `directory`, on `node`. */
export interface ServiceSpec { directory: string; release: string; label: string; node: string }

export interface ServiceHost {
  kind: 'launchd' | 'systemd';
  /** Where installed service files go: `~/Library/LaunchAgents` or `~/.config/systemd/user`. */
  dir: string;
  /** The service file's name inside a release folder. Prepare writes it; activation copies it into `dir`. */
  releaseFile: string;
  /** The installed service file's name for a label. */
  fileName(label: string): string;
  /** The service file's text. */
  unit(spec: ServiceSpec): string;
  driver: ServiceDriver;
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const isReady = (value: unknown): value is { pid: number } => isRecord(value) && Number.isSafeInteger(value.pid);

/** The last error the daemon logged while it was starting, so a failed start says why. Older lines are ignored. */
export const startupError = (logPath: string, since: number): string | undefined => {
  try {
    if (statSync(logPath).mtimeMs < since) return undefined;
    const line = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-50).findLast((l) => l.includes('[ERROR]'));
    const at = line ? Date.parse(line.slice(0, line.indexOf(' '))) : NaN;
    return line && !(at < since - 1000) ? line.replace(/^\S+ \[ERROR\] (?:\S+ )?/, '') : undefined;
  } catch { return undefined; }
};

/** Waits for the daemon's `ready.json` with a live PID, as both drivers do. */
const waitReady = async (directory: string, timeoutMs = 25_000): Promise<void> => {
  const started = Date.now();
  const deadline = started + timeoutMs;
  do {
    // A marker that doesn't read yet may still be being written by the daemon.
    const ready = readJsonOrNull(join(directory, 'ready.json'), isReady);
    if (ready && processAlive(ready.pid)) return;
    await delay(250);
  } while (Date.now() < deadline);
  const reason = startupError(join(directory, 'logs/bot.log'), started);
  throw new Error(`Bot did not become ready${reason ? `: ${reason}` : ''}. Check ${join(directory, 'logs/bot.log')}`);
};

/** Waits for an old daemon's PID to go, so a new one never runs beside it. */
const waitGone = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (pid && processAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Old PID ${pid} has not stopped. Refusing to start another bot.`);
    await delay(100);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// launchd (macOS)
// ---------------------------------------------------------------------------------------------------------------

const xmlEscape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export const servicePlist = ({ directory, release, label, node }: ServiceSpec): string => {
  const s = (value: string): string => `<string>${xmlEscape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${s(label)}
<key>WorkingDirectory</key>${s(release)}
<key>ProgramArguments</key><array>${[node, join(release, 'src/index.ts'), '--profile', directory].map(s).join('')}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key>${s(homedir())}<key>PATH</key>${s(`${dirname(node)}:${process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}`)}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>75</integer>
<key>StandardOutPath</key>${s(join(directory, 'logs/bot.log'))}
<key>StandardErrorPath</key>${s(join(directory, 'logs/bot.log'))}
</dict></plist>\n`;
};

const missingLaunchd = (error: unknown): boolean => /Could not find service|No such process|Could not find specified service/i.test(String(error));

const launchdDriver = (run: Run = runCommand): ServiceDriver => {
  const domain = (): string => `gui/${process.getuid!()}`;
  return {
    async loaded(label) {
      try { await run('launchctl', ['print', `${domain()}/${label}`]); return true; }
      catch (error) { if (missingLaunchd(error)) return false; throw error; }
    },
    async stop(label) {
      let info: string;
      try { info = await run('launchctl', ['print', `${domain()}/${label}`]); }
      catch (error) { if (missingLaunchd(error)) return; throw error; }
      const pid = Number(/^\s*pid = (\d+)/m.exec(info)?.[1] ?? 0);
      await run('launchctl', ['bootout', `${domain()}/${label}`], { timeoutMs: 90_000 });
      await waitGone(pid);
    },
    async start(plist) { await run('launchctl', ['bootstrap', domain(), plist]); },
    ready: (directory) => waitReady(directory),
  };
};

const launchdHost = (home = homedir(), run?: Run): ServiceHost => ({
  kind: 'launchd',
  dir: join(home, 'Library/LaunchAgents'),
  releaseFile: 'service.plist',
  fileName: (label) => `${label}.plist`,
  unit: servicePlist,
  driver: launchdDriver(run),
});

// ---------------------------------------------------------------------------------------------------------------
// systemd user units (Linux)
// ---------------------------------------------------------------------------------------------------------------

/** A path, which systemd reads to the end of the line: specifiers escaped, no quotes. */
const unitPath = (value: string): string => {
  if (/[\0\r\n]/.test(value)) throw new Error('A service path or setting has a line break in it');
  return value.replaceAll('%', '%%');
};
/** One quoted `Environment=` assignment: `\`, `"` and specifiers escaped (`$` is literal there). */
const unitEnv = (value: string): string => `"${unitPath(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
/** One quoted `ExecStart=` argument: as `unitEnv`, and `$` escaped, since systemd expands variables there. */
const unitArg = (value: string): string => unitEnv(value).replaceAll('$', '$$$$');

/**
 * The bot's systemd user unit. It restarts like the launchd agent does (after 30 s), gets 75 s to hand waiting
 * messages over on stop, logs to the profile's `logs/bot.log`, and starts with the user's manager (at boot when
 * lingering is on: `serra server doctor` says how).
 */
export const serviceUnit = ({ directory, release, label, node }: ServiceSpec, home = homedir()): string => {
  const path = `${dirname(node)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`;
  const log = unitPath(join(directory, 'logs/bot.log'));
  return `[Unit]
Description=Serra bot ${label}
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${unitPath(release)}
ExecStart=${[node, join(release, 'src/index.ts'), '--profile', directory].map(unitArg).join(' ')}
Environment=${unitEnv(`HOME=${home}`)} ${unitEnv(`PATH=${path}`)}
Restart=always
RestartSec=30
KillMode=mixed
TimeoutStopSec=75
UMask=0077
NoNewPrivileges=true
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
};

/** The gateway's label: one per server, for every profile on it. */
export const GATEWAY_LABEL = 'dev.serra.gateway';

/**
 * The gateway's systemd user unit (SB-32): `serra server gateway` from this checkout, restarted after a crash, private
 * files only, logging to `gateway/gateway.log` in the profiles folder. It listens on loopback and Tailscale only.
 * It serves the same profiles folder, and keeps the `--port` and `--listen` it was installed with (`flags`).
 */
export const gatewayUnit = ({ node, entry, root, flags = [] }: { node: string; entry: string; root: string; flags?: readonly string[] }, home = homedir()): string => {
  const path = `${dirname(node)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`;
  const log = unitPath(join(root, 'gateway/gateway.log'));
  return `[Unit]
Description=Serra gateway
After=network-online.target tailscaled.service
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${[node, entry, 'server', 'gateway', '--root', root, ...flags].map(unitArg).join(' ')}
Environment=${unitEnv(`HOME=${home}`)} ${unitEnv(`PATH=${path}`)}
Restart=always
RestartSec=10
UMask=0077
NoNewPrivileges=true
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
};

/** `systemctl --user` can't reach a user manager: WSL without systemd, a container, or no login session. */
const noUserManager = (error: unknown): boolean => /Failed to connect to (?:user scope )?bus|No medium found|\$DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/i.test(String(error));
const NO_USER_MANAGER = 'systemd user services aren’t available here. Run pnpm start --profile … in the foreground instead.';

export const systemdDriver = ({ run = runCommand, systemctl = 'systemctl' }: { run?: Run; systemctl?: string } = {}): ServiceDriver => {
  const user = async (args: string[], timeoutMs?: number): Promise<string> => {
    try { return await run(systemctl, ['--user', ...args], timeoutMs ? { timeoutMs } : {}); }
    catch (error) { throw noUserManager(error) ? new Error(NO_USER_MANAGER) : error; }
  };
  const state = async (label: string): Promise<{ active: string; pid: number }> => {
    const out = await user(['show', `${label}.service`, '--property=ActiveState', '--property=MainPID']);
    return { active: /^ActiveState=(.*)$/m.exec(out)?.[1]?.trim() ?? '', pid: Number(/^MainPID=(\d+)$/m.exec(out)?.[1] ?? 0) };
  };
  return {
    async loaded(label) { return ['active', 'activating', 'reloading', 'deactivating'].includes((await state(label)).active); },
    async stop(label) {
      const { active, pid } = await state(label);
      if (active === 'inactive' || active === 'failed' || active === '') return;
      await user(['stop', `${label}.service`], 90_000);
      await waitGone(pid);
    },
    async start(path) {
      const unit = basename(path);
      await user(['daemon-reload']);
      // Enabled, so it starts again with the user's manager, as launchd's RunAtLoad does at login.
      await user(['enable', unit]);
      await user(['start', unit], 90_000);
    },
    ready: (directory) => waitReady(directory),
    async forget(path) {
      try { await user(['disable', basename(path)]); } catch { /* never enabled */ }
      await user(['daemon-reload']);
    },
  };
};

export const systemdHost = (home = homedir(), env: NodeJS.ProcessEnv = process.env, driver: ServiceDriver = systemdDriver()): ServiceHost => ({
  kind: 'systemd',
  dir: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd/user'),
  releaseFile: 'service.unit',
  fileName: (label) => `${label}.service`,
  unit: (spec) => serviceUnit(spec, home),
  driver,
});

/** The service host for this computer: launchd on macOS, systemd on Linux. Throws elsewhere. */
export const serviceHost = (platform: NodeJS.Platform = process.platform): ServiceHost => {
  if (platform === 'darwin') return launchdHost();
  if (platform === 'linux') return systemdHost();
  throw new Error('Background service management needs macOS or Linux. Run pnpm start --profile … in the foreground on other systems.');
};

/** Platforms with a background service. */
export const hasServiceHost = (platform: NodeJS.Platform = process.platform): boolean => platform === 'darwin' || platform === 'linux';
