// Overview's "What your notes do": every page with what it did for the bot in the window. Pages that earn their keep
// first, each with a real request it answered; pages no reply used last, with Retire one click away.
import { useState } from 'react';
import type { PageValue } from '../../../../src/knowledge-overview.ts';
import { Badge, Button, Dialog, useToast } from '../../ui/index.ts';
import { serra } from '../../bridge.ts';
import { valueLabel, valueSummary } from '../overview.logic.ts';
import { settle } from './WeekDigest.tsx';

const TONE = { earns: 'up', some: 'neutral', carried: 'accent', idle: 'warn', unknown: 'neutral' } as const;

export const ValueList = ({ value, days, replies, onOpen, onChanged }: { value: PageValue[]; days: number; replies: number; onOpen: (path: string) => void; onChanged: () => void }) => {
  const toast = useToast();
  const [all, setAll] = useState(false);
  const idle = value.filter((page) => page.state === 'idle');
  // Pages no reply used are always in view, with Retire: the dead weight is the point of this list as much as the value.
  const shown = all ? value : [...value.filter((page) => page.state !== 'idle').slice(0, 5), ...idle];
  const [asking, setAsking] = useState<PageValue | null>(null);
  const retire = async (page: PageValue) => {
    try {
      const undoId = await settle({ id: `retire:${page.path}`, kind: 'retire', page: page.path, title: page.title, why: '' });
      onChanged();
      toast({
        message: `Retired ${page.title}. It's under Archived in Pages.`, tone: 'success',
        ...(undoId ? { action: { label: 'Undo', onClick: () => { void serra()?.proposals.undo(undoId).then(onChanged, (failure: unknown) => toast({ message: failure instanceof Error ? failure.message : String(failure), tone: 'error' })); } } } : {}),
      });
    } catch (failure) { toast({ message: failure instanceof Error ? failure.message : String(failure), tone: 'error' }); }
  };
  return (
    <section aria-labelledby="value-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="value-title" className="text-sm font-semibold">What your notes do</h2>
        <p className="text-xs text-muted">
          {replies === 0 ? 'No replies yet' : valueSummary(value.map((page) => page.state), days)}
        </p>
      </div>
      <ul className="divide-y divide-line-subtle rounded-lg border border-line bg-panel">
        {shown.map((page) => (
          <li key={page.path} className="flex items-start gap-3 px-4 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <button type="button" onClick={() => onOpen(page.path)} title={page.path} className="truncate text-left text-[13px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-focus">{page.title}</button>
              {page.examples[0]
                ? <p className="truncate text-xs text-muted">Answered “{page.examples[0].request}”</p>
                : <p className="text-xs text-faint">{page.area}</p>}
            </div>
            <Badge tone={TONE[page.state]} className="shrink-0">{valueLabel(page.state, page.uses)}</Badge>
            {page.state === 'idle' && <Button size="sm" variant="ghost" onClick={() => setAsking(page)}>Retire…</Button>}
          </li>
        ))}
        {(all || value.length > shown.length) && (
          <li className="px-4 py-2">
            <button type="button" onClick={() => setAll(!all)} className="text-xs text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">{all ? 'Show fewer' : `Show all ${value.length}`}</button>
          </li>
        )}
      </ul>
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={`Retire ${asking?.title ?? 'this page'}?`}
        description="No reply used it lately. The bot stops using it; it moves to Archived in Pages, where you can restore it."
        actions={(
          <>
            <Button data-autofocus onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { const page = asking; setAsking(null); if (page) void retire(page); }}>Retire</Button>
          </>
        )}
      />
    </section>
  );
};
