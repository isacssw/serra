// The weekly review on Overview: its proof (one real request answered with and without the page that answered it),
// and its controls (run it now, every week). Its fixes and what it found missing are in To do.
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ReviewExample, ReviewSuggestion } from '../../../../src/knowledge-review-store.ts';
import { serra } from '../../bridge.ts';
import { Button, cx, useToast } from '../../ui/index.ts';
import { localDate, markVerified } from '../pages.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Settle one suggestion the way its button says: approve the rewrite, retire the page, or confirm it still holds.
 * Returns the change's undo ID, so the toast can offer Undo where the click happened.
 */
export const settle = async (suggestion: ReviewSuggestion): Promise<string | null> => {
  const bridge = serra();
  if (!bridge) throw new Error('The Serra bridge is missing.');
  if (suggestion.kind === 'replace' && suggestion.proposal) {
    const { proposed, current, proposal } = await bridge.proposals.diff(suggestion.proposal);
    // Never over a page that changed since the review saw it: that would undo the newer edit without a word.
    if (suggestion.base && current !== null && await sha256(current) !== suggestion.base) {
      throw new Error('The page changed since the review. Look at the rewrite in Proposals, beside the page as it is now.');
    }
    return (await bridge.proposals.promote(suggestion.proposal, undefined, { proposal: proposed, path: proposal.target, page: current })).undoId;
  }
  if (suggestion.kind === 'retire') return (await bridge.proposals.retire(suggestion.page, await bridge.pages.read(suggestion.page))).undoId;
  if (suggestion.kind === 'confirm') {
    const text = await bridge.pages.read(suggestion.page);
    await bridge.pages.save(suggestion.page, markVerified(text, localDate(new Date())), text);
  }
  return null;
};

/** One request, answered with the notes and without the page: the value, shown rather than told. */
export const Proof = ({ example }: { example: ReviewExample }) => (
  <figure className="flex flex-col gap-2">
    <figcaption className="text-[13px] text-muted">“{example.request}”</figcaption>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div className="rounded-md border border-line px-3 py-2" title={example.withPage}>
        <p className="text-[11px] font-medium">With your notes</p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-ink">{example.withPage}</p>
      </div>
      <div className="rounded-md border border-dashed border-line px-3 py-2" title={example.without}>
        <p className="text-[11px] font-medium text-muted">Without</p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted">{example.without}</p>
      </div>
    </div>
  </figure>
);

/** Run the review now, and whether it runs every week. */
export const ReviewControls = ({ weekly, first, onChanged }: { weekly: boolean; first: boolean; onChanged: () => void }) => {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const run = async () => {
    const bridge = serra();
    if (!bridge || running) return;
    setRunning(true);
    try {
      const next = await bridge.pages.runReview();
      toast({ message: next.error ? `Review saved; the model part failed: ${next.error}` : 'Review ready.', tone: next.error ? 'error' : 'success' });
      onChanged();
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setRunning(false); }
  };
  const toggle = async () => {
    try { await serra()?.pages.setReviewWeekly(!weekly); onChanged(); } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" variant={first ? 'primary' : 'ghost'} disabled={running} onClick={() => void run()} icon={<RefreshCw size={13} aria-hidden className={cx(running && 'animate-spin')} />}>{running ? 'Reviewing…' : first ? 'Run review' : 'Run again'}</Button>
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" checked={weekly} onChange={() => void toggle()} className="accent-ink" />
        Every week
      </label>
    </div>
  );
};
