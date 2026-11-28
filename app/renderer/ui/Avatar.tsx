// A profile's avatar (SB-10): its letters on its colour, with the status dot at the corner. A profile left halfway is
// a dashed outline with no dot. The dot's word is always beside it or in the label (UX rule B4), never colour alone.
import type { Dot } from '../presence.logic.ts';
import { cx } from './cx.ts';

const dotColor: Record<Exclude<Dot, 'none'>, string> = { up: 'bg-up', warn: 'bg-warn', down: 'bg-down', faint: 'bg-faint' };

const rings = { sidebar: 'ring-sidebar', overlay: 'ring-overlay', panel: 'ring-panel', canvas: 'ring-canvas' } as const;

export const Avatar = ({ letters, color, size, dot = 'none', pulse = false, dashed = false, surface = 'sidebar', className }: {
  letters: string; color: string; size: 16 | 18 | 24 | 28 | 44; dot?: Dot; pulse?: boolean; dashed?: boolean;
  /** What the avatar sits on: the dot's ring takes its colour, so the dot reads apart from the letters. */
  surface?: keyof typeof rings; className?: string;
}) => {
  const dotSize = size <= 18 ? 'size-[7px]' : size <= 28 ? 'size-[9px]' : 'size-3';
  return (
    <span aria-hidden className={cx('relative inline-grid shrink-0 place-items-center', className)} style={{ width: size, height: size }}>
      <span
        className={cx(
          'grid size-full place-items-center font-semibold select-none',
          size <= 18 ? 'rounded-[4px] text-[8px]' : size === 24 ? 'rounded-[6px] text-[11px]' : size === 28 ? 'rounded-[7px] text-[12px]' : 'rounded-[10px] text-[17px]',
          // A hairline inside the fill, so the deepest colours still read as a tile on a dark surface.
          dashed ? 'border border-dashed border-line-strong text-muted' : 'text-avatar-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]',
        )}
        style={dashed ? undefined : { backgroundColor: color }}
      >
        {letters}
      </span>
      {dot !== 'none' && !dashed && (
        <span className={cx('absolute -right-[2px] -bottom-[2px] rounded-full ring-2', rings[surface], dotSize, dotColor[dot], pulse && 'motion-safe:animate-pulse')} />
      )}
    </span>
  );
};
