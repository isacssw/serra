// Overview's "To do": the one place to act on the knowledge, shown only when there is something to do. The weekly
// review's fixes, rules that disagree (Keep one, right here), proposals waiting, what replies were missing (Tell it) and
// hand edits, worst first, three at a time. Each item is one line and one button; rewrites show their change first.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PROPOSAL_PARAM } from '../proposals.logic.ts';
import { AlertTriangle, Check, ChevronRight, CircleCheck, CircleHelp, FileText, PenLine, Sparkles } from 'lucide-react';
import type { KnowledgeOverview } from '../../../../src/knowledge-overview.ts';
import type { ReviewSuggestion } from '../../../../src/knowledge-review-store.ts';
import { serra } from '../../bridge.ts';
import { Button, cx, Dialog, useToast } from '../../ui/index.ts';
import { DiffView } from '../proposals/DiffView.tsx';
import { pageBody } from '../../../../src/knowledge-rules.ts';
import { fixItems, fixKind, groupFixes, type FixItem } from '../overview.logic.ts';
import { keepOne } from '../keep.ts';
import { keepLabel } from '../pages.logic.ts';
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
  const [asking, setAsking] = useState<{ title: string; description: string; items: ReviewSuggestion[] } | null>(null);
  // Pages' "Settle" link lands here with the whole list open (#todo).
  const [all, setAll] = useState(() => window.location.hash.endsWith('#todo'));
  const open = fixItems(overview).filter((item) => !done.has(item.id));
  const items = groupFixes(open);
  // "Do all" takes the fixes that change text the owner can see first. Saying a page still holds is theirs to say.
  const oneClick = items.flatMap((item) => (item.suggestion && item.suggestion.kind !== 'confirm' ? [item.suggestion] : []));
  if (items.length === 0) {
    return (
      <section aria-labelledby="todo-title" className="flex flex-col gap-2">
        <h2 id="todo-title" className="text-sm font-semibold">Needs you</h2>
        <p className="flex items-center gap-2 border-t border-line py-3 text-[13px] text-muted"><Check size={14} aria-hidden className="text-up" />All caught up</p>
      </section>
    );
  }
  const shown = all ? items : items.slice(0, SHOWN);

  const apply = async (list: ReviewSuggestion[]) => {
    const undoIds: string[] = [];
    for (const suggestion of list) {
      setBusy(suggestion.id);
      try {
        const undoId = await settle(suggestion);
        if (undoId) undoIds.push(undoId);
        setDone((set) => new Set([...set, suggestion.id]));
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

  /** Keeps `kept` and moves `drop` under "Replaced" on its page, saved at once; Undo puts the page back. */
  const keep = async (item: FixItem, kept: { page: string; text: string }, drop: { page: string; text: string }) => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(item.id);
    try {
      const result = await keepOne(bridge, kept, drop);
      // A rule that isn't a whole line of its own can't be moved by a click: the page opens instead.
      if (result === 'open') { onOpen(drop.page); return; }
      setDone((set) => new Set([...set, item.id]));
      toast({ message: 'Kept.', tone: 'success', action: { label: 'Undo', onClick: () => { void result.undo().then(onChanged, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
      onChanged();
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setBusy(null); }
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
    if (suggestion.kind === 'retire') setAsking({ title: `Retire ${suggestion.title}?`, description: 'The bot stops using it. Restore it from Archived in Pages.', items: [suggestion] });
    else void apply([suggestion]);
  };

  return (
    <section id="todo" aria-labelledby="todo-title" className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 id="todo-title" className="text-sm font-semibold">Needs you <span className="ml-1 font-normal tabular-nums text-faint">{open.length}</span></h2>
        {oneClick.length > 1 && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setAsking({ title: `Do all ${oneClick.length}?`, description: 'Rewrites are approved as shown; retired pages can be restored.', items: oneClick })}>
            Do all
          </Button>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-line-subtle border-y border-line">
        {shown.map((item) => {
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
                    : item.keep && item.keep.length === 2
                      ? item.keep.map((fact, at) => (
                        <Button key={fact.text} size="sm" disabled={busy !== null} onClick={() => void keep(item, fact, item.keep![1 - at]!)} title={fact.text}>
                          {keepLabel(fact.text, item.keep![1 - at]!.text)}
                        </Button>
                      ))
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
        })}
      </ul>
      {items.length > SHOWN && (
        <Button size="sm" variant="ghost" className="self-start" flush onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</Button>
      )}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking?.title ?? ''}
        description={asking?.description}
        actions={(
          <>
            <Button data-autofocus onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { const list = asking?.items ?? []; setAsking(null); void apply(list); }}>Do it</Button>
          </>
        )}
      />
    </section>
  );
};
