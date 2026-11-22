/** An error's message, or the thrown value as text: what logs and events record. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A command that failed (src/t3.ts `run`). The message holds everything the log needs: the command, its exit and what
 * it printed (stderr, or stdout when stderr is empty: T3 prints its errors there). `shortError` turns it into a
 * sentence fit for a person.
 */
export class CommandError extends Error {
  /** The command's name and first two arguments, like `t3 project add`. Never a path. */
  readonly command: string;
  /** What it printed: stderr, else stdout. Empty when it printed nothing or never ran. */
  readonly detail: string;
  readonly reason: 'exit' | 'missing' | 'timeout' | 'spawn';

  constructor(message: string, command: string, detail: string, reason: CommandError['reason']) {
    super(message);
    this.name = 'CommandError';
    this.command = command;
    this.detail = detail;
    this.reason = reason;
  }
}

const NOT_RUNNING = /ECONNREFUSED|not running|no running t3 code server|could ?n[o']t connect|unable to connect|connection refused/i;

/** Absolute paths become their last part, so a message never shows a home folder or where an app lives. */
const withoutPaths = (text: string): string =>
  text.replace(/(?:\/(?:Users|home|private|tmp|var|Applications|opt|Volumes))(?:\/[^\s'"`),:]*)+/g, (path) => path.split('/').filter(Boolean).at(-1) ?? path);

/**
 * A short sentence about a failure, safe to show a person (a Slack DM, a screen): never blank, never a local path,
 * never a command's raw output. The caller logs the full error; this is only what is shown.
 */
export const shortError = (error: unknown): string => {
  if (error instanceof CommandError) {
    const t3 = error.command.startsWith('t3');
    if (error.reason === 'missing') return t3 ? 'Serra can’t find T3 Code’s `t3` command. Install T3 Code and open it once.' : `\`${error.command.split(' ')[0]}\` isn’t installed.`;
    if (t3 && NOT_RUNNING.test(error.detail)) return 'T3 Code isn’t running. Open it, then try again.';
    if (error.reason === 'timeout') return `\`${error.command}\` didn’t answer in time. Try again.`;
    return t3 ? `T3 Code couldn’t run \`${error.command}\`. Check that T3 Code is open and up to date.` : `\`${error.command}\` failed.`;
  }
  const message = withoutPaths(errorMessage(error).split('\n', 1)[0]?.trim() ?? '');
  return message ? message.slice(0, 300) : 'Something went wrong.';
};
