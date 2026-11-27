// Needs you's rule pairs, opened. Repeats: each rule once, as its newest line reads, with one "Use newer" and the
// other choices behind "More". Disagreements: the two rules side by side, older on the left, one Keep each. FixList.tsx
// owns what a click does; this file only draws. The pure half is conflicts.logic.ts.
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { PairInfo } from '../../../../src/knowledge-health.ts';
import { Button, cx } from '../../ui/index.ts';
import { checkReason, sideNames, wordDiff, type ChainRow, type DiffPart } from '../conflicts.logic.ts';

export interface PairActions {
  busy: boolean;
  /** Keep one side; the other moves under "Replaced" on its page. */
  keep: (pair: PairInfo, side: 'older' | 'newer') => void;
  /** Keep a repeated rule's newest line (every older version moves under "Replaced") or its latest older one. */
  keepRow: (row: ChainRow, side: 'older' | 'newer') => void;
  /** Both lines hold: the pairs stop being listed. No page changes. */
  bothHold: (pairs: PairInfo[]) => void;
  /** Open a page, for a rule a click can't move. */
  open: (page: string) => void;
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
  const reason = checkReason(row);
  const prose = reason === 'Inside longer text';
  // A rule "Use newer for all" settles has no button of its own. One that loses detail shows both choices.
  const both = !row.safe && !row.twice && !prose;
  const newer = row.twice ? 'Remove copy' : row.order === 'length' ? 'Keep longer' : 'Keep newer';
  const older = row.order === 'length' ? 'Keep shorter' : 'Keep older';
  return (
    <li className="flex items-start gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5" title={[...row.olders.map((side) => side.text), row.newer.text].join('\n')}>
        <p className="text-[13px] leading-5 text-ink">{row.covers && !row.twice ? <Newest row={row} /> : row.newer.plain}</p>
        {reason && <p className="text-xs text-muted">{reason}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {prose && <Button size="sm" disabled={actions.busy} onClick={() => actions.open(row.newer.page)}>Open page</Button>}
        {!prose && (both || (more && !row.twice)) && <Button size="sm" variant={both ? 'secondary' : 'ghost'} disabled={actions.busy} title={row.latest.older.text} onClick={() => actions.keepRow(row, 'older')}>{older}</Button>}
        {!prose && (reason !== null || more) && <Button size="sm" variant={reason !== null ? 'secondary' : 'ghost'} disabled={actions.busy} title={row.newer.text} onClick={() => actions.keepRow(row, 'newer')}>{newer}</Button>}
        {more && <Button size="sm" variant="ghost" disabled={actions.busy} title="Leave the page as it is" onClick={() => actions.bothHold(row.all)}>Keep both</Button>}
        {more && !prose && <Button size="sm" variant="ghost" disabled={actions.busy} onClick={() => actions.open(row.newer.page)}>Open page</Button>}
        <Button size="sm" variant="ghost" aria-label="Other choices" aria-expanded={more} className="px-1.5" onClick={() => setMore(!more)}><MoreHorizontal size={14} aria-hidden /></Button>
      </div>
    </li>
  );
};

/**
 * One page's repeated rules: those that need a choice, each with its reason; the rest, which "Keep newer for all"
 * settles, folded into one quiet line that opens to show them.
 */
export const RepeatPairs = ({ rows, actions }: { rows: ChainRow[]; actions: PairActions }) => {
  const [shown, setShown] = useState(false);
  const check = rows.filter((row) => checkReason(row) !== null);
  const rest = rows.filter((row) => checkReason(row) === null);
  return (
    <ul className="flex flex-col divide-y divide-line-subtle">
      {check.map((row) => <RepeatRow key={row.key} row={row} actions={actions} />)}
      {rest.length > 0 && (shown
        ? rest.map((row) => <RepeatRow key={row.key} row={row} actions={actions} />)
        : (
          <li className="py-2">
            <Button size="sm" variant="ghost" flush aria-expanded={false} onClick={() => setShown(true)}>
              {rest.length} more {rest.length === 1 ? 'changes' : 'change'} with Keep newer
            </Button>
          </li>
        ))}
    </ul>
  );
};

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
              {side === 'older' ? from : to}{pair.older.page === pair.newer.page ? '' : ` · ${titleOf(rule.page)}`}
            </p>
            <p className="text-[13px] leading-5 text-ink" title={rule.text}><Side parts={wordDiff(pair.older.plain, pair.newer.plain, side)} /></p>
            <Button size="sm" variant={lead ? 'primary' : 'secondary'} className="mt-0.5 self-start" disabled={actions.busy} onClick={() => actions.keep(pair, side)}>Keep</Button>
          </div>
        );
      };
      return (
        <li key={pair.id} className="flex flex-col gap-1.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{card('older')}{card('newer')}</div>
          <div className="flex flex-wrap items-center gap-x-3">
            <Button size="sm" variant="ghost" flush disabled={actions.busy} title="Both stay; the page is unchanged" onClick={() => actions.bothHold([pair])}>Keep both</Button>
            <Button size="sm" variant="ghost" flush disabled={actions.busy} onClick={() => actions.open(pair.newer.page)}>Open page</Button>
            <span className="text-xs text-faint">The other moves to “Replaced”. You can undo.</span>
          </div>
        </li>
      );
    })}
  </ul>
);
