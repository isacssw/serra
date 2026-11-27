// Who may hear a page, as three choices in one track. Pages sets it in a page's header; Proposals sets it on the page
// an approval creates or replaces.
import type { Audience } from '../../../src/owner-model.ts';
import { cx, Segmented } from '../ui/index.ts';
import { labelClass } from '../ui/field.ts';

const OPTIONS: { value: Audience; label: string; title: string }[] = [
  { value: 'owner', label: 'Only you', title: 'Only you' },
  { value: 'team', label: 'Team', title: 'Your team' },
  { value: 'external', label: 'External', title: 'People outside your company' },
];

/** `label` shows "Who may hear it" above the track; without it the name is only read out. */
export const AudienceChoice = ({ value, disabled, onChange, id, label = false, className }: {
  value: Audience; disabled?: boolean; onChange: (value: Audience) => void; id: string; label?: boolean; className?: string;
}) => (
  <div className={cx('flex flex-col gap-1.5', className)}>
    <span id={id} className={label ? labelClass : 'sr-only'}>Who may hear it</span>
    <Segmented aria-labelledby={id} value={value} onChange={onChange} options={OPTIONS} disabled={disabled} size={label ? 'md' : 'sm'} />
  </div>
);
