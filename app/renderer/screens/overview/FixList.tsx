// Overview's "To do": every organising job in one list, each with one button. The weekly review's fixes (approve a
// rewrite, retire a page, confirm a stale one) and what the health check finds now (rules that disagree, repeats,
// stale pages), worst first. Rewrites show their change before they're approved; Retire asks first.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PROPOSAL_PARAM } from '../proposals.logic.ts';
import { ArrowUpRight, Check, CircleCheck } from 'lucide-react';
import type { KnowledgeOverview } from '../../../../src/knowledge-overview.ts';
import type { ReviewSuggestion } from '../../../../src/knowledge-review-store.ts';
import { serra } from '../../bridge.ts';
import { Button, Dialog, useToast } from '../../ui/index.ts';
import { DiffView } from '../proposals/DiffView.tsx';
import { pageBody } from '../../../../src/knowledge-rules.ts';
import { fixItems, type FixItem } from '../overview.logic.ts';
import { settle } from './WeekDigest.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const FixList = ({ overview, onOpen, onChanged }: { overview: KnowledgeOverview; onOpen: (path: string) => void; onChanged: () => void }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<{ id: string; current: string | null; proposed: string } | null>(null);
  const [asking, setAsking] = useState<{ title: string; description: string; items: ReviewSuggestion[] } | null>(null);
  const [all, setAll] = useState(false);
  const items = fixItems(overview).filter((item) => !done.has(item.id));
  // "Do all" takes the fixes that change text the owner can see first. Saying a page still holds is theirs to say.
  const oneClick = items.flatMap((item) => (item.suggestion && item.suggestion.kind !== 'confirm' ? [item.suggestion] : []));
  const shown = all ? items : items.slice(0, 6);

  const apply = async (list: ReviewSuggestion[]) => {
    const undoIds: string[] = [];
    for (const suggestion of list) {
      setBusy(suggestion.id);
      try {
        const undoId = await settle(suggestion);
        if (undoId) undoIds.push(undoId);
        setDone((set) => new Set([...set, suggestion.id]));
        // One fix at a time can be taken back right here.
        if (undoId && list.length === 1) {
          toast({ message: `${suggestion.title}: done.`, tone: 'success', action: { label: 'Undo', onClick: () => { void serra()?.proposals.undo(undoId).then(onChanged, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
        }
      } catch (failure) {
        toast({ message: `${suggestion.title}: ${message(failure)}`, tone: 'error' });
        break;
      }
    }
    setBusy(null);
    // Several fixes at once come back as one Undo, newest first.
    if (list.length > 1 && undoIds.length > 0) {
      toast({ message: `${undoIds.length} fixes done.`, tone: 'success', action: { label: 'Undo all', onClick: () => {
        void (async () => { for (const id of [...undoIds].reverse()) await serra()?.proposals.undo(id); })().then(onChanged, (failure: unknown) => toast({ message: message(failure), tone: 'error' }));
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
      // The rules, not the header: dates and sources change on every rewrite and say nothing to the owner.
      setDiff({ id: item.id, current: read.current === null ? null : pageBody(read.current), proposed: pageBody(read.proposed) });
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
  };
  const run = (item: FixItem) => {
    const suggestion = item.suggestion;
    if (item.proposal) { void navigate(`/knowledge/proposals?${PROPOSAL_PARAM}=${encodeURIComponent(item.proposal)}`); return; }
    if (!suggestion) { onOpen(item.pages[0]!); return; }
    // Taking a page away asks first; the others are reversible edits the owner sees.
    if (suggestion.kind === 'retire') setAsking({ title: `Retire ${suggestion.title}?`, description: 'The bot stops using it. It moves to Archived in Pages, where you can restore it.', items: [suggestion] });
    else void apply([suggestion]);
  };

  return (
    <section aria-labelledby="todo-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="todo-title" className="text-sm font-semibold">To do</h2>
        {oneClick.length > 1 && (
          <Button size="sm" disabled={busy !== null} onClick={() => setAsking({ title: `Do all ${oneClick.length} one-click fixes?`, description: 'Rewrites are approved as shown and pages are retired. Retired pages can be restored from Archived in Pages.', items: oneClick })}>
            Do all {oneClick.length}
          </Button>
        )}
      </div>
      {items.length === 0
        ? <p className="flex items-center gap-2 rounded-lg border border-line bg-panel px-4 py-3 text-[13px] text-muted"><CircleCheck size={15} aria-hidden className="text-up" />Nothing to tidy. No rules that disagree, repeats or stale pages.</p>
        : (
          <ul className="divide-y divide-line-subtle rounded-lg border border-line bg-panel">
            {shown.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 px-4 py-2.5">
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-[13px]"><span className="font-medium">{item.title}</span> <span className="text-muted">· {item.why}</span></p>
                    {item.lines.map((line) => <p key={line} className="truncate border-l-2 border-line pl-2 text-xs text-muted">{line}</p>)}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {item.suggestion?.kind === 'replace' && <Button size="sm" variant="ghost" onClick={() => void showChange(item)}>{diff?.id === item.id ? 'Hide change' : 'See change'}</Button>}
                    {done.has(item.id)
                      ? <span className="flex items-center gap-1 text-xs text-up"><Check size={13} aria-hidden />Done</span>
                      : (
                        <Button size="sm" variant={item.suggestion ? 'secondary' : 'ghost'} disabled={busy !== null} onClick={() => run(item)} icon={item.suggestion ? undefined : <ArrowUpRight size={13} aria-hidden />}>
                          {busy === item.id ? 'Working…' : item.action}
                        </Button>
                      )}
                  </div>
                </div>
                {diff?.id === item.id && <DiffView current={diff.current} proposed={diff.proposed} />}
              </li>
            ))}
            {items.length > 6 && (
              <li className="px-4 py-2">
                <button type="button" onClick={() => setAll(!all)} className="text-xs text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">{all ? 'Show fewer' : `Show all ${items.length}`}</button>
              </li>
            )}
          </ul>
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
