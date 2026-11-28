import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BotEvents } from './bot.ts';

/** How much a logger writes: Bolt's levels, by the same names, so a chat library can be handed this logger as is. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The daemon's logger. It has the shape Bolt asks for, so the Slack connection passes it to Bolt unchanged. */
export interface Logger {
  debug(...msg: unknown[]): void;
  info(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  error(...msg: unknown[]): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  setName(name: string): void;
}

/** One log argument as text. Errors keep their stack, and an object that can't be serialised never makes logging throw. */
const show = (part: unknown): string => {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return part.stack ?? part.message;
  try { return JSON.stringify(part) ?? String(part); } catch { return String(part); }
};

const ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * A logger with a timestamp on every line, so bot.log can say when something happened:
 * how long a reply took, or whether a Slack reconnect lined up with a lost message.
 */
export const timestampedLogger = (level: LogLevel = 'info', now: () => Date = () => new Date(), write = console.log): Logger => {
  let current = level;
  let name = 'bolt-app';
  const at = (wanted: LogLevel) => (...msg: unknown[]): void => {
    if (ORDER.indexOf(wanted) < ORDER.indexOf(current)) return;
    write(`${now().toISOString()} [${wanted.toUpperCase()}] ${name} ${msg.map(show).join(' ')}`);
  };
  return {
    debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
    setLevel: (next) => { current = next; },
    getLevel: () => current,
    setName: (next) => { name = next; },
  };
};

/**
 * One JSON line per bot event in `file`, for measuring the bot: time to first reply, quiet runs, owner pings.
 * A failed write is never allowed to break a reply.
 */
export const eventLog = (file: string, now: () => Date = () => new Date()): BotEvents => (name, fields) => {
  try {
    appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), event: name, ...fields })}\n`, { mode: 0o600 });
  } catch {
    // Measuring is optional; the bot's work isn't.
  }
};

/** Rotated copies of `file`, newest first: `bot.log.0` (newsyslog) or `bot.log.1` (logrotate), then older numbers. */
const rotatedCopies = (file: string): string[] => {
  const base = basename(file);
  let names: string[];
  try { names = readdirSync(dirname(file)); } catch { return []; }
  return names
    .map((name) => ({ name, n: name.startsWith(`${base}.`) ? name.slice(base.length + 1) : '' }))
    .filter(({ n }) => /^\d+$/.test(n))
    .sort((a, b) => Number(a.n) - Number(b.n))
    .map(({ name }) => join(dirname(file), name));
};

/** Up to `count` complete lines from the end of one file, oldest first. Reads backwards in chunks, never the whole file. */
const tailOfFile = (file: string, count: number, chunkSize: number): string[] => {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    let position = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    // One newline more than lines wanted (plus a trailing one), so a partial first line is never counted.
    // Chunks stay bytes until the end, so a character split across two chunks still decodes.
    while (position > 0 && newlines <= count + 1) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, position);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 0x0a) newlines++;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (position > 0) lines.shift();
    if (lines.length === 1 && lines[0] === '') return [];
    return lines.slice(-count);
  } finally { closeSync(fd); }
};

/**
 * The last `count` lines of a log, oldest first. When `file` was just rotated and holds fewer lines, the rest come
 * from its newest rotated copy (`bot.log.0` or `bot.log.1`, then older ones), so the tail stays continuous.
 * A missing file is an empty log; compressed copies (`.gz`) are skipped.
 */
export const tailLog = (file: string, count: number, { chunkSize = 64 * 1024 }: { chunkSize?: number } = {}): string[] => {
  if (!Number.isInteger(count) || count < 1) return [];
  const lines: string[] = [];
  for (const path of [file, ...rotatedCopies(file)]) {
    const wanted = count - lines.length;
    if (wanted <= 0) break;
    lines.unshift(...tailOfFile(path, wanted, chunkSize));
  }
  return lines;
};
