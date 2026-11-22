/**
 * Live daemon status over a Unix socket in the profile (`status.sock`, mode 600, no TCP port).
 *
 * The daemon runs the server: every client gets a `BotStatus` snapshot when it connects, then each `BotEvent` as it
 * happens and a new snapshot whenever the status changes. The app runs the client, `subscribeStatus()`, which reports
 * `stopped` while the socket is missing or after it closes, and reconnects when the daemon comes back.
 *
 * Wire format: one JSON `StatusMessage` per line. Clients only read; anything they send is ignored.
 *
 * This file must stay free of Slack/Bolt imports: the Electron main process bundles `subscribeStatus()`.
 */
import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { BotEvent, BotStatus, Job } from './contracts.ts';

export const STATUS_SOCKET = 'status.sock';

export const statusSocketPath = (profileDir: string): string => join(profileDir, STATUS_SOCKET);

/** One line on the socket. */
export type StatusMessage =
  | { type: 'status'; status: BotStatus }
  | { type: 'event'; event: BotEvent };

/** The status the daemon reports about itself while it runs. */
export type UpStatus = Extract<BotStatus, { state: 'up' }>;

/** A client that reads slower than the daemon writes is dropped past this much unsent data, so it can't grow memory. */
const MAX_BUFFERED = 1024 * 1024;
/** macOS limits a socket path to 104 bytes including the terminator. */
const MAX_PATH_BYTES = 103;

const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));

/**
 * The daemon's event as the app sees it, or null for events the app doesn't show (progress lines, question
 * bookkeeping). Takes the same `(name, fields)` the daemon gives `eventLog`, so the socket and `events.jsonl` agree.
 */
export const toBotEvent = (name: string, fields: Record<string, unknown>, at: string): BotEvent | null => {
  const key = str(fields.key);
  switch (name) {
    case 'job_started':
      return { at, event: 'job_started', key, t3ThreadId: str(fields.t3ThreadId), requester: str(fields.requester) };
    case 'reply': {
      const kind = fields.kind;
      if (kind !== 'reply' && kind !== 'quiet' && kind !== 'status_posted' && kind !== 'status_edited') return null;
      return {
        at, event: 'reply', key, kind,
        ...(typeof fields.needsOwner === 'boolean' ? { needsOwner: fields.needsOwner } : {}),
        ...(fields.notice === true ? { notice: true } : {}),
      };
    }
    case 'needs_owner':
      return { at, event: 'needs_owner', key };
    case 'failure':
      return { at, event: 'failure', key, error: str(fields.error) };
    default:
      return null;
  }
};

/**
 * Counts for the status line, from `state.json`'s jobs. A job needs the owner while the owner was pinged for a blocker
 * and hasn't answered, or while its run waits on something only T3 can show (a token, an approval). A question shown
 * in Slack waits on the requester, so it counts as neither. A job is running while someone's request still waits for its
 * reply.
 */
export const jobCounts = (jobs: Iterable<Job>): UpStatus['counts'] => {
  let needsYou = 0;
  let running = 0;
  for (const job of jobs) {
    if (job.ownerAskOpen === true || (job.waitingInT3 === true && !job.question)) needsYou += 1;
    else if (job.loadingRequested === true && job.waitingInT3 !== true) running += 1;
  }
  return { needsYou, running };
};

const line = (message: StatusMessage): string => `${JSON.stringify(message)}\n`;

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** Resolves true when something accepts connections at `path`. */
const answers = (path: string): Promise<boolean> => new Promise((resolve) => {
  const probe = createConnection(path);
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  probe.once('error', () => resolve(false));
});

/**
 * Clears a socket file left by a daemon that crashed. A socket another process still answers on, or a path that
 * isn't a socket, is left alone and stops startup.
 */
const clearStale = async (path: string): Promise<void> => {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket()) throw new Error(`${path} exists and is not a socket; move it away so the status socket can start.`);
  if (await answers(path)) throw new Error(`Another process is serving ${path}. Is a second daemon running on this profile?`);
  rmSync(path, { force: true });
};

export interface StatusServerOptions {
  profileDir: string;
  /** The daemon's current status. Called for each new client and after each event. */
  status: () => UpStatus;
  now?: () => Date;
}

export interface StatusServer {
  path: string;
  /** Sends the daemon's event to every client, when the app shows that kind of event. Then refreshes the status. */
  publish: (name: string, fields: Record<string, unknown>) => void;
  /** Sends a new status snapshot to every client if it changed since the last one. */
  refresh: () => void;
  /** Stops listening, disconnects clients and removes the socket file. */
  close: () => Promise<void>;
  /** The same as `close`, synchronous, for `process.on('exit')`: only removes the socket file. */
  removeSocketFile: () => void;
}

/**
 * Starts the daemon's status socket. Only the owner can connect: the file is created with mode 600.
 * Status and events are best effort and never throw into the bot's work.
 */
export const startStatusServer = async ({ profileDir, status, now = () => new Date() }: StatusServerOptions): Promise<StatusServer> => {
  const path = statusSocketPath(profileDir);
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw new Error(`The status socket path is too long for a Unix socket: ${path}`);
  await clearStale(path);

  const clients = new Set<Socket>();
  let last = '';

  const send = (socket: Socket, text: string): void => {
    if (socket.destroyed) return;
    if (socket.writableLength > MAX_BUFFERED) { socket.destroy(); return; }
    socket.write(text);
  };
  const broadcast = (text: string): void => { for (const socket of clients) send(socket, text); };
  const snapshot = (): string => line({ type: 'status', status: status() });

  const server: Server = createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.on('data', () => {}); // Clients only read.
    try {
      // A change since the last snapshot goes to everyone, so earlier clients don't fall behind the new one.
      const next = snapshot();
      if (next === last) send(socket, next);
      else { last = next; broadcast(next); }
    } catch {
      socket.destroy();
    }
  });
  server.on('error', () => {}); // After listening, a failing server must not crash the daemon.

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // bind() runs inside listen(), so the umask covers the moment the file is created: it is never readable by others.
    const previous = process.umask(0o177);
    try {
      server.listen(path, () => { server.off('error', reject); resolve(); });
    } finally {
      process.umask(previous);
    }
  });
  chmodSync(path, 0o600);

  const refresh = (): void => {
    if (clients.size === 0) return;
    try {
      const next = snapshot();
      if (next === last) return;
      last = next;
      broadcast(next);
    } catch {
      // A status that can't be read now is sent with the next change.
    }
  };

  let closed: Promise<void> | null = null;
  const removeSocketFile = (): void => { rmSync(path, { force: true }); };

  return {
    path,
    publish: (name, fields) => {
      const event = toBotEvent(name, fields, now().toISOString());
      if (event && clients.size > 0) broadcast(line({ type: 'event', event }));
      refresh();
    },
    refresh,
    removeSocketFile,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => { removeSocketFile(); resolve(); });
        for (const socket of clients) socket.destroy();
      });
      return closed;
    },
  };
};

const isStatusMessage = (value: unknown): value is StatusMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown; status?: { state?: unknown }; event?: { event?: unknown } };
  if (message.type === 'status') return message.status?.state === 'up' || message.status?.state === 'stopped';
  if (message.type === 'event') return typeof message.event?.event === 'string';
  return false;
};

export interface SubscribeOptions {
  /** How long to wait before trying the socket again after it is missing or closed. 0 doesn't retry. Default 2 s. */
  retryMs?: number;
}

export interface StatusSubscription {
  close: () => void;
}

/**
 * Follows the daemon's status socket in `profileDir`. The listener gets `{ type: 'status', status: { state: 'stopped' } }`
 * once whenever the daemon is unreachable (socket missing, refused, or closed), then the daemon's snapshot and events
 * when it is up. Never throws: a broken socket is just "stopped".
 */
export const subscribeStatus = (
  profileDir: string,
  listener: (message: StatusMessage) => void,
  { retryMs = 2_000 }: SubscribeOptions = {},
): StatusSubscription => {
  const path = statusSocketPath(profileDir);
  let closed = false;
  let socket: Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let reported: 'up' | 'stopped' | null = null;

  const deliver = (message: StatusMessage): void => {
    if (closed) return;
    if (message.type === 'status') reported = message.status.state;
    try { listener(message); } catch { /* A listener's failure is its own. */ }
  };

  const stopped = (): void => {
    if (reported !== 'stopped') deliver({ type: 'status', status: { state: 'stopped' } });
  };

  const connect = (): void => {
    timer = null;
    if (closed) return;
    let buffer = '';
    const current = createConnection(path);
    socket = current;
    current.setEncoding('utf8');
    current.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\n');
      while (end !== -1) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf('\n');
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { continue; }
        if (isStatusMessage(parsed)) deliver(parsed);
      }
    });
    current.on('error', () => {}); // 'close' follows and reports it.
    current.on('close', () => {
      if (socket === current) socket = null;
      if (closed) return;
      stopped();
      if (retryMs > 0) timer = setTimeout(connect, retryMs);
    });
  };

  connect();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.destroy();
    },
  };
};
