// Overview's "What your notes do": every page with what it did for the bot in the window. Pages that earn their keep
// first, each with a real request it answered; pages no reply used last, with Retire one click away.
import { useState } from 'react';
import type { PageValue } from '../../../../src/knowledge-overview.ts';
import { Badge, Button, useToast } from '../../ui/index.ts';
import { valueLabel } from '../overview.logic.ts';
import { settle } from './WeekDigest.tsx';

const TONE = { earns: 'up', some: 'neutral', carried: 'accent', idle: 'warn', unknown: 'neutral' } as const;

export const ValueList = ({ value, days, replies, onOpen, onChanged }: { value: PageValue[]; days: number; replies: number; onOpen: (path: string) => void; onChanged: () => void }) => {
  const toast = useToast();
  const [all, setAll] = useState(false);
  const earning = value.filter((page) => page.state === 'earns' || page.state === 'some' || page.state === 'carried').length;
  const idle = value.filter((page) => page.state === 'idle');
  const shown = all ? value : value.slice(0, 6);
  const retire = async (page: PageValue) => {
    try {
      await settle({ id: `retire:${page.path}`, kind: 'retire', page: page.path, title: page.title, why: '' });
      toast({ message: `Retired ${page.title}. Undo it from Pages' archive if you need it back.`, tone: 'success' });
      onChanged();
    } catch (failure) { toast({ message: failure instanceof Error ? failure.message : String(failure), tone: 'error' }); }
  };
  return (
    <section aria-labelledby="value-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="value-title" className="text-sm font-semibold">What your notes do</h2>
        <p className="text-xs text-muted">
          {replies === 0 ? 'No replies yet' : `${earning} of ${value.length} pages helped in the last ${days} days${idle.length ? ` · ${idle.length} not used` : ''}`}
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
            {page.state === 'idle' && <Button size="sm" variant="ghost" onClick={() => void retire(page)}>Retire</Button>}
          </li>
        ))}
        {value.length > 6 && (
          <li className="px-4 py-2">
            <button type="button" onClick={() => setAll(!all)} className="text-xs text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">{all ? 'Show fewer' : `Show all ${value.length}`}</button>
          </li>
        )}
      </ul>
    </section>
  );
};
