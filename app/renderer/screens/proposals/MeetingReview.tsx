// Meeting edits in Proposals (SERRA-62): one group per meeting the owner sent Serra, each edit with its quote, the
// turns around it, and the page before and after. Approve or discard one at a time; there's no free-text edit (to
// reword one, approve it and edit the page in Pages). Discard meeting drops every pending edit and its evidence.
import { useCallback, useEffect, useState } from 'react';
import { FileText, LoaderCircle, Quote } from 'lucide-react';
import type { Proposal } from '../../../../src/contracts.ts';
import type { MeetingItemView, MeetingView } from '../../../../src/meeting-store.ts';
import { serra } from '../../bridge.ts';
import { REFRESH_COUNTS } from '../../shell/events.ts';
import { Badge, Button, Dialog, useToast } from '../../ui/index.ts';
import { ToolIcon } from '../../ui/ToolIcon.tsx';
import { DiffView } from './DiffView.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const SourceIcon = ({ source }: { source: MeetingView['source'] }) => (source === 'granola'
  ? <ToolIcon brand={null} image="granola" fallback={null} label="Granola" />
  : source === 'google-meet'
    ? <ToolIcon brand="googlemeet" fallback={null} label="Google Meet" />
    : <ToolIcon brand={null} fallback={<FileText size={14} />} label={source === 'paste' ? 'Pasted text' : 'Uploaded file'} />);

const Item = ({ meeting, item, busy, onApprove, onDiscard }: {
  meeting: MeetingView; item: MeetingItemView; busy: boolean; onApprove: () => void; onDiscard: () => void;
}) => (
  <article className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
    <header className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{item.kind === 'decision' ? 'Decision' : 'Constraint'}</Badge>
        <h3 className="text-sm font-semibold">{item.text}</h3>
      </div>
      <p className="text-xs text-muted">
        {item.newPage ? <>New page <code>{item.target}</code>, visible to your team</> : item.op === 'replace'
          ? <>Replaces &ldquo;{item.old}&rdquo; in <code>{item.target}</code></>
          : <>Adds to <code>{item.target}</code></>}
      </p>
    </header>
    <figure className="flex flex-col gap-2 rounded-md border border-line bg-canvas px-3 py-2.5">
      <figcaption className="flex items-center gap-1.5 text-xs text-muted"><Quote size={12} aria-hidden /> From the transcript (speakers as named there)</figcaption>
      <ol className="flex flex-col gap-1 text-[13px] leading-5">
        {item.context.map((turn) => (
          <li key={turn.n}><span className="font-medium">{turn.speaker ?? 'Unnamed'}:</span> {turn.text}</li>
        ))}
      </ol>
    </figure>
    {item.wholePage && <p className="text-xs text-warn">This page changed since the meeting was read. Check the whole diff.</p>}
    {item.problem
      ? <p role="alert" className="text-sm text-down">{item.problem}</p>
      : item.after !== null && <DiffView current={item.before} proposed={item.after} labels={['Now', 'After']} emptyCurrent="No page yet: approving creates it." />}
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={busy || !item.reviewed} onClick={onApprove}>Approve</Button>
      <Button disabled={busy} onClick={onDiscard}>Discard</Button>
    </div>
    <span className="sr-only">From {meeting.title}</span>
  </article>
);

/**
 * Every meeting with edits waiting, plus any stub under `from-meeting/` (from `stubs`) Serra has no record of, which
 * can only be discarded. `onChanged` rereads the general queue. `onCount` says how many edits are shown.
 */
export const MeetingReview = ({ stubs, onChanged, onCount }: { stubs: Proposal[]; onChanged: () => void; onCount: (count: number) => void }) => {
  const toast = useToast();
  const [meetings, setMeetings] = useState<MeetingView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<MeetingView | null>(null);

  const reload = useCallback(async () => {
    const bridge = serra();
    if (!bridge) return;
    try {
      const list = await bridge.meetings.list();
      setMeetings(list);
      setError(null);
      onCount(list.reduce((sum, meeting) => sum + meeting.items.filter((item) => item.status === 'pending').length, 0));
    } catch (failure) { setError(message(failure)); }
  }, [onCount]);

  useEffect(() => {
    void reload();
    const bridge = serra();
    if (!bridge) return;
    const refresh = (): void => { void reload(); };
    const offProposals = bridge.on.proposals(refresh);
    window.addEventListener('focus', refresh);
    return () => { offProposals(); window.removeEventListener('focus', refresh); };
  }, [reload]);

  const run = async <T,>(work: () => Promise<T>, done: string, undoId?: (result: T) => string | null): Promise<void> => {
    const bridge = serra();
    if (!bridge || busy) return;
    setBusy(true);
    try {
      const result = await work();
      const id = undoId?.(result) ?? null;
      toast({ message: done, tone: 'success', ...(id ? { action: { label: 'Undo', onClick: () => { void bridge.proposals.undo(id).then(() => { void reload(); onChanged(); }, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } } : {}) });
    } catch (failure) {
      toast({ message: message(failure), tone: 'error' });
    } finally {
      setBusy(false);
      await reload();
      onChanged();
      window.dispatchEvent(new Event(REFRESH_COUNTS));
    }
  };

  const bridge = serra();
  if (!bridge) return null;
  if (error) return <p role="alert" className="text-sm text-down">{error}</p>;
  if (!meetings) return null;
  // A stub the registry doesn't list as pending (written by something other than Serra) can only be discarded.
  const strays = stubs.filter((stub) => {
    const [, id, file = ''] = stub.path.split('/');
    return !meetings.some((meeting) => meeting.id === id && meeting.items.some((item) => item.id === file.replace(/\.md$/, '') && item.status === 'pending'));
  });
  if (meetings.length === 0 && strays.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {meetings.map((meeting) => (
        <section key={meeting.id} aria-label={`From the meeting ${meeting.title}`} className="flex flex-col gap-3">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <SourceIcon source={meeting.source} />
              <div className="flex flex-col gap-0.5">
                <h2 className="text-base font-semibold">{meeting.title} <span className="font-normal text-muted">· {meeting.date}</span></h2>
                <p className="text-xs text-muted">
                  {meeting.speakers.length ? `${meeting.speakers.join(', ')} (as named in the transcript) · ` : ''}Visible to your team
                </p>
              </div>
            </div>
            <Button size="sm" disabled={busy} onClick={() => setConfirm(meeting)}>Discard meeting</Button>
          </header>
          {Object.keys(meeting.dropped).length > 0 && (
            <p className="text-xs text-muted">Left out: {Object.entries(meeting.dropped).map(([reason, count]) => `${count} ${reason}`).join(', ')}.</p>
          )}
          <p className="text-xs text-muted">
            Serra checked each quote is in the transcript, not that the decision is right or final, and didn&rsquo;t compare it with your private pages. Approve only what you agree with.
          </p>
          {meeting.items.filter((item) => item.status === 'pending').map((item) => (
            <Item
              key={item.id} meeting={meeting} item={item} busy={busy}
              onApprove={() => void run(() => bridge.meetings.approve(meeting.id, item.id, item.reviewed!), `Added to ${item.target}.`, (result) => result.undoId)}
              onDiscard={() => void run(() => bridge.meetings.discard(meeting.id, item.id), 'Discarded.')}
            />
          ))}
        </section>
      ))}
      {strays.length > 0 && (
        <section aria-label="Meeting edits Serra didn't write" className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Not from Serra</h2>
          <p className="text-xs text-muted">These look like meeting edits, but Serra has no record of them. They can only be discarded.</p>
          {strays.map((stray) => {
            const [, id = '', file = ''] = stray.path.split('/');
            return (
              <div key={stray.path} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
                <code className="truncate">{stray.path}</code>
                <Button size="sm" disabled={busy} onClick={() => void run(() => bridge.meetings.discard(id, file.replace(/\.md$/, '')), 'Discarded.')}>Discard</Button>
              </div>
            );
          })}
        </section>
      )}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Discard this meeting?"
        description="Every edit still waiting from it goes, with the quotes kept for review. This can't be undone. Edits you already approved stay; use Forget meeting in Settings › Meetings to remove those."
        actions={(
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="primary" icon={busy ? <LoaderCircle size={16} className="animate-spin" /> : undefined} onClick={() => {
              const meeting = confirm!;
              setConfirm(null);
              void run(() => bridge.meetings.discardMeeting(meeting.id), `Discarded ${meeting.title}.`);
            }}>Discard meeting</Button>
          </>
        )}
      />
    </div>
  );
};
