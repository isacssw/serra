// Overview's "To do": the one place to act on the knowledge, shown only when there is something to do. The weekly
// review's fixes, rules that disagree (Keep one, right here), proposals waiting, what replies were missing (Tell it) and
// hand edits, worst first, three at a time. Each item is one line and one button; rewrites show their change first.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PROPOSAL_PARAM } from '../proposals.logic.ts';
import { ArrowUpRight, Check } from 'lucide-react';
import type { KnowledgeOverview } from '../../../../src/knowledge-overview.ts';
import type { ReviewSuggestion } from '../../../../src/knowledge-review-store.ts';
import { serra } from '../../bridge.ts';
import { Button, Dialog, useToast } from '../../ui/index.ts';
import { DiffView } from '../proposals/DiffView.tsx';
import { pageBody } from '../../../../src/knowledge-rules.ts';
import { fixItems, type FixItem } from '../overview.logic.ts';
import { keepLabel, keepRule, localDate, replacedOn } from '../pages.logic.ts';
import { settle } from './WeekDigest.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const SHOWN = 3;

export const FixList = ({ overview, onOpen, onChanged }: { overview: KnowledgeOverview; onOpen: (path: string) => void; onChanged: () => void }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<{ id: string; current: string | null; proposed: string } | null>(null);
  const [asking, setAsking] = useState<{ title: string; description: string; items: ReviewSuggestion[] } | null>(null);
  // Pages' "Settle" link lands here with the whole list open (#todo).
  const [all, setAll] = useState(() => window.location.hash.endsWith('#todo'));
  const items = fixItems(overview).filter((item) => !done.has(item.id));
  // "Do all" takes the fixes that change text the owner can see first. Saying a page still holds is theirs to say.
  const oneClick = items.flatMap((item) => (item.suggestion && item.suggestion.kind !== 'confirm' ? [item.suggestion] : []));
  if (items.length === 0) return null;
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
      const before = await bridge.pages.read(drop.page);
      const next = keepRule(before, drop.text, replacedOn(kept.text, localDate(new Date())));
      // A rule that isn't a whole line of its own can't be moved by a click: the page opens instead.
      if (next === before) { onOpen(drop.page); return; }
      await bridge.pages.save(drop.page, next, before);
      setDone((set) => new Set([...set, item.id]));
      toast({ message: 'Kept.', tone: 'success', action: { label: 'Undo', onClick: () => { void bridge.pages.read(drop.page).then((now) => bridge.pages.save(drop.page, before, now)).then(onChanged, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
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
    <section id="todo" aria-labelledby="todo-title" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="todo-title" className="text-sm font-semibold">To do <span className="font-normal tabular-nums text-muted">{items.length}</span></h2>
        {oneClick.length > 1 && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setAsking({ title: `Do all ${oneClick.length}?`, description: 'Rewrites are approved as shown; retired pages can be restored.', items: oneClick })}>
            Do all
          </Button>
        )}
      </div>
      <ul className="divide-y divide-line-subtle rounded-lg border border-line bg-panel">
        {shown.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <p className="line-clamp-2 min-w-0 flex-1 text-[13px]" title={[item.title, ...item.lines].join('\n')}>
                <span className="font-medium">{item.title}</span> <span className="text-muted">· {item.why}</span>
              </p>
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
                      <Button size="sm" variant={item.suggestion || item.tell ? 'secondary' : 'ghost'} disabled={busy !== null} onClick={() => run(item)} icon={item.suggestion || item.tell ? undefined : <ArrowUpRight size={13} aria-hidden />}>
                        {busy === item.id ? 'Working…' : item.action}
                      </Button>
                    )}
              </div>
            </div>
            {diff?.id === item.id && <DiffView current={diff.current} proposed={diff.proposed} />}
          </li>
        ))}
        {items.length > SHOWN && (
          <li className="px-4 py-2">
            <button type="button" onClick={() => setAll(!all)} className="text-xs text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">{all ? 'Fewer' : `${items.length - SHOWN} more`}</button>
          </li>
        )}
      </ul>
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
