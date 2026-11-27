// A change to a page, as its rules: the header (dates, sources, who may hear it) is hidden unless asked for, since
// who may hear it has its own picker and the rest changes on every approval. Used by Proposals and Pages.
import { useState } from 'react';
import { pageBody } from '../../../../src/knowledge-rules.ts';
import { DiffView } from './DiffView.tsx';
import { Button } from '../../ui/index.ts';

export const RuleDiff = ({ current, proposed, labels, emptyCurrent }: { current: string | null; proposed: string; labels?: [string, string]; emptyCurrent?: string }) => {
  const [header, setHeader] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <DiffView current={current === null ? null : header ? current : pageBody(current)} proposed={header ? proposed : pageBody(proposed)} {...(labels ? { labels } : {})} {...(emptyCurrent ? { emptyCurrent } : {})} />
      <Button size="sm" variant="ghost" flush className="self-start" aria-pressed={header} onClick={() => setHeader(!header)}>
        {header ? 'Hide dates and sources' : 'Show dates and sources'}
      </Button>
    </div>
  );
};
