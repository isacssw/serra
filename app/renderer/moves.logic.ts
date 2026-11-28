// How the window shows a move, a move back and a restore (SB-34): the confirm's title, promises and away line, the
// progress steps with their one detail each, and the few words at the end. Pure: imported by `node --test` too.
import type { BackupView, MoveView } from '../main/bridge.ts';

/** `this Mac` at the start of a sentence. */
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The confirm's title and its one button (ux-rules A4, A5): both name the profile. */
export const moveTitle = (name: string, toName: string): { title: string; button: string } =>
  toName === 'this Mac' ? { title: `Move ${name} back`, button: `Move ${name} back` } : { title: `Move ${name} to ${toName}`, button: `Move ${name}` };

/** The three promises a move makes. */
export const movePromises = (fromName: string): string[] => ['Running jobs finish first', 'Knowledge is copied and checked', `${capital(fromName)} keeps a backup`];

export const restorePromises = (name: string): string[] => [`Today’s ${name} is backed up first`, 'The backup is checked, file by file'];

/** How long the bot is away, said once. */
export const awayLine = (name: string, minutes: number): string => `${name} is away about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;

type StepState = 'done' | 'now' | 'todo' | 'blocked';
export interface StepLine { text: string; state: StepState; detail: string | null }

const ORDER = ['drain', 'pause', 'backup', 'copy', 'start', 'archive'] as const;

/** The steps as the progress lists them, each done, running now, or still to come. */
export const moveSteps = (move: MoveView): StepLine[] => {
  const restore = move.kind === 'restore';
  const texts: Record<(typeof ORDER)[number], string> = restore
    ? { drain: 'Finish running jobs', pause: `Pause on ${move.fromName}`, backup: 'Back up today’s copy', copy: 'Import and check', start: `Start on ${move.toName}`, archive: '' }
    : { drain: 'Finish running jobs', pause: `Pause on ${move.fromName}`, backup: `Back up on ${move.fromName}`, copy: 'Copy and check', start: `Start on ${move.toName}`, archive: `Archive ${move.fromName}’s copy` };
  const at = ORDER.indexOf(move.step);
  const finished = move.state === 'done';
  return ORDER.filter((step) => !(restore && step === 'archive')).map((step, index) => {
    let state: StepState = finished || index < at ? 'done' : index === at ? 'now' : 'todo';
    let detail: string | null = null;
    if (step === 'drain' && state === 'now') {
      if (move.waiting) { state = 'blocked'; detail = `${move.waiting} ${move.waiting === 1 ? 'job waits' : 'jobs wait'} for you`; }
      else if (move.running) detail = `${move.running} running`;
    }
    if (step === 'copy' && !restore && move.total && state !== 'todo') detail = `${move.copied} of ${move.total} files`;
    return { text: texts[step], state, detail };
  });
};

/** The progress dialog's title. */
export const progressTitle = (move: MoveView): string => {
  if (move.state === 'interrupted') return move.kind === 'move' ? 'Move interrupted' : 'Restore interrupted';
  return move.kind === 'move' ? `Moving ${move.name}` : `Restoring ${move.name}`;
};

/** While it can still stop: `Move later` while jobs finish, `Cancel` until it starts there; then nothing. */
export const stopLabel = (move: MoveView): string | null => {
  if (move.state !== 'running') return null;
  if (move.step === 'drain') return move.kind === 'move' ? 'Move later' : 'Restore later';
  return move.step === 'start' || move.step === 'archive' ? null : 'Cancel';
};

/** `28 Nov 14:02`, in the owner's time. */
const shortDate = (iso: string): string => {
  const date = new Date(iso);
  const month = date.toLocaleString('en-GB', { month: 'short' });
  return `${date.getDate()} ${month} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** How a move ended, as one toast, or null while it runs. `action`: Move back after a move. */
export const moveEnding = (move: MoveView): { message: string; tone: 'success' | 'info' | 'error'; moveBack: boolean } | null => {
  if (move.state === 'running' || move.state === 'interrupted') return null;
  if (move.kind === 'restore') {
    if (move.state === 'done') return { message: `${move.name} restored`, tone: 'success', moveBack: false };
    if (move.state === 'later') return { message: `${move.name} wasn’t restored`, tone: 'info', moveBack: false };
    return { message: `Restore stopped · ${move.name} is back as it was, unchanged.`, tone: move.error ? 'error' : 'info', moveBack: false };
  }
  if (move.state === 'done') return { message: `${move.name} moved to ${move.toName}`, tone: 'success', moveBack: true };
  if (move.state === 'later') return { message: `${move.name} stays on ${move.fromName}`, tone: 'info', moveBack: false };
  return { message: `Move stopped · ${move.name} is back on ${move.fromName}, unchanged.`, tone: move.error ? 'error' : 'info', moveBack: false };
};

/** A backup's line in the list: why it was made, and when. */
export const backupLine = (backup: BackupView): string => {
  const when = shortDate(backup.at);
  if (backup.kind === 'moved') return `Before the move to ${backup.detail ?? 'a server'} · ${when}`;
  if (backup.kind === 'restore') return `Before a restore · ${when}`;
  return `When it was removed · ${when}`;
};

/** The restore confirm's title and button. */
export const restoreTitle = (name: string, backup: BackupView): { title: string; button: string } =>
  ({ title: `Restore ${name} to ${shortDate(backup.at)}?`, button: `Restore ${name}` });
