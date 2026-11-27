// Needs you's rule pairs, opened: a page's repeats as before → after lines with what changed marked (Keep older /
// Keep newer, older always first), and two rules that disagree side by side (Keep this, or Both hold). FixList.tsx owns
// what a click does; this file only draws the pairs. The pure half is conflicts.logic.ts.
import { Check } from 'lucide-react';
import type { PairInfo } from '../../../../src/knowledge-health.ts';
import { Button, cx } from '../../ui/index.ts';
import { keepNames, rowNames, sideNames, wordDiff, type ChainRow, type DiffPart } from '../conflicts.logic.ts';

export interface PairActions {
  busy: boolean;
  /** Keep one side; the other moves under "Replaced" on its page. */
  keep: (pair: PairInfo, side: 'older' | 'newer') => void;
  /** Keep a repeated rule's newest line (every older version moves under "Replaced") or its latest older one. */
  keepRow: (row: ChainRow, side: 'older' | 'newer') => void;
  /** Both lines hold: the pairs stop being listed. No page changes. */
  bothHold: (pairs: PairInfo[]) => void;
}

/** A line with its changed words marked: struck out (gone) and highlighted (new) in one line, or bold on one side. */
const Marked = ({ parts }: { parts: DiffPart[] }) => (
  <>
    {parts.map((part, at) => {
      if (part.op === 'same') return <span key={at}>{part.text}</span>;
      if (part.op === 'del') return <del key={at} className="rounded-sm bg-down/10 text-down decoration-down/70">{part.text}</del>;
      return <ins key={at} className="rounded-sm bg-up/12 text-up no-underline">{part.text}</ins>;
    })}
  </>
);

/** One side of two rules that disagree, what sets it apart in bold. */
const Side = ({ parts }: { parts: DiffPart[] }) => (
  <>{parts.map((part, at) => (part.op === 'same' ? <span key={at}>{part.text}</span> : <strong key={at} className="font-semibold text-ink">{part.text}</strong>))}</>
);

/** A page's repeated rules, one row each, read older → newer. "Keep newer" leads where it loses nothing. */
export const RepeatPairs = ({ rows, titleOf, actions }: { rows: ChainRow[]; titleOf: (page: string) => string; actions: PairActions }) => (
  <ul className="flex flex-col gap-2">
    {rows.map((row) => {
      const [from, to] = rowNames(row);
      const [keepOlder, keepNewer] = keepNames(row);
      const parts = wordDiff(row.latest.older.plain, row.newer.plain);
      const same = parts.every((part) => part.op === 'same');
      return (
        <li key={row.key} className={cx('flex flex-col gap-2 rounded-lg border px-3 py-2.5', row.covers ? 'border-line' : 'border-warn/50')}>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
            {!row.covers && <span className="font-medium text-warn">Newer drops detail ·</span>}
            <span>{from}</span><span aria-hidden>→</span>
            <span className={cx(row.covers && 'text-up')}>{to}</span>
            {row.covers && <Check size={12} aria-label="Says everything the older lines do" className="text-up" />}
            {same && <span>· same words</span>}
            {/* Two pages: which one each version sits on, so Keep says where the rule stays. */}
            {row.latest.older.page !== row.newer.page && <span className="truncate">· {titleOf(row.latest.older.page)} → {titleOf(row.newer.page)}</span>}
          </p>
          <p className="text-[13px] leading-5 text-ink" title={[...row.olders.map((side) => side.text), row.newer.text].join('\n')}><Marked parts={parts} /></p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" disabled={actions.busy} title={row.latest.older.text} onClick={() => actions.keepRow(row, 'older')}>{keepOlder}</Button>
            <Button size="sm" variant={row.covers ? 'primary' : 'secondary'} disabled={actions.busy} title={row.newer.text} onClick={() => actions.keepRow(row, 'newer')}>{keepNewer}</Button>
            <Button size="sm" variant="ghost" disabled={actions.busy} title="Leave both lines and stop listing them" onClick={() => actions.bothHold(row.pairs)}>Both stay</Button>
          </div>
        </li>
      );
    })}
  </ul>
);

/** Two rules that disagree, side by side, older on the left; what tells them apart in bold. */
export const DisagreePairs = ({ pairs, titleOf, actions }: { pairs: PairInfo[]; titleOf: (page: string) => string; actions: PairActions }) => (
  <ul className="flex flex-col gap-4">
    {pairs.map((pair) => {
      const [from, to] = sideNames(pair);
      const where = (page: string): string => (pair.older.page === pair.newer.page ? '' : ` · ${titleOf(page)}`);
      const card = (side: 'older' | 'newer') => {
        const rule = pair[side];
        const lead = side === 'newer' && pair.order === 'date';
        return (
          <div className={cx('flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5', lead ? 'border-up/50 bg-up/5' : 'border-line')}>
            <p className="truncate text-xs text-faint">
              {pair.order === 'date' ? `Learned ${side === 'older' ? from : to}` : side === 'older' ? from : to}{where(rule.page)}
              {lead && <span className="text-up"> · newer</span>}
            </p>
            <p className="text-[13px] leading-5 text-ink" title={rule.text}><Side parts={wordDiff(pair.older.plain, pair.newer.plain, side)} /></p>
            <Button size="sm" variant={lead ? 'primary' : 'secondary'} className="self-start" disabled={actions.busy} onClick={() => actions.keep(pair, side)}>Keep this</Button>
          </div>
        );
      };
      return (
        <li key={pair.id} className="flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{card('older')}{card('newer')}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" disabled={actions.busy} onClick={() => actions.bothHold([pair])}>Both hold, not a conflict</Button>
            <span className="text-xs text-faint">The other moves under “Replaced” on its page.</span>
          </div>
        </li>
      );
    })}
  </ul>
);
