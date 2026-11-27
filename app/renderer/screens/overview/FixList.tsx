// Overview's "Needs you": the one place to act on the knowledge, one quiet row per job. Review fixes, proposals and
// pages to confirm come first; then each pair of rules that disagree (Compare); then every repeated rule in one row
// (Review, with one "Keep newer for all"); then what can wait ("N pages to tidy"). A row opens in place.
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { PROPOSAL_PARAM } from '../proposals.logic.ts';
import { AlertTriangle, Check, ChevronRight, CircleCheck, CircleHelp, Copy, FileText, PenLine, Sparkles } from 'lucide-react';
import type { KnowledgeOverview } from '../../../../src/knowledge-overview.ts';
import type { PairInfo } from '../../../../src/knowledge-health.ts';
import type { ReviewSuggestion } from '../../../../src/knowledge-review-store.ts';
import { serra } from '../../bridge.ts';
import { Button, cx, Dialog, useToast } from '../../ui/index.ts';
import { DiffView } from '../proposals/DiffView.tsx';
import { pageBody } from '../../../../src/knowledge-rules.ts';
import { fixItems, fixKind, needsYou, type FixItem } from '../overview.logic.ts';
import { groupLine, repeatsLine, type ChainRow, type PairGroup } from '../conflicts.logic.ts';
import { keepNewerOnPages, keepOne, keepOver } from '../keep.ts';
import { localDate } from '../pages.logic.ts';
import { DisagreePairs, RepeatPairs, type PairActions } from './RulePairs.tsx';
import { settle } from './WeekDigest.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const SHOWN = 5;

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
  const [openPage, setOpenPage] = useState<string | null>(null);
  // Fresh data says what is still open: rows hidden after a click are judged again from it.
  useEffect(() => { setDone(new Set()); }, [overview]);
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
      toast({ message: 'Moved to “Replaced”.', tone: 'success', action: { label: 'Undo', onClick: () => { void result.undo().then(() => { unmark([pair.id]); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
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
      const ids = (side === 'newer' ? row.all : row.pairs).map((pair) => pair.id);
      markDone(ids);
      toast({ message: 'Moved to “Replaced”.', tone: 'success', action: { label: 'Undo', onClick: () => { void result.undo().then(() => { unmark(ids); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
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
      for (const id of new Set(pairs.map((pair) => pair.id))) { await bridge.pages.bothHold(id); set.push(id); }
      markDone(set);
      toast({ message: 'Both kept. Page unchanged.', tone: 'success', action: { label: 'Undo', onClick: () => { void undo().then(() => { unmark(set); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
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
    const settled = groups.flatMap((group) => group.pairs.filter((pair) => result.moved.some((line) => [pair.older, pair.newer].some((side) => line.page === side.page && line.text === side.text.trim()))).map((pair) => pair.id));
    markDone(settled);
    setBusy(null);
    const undo = { label: 'Undo', onClick: () => { void result.undo().then(() => { unmark(settled); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } };
    const moved = `${result.lines} older line${result.lines === 1 ? '' : 's'} moved to “Replaced”`;
    // One toast: what was done, what stopped it, and Undo for what was saved.
    if (result.error !== undefined) toast({ message: result.pages.length > 0 ? `${moved}, then stopped: ${message(result.error)}` : message(result.error), tone: 'error', ...(result.pages.length > 0 ? { action: undo } : {}) });
    else if (result.lines === 0) toast({ message: 'Nothing moved: those lines sit inside longer text. Open the page to tidy them.', tone: 'error' });
    else toast({ message: `${moved}.`, tone: 'success', action: undo });
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

  const actions: PairActions = { busy: busy !== null, keep: (pair, side) => void keep(pair, side), keepRow: (row, side) => void keepRow(row, side), bothHold: (pairs) => void bothHold(pairs), open: onOpen };
  const safePages = view.repeats.filter((group) => group.safe.length > 0 && group.pages.length === 1);
  const safeRows = safePages.reduce((sum, group) => sum + group.safeRows, 0);
  const askKeepNewer = (groups: PairGroup[]) => setAsking({
    title: `Keep the newer line for ${safeRows} ${safeRows === 1 ? 'rule' : 'rules'}?`,
    description: `Only where it says everything the older one does. Older lines move to “Replaced” on ${groups.length === 1 ? groupTitle(groups[0]!) : `${groups.length} pages`}. You can undo.`,
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

  /** One quiet row that opens in place: its icon, its name, one short line, and its one action. */
  const row = ({ id, icon, name, line, action, panel }: { id: string; icon: ReactNode; name: string; line: string; action: string; panel: ReactNode }) => {
    const isOpen = opened === id;
    return (
      <li key={id} className="flex flex-col gap-2 py-2.5">
        <div className="flex items-start gap-3">
          {icon}
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate text-[13px] leading-5 font-medium text-ink" title={name}>{name}</p>
            <p className="truncate text-xs leading-4 text-muted">{line}</p>
          </div>
          <Button size="sm" variant="ghost" aria-expanded={isOpen} className="pr-1.5" onClick={() => { setOpened(isOpen ? null : id); if (!isOpen && id === 'repeats') setOpenPage(view.repeats[0]?.key ?? null); }}>
            {isOpen ? 'Close' : action}
            <ChevronRight size={13} aria-hidden className={cx('-ml-0.5 transition-transform', isOpen && 'rotate-90')} />
          </Button>
        </div>
        {isOpen && <div className="flex flex-col gap-3 pl-7">{panel}</div>}
      </li>
    );
  };

  const quiet = { size: 15, 'aria-hidden': true as const, className: 'mt-0.5 shrink-0 text-muted' };
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
      <ul className="flex flex-col divide-y divide-line-subtle border-y border-line">
        {shown.map(itemRow)}
        {view.disagree.map((group) => row({
          // What differs leads; the page it's on comes second.
          id: group.key, icon: <AlertTriangle {...quiet} />, name: groupLine(group), line: groupTitle(group), action: 'Compare',
          panel: <DisagreePairs pairs={group.pairs} titleOf={title} actions={actions} />,
        }))}
        {view.repeats.length > 0 && row({
          id: 'repeats', icon: <Copy {...quiet} />, name: 'Repeated rules', line: repeatsLine(view.repeats), action: 'Review',
          panel: (
            <>
              {safeRows > 0 && (
                <div className="flex items-center gap-3">
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => askKeepNewer(safePages)}>{busy === 'bulk' ? 'Working…' : safeRows === view.repeats.reduce((sum, group) => sum + group.rows.length, 0) ? 'Keep newer for all' : 'Keep newer where safe'}</Button>
                  <span className="text-xs text-faint">Older lines move to “Replaced”. You can undo.</span>
                </div>
              )}
              {/* One line per page; a page opens to its rules, so the list stays short. */}
              <ul className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle">
                {view.repeats.map((group) => {
                  const isOpen = openPage === group.key;
                  return (
                    <li key={group.key} className="flex flex-col">
                      <button type="button" aria-expanded={isOpen} onClick={() => setOpenPage(isOpen ? null : group.key)} className="flex items-center gap-2 py-2 text-left text-[13px] text-ink hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
                        <ChevronRight size={13} aria-hidden className={cx('shrink-0 text-faint transition-transform', isOpen && 'rotate-90')} />
                        <span className="min-w-0 flex-1 truncate">{groupTitle(group)}</span>
                      </button>
                      {isOpen && <div className="pb-2 pl-5"><RepeatPairs rows={group.rows} actions={actions} /></div>}
                    </li>
                  );
                })}
              </ul>
            </>
          ),
        })}
        {view.tidy.length > 0 && row({
          id: 'tidy', icon: <Sparkles {...quiet} />, name: `${view.tidy.length} ${view.tidy.length === 1 ? 'page' : 'pages'} to tidy`, line: 'Can wait', action: 'Show',
          panel: <ul className="flex flex-col divide-y divide-line-subtle">{view.tidy.map(itemRow)}</ul>,
        })}
      </ul>
      {view.items.length > SHOWN && (
        <Button size="sm" variant="ghost" className="self-start" flush onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${view.items.length}`}</Button>
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
