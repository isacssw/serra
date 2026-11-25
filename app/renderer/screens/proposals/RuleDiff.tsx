// A change to a page, as its rules: the header (dates, sources, who may hear it) is hidden unless asked for, since
// who may hear it has its own picker and the rest changes on every approval. Used by Proposals and Pages.
import { useState } from 'react';
import { pageBody } from '../../../../src/knowledge-rules.ts';
import { DiffView } from './DiffView.tsx';

export const RuleDiff = ({ current, proposed, labels, emptyCurrent }: { current: string | null; proposed: string; labels?: [string, string]; emptyCurrent?: string }) => {
  const [header, setHeader] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <DiffView current={current === null ? null : header ? current : pageBody(current)} proposed={header ? proposed : pageBody(proposed)} {...(labels ? { labels } : {})} {...(emptyCurrent ? { emptyCurrent } : {})} />
      <button type="button" onClick={() => setHeader(!header)} className="self-start text-xs text-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
        {header ? 'Hide the page header' : 'Show the page header too'}
      </button>
    </div>
  );
};
