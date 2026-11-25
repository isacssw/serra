// Overview's "This week": the weekly knowledge review's digest. What the knowledge did for the bot, one real request
// answered with and without the page that answered it, and what it needed and no page had. Its fixes are in To do.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { KnowledgeReview, ReviewSuggestion } from '../../../../src/knowledge-review-store.ts';
import { serra } from '../../bridge.ts';
import { Button, cx, useToast } from '../../ui/index.ts';
import { localDate, markVerified } from '../pages.logic.ts';
import { shortDate, weekLine } from '../overview.logic.ts';

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

export const WeekDigest = ({ review, weekly, onChanged }: { review: KnowledgeReview | null; weekly: boolean; onChanged: () => void }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const [running, setRunning] = useState(false);

  const run = async () => {
    const bridge = serra();
    if (!bridge || running) return;
    setRunning(true);
    try {
      const next = await bridge.pages.runReview();
      toast({ message: next.error ? `Review saved, but the model part failed: ${next.error}` : 'This week’s review is ready.', tone: next.error ? 'error' : 'success' });
      onChanged();
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setRunning(false); }
  };
  const toggleWeekly = async () => {
    try { await serra()?.pages.setReviewWeekly(!weekly); onChanged(); } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
  };
  if (!review) {
    return (
      <section aria-label="This week" className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3.5">
        <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={15} aria-hidden />Weekly review</p>
        <p className="text-[13px] text-muted">Once a week your bot looks back at its replies: which notes helped, what it was missing, and what to fix. You approve every change.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={running} onClick={() => void run()} icon={<RefreshCw size={13} aria-hidden className={cx(running && 'animate-spin')} />}>{running ? 'Reviewing…' : 'Run the first review'}</Button>
          <WeeklyToggle weekly={weekly} onToggle={() => void toggleWeekly()} />
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="week-title" className="flex flex-col gap-4 rounded-lg border border-line bg-panel px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="week-title" className="text-sm font-semibold">This week <span className="font-normal text-muted">· {shortDate(`${review.from}T00:00:00Z`)} – {shortDate(`${review.to}T00:00:00Z`)}</span></h2>
        <div className="flex items-center gap-2">
          <WeeklyToggle weekly={weekly} onToggle={() => void toggleWeekly()} />
          <Button size="sm" variant="ghost" disabled={running} onClick={() => void run()} icon={<RefreshCw size={13} aria-hidden className={cx(running && 'animate-spin')} />}>{running ? 'Reviewing…' : 'Run again'}</Button>
        </div>
      </div>
      <p className="text-[13px] leading-5">{review.summary}</p>
      <p className="text-xs text-muted">{weekLine(review)}</p>

      {review.examples.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium text-muted">What your notes changed</p>
          {review.examples.map((example) => (
            <figure key={example.page} className="flex flex-col gap-2">
              <figcaption className="text-[13px]">“{example.request}”</figcaption>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-line px-3 py-2">
                  <p className="text-[11px] font-medium text-ink">With this page</p>
                  <p className="text-[11px] text-muted">{example.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted">{example.withPage}</p>
                </div>
                <div className="rounded-md border border-dashed border-line px-3 py-2">
                  <p className="text-[11px] font-medium text-muted">Without it</p>
                  <p className="mt-1 text-xs leading-5 text-muted">{example.without}</p>
                </div>
              </div>
            </figure>
          ))}
        </div>
      )}

      {review.missing.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted">Missing from your notes</p>
          <ul className="flex flex-col gap-0.5 text-[13px]">
            {review.missing.map((item) => (
              <li key={item.topic} className="flex items-start gap-3">
                <span className="min-w-0 flex-1">{item.topic}{item.count > 1 ? <span className="text-muted"> · asked {item.count}×</span> : null}</span>
                <Button size="sm" onClick={() => void navigate(`/jobs/new?text=${encodeURIComponent(`Remember this for my notes. ${item.topic}: `)}`)}>Tell it</Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-faint">Tell it the answer; it writes a proposal for you to approve.</p>
        </div>
      )}

      {review.error && <p className="text-xs text-warn">The model part didn’t run: {review.error}</p>}
    </section>
  );
};

const WeeklyToggle = ({ weekly, onToggle }: { weekly: boolean; onToggle: () => void }) => (
  <label className="flex items-center gap-1.5 text-xs text-muted">
    <input type="checkbox" checked={weekly} onChange={onToggle} className="accent-ink" />
    Every week
  </label>
);
