import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * What a list says when it has nothing to show: an icon, a title, one sentence and at most one next step. An empty
 * list should read as an answer ("you're all caught up"), never as a page that failed to load.
 */
export const EmptyState = ({ icon, title, children, action, className }: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) => (
  <div className={cx('flex flex-col items-center gap-3 rounded-xl border border-dashed border-line px-6 py-14 text-center', className)}>
    <span className="grid size-10 place-items-center rounded-full border border-line bg-raised text-muted" aria-hidden>{icon}</span>
    <div className="flex max-w-sm flex-col gap-1">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <p className="text-[13px] leading-5 text-muted">{children}</p>}
    </div>
    {action && <div className="pt-1">{action}</div>}
  </div>
);
