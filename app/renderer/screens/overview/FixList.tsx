// Overview's "Needs you": the one place to act on the knowledge. The weekly review's fixes, proposals waiting, what
// replies were missing (Tell it) and hand edits come first, one line and one button each. Rules that repeat or disagree
// follow one row per page, in two groups: "Same rule, learned again" (safe: Keep newer for all) and "Really disagree"
// (your call, side by side). Jobs that can wait fold away under "Tidy up".
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { PROPOSAL_PARAM } from '../proposals.logic.ts';
import { AlertTriangle, Check, ChevronRight, CircleCheck, CircleHelp, FileText, PenLine, Sparkles } from 'lucide-react';
import type { KnowledgeOverview } from '../../../../src/knowledge-overview.ts';
import type { PairInfo } from '../../../../src/knowledge-health.ts';
import type { ReviewSuggestion } from '../../../../src/knowledge-review-store.ts';
import { serra } from '../../bridge.ts';
import { Button, cx, Dialog, useToast } from '../../ui/index.ts';
import { DiffView } from '../proposals/DiffView.tsx';
import { pageBody } from '../../../../src/knowledge-rules.ts';
import { fixItems, fixKind, needsYou, type FixItem } from '../overview.logic.ts';
import { groupLine, type ChainRow, type PairGroup } from '../conflicts.logic.ts';
import { keepNewerOnPages, keepOne, keepOver } from '../keep.ts';
import { localDate } from '../pages.logic.ts';
import { DisagreePairs, RepeatPairs, type PairActions } from './RulePairs.tsx';
import { settle } from './WeekDigest.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const SHOWN = 5;
/** Pages shown per rules group before "N more pages". */
const PAGES_SHOWN = 3;

/** One icon per kind of job, so a long list scans by shape. */
const KindIcon = ({ item }: { item: FixItem }) => {
  const kind = fixKind(item);
  const props = { size: 15, 'aria-hidden': true as const, className: 'mt-0.5 shrink-0' };
  if (kind === 'conflict' || kind === 'duplicate' || kind === 'replace') return <AlertTriangle {...props} className={cx(props.className, 'text-warn')} />;
  if (kind === 'proposal' || kind === 'proposals') return <FileText {...props} className={cx(props.className, 'text-muted')} />;
  if (kind === 'missing') return <CircleHelp {...props} className={cx(props.className, 'text-muted')} />;
  if (kind === 'unreviewed') return <PenLine {...props} className={cx(props.className, 'text-muted')} />;
  if (kind === 'confirm' || kind === 'stale' || kind === 'draft' || kind === 'drafts') return <CircleCheck {...props} className={cx(props.className, 'text-muted')} />;
  return <Sparkles {...props} className={cx(props.className, 'text-muted')} />;
};

/** A group's small heading: "SAME RULE, LEARNED AGAIN · safe", with its one action on the right. */
const GroupHead = ({ id, title, hint, action }: { id: string; title: string; hint: string; action?: ReactNode }) => (
  <div className="flex min-h-7 items-center justify-between gap-2 pt-2">
    <h3 id={id} className="text-[11px] font-medium tracking-wide text-faint uppercase">{title}<span className="ml-1.5 normal-case tracking-normal">· {hint}</span></h3>
    {action}
  </div>
);

/** "Tidy up": what can wait, as one line until opened ("2 pages near the size limit · 3 pages of long prose"). */
const tidyLine = (items: FixItem[]): string => {
  const count = (kind: string): number => items.filter((item) => fixKind(item) === kind).length;
  const pages = (n: number): string => `${n} page${n === 1 ? '' : 's'}`;
  return [
    count('long') && `${pages(count('long'))} near the size limit`,
    count('unstructured') && `${pages(count('unstructured'))} of long prose`,
    count('overlap') && `${count('overlap')} to merge`,
    count('unindexed') && `${pages(count('unindexed'))} not in the index`,
  ].filter(Boolean).join(' · ');
};

export const FixList = ({ overview, onOpen, onChanged }: { overview: KnowledgeOverview; onOpen: (path: string) => void; onChanged: () => void }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<{ id: string; current: string | null; proposed: string } | null>(null);
  const [asking, setAsking] = useState<{ title: string; description: string; confirm: string; run: () => void } | null>(null);
  // Pages' "Review in Overview" link lands here with the whole list open (#todo).
  const [all, setAll] = useState(() => window.location.hash.endsWith('#todo'));
  const [opened, setOpened] = useState<string | null>(null);
  const [more, setMore] = useState<Set<string>>(new Set());
  const [tidyOpen, setTidyOpen] = useState(false);
  const items = fixItems(overview);
  const open = items.filter((item) => !done.has(item.id) && !(item.pair && done.has(item.pair.id)));
  const view = needsYou(open);
  const title = (path: string): string => overview.value.find((page) => page.path === path)?.title ?? path;
  const groupTitle = (group: PairGroup): string => group.pages.map(title).join(' and ');
  // "Do all" takes the fixes that change text the owner can see first. Saying a page still holds is theirs to say.
  const oneClick = view.items.flatMap((item) => (item.suggestion && item.suggestion.kind !== 'confirm' ? [item.suggestion] : []));
  if (view.rows === 0) {
    return (
      <section aria-labelledby="todo-title" className="flex flex-col gap-2">
        <h2 id="todo-title" className="text-sm font-semibold">Needs you</h2>
        <p className="flex items-center gap-2 border-t border-line py-3 text-[13px] text-muted"><Check size={14} aria-hidden className="text-up" />All caught up</p>
      </section>
    );
  }
  const shown = all ? view.items : view.items.slice(0, SHOWN);
  const markDone = (ids: string[]): void => setDone((set) => new Set([...set, ...ids]));
  /** After an Undo: the rows come back at once, not only after the reload. */
  const unmark = (ids: string[]): void => setDone((set) => new Set([...set].filter((id) => !ids.includes(id))));

  const apply = async (list: ReviewSuggestion[]) => {
    const undoIds: string[] = [];
    for (const suggestion of list) {
      setBusy(suggestion.id);
      try {
        const undoId = await settle(suggestion);
        if (undoId) undoIds.push(undoId);
        markDone([suggestion.id]);
        if (undoId && list.length === 1) {
          toast({ message: 'Done.', tone: 'success', action: { label: 'Undo', onClick: () => { void serra()?.proposals.undo(undoId).then(onChanged, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
        }
      } catch (failure) {
        toast({ message: `${suggestion.title}: ${message(failure)}`, tone: 'error' });
        break;
      }
    }
    setBusy(null);
    if (list.length > 1 && undoIds.length > 0) {
      toast({ message: `${undoIds.length} done.`, tone: 'success', action: { label: 'Undo all', onClick: () => {
        void (async () => { for (const id of [...undoIds].reverse()) await serra()?.proposals.undo(id); })().then(onChanged, (failure: unknown) => toast({ message: message(failure), tone: 'error' }));
      } } });
    }
    onChanged();
  };

  /** Keeps one line of a pair and moves the other under "Replaced" on its page (backed up, saved at once, undoable). */
  const keep = async (pair: PairInfo, side: 'older' | 'newer') => {
    const bridge = serra();
    if (!bridge) return;
    const [kept, drop] = side === 'older' ? [pair.older, pair.newer] : [pair.newer, pair.older];
    setBusy(pair.id);
    try {
      const result = await keepOne(bridge, kept, drop);
      // A rule that isn't a whole line of its own can't be moved by a click: the page opens instead.
      if (result === 'open') { onOpen(drop.page); return; }
      // Only this pair leaves the list: the page's other pairs stay until the reload says they're settled too.
      markDone([pair.id]);
      toast({ message: 'Kept.', tone: 'success', action: { label: 'Undo', onClick: () => { void result.undo().then(() => { unmark([pair.id]); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
      onChanged();
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setBusy(null); }
  };

  /**
   * A repeated rule: Keep newer moves every older version under "Replaced" (one save per page); Keep older keeps the
   * latest older version and moves the newest. Backed up, saved at once, undoable.
   */
  const keepRow = async (row: ChainRow, side: 'older' | 'newer') => {
    const bridge = serra();
    if (!bridge) return;
    const [kept, drops] = side === 'newer' ? [row.newer, row.olders] : [row.latest.older, [row.newer]];
    setBusy(row.key);
    try {
      const result = await keepOver(bridge, kept, drops);
      if (result === 'open') { onOpen(drops[0]!.page); return; }
      const ids = row.pairs.map((pair) => pair.id);
      markDone(ids);
      toast({ message: 'Kept.', tone: 'success', action: { label: 'Undo', onClick: () => { void result.undo().then(() => { unmark(ids); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
      onChanged();
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setBusy(null); }
  };

  /** Both lines hold: Serra stops listing the pairs. Remembered in the profile; no page is written. */
  const bothHold = async (pairs: PairInfo[]) => {
    const bridge = serra();
    if (!bridge) return;
    setBusy('both');
    const set: string[] = [];
    const undo = async (): Promise<void> => { for (const id of set) await bridge.pages.undoBothHold(id); };
    try {
      for (const pair of pairs) { await bridge.pages.bothHold(pair.id); set.push(pair.id); }
      markDone(set);
      toast({ message: 'Both kept. Not listed again.', tone: 'success', action: { label: 'Undo', onClick: () => { void undo().then(() => { unmark(set); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
      onChanged();
    } catch (failure) {
      await undo().catch(() => {});
      toast({ message: message(failure), tone: 'error' });
    } finally { setBusy(null); }
  };

  /** "Keep newer" on every safe pair of these pages: one backed-up save per page (keep.ts), undoable as one. */
  const keepNewer = async (groups: PairGroup[]) => {
    const bridge = serra();
    if (!bridge) return;
    setBusy('bulk');
    const result = await keepNewerOnPages(bridge, groups, localDate(new Date()));
    // Only the pairs whose older line really moved leave the list; a rule inside a sentence of prose stays for the page.
    const settled = groups.flatMap((group) => group.safe.filter((pair) => result.moved.some((line) => line.page === pair.older.page && line.text === pair.older.text.trim())).map((pair) => pair.id));
    markDone(settled);
    setBusy(null);
    if (result.error !== undefined) toast({ message: message(result.error), tone: 'error' });
    else if (result.lines === 0) toast({ message: 'Nothing moved: those lines sit inside longer text. Open the page to tidy them.', tone: 'error' });
    if (result.pages.length > 0) {
      toast({ message: `Kept newer: ${result.lines} older line${result.lines === 1 ? '' : 's'} moved under “Replaced”.`, tone: 'success', action: { label: 'Undo', onClick: () => {
        void result.undo().then(() => { unmark(settled); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' }));
      } } });
    }
    onChanged();
  };

  const showChange = async (item: FixItem) => {
    if (diff?.id === item.id) { setDiff(null); return; }
    const proposal = item.suggestion?.proposal;
    const bridge = serra();
    if (!proposal || !bridge) return;
    try {
      const read = await bridge.proposals.diff(proposal);
      setDiff({ id: item.id, current: read.current === null ? null : pageBody(read.current), proposed: pageBody(read.proposed) });
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
  };
  const run = (item: FixItem) => {
    const suggestion = item.suggestion;
    if (item.href) { void navigate(item.href); return; }
    if (item.tell) { void navigate(`/jobs/new?text=${encodeURIComponent(`Remember this for my notes. ${item.tell}: `)}`); return; }
    if (item.proposal) { void navigate(`/knowledge/proposals?${PROPOSAL_PARAM}=${encodeURIComponent(item.proposal)}`); return; }
    if (!suggestion) { onOpen(item.pages[0]!); return; }
    if (suggestion.kind === 'retire') setAsking({ title: `Retire ${suggestion.title}?`, description: 'The bot stops using it. Restore it from Archived in Pages.', confirm: 'Retire', run: () => void apply([suggestion]) });
    else void apply([suggestion]);
  };

  const actions: PairActions = { busy: busy !== null, keep: (pair, side) => void keep(pair, side), keepRow: (row, side) => void keepRow(row, side), bothHold: (pairs) => void bothHold(pairs) };
  const safePages = view.repeats.filter((group) => group.safe.length > 0 && group.pages.length === 1);
  const safeLines = (groups: PairGroup[]): number => new Set(groups.flatMap((group) => group.safe.map((pair) => `${group.key}\n${pair.older.text}`))).size;
  const safeRows = (groups: PairGroup[]): number => groups.reduce((sum, group) => sum + group.safeRows, 0);
  const askKeepNewer = (groups: PairGroup[]) => setAsking({
    title: groups.length === 1 ? `Keep newer on ${groupTitle(groups[0]!)}?` : `Keep newer on ${groups.length} pages?`,
    description: `${safeLines(groups)} older line${safeLines(groups) === 1 ? '' : 's'} move under “Replaced”, only where the newer line says everything they do${groups.length > 1 ? `, on ${groups.map(groupTitle).join('; ')}` : ''}. Each page is backed up first.`,
    confirm: 'Keep newer', run: () => void keepNewer(groups),
  });

  const itemRow = (item: FixItem) => {
    const navigates = !(item.suggestion || item.tell);
    return (
      <li key={item.id} className="flex flex-col gap-2 py-2.5">
        <div className="flex items-start gap-3">
          <KindIcon item={item} />
          <div className="flex min-w-0 flex-1 flex-col" title={[item.title, ...item.lines].join('\n')}>
            <p className="truncate text-[13px] leading-5 font-medium text-ink">{item.title}</p>
            <p className="truncate text-xs leading-4 text-muted">{item.why}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {item.suggestion?.kind === 'replace' && <Button size="sm" variant="ghost" onClick={() => void showChange(item)}>{diff?.id === item.id ? 'Hide' : 'See change'}</Button>}
            {done.has(item.id)
              ? <span className="flex items-center gap-1 text-xs text-up"><Check size={13} aria-hidden />Done</span>
              : (
                <Button size="sm" variant={navigates ? 'ghost' : 'secondary'} disabled={busy !== null} onClick={() => run(item)} className={navigates ? 'pr-1.5' : undefined}>
                  {busy === item.id ? 'Working…' : item.action}
                  {navigates && <ChevronRight size={13} aria-hidden className="-ml-0.5" />}
                </Button>
              )}
          </div>
        </div>
        {diff?.id === item.id && <div className="pl-7"><DiffView current={diff.current} proposed={diff.proposed} /></div>}
      </li>
    );
  };

  const groupRows = (groups: PairGroup[], kind: 'repeat' | 'disagree') => {
    const showAll = more.has(kind);
    const list = showAll ? groups : groups.slice(0, PAGES_SHOWN);
    return (
      <ul aria-labelledby={`todo-${kind}`} className="flex flex-col divide-y divide-line-subtle border-y border-line">
        {list.map((group, at) => {
          const isOpen = opened === group.key;
          return (
            <li key={group.key} className="flex flex-col gap-2.5 py-2.5">
              <div className="flex items-start gap-3">
                <AlertTriangle size={15} aria-hidden className="mt-0.5 shrink-0 text-warn" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <p className="truncate text-[13px] leading-5 font-medium text-ink" title={groupTitle(group)}>{groupTitle(group)}</p>
                  <p className="truncate text-xs leading-4 text-muted">{groupLine(group)}</p>
                </div>
                <Button size="sm" variant={at === 0 && !isOpen ? 'secondary' : 'ghost'} aria-expanded={isOpen} className="pr-1.5" onClick={() => setOpened(isOpen ? null : group.key)}>
                  {kind === 'repeat' ? `Review ${group.rows.length}` : 'Compare'}
                  <ChevronRight size={13} aria-hidden className={cx('-ml-0.5 transition-transform', isOpen && 'rotate-90')} />
                </Button>
              </div>
              {isOpen && (
                <div className="flex flex-col gap-2.5 pl-7">
                  <div className="flex flex-wrap gap-1.5">
                    {kind === 'repeat' && group.safe.length > 0 && group.pages.length === 1 && (
                      <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => askKeepNewer([group])}>Keep newer for all {safeRows([group])}</Button>
                    )}
                    {group.pages.map((page) => (
                      <Button key={page} size="sm" variant="ghost" className="pr-1.5" onClick={() => onOpen(page)}>
                        {group.pages.length === 1 ? 'Open page' : `Open ${title(page)}`}<ChevronRight size={13} aria-hidden className="-ml-0.5" />
                      </Button>
                    ))}
                  </div>
                  {kind === 'repeat' ? <RepeatPairs rows={group.rows} titleOf={title} actions={actions} /> : <DisagreePairs pairs={group.pairs} titleOf={title} actions={actions} />}
                </div>
              )}
            </li>
          );
        })}
        {groups.length > PAGES_SHOWN && (
          <li className="py-1.5">
            <Button size="sm" variant="ghost" flush onClick={() => setMore((set) => { const next = new Set(set); if (showAll) next.delete(kind); else next.add(kind); return next; })}>
              {showAll ? 'Show fewer' : `${groups.length - PAGES_SHOWN} more page${groups.length - PAGES_SHOWN === 1 ? '' : 's'}`}
            </Button>
          </li>
        )}
      </ul>
    );
  };

  return (
    <section id="todo" aria-labelledby="todo-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 id="todo-title" className="text-sm font-semibold">Needs you <span className="ml-1 font-normal tabular-nums text-faint">{view.rows}</span></h2>
        {oneClick.length > 1 && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setAsking({ title: `Do all ${oneClick.length}?`, description: 'Rewrites are approved as shown; retired pages can be restored.', confirm: 'Do it', run: () => void apply(oneClick) })}>
            Do all
          </Button>
        )}
      </div>
      {view.items.length > 0 && (
        <>
          <ul className="flex flex-col divide-y divide-line-subtle border-y border-line">{shown.map(itemRow)}</ul>
          {view.items.length > SHOWN && (
            <Button size="sm" variant="ghost" className="self-start" flush onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${view.items.length}`}</Button>
          )}
        </>
      )}
      {view.repeats.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <GroupHead
            id="todo-repeat" title="Same rule, learned again" hint={view.repeats.some((group) => group.dropsDetail > 0) ? 'mostly safe' : 'safe'}
            action={safePages.length > 1 && <Button size="sm" disabled={busy !== null} onClick={() => askKeepNewer(safePages)}>{busy === 'bulk' ? 'Working…' : `Keep newer on all ${safePages.length} pages`}</Button>}
          />
          {groupRows(view.repeats, 'repeat')}
        </div>
      )}
      {view.disagree.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <GroupHead id="todo-disagree" title="Really disagree" hint="your call" />
          {groupRows(view.disagree, 'disagree')}
        </div>
      )}
      {view.tidy.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <GroupHead
            id="todo-tidy" title="Tidy up" hint="later"
            action={<Button size="sm" variant="ghost" aria-expanded={tidyOpen} className="pr-1.5" onClick={() => setTidyOpen(!tidyOpen)}>{tidyOpen ? 'Hide' : `Show ${view.tidy.length}`}<ChevronRight size={13} aria-hidden className={cx('-ml-0.5 transition-transform', tidyOpen && 'rotate-90')} /></Button>}
          />
          {tidyOpen
            ? <ul aria-labelledby="todo-tidy" className="flex flex-col divide-y divide-line-subtle border-y border-line">{view.tidy.map(itemRow)}</ul>
            : <p className="flex items-center gap-3 border-y border-line py-2.5 text-[13px] text-muted"><Sparkles size={15} aria-hidden className="shrink-0 text-faint" />{tidyLine(view.tidy)}</p>}
        </div>
      )}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking?.title ?? ''}
        description={asking?.description}
        actions={(
          <>
            <Button data-autofocus onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { const next = asking; setAsking(null); next?.run(); }}>{asking?.confirm ?? 'Do it'}</Button>
          </>
        )}
      />
    </section>
  );
};
