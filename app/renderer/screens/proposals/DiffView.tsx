// Side-by-side current/proposed view, lines wrapped and kept level, of one proposal, from the rows in proposals.logic.ts.
import { useMemo } from 'react';
import { cx } from '../../ui/index.ts';
import { diffRows, diffStats, type DiffCell } from '../proposals.logic.ts';

const cellTone: Record<DiffCell['kind'], string> = {
  same: '',
  removed: 'bg-down/15',
  added: 'bg-up/15',
  moved: '',
};

const marker: Record<DiffCell['kind'], string> = { same: ' ', removed: '-', added: '+', moved: '~' };

/** One side of one row: its line number, marker and text, which wraps instead of scrolling. */
const Cell = ({ cell }: { cell: DiffCell | null }) => (
  <div className={cx('flex min-h-6 min-w-0', cell && cellTone[cell.kind])} data-kind={cell?.kind ?? 'gap'}>
    <span className="w-10 shrink-0 pr-2 text-right text-faint select-none">{cell?.number ?? ''}</span>
    <span className={cx('w-4 shrink-0 select-none', cell?.kind === 'removed' && 'text-down', cell?.kind === 'added' && 'text-up')}>
      {cell ? marker[cell.kind] : ''}
    </span>
    <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">{cell?.text ?? ''}</span>
  </div>
);

/** `current` is null when the proposal is a new page. */
export const DiffView = ({ current, proposed, labels = ['Current', 'Proposed'], emptyCurrent = 'No page yet: promoting creates it.' }: {
  current: string | null; proposed: string; labels?: [string, string]; emptyCurrent?: string;
}) => {
  const rows = useMemo(() => diffRows(current, proposed), [current, proposed]);
  const stats = diffStats(rows);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-faint">
        {current === null ? `New page, ${stats.added} lines.` : `${stats.removed} line${stats.removed === 1 ? '' : 's'} removed, ${stats.added} added${stats.moved ? `, ${stats.moved} moved` : ''}.`}
      </p>
      <div className="@container">
        {/* Narrow: one column, removed lines above the lines that replace them, so nothing wraps mid-word. */}
        <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-card @3xl:hidden" role="group" aria-label={`${labels[0]} and ${labels[1]}, one column`}>
          <h3 className="border-b border-line-subtle px-4 py-2 text-xs font-medium text-muted">
            {current === null ? labels[1] : `${labels[0]} → ${labels[1]}`}
          </h3>
          <div className="py-1.5 font-mono text-xs leading-6">
            {rows.flatMap((row, index) => (row.current?.kind === 'same'
              ? [<Cell key={index} cell={row.proposed} />]
              // A moved line shows once, where it now sits.
              : [row.current && row.current.kind !== 'moved' && <Cell key={`${index}-was`} cell={row.current} />, row.proposed && <Cell key={`${index}-now`} cell={row.proposed} />]))}
          </div>
        </div>
        {/* Wide: one grid, so a wrapped line on one side keeps its row level with the other side. */}
        <div className="hidden grid-cols-2 overflow-hidden rounded-xl border border-line bg-panel shadow-card @3xl:grid" role="group" aria-label={`${labels[0]} and ${labels[1]}`}>
          <h3 className="border-r border-b border-line-subtle px-4 py-2 text-xs font-medium text-muted">{labels[0]}</h3>
          <h3 className="border-b border-line-subtle px-4 py-2 text-xs font-medium text-muted">{labels[1]}</h3>
          {current === null ? (
            <>
              <p className="border-r border-line-subtle px-4 py-3 text-[13px] text-faint">{emptyCurrent}</p>
              <div className="py-1.5 font-mono text-xs leading-6" aria-label={labels[1]}>
                {rows.map((row, index) => <Cell key={index} cell={row.proposed} />)}
              </div>
            </>
          ) : (
            <div className="col-span-2 grid grid-cols-2 py-1.5 font-mono text-xs leading-6">
              {rows.map((row, index) => (
                <div key={index} className="contents">
                  <div className="min-w-0 border-r border-line-subtle"><Cell cell={row.current} /></div>
                  <div className="min-w-0"><Cell cell={row.proposed} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
