// A row of two to four exclusive choices in one track: About me's audience tabs, who may hear a page. As tabs
// (`role="tab"`) it switches a view; as radios it sets a value. Either way the arrow keys move the choice and only the
// chosen segment is a Tab stop, as WAI-ARIA asks of both patterns.
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from './cx.ts';

interface SegmentOption<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  /** A longer name on hover, like "People outside your company" for "External". */
  title?: string;
}

export interface SegmentedProps<V extends string> {
  value: V;
  onChange(value: V): void;
  options: readonly SegmentOption<V>[];
  /** `tab` when the choice switches what the page shows, `radio` when it sets a value. */
  kind?: 'tab' | 'radio';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  /** For tabs: the id of the panel they control. */
  controls?: string;
}

export const Segmented = <V extends string>({
  value, onChange, options, kind = 'radio', 'aria-label': ariaLabel, 'aria-labelledby': labelledBy, disabled, size = 'md', className, controls,
}: SegmentedProps<V>) => {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const at = options.findIndex((option) => option.value === value);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? at + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? at - 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const index = (next + options.length) % options.length;
    onChange(options[index]!.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[index]?.focus();
  };
  return (
    <div
      role={kind === 'tab' ? 'tablist' : 'radiogroup'}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      className={cx('inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-line-strong bg-raised p-0.5', disabled && 'opacity-60', className)}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={kind}
            {...(kind === 'tab' ? { 'aria-selected': on, ...(controls ? { 'aria-controls': controls } : {}) } : { 'aria-checked': on })}
            tabIndex={on ? 0 : -1}
            title={option.title}
            disabled={disabled}
            onClick={() => { if (!on) onChange(option.value); }}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-150',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed',
              size === 'sm' ? 'h-[22px] px-2 text-xs' : 'h-[26px] px-2.5 text-[13px]',
              on ? 'bg-[light-dark(#ffffff,#2a2a31)] text-ink shadow-[0_1px_2px_rgb(0_0_0/0.14),0_0_0_1px_var(--color-line-strong)]' : 'text-muted enabled:hover:text-ink',
            )}
          >
            {option.icon && <span aria-hidden className={cx('flex', on ? 'text-ink' : 'text-faint')}>{option.icon}</span>}
            {option.label}
          </button>
        );
      })}
    </div>
  );
};
