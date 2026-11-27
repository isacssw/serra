// Needs you's rule pairs, opened: a page's repeats as before → after lines with what changed marked (Keep older /
// Keep newer, older always first), and two rules that disagree side by side (Keep this, or Both hold). FixList.tsx owns
// what a click does; this file only draws the pairs. The pure half is conflicts.logic.ts.
import { Check } from 'lucide-react';
import type { PairInfo } from '../../../../src/knowledge-health.ts';
import { Button, cx } from '../../ui/index.ts';
import { keepNames, sideNames, wordDiff, type DiffPart } from '../conflicts.logic.ts';

export interface PairActions {
  busy: boolean;
  /** Keep one side; the other moves under "Replaced" on its page. */
  keep: (pair: PairInfo, side: 'older' | 'newer') => void;
  /** Both lines hold: the pair stops being listed. No page changes. */
  bothHold: (pair: PairInfo) => void;
}

/** One version of a line with its changed words marked: struck out (gone) or highlighted (new). */
const Marked = ({ parts, show }: { parts: DiffPart[]; show: 'both' | 'older' | 'newer' }) => (
  <>
    {parts.map((part, at) => {
      if (part.op === 'same') return <span key={at}>{part.text}</span>;
      if (part.op === 'del') {
        if (show === 'newer') return null;
        return show === 'both'
          ? <del key={at} className="rounded-sm bg-down/10 text-down decoration-down/70">{part.text}</del>
          : <strong key={at} className="font-semibold text-ink">{part.text}</strong>;
      }
      if (show === 'older') return null;
      return show === 'both'
        ? <ins key={at} className="rounded-sm bg-up/12 text-up no-underline">{part.text}</ins>
        : <strong key={at} className="font-semibold text-ink">{part.text}</strong>;
    })}
  </>
);

/** A page's repeats, each as one line read older → newer. "Keep newer" leads where it loses nothing. */
export const RepeatPairs = ({ pairs, actions }: { pairs: PairInfo[]; actions: PairActions }) => (
  <ul className="flex flex-col gap-2">
    {pairs.map((pair) => {
      const [from, to] = sideNames(pair);
      const [keepOlder, keepNewer] = keepNames(pair);
      const parts = wordDiff(pair.older.plain, pair.newer.plain);
      const same = parts.every((part) => part.op === 'same');
      return (
        <li key={pair.id} className={cx('flex flex-col gap-2 rounded-lg border px-3 py-2.5', pair.covers ? 'border-line' : 'border-warn/50')}>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
            {!pair.covers && <span className="font-medium text-warn">Newer drops detail ·</span>}
            <span>{from}</span><span aria-hidden>→</span>
            <span className={cx(pair.covers && 'text-up')}>{to}</span>
            {pair.covers && <Check size={12} aria-label="Says everything the other does" className="text-up" />}
            {same && <span>· same words</span>}
          </p>
          <p className="text-[13px] leading-5 text-ink" title={`${pair.older.text}\n${pair.newer.text}`}><Marked parts={parts} show="both" /></p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" disabled={actions.busy} title={pair.older.text} onClick={() => actions.keep(pair, 'older')}>{keepOlder}</Button>
            <Button size="sm" variant={pair.covers ? 'primary' : 'secondary'} disabled={actions.busy} title={pair.newer.text} onClick={() => actions.keep(pair, 'newer')}>{keepNewer}</Button>
            <Button size="sm" variant="ghost" disabled={actions.busy} onClick={() => actions.bothHold(pair)}>Keep both</Button>
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
      const parts = wordDiff(pair.older.plain, pair.newer.plain);
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
            <p className="text-[13px] leading-5 text-ink" title={rule.text}><Marked parts={parts} show={side} /></p>
            <Button size="sm" variant={lead ? 'primary' : 'secondary'} className="self-start" disabled={actions.busy} onClick={() => actions.keep(pair, side)}>Keep this</Button>
          </div>
        );
      };
      return (
        <li key={pair.id} className="flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{card('older')}{card('newer')}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" disabled={actions.busy} onClick={() => actions.bothHold(pair)}>Both hold, not a conflict</Button>
            <span className="text-xs text-faint">The other moves under “Replaced” on its page.</span>
          </div>
        </li>
      );
    })}
  </ul>
);
