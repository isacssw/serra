// The Add… sheet and pairing with a server (SB-32), as pure steps and words, so the dialog only draws them.
//
//   add → address (Address + Code) → words (do they match?) → ready
//                                  ↘ not paired (they don't)    ↘ back to the code (tries left) / locked
//   add → address → ssh (SSH address) → ready, or what went wrong in a few words
//
// The words come from the server's certificate and the typed code, and the code is only sent after the owner says
// they match (ux-rules F5), so a new code always means new words. Copy follows ux-rules A4.
import type { PairOutcome, ServerView } from '../../../src/gateway/pairing.ts';

export type PairStep =
  | { step: 'add' }
  | { step: 'address'; address: string; code: string; error: string | null; codeError?: string | null; name?: string }
  | { step: 'words'; address: string; code: string; probeId: string; name: string; words: readonly string[] }
  | { step: 'mismatch'; name: string }
  | { step: 'locked'; name: string; address: string; expired: boolean }
  | { step: 'ssh'; target: string; error: { title: string; line: string } | null }
  | { step: 'ready'; server: ServerView };

/** The code's 31 letters and digits: no 0/O, 1/I/L. */
const CODE_CHARS = /[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g;

/** What the code field shows as it is typed or pasted: capitals, six at most, `K7Q-4MX`. */
export const codeInput = (typed: string): string => {
  const chars = typed.toUpperCase().replace(CODE_CHARS, '').slice(0, 6);
  return chars.length > 3 ? `${chars.slice(0, 3)}-${chars.slice(3)}` : chars;
};

export const codeComplete = (code: string): boolean => code.replace('-', '').length === 6;

/** The title for each step. A server's own name once it is known. */
export const pairTitle = (step: PairStep): string => {
  switch (step.step) {
    case 'add': return 'Add';
    case 'address': return step.name ? `Pair with ${step.name}` : 'Add server';
    case 'words': return `Pair with ${step.name}`;
    case 'mismatch': return 'Not paired';
    case 'locked': return `Pair with ${step.name}`;
    case 'ssh': return 'Pair over SSH';
    case 'ready': return `${step.server.name} is ready`;
  }
};

/** The one short line under the title. */
export const pairLine = (step: PairStep): string | null => {
  switch (step.step) {
    case 'add': return null;
    case 'address': return step.name ? `On ${step.name}, run serra server pair.` : 'On the server, run serra server pair.';
    case 'words': return `${step.name} shows three words. Do they match?`;
    case 'mismatch': return 'The words didn’t match, so nothing was sent.';
    case 'locked': return step.expired ? `The code expired. Run serra server pair on ${step.name} again.` : `No tries left. Run serra server pair on ${step.name} again.`;
    case 'ssh': return 'Uses your SSH keys. Nothing opens to the internet.';
    case 'ready': return step.server.profiles.length ? null : 'No profiles yet';
  }
};

/** A wrong code, said with what is left. */
export const wrongCode = (triesLeft: number): string => `Wrong or expired code. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left.`;

/** `you@t480.home` → `t480`. */
const sshName = (target: string): string => target.trim().replace(/^[^@]*@/, '').split('.')[0] || target.trim();

/** What a failed SSH pairing says: what happened and that nothing changed, in two short lines (A6). */
export const sshError = (target: string, detail: string): { title: string; line: string } => {
  const name = sshName(target);
  switch (detail) {
    case 'no serra': return { title: `Serra isn’t on ${name}`, line: `Install it there with ./scripts/install.sh, then try again.` };
    case 'no gateway': return { title: `${name} isn’t ready`, line: `On ${name}, run serra server gateway --install, then try again.` };
    case 'key refused':
    case 'host unknown':
    case 'timed out':
      return { title: `Can’t reach ${name} over SSH · ${detail}`, line: `Nothing changed. Check ssh ${target.trim()} works in Terminal.` };
    default: return { title: `Can’t reach ${name} over SSH`, line: `Nothing changed. Check ssh ${target.trim()} works in Terminal.` };
  }
};


/** Where the dialog goes once the server answered the code: ready, the code again with tries left, or locked. */
export const afterCode = (sent: { address: string; name: string }, outcome: PairOutcome): PairStep => {
  if (outcome.ok) return { step: 'ready', server: outcome.server };
  if (outcome.reason === 'wrong') return { step: 'address', address: sent.address, code: '', error: null, codeError: wrongCode(outcome.triesLeft), name: sent.name };
  return { step: 'locked', name: sent.name, address: sent.address, expired: outcome.reason === 'expired' };
};
