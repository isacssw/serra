// One look for every field: Input, TextArea and the Select's button. 32px, radius 8, a fill set apart from its card,
// an edge at 3:1, focus as an ink edge plus a soft 3px halo, and a disabled state that reads as off, not broken.
import { cx } from './cx.ts';

/** Classes for a field's box. `invalid` swaps the edge and halo for the down colour. */
export const fieldClass = (invalid?: boolean, size: 'sm' | 'md' = 'md'): string => cx(
  size === 'sm' ? 'rounded-[7px] text-xs' : 'rounded-lg text-[13px]',
  'border bg-field text-ink shadow-field outline-none transition-[border-color,box-shadow] duration-150',
  'placeholder:text-faint/65',
  invalid
    ? 'border-down focus-visible:ring-3 focus-visible:ring-down/25 aria-expanded:ring-3 aria-expanded:ring-down/25'
    : 'border-line-control enabled:hover:border-faint focus-visible:border-focus-field focus-visible:ring-3 focus-visible:ring-ring aria-expanded:border-focus-field aria-expanded:ring-3 aria-expanded:ring-ring',
  'disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-transparent disabled:text-faint disabled:shadow-none',
  'read-only:bg-transparent read-only:shadow-none',
);

/** A field's label: small, medium weight, muted. */
export const labelClass = 'text-xs font-medium text-muted';

/** The help or error line under a field. */
export const noteClass = (error: boolean): string => cx('text-xs leading-4', error ? 'text-down' : 'text-faint');
