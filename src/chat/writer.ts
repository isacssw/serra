/**
 * Writing the worker's words. Only an adapter makes a `WorkerWriter`, and only `deliver` (`deliver.ts`) is ever handed
 * one: the rest of the core holds a `ChatPort`, which has no method that takes worker text. An import rule in
 * `.oxlintrc.json` keeps this file to `src/chat/deliver.ts` and the adapters (`src/slack/`), types included.
 */
import type { Audience, MessageRef, PersonId, Result, Target, WorkerFile, WorkerOut } from './port.ts';

declare const cleared: unique symbol;
/** The adapter confirmed, at `at`, who can see `target`. Only `clearedFor` makes one, and only adapters call it. */
export interface Cleared { readonly [cleared]: true; readonly target: Target; readonly audience: Audience; readonly at: number }

/** The one way to make a `Cleared`. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand exists only in the type; this is its constructor
export const clearedFor = (target: Target, audience: Audience, at: number): Cleared => ({ target, audience, at }) as Cleared;

export interface WorkerWriter {
  /** Asks the chat who can see `target` now, for a reply to `requester`. */
  clear(target: Target, requester: PersonId): Promise<Result<Cleared>>;
  /** Posts in `proof.target`. Returns the message's ID. Throws what the chat throws. */
  send(proof: Cleared, out: WorkerOut): Promise<string>;
  /** Edits a message in `proof.target`'s conversation (who can see it is the conversation's). Throws `MessageGone` when it was deleted. */
  revise(proof: Cleared, ref: MessageRef, out: WorkerOut): Promise<void>;
  /** Uploads a file into `proof.target`. Returns the error instead of throwing, so one failed upload doesn't lose the reply. */
  upload(proof: Cleared, file: WorkerFile): Promise<Error | null>;
}
