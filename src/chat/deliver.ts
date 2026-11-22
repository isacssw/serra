/**
 * The one way the worker's words reach a chat. `createDeliver` is handed the adapter's `WorkerWriter` and the page
 * check, and keeps both: the function it returns is the only code that ever writes worker text. Each write first asks
 * the chat who can see the target now (`clear`), then checks that this audience may hear what the worker was told, and
 * writes straight after, so the gap between the check and the post is as small as it can be.
 *
 * A caller can't skip or loosen the check: it names one of a closed list of rules (`Hearing`), and the page check
 * itself is fixed when the daemon wires `deliver`.
 *
 * Not guaranteed by anything: the milliseconds between the chat's answer and the write. A channel can be shared outside
 * in between. Today's code has the same gap.
 */
import { mayHearWith, wider, type Heard } from '../hearing.ts';
import type { BriefKnowledge } from '../knowledge.ts';
import type { Audience, ChatError, MessageRef, PersonId, Target, WorkerFile, WorkerOut } from './port.ts';
import type { Cleared, WorkerWriter } from './writer.ts';

/** Which rule a write must pass, besides the chat saying who can see the target. */
type Hearing =
  /**
   * A job's thread: everyone who can see it may hear every page its worker was told. `heard` is the job as saved: a
   * caller could still pass a made-up record here, which only review catches. An empty one is withheld from all but the owner.
   */
  | { kind: 'thread'; heard: Heard }
  /** Text only the owner may see, such as raw error output: the target must be theirs alone. */
  | { kind: 'owner-only' }
  /**
   * Somewhere else than the job's thread (the code-review channel): everyone there may hear what the worker was told,
   * and so may whoever sees `source`, the job's thread, now.
   */
  | { kind: 'elsewhere'; heard: Heard; source: { target: Target; requester: PersonId } };

/** Where worker words go, for whom, and the rule they must pass. */
export interface Delivery {
  target: Target;
  /** Whose request this answers: their DM, say, is theirs alone. */
  requester: PersonId;
  hearing: Hearing;
}

type Write =
  | { op: 'send'; out: WorkerOut }
  | { op: 'revise'; ref: MessageRef; out: WorkerOut }
  | { op: 'upload'; file: WorkerFile };

type Written<W extends Write> = W extends { op: 'send' } ? string : W extends { op: 'upload' } ? Error | null : undefined;

/** Not written: `withheld` when the audience may not hear it, `unconfirmed` when the chat couldn't say who the audience is. */
export type Refused = { ok: false; why: 'withheld' } | { ok: false; why: 'unconfirmed'; error: ChatError };
type Delivered<T> = { ok: true; value: T } | Refused;

export type Deliver = <W extends Write>(to: Delivery, write: W) => Promise<Delivered<Written<W>>>;

/**
 * `loadKnowledge`: the knowledge for an audience, the same one the bot builds briefs from. Without it (no knowledge set
 * up) nothing is withheld, as for the bot's own checks.
 */
export const createDeliver = (writer: WorkerWriter, loadKnowledge: ((visibility: Audience) => BriefKnowledge) | undefined): Deliver => {
  const mayHear = mayHearWith(loadKnowledge);
  const perform = async (proof: Cleared, write: Write): Promise<string | Error | null | undefined> => {
    switch (write.op) {
      case 'send': return writer.send(proof, write.out);
      case 'revise': await writer.revise(proof, write.ref, write.out); return undefined;
      case 'upload': return writer.upload(proof, write.file);
    }
  };

  return async <W extends Write>(to: Delivery, write: W): Promise<Delivered<Written<W>>> => {
    const { hearing } = to;
    // Raw error output is never worker words for a thread: it goes only where only the owner can see it.
    if ('out' in write && write.out.kind === 'failure-detail' && hearing.kind !== 'owner-only') throw new Error('An error\'s detail goes out only under the owner-only rule');
    // Somewhere else: who sees the job's thread now is asked first, so the target's answer is the last before the write.
    let heard = 'heard' in hearing ? hearing.heard : {};
    if (hearing.kind === 'elsewhere') {
      const source = await writer.clear(hearing.source.target, hearing.source.requester);
      if (!source.ok) return { ok: false, why: 'unconfirmed', error: source.error };
      if (!mayHear(heard, source.value.audience)) return { ok: false, why: 'withheld' };
      // The target is then checked for the wider of the two: the source's audience is who the worker's thread speaks to now.
      heard = { ...heard, visibility: wider(heard.visibility, source.value.audience) };
    }
    const cleared = await writer.clear(to.target, to.requester);
    if (!cleared.ok) return { ok: false, why: 'unconfirmed', error: cleared.error };
    const audience = cleared.value.audience;
    if (hearing.kind === 'owner-only' ? audience !== 'owner' : !mayHear(heard, audience)) return { ok: false, why: 'withheld' };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `perform` returns what `write.op` asks for; TypeScript can't narrow a generic through the switch
    return { ok: true, value: (await perform(cleared.value, write)) as Written<W> };
  };
};
