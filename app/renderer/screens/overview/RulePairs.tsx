// Needs you's rule pairs, opened. Repeats: each rule once, as its newest line reads, with one "Use newer" and the
// other choices behind "More". Disagreements: the two rules side by side, older on the left, one Keep each. FixList.tsx
// owns what a click does; this file only draws. The pure half is conflicts.logic.ts.
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { PairInfo } from '../../../../src/knowledge-health.ts';
import { Button, cx } from '../../ui/index.ts';
import { droppedWords, sideNames, wordDiff, type ChainRow, type DiffPart } from '../conflicts.logic.ts';

export interface PairActions {
  busy: boolean;
  /** Keep one side; the other moves under "Replaced" on its page. */
  keep: (pair: PairInfo, side: 'older' | 'newer') => void;
  /** Keep a repeated rule's newest line (every older version moves under "Replaced") or its latest older one. */
  keepRow: (row: ChainRow, side: 'older' | 'newer') => void;
  /** Both lines hold: the pairs stop being listed. No page changes. */
  bothHold: (pairs: PairInfo[]) => void;
}

/** One side of two rules that disagree, what sets it apart in bold. */
const Side = ({ parts }: { parts: DiffPart[] }) => (
  <>{parts.map((part, at) => (part.op === 'same' ? <span key={at}>{part.text}</span> : <strong key={at} className="font-semibold text-ink">{part.text}</strong>))}</>
);

/** The newest line, its added words in quiet green: what "Use newer" keeps. */
const Newest = ({ row }: { row: ChainRow }) => (
  <>{wordDiff(row.latest.older.plain, row.newer.plain, 'newer').map((part, at) => <span key={at} className={cx(part.op === 'add' && 'text-up')}>{part.text}</span>)}</>
);

const RepeatRow = ({ row, actions }: { row: ChainRow; actions: PairActions }) => {
  const [more, setMore] = useState(false);
  const dropped = row.covers ? null : droppedWords(row);
  // A rule "Use newer for N" already settles needs no button of its own; its other choices stay behind "…".
  const own = !row.safe || more;
  return (
    <li className="flex items-start gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5" title={[...row.olders.map((side) => side.text), row.newer.text].join('\n')}>
        <p className="text-[13px] leading-5 text-ink">{row.twice ? row.newer.plain : <Newest row={row} />}</p>
        {row.twice && <p className="text-xs text-faint">Written twice</p>}
        {dropped && <p className="text-xs text-warn">Drops “{dropped}”</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {more && !row.twice && <Button size="sm" variant="ghost" disabled={actions.busy} title={row.latest.older.text} onClick={() => actions.keepRow(row, 'older')}>{row.order === 'length' ? 'Use shorter' : 'Use older'}</Button>}
        {more && <Button size="sm" variant="ghost" disabled={actions.busy} title="Leave the page as it is" onClick={() => actions.bothHold(row.all)}>Keep both</Button>}
        {own && (
          <Button size="sm" disabled={actions.busy} title={row.newer.text} onClick={() => actions.keepRow(row, 'newer')}>
            {row.twice ? 'Remove copy' : row.order === 'length' ? 'Use longer' : 'Use newer'}
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-label="Other choices" aria-expanded={more} className="px-1.5" onClick={() => setMore(!more)}><MoreHorizontal size={14} aria-hidden /></Button>
      </div>
    </li>
  );
};

/** One page's repeated rules, each once. */
export const RepeatPairs = ({ rows, actions }: { rows: ChainRow[]; actions: PairActions }) => (
  <ul className="flex flex-col divide-y divide-line-subtle">{rows.map((row) => <RepeatRow key={row.key} row={row} actions={actions} />)}</ul>
);

/** Two rules that disagree, side by side, older on the left; what tells them apart in bold. */
export const DisagreePairs = ({ pairs, titleOf, actions }: { pairs: PairInfo[]; titleOf: (page: string) => string; actions: PairActions }) => (
  <ul className="flex flex-col gap-3">
    {pairs.map((pair) => {
      const [from, to] = sideNames(pair);
      const card = (side: 'older' | 'newer') => {
        const rule = pair[side];
        const lead = side === 'newer' && pair.order === 'date';
        return (
          <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
            <p className="truncate text-xs text-faint">
              {side === 'older' ? from : to}{pair.older.page === pair.newer.page ? '' : ` · ${titleOf(rule.page)}`}{lead && ' · newer'}
            </p>
            <p className="text-[13px] leading-5 text-ink" title={rule.text}><Side parts={wordDiff(pair.older.plain, pair.newer.plain, side)} /></p>
            <Button size="sm" variant={lead ? 'primary' : 'secondary'} className="mt-0.5 self-start" disabled={actions.busy} onClick={() => actions.keep(pair, side)}>Keep</Button>
          </div>
        );
      };
      return (
        <li key={pair.id} className="flex flex-col gap-1.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{card('older')}{card('newer')}</div>
          <Button size="sm" variant="ghost" flush className="self-start" disabled={actions.busy} title="Both stay; the page is unchanged" onClick={() => actions.bothHold([pair])}>Both are right</Button>
        </li>
      );
    })}
  </ul>
);
