import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx.ts';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

// Disabled buttons drop their fill and keep an outline with faint text: off, never a grey block.
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-transparent enabled:hover:bg-accent/88 enabled:active:bg-accent/80 disabled:border-line aria-disabled:border-line',
  secondary: 'bg-control text-ink border-line-control shadow-field enabled:hover:bg-control-hover enabled:hover:border-faint enabled:active:bg-selected disabled:border-line disabled:shadow-none aria-disabled:border-line',
  ghost: 'bg-transparent text-muted border-transparent enabled:hover:bg-hover enabled:hover:text-ink enabled:active:bg-selected disabled:border-transparent aria-disabled:border-transparent',
  danger: 'bg-down text-status-ink border-transparent enabled:hover:bg-down/88 enabled:active:bg-down/80 disabled:border-line aria-disabled:border-line',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-[7px]',
  md: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A text action in a form: no side padding, so its icon lines up with the fields above (the hover fill still shows). */
  flush?: boolean;
  /** A lucide icon element shown before the label. */
  icon?: ReactNode;
  /** React 19 passes `ref` as a prop; it reaches the <button>. */
  ref?: Ref<HTMLButtonElement>;
}

export const Button = ({ variant = 'secondary', size = 'md', flush, icon, className, children, type = 'button', ...rest }: ButtonProps) => (
  <button
    type={type}
    className={cx(
      'inline-flex shrink-0 select-none items-center justify-center border font-medium whitespace-nowrap transition-colors duration-150',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      variants[variant], sizes[size],
      'disabled:cursor-not-allowed disabled:bg-transparent disabled:text-faint disabled:shadow-none',
      // A button kept focusable while off (aria-disabled, so it can say why) looks like a disabled one, and takes no hover.
      'aria-disabled:cursor-not-allowed aria-disabled:bg-transparent aria-disabled:text-faint aria-disabled:shadow-none aria-disabled:hover:bg-transparent',
      flush && (size === 'sm' ? '-mx-2.5' : '-mx-3'),
      className,
    )}
    {...rest}
  >
    {icon}
    {children}
  </button>
);
