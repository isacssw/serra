// Side-by-side current/proposed view of one proposal, from the rows in proposals.logic.ts.
import { useMemo } from 'react';
import { cx } from '../../ui/index.ts';
import { diffRows, diffStats, type DiffCell, type DiffRow } from '../proposals.logic.ts';

const cellTone: Record<DiffCell['kind'], string> = {
  same: '',
  removed: 'bg-down/15',
  added: 'bg-up/15',
};

const marker: Record<DiffCell['kind'], string> = { same: ' ', removed: '-', added: '+' };

const Side = ({ title, rows, side, empty }: { title: string; rows: DiffRow[]; side: keyof DiffRow; empty?: string }) => (
  <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-panel" aria-label={title}>
    <h3 className="border-b border-line bg-raised px-3 py-2 text-sm font-semibold">{title}</h3>
    {empty ? (
      <p className="px-3 py-3 text-sm text-muted">{empty}</p>
    ) : (
      <div className="overflow-x-auto py-1.5 font-mono text-xs leading-6">
        {rows.map((row, index) => {
          const cell = row[side];
          return (
            <div key={index} className={cx('flex min-h-6 min-w-max', cell && cellTone[cell.kind])} data-kind={cell?.kind ?? 'gap'}>
              <span className="w-10 shrink-0 pr-2 text-right text-muted select-none">{cell?.number ?? ''}</span>
              <span className={cx('w-4 shrink-0 select-none', cell?.kind === 'removed' && 'text-down', cell?.kind === 'added' && 'text-up')}>
                {cell ? marker[cell.kind] : ''}
              </span>
              <span className="pr-3 whitespace-pre">{cell?.text ?? ''}</span>
            </div>
          );
        })}
      </div>
    )}
  </section>
);

/** `current` is null when the proposal is a new page. */
export const DiffView = ({ current, proposed, labels = ['Current', 'Proposed'], emptyCurrent = 'No page yet: promoting creates it.' }: {
  current: string | null; proposed: string; labels?: [string, string]; emptyCurrent?: string;
}) => {
  const rows = useMemo(() => diffRows(current, proposed), [current, proposed]);
  const stats = diffStats(rows);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        {current === null ? `New page, ${stats.added} lines.` : `${stats.removed} lines removed, ${stats.added} added.`}
      </p>
      <div className="flex gap-2">
        <Side title={labels[0]} rows={rows} side="current" empty={current === null ? emptyCurrent : undefined} />
        <Side title={labels[1]} rows={rows} side="proposed" />
      </div>
    </div>
  );
};
