// The one dropdown: a button that opens a list of options, in place of the system <select>. It looks like the other
// fields (field.ts), can show an icon per option (brand marks, lucide icons), groups options under headings, and
// follows the WAI-ARIA select-only combobox pattern (select.logic.ts) for the keyboard and screen readers. The list
// is a popover, so it draws above dialogs and is never clipped by a scrolling parent.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from './cx.ts';
import { fieldClass, labelClass, noteClass } from './field.ts';
import { isPrintable, openIndex, selectKey, typeahead } from './select.logic.ts';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
  /** Shown before the label, in the list and on the button when chosen: a brand mark or a lucide icon. */
  icon?: ReactNode;
  /** A short muted note after the label in the list, like "Not installed". */
  detail?: string;
  /** Options with the same group are listed under that heading, in the order the groups first appear. */
  group?: string;
}

export interface SelectProps<V extends string> {
  value: V;
  onChange(value: V): void;
  options: readonly SelectOption<V>[];
  /** A visible label above the button. Without one, pass `aria-label`. */
  label?: string;
  'aria-label'?: string;
  hint?: string;
  error?: string | null;
  id?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** An icon on the button when the chosen option has none (Jobs' channel filter). */
  icon?: ReactNode;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  /** Lays out the wrapper (width, grid span). */
  className?: string;
}

/** Puts options in group order, so the list, its headings and the keyboard all agree. */
const inGroupOrder = <V extends string>(options: readonly SelectOption<V>[]): SelectOption<V>[] => {
  const groups = [...new Set(options.map((option) => option.group ?? ''))];
  return groups.flatMap((group) => options.filter((option) => (option.group ?? '') === group));
};

/** Places the list under the button, or above it when there is more room there, inside the window. */
const place = (button: HTMLElement, list: HTMLElement): void => {
  const box = button.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const below = window.innerHeight - box.bottom - gap - margin;
  const above = box.top - gap - margin;
  const natural = list.scrollHeight;
  const up = below < Math.min(natural, 240) && above > below;
  const room = Math.max(120, Math.min(320, up ? above : below));
  list.style.minWidth = `${box.width}px`;
  list.style.maxHeight = `${room}px`;
  const height = Math.min(natural, room);
  list.style.top = `${up ? box.top - gap - height : box.bottom + gap}px`;
  list.style.left = `${Math.max(margin, Math.min(box.left, window.innerWidth - list.offsetWidth - margin))}px`;
};

export const Select = <V extends string>({
  value, onChange, options, label, 'aria-label': ariaLabel, hint, error, id, disabled, size = 'md', icon, placeholder = 'Choose…', className,
}: SelectProps<V>) => {
  const generated = useId();
  const buttonId = id ?? generated;
  const labelId = `${buttonId}-label`;
  const listId = `${buttonId}-list`;
  const noteId = `${buttonId}-note`;
  const optionId = (index: number): string => `${buttonId}-option-${index}`;
  const ordered = inGroupOrder(options);
  const selected = ordered.findIndex((option) => option.value === value);
  const chosen = ordered[selected];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ query: '', at: 0 });
  const note = error || hint;

  const show = (index: number): void => { setActive(index); setOpen(true); };
  const close = (): void => setOpen(false);
  const choose = (index: number): void => {
    const option = ordered[index];
    close();
    if (option && !option.disabled && option.value !== value) onChange(option.value);
  };

  // Open: into the top layer, placed by the button, following it while anything scrolls or the window resizes.
  useLayoutEffect(() => {
    const popup = list.current;
    const anchor = button.current;
    if (!popup || !anchor) return;
    if (!open) { if (popup.matches(':popover-open')) popup.hidePopover(); return; }
    if (!popup.matches(':popover-open')) popup.showPopover();
    place(anchor, popup);
    const follow = (): void => place(anchor, popup);
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => { window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true); };
  }, [open]);

  // Keeps the highlighted option in view as the arrows move it.
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${buttonId}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, buttonId]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (isPrintable(event.key, event)) {
      const now = event.timeStamp;
      const query = now - typed.current.at > 600 ? event.key : typed.current.query + event.key;
      typed.current = { query, at: now };
      const match = typeahead(ordered, query, open ? active : selected);
      if (match >= 0) show(match);
      event.preventDefault();
      return;
    }
    const action = selectKey(event.key, { open, active, selected, options: ordered, altKey: event.altKey });
    switch (action.type) {
      case 'none': return;
      case 'open': show(action.index); break;
      case 'move': setActive(action.index); break;
      case 'close': close(); break;
      case 'choose':
        choose(action.index);
        if (!action.keepFocus) return;
        break;
    }
    event.preventDefault();
  };

  const groups = [...new Set(ordered.map((option) => option.group ?? ''))]
    .map((group) => ({ group, items: ordered.flatMap((option, index) => ((option.group ?? '') === group ? [{ option, index }] : [])) }));
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      {label && <label id={labelId} htmlFor={buttonId} className={labelClass}>{label}</label>}
      <button
        ref={button}
        id={buttonId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        aria-describedby={note ? noteId : undefined}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show(openIndex(ordered, selected)))}
        onKeyDown={onKeyDown}
        onBlur={close}
        className={cx(
          'group flex w-full min-w-0 cursor-default items-center gap-2 text-left',
          size === 'sm' ? 'h-7 px-2' : 'h-8 px-2.5',
          fieldClass(Boolean(error), size),
        )}
      >
        {(chosen?.icon ?? icon) && <span className="flex shrink-0 text-muted group-disabled:text-faint" aria-hidden>{chosen?.icon ?? icon}</span>}
        <span className={cx('min-w-0 flex-1 truncate', !chosen && 'text-faint')}>{chosen?.label ?? placeholder}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint transition-transform duration-150 group-aria-expanded:rotate-180" />
      </button>
      {note && <p id={noteId} className={noteClass(Boolean(error))}>{note}</p>}
      <div
        ref={list}
        id={listId}
        role="listbox"
        popover="manual"
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        tabIndex={-1}
        // Clicks on a heading or the scrollbar keep focus on the button too, so the list stays open.
        onMouseDown={(event) => event.preventDefault()}
        className={cx(
          'fixed inset-auto m-0 max-w-[min(360px,calc(100vw-16px))] overflow-y-auto overscroll-contain rounded-[10px] border-0 bg-overlay p-1 text-ink shadow-overlay',
          'motion-safe:animate-[serra-pop_120ms_ease-out]',
        )}
      >
        {groups.map(({ group, items }) => {
          const rows = items.map(({ option, index }) => (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              data-value={option.value}
              aria-selected={index === selected}
              aria-disabled={option.disabled || undefined}
              data-active={index === active || undefined}
              // The button keeps focus: the list is only ever pointed at.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => { if (!option.disabled && index !== active) setActive(index); }}
              onClick={() => { if (!option.disabled) choose(index); }}
              className={cx(
                'flex cursor-default items-center gap-2 rounded-md px-2 whitespace-nowrap',
                size === 'sm' ? 'min-h-7 text-xs' : 'min-h-8 text-[13px]',
                option.disabled ? 'text-faint' : 'text-ink data-active:bg-selected',
              )}
            >
              {option.icon && <span className={cx('flex shrink-0', option.disabled ? 'text-faint' : 'text-muted')} aria-hidden>{option.icon}</span>}
              <span className={cx('min-w-0 flex-1 truncate', index === selected && 'font-medium')}>{option.label}</span>
              {option.detail && <span className="shrink-0 text-xs text-faint">{option.detail}</span>}
              <Check size={14} strokeWidth={2} aria-hidden className={cx('shrink-0', index === selected ? 'text-ink' : 'invisible')} />
            </div>
          ));
          if (!group) return rows;
          const headingId = `${buttonId}-group-${group.replace(/\W+/g, '-')}`;
          return (
            <div key={group} role="group" aria-labelledby={headingId}>
              <div id={headingId} className="px-2 pt-2 pb-1 text-[11px] font-medium text-faint">{group}</div>
              {rows}
            </div>
          );
        })}
      </div>
    </div>
  );
};
