// The sidebar's way back to setup while a step is left: "Finish setup" with a ring of the steps done.
import { Link } from 'react-router';
import { cx } from '../ui/index.ts';
import { doneCount, FLOW, resumePath, ringDash, setupRowLabel } from './setup.logic.ts';
import { useSetup } from './SetupState.tsx';

const R = 6;

export const SetupRow = () => {
  const { progress } = useSetup();
  if (!progress?.next) return null;
  const label = setupRowLabel(progress);
  const ring = ringDash(doneCount(progress), FLOW.length, R);
  return (
    <Link
      to={resumePath(progress)}
      data-nav
      data-setup-row
      aria-label={label.aria}
      className={cx(
        'group mb-1.5 flex h-8 items-center gap-2.5 rounded-lg border border-line px-2 text-[13px] text-ink transition-colors duration-150',
        'hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
      )}
    >
      <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden className="shrink-0 -rotate-90">
        <circle cx="8" cy="8" r={R} fill="none" strokeWidth="2" className="stroke-line-strong" />
        <circle cx="8" cy="8" r={R} fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-ink" strokeDasharray={ring.dash} />
      </svg>
      <span className="flex-1 truncate font-medium">{label.text}</span>
      <span className="text-[11px] text-muted tabular-nums">{label.detail}</span>
    </Link>
  );
};
