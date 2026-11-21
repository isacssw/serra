import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export type BadgeTone = 'neutral' | 'accent' | 'up' | 'warn' | 'down';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-raised text-muted',
  accent: 'bg-selected text-ink',
  up: 'bg-up/15 text-up',
  warn: 'bg-warn text-status-ink',
  down: 'bg-down/15 text-down',
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** A count badge is a round pill with tabular digits; a label badge is a small tag. */
  shape?: 'count' | 'label';
  className?: string;
  title?: string;
  children: ReactNode;
}

export const Badge = ({ tone = 'neutral', shape = 'label', className, title, children }: BadgeProps) => (
  <span
    title={title}
    className={cx(
      'inline-flex items-center justify-center font-medium',
      shape === 'count' ? 'min-w-5 h-5 rounded-full px-1.5 text-xs tabular-nums' : 'h-5 rounded px-1.5 text-xs',
      tones[tone], className,
    )}
  >
    {children}
  </span>
);
