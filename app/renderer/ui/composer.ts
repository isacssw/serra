// One look for the two places you write to the agent: New task and the follow-up in a run's chat. A card-like box
// with a 3:1 edge, a soft lift (shadow-composer), the field focus ring, and a round ink send button.
import { cx } from './cx.ts';

/** The composer's box. `filled` firms the edge once something is typed; `invalid` swaps it for the down colour. */
export const composerClass = ({ invalid = false, filled = false }: { invalid?: boolean; filled?: boolean } = {}): string => cx(
  'rounded-2xl border bg-panel shadow-composer transition-[border-color,box-shadow] duration-150',
  invalid
    ? 'border-down focus-within:ring-3 focus-within:ring-down/20'
    : cx(filled ? 'border-faint' : 'border-line-control', 'focus-within:border-focus-field focus-within:ring-3 focus-within:ring-ring'),
);

/** The text area inside: no box of its own, grows with what's typed. */
export const composerInputClass = 'resize-none bg-transparent text-ink outline-none [field-sizing:content] placeholder:text-faint disabled:opacity-60';

/** The round send (or start) button. Disabled is an outline, never a grey disc. */
export const sendButtonClass = cx(
  'grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition-colors duration-150 enabled:hover:bg-accent/88',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:border disabled:border-line-strong disabled:bg-transparent disabled:text-faint',
);

/** The ⌘↩ hint beside the send button. */
export const composerKbdClass = 'rounded border border-line px-1 font-sans text-[11px] leading-4 text-faint';
