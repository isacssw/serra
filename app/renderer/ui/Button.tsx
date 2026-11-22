import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx.ts';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-transparent hover:bg-accent/85',
  secondary: 'bg-panel text-ink border-line hover:bg-hover hover:border-line-strong',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-hover',
  danger: 'bg-down text-status-ink border-transparent hover:bg-down/85',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A lucide icon element shown before the label. */
  icon?: ReactNode;
  /** React 19 passes `ref` as a prop; it reaches the <button>. */
  ref?: Ref<HTMLButtonElement>;
}

export const Button = ({ variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest }: ButtonProps) => (
  <button
    type={type}
    className={cx(
      'inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors duration-150',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      'disabled:pointer-events-none disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
      variants[variant], sizes[size], className,
    )}
    {...rest}
  >
    {icon}
    {children}
  </button>
);
