// Who may hear a page, as three plain choices. Pages sets it in a page's header; Proposals sets it on the page an
// approval creates or replaces.
import type { KeyboardEvent } from 'react';
import type { Audience } from '../../../src/owner-model.ts';
import { cx } from '../ui/index.ts';

const OPTIONS: { value: Audience; label: string }[] = [
  { value: 'owner', label: 'Only you' }, { value: 'team', label: 'Your team' }, { value: 'external', label: 'Outside your company' },
];

/** Arrow keys move the choice, as in any radio group; only the chosen option is a Tab stop. */
const onArrow = (value: Audience, onChange: (value: Audience) => void) => (event: KeyboardEvent<HTMLDivElement>) => {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const at = (OPTIONS.findIndex((option) => option.value === value) + step + OPTIONS.length) % OPTIONS.length;
  onChange(OPTIONS[at]!.value);
  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[at]?.focus();
};

export const AudienceChoice = ({ value, disabled, onChange, id }: { value: Audience; disabled?: boolean; onChange: (value: Audience) => void; id: string }) => (
  <div className="flex flex-wrap items-center gap-2">
    <span id={id} className="text-xs text-muted">Who may hear it</span>
    <div role="radiogroup" aria-labelledby={id} className="flex gap-1" onKeyDown={disabled ? undefined : onArrow(value, onChange)}>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-7 rounded-md border px-2 text-xs focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50',
            value === option.value ? 'border-line-strong bg-selected text-ink' : 'border-line text-muted hover:bg-raised hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
);
