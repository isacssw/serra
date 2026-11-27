// Knowledge → Proposals (APP-13): the review queue for pages the workers proposed. Pick one, read the side-by-side
// diff, then Promote it into a folder, Merge it into an existing page, or Discard it. Each action offers Undo.
// Start interview (APP-26) starts the guided knowledge interview as a T3 thread; what the owner confirms there is
// written to knowledge/proposals/, and the main process tells this screen as soon as a file lands.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Folder, Inbox, LoaderCircle, MessagesSquare, Trash2 } from 'lucide-react';
import type { Proposal, ProposalDiff } from '../../../src/contracts.ts';
import type { ProposalTargets } from '../../../src/proposals.ts';
import type { UndoHandle } from '../../main/bridge.ts';
import type { InterviewPreview } from '../../../src/tasks.ts';
import { serra } from '../bridge.ts';
import { REFRESH_COUNTS, announceTaskStart } from '../shell/events.ts';
import { Button, cx, Dialog, EmptyState, Page, Select, TextArea, useToast } from '../ui/index.ts';
import { PageBody } from './PageBody.tsx';
import { aboutCard } from './about.logic.ts';
import { RuleDiff } from './proposals/RuleDiff.tsx';
import { MeetingReview } from './proposals/MeetingReview.tsx';
import { AudienceChoice } from './AudienceChoice.tsx';
import { alignHeader, frontmatter, pageBody, removeHeaderField, setHeaderField } from '../../../src/knowledge-rules.ts';
import { localDate } from './pages.logic.ts';
import { approvalAudience, pageAudience, type Audience } from '../../../src/owner-model.ts';
import { useSearchParams } from 'react-router';
import { registerActions } from '../commands/registry.ts';
import {
  defaultFolder, folderChoices, swapRule, folderLabel, groupByDate, interviewStartedText, nextSelection, PROPOSAL_PARAM, promoteProposalAction, proposalBody,
  proposalTitle, withoutTarget, diffRows, diffStats, proposalMeta, sourceLine,
} from './proposals.logic.ts';

const unregister = registerActions([promoteProposalAction]);
import.meta.hot?.dispose(unregister);
import { taskLink } from './newTask.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const Queue = ({ proposals, selected, onSelect }: { proposals: Proposal[]; selected: string | null; onSelect: (path: string) => void }) => (
  <nav aria-label="Proposals" className="flex w-full shrink-0 flex-col gap-4 pt-3 lg:mr-6 lg:h-full lg:w-72 lg:overflow-y-auto lg:overscroll-contain lg:pb-6">
    {groupByDate(proposals).map((group) => (
      <section key={group.date ?? 'undated'} aria-label={group.label} className="flex flex-col gap-px">
        <h2 className="sticky top-0 z-10 bg-canvas px-2.5 pt-1 pb-1 text-xs font-medium text-faint">{group.label}</h2>
        {group.proposals.map((proposal) => {
          const active = proposal.path === selected;
          return (
            <button
              key={proposal.path}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(proposal.path)}
              title={proposal.description ?? proposal.path}
              className={cx(
                'flex flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                active ? 'bg-selected' : 'hover:bg-hover',
              )}
            >
              <span className={cx('truncate text-[13px] leading-5 text-ink', active && 'font-medium')}>{proposalTitle(proposal)}</span>
              <span className="truncate text-xs leading-4 text-muted">{proposal.target ? `Changes ${proposal.target}` : 'New page'}</span>
            </button>
          );
        })}
      </section>
    ))}
  </nav>
);

export const Proposals = () => {
  const toast = useToast();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  /** Meeting edits have their own review (MeetingReview): stubs under from-meeting/ never use promote or merge. */
  const [meetingStubs, setMeetingStubs] = useState<Proposal[]>([]);
  const [meetingCount, setMeetingCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<ProposalDiff | null>(null);
  /** Pages this proposal repeats: where it probably belongs instead of a new page. */
  /** A weekly-review rewrite of a page that changed since the review: approving it would undo the newer edit. */
  const [stale, setStale] = useState(false);
  const [similar, setSimilar] = useState<{ path: string; shared: string[]; disagrees: { page: string; proposal: string } | null }[]>([]);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [targets, setTargets] = useState<ProposalTargets>({ folders: [], pages: [] });
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState('');
  /** The owner's own pick, or null to take the default for wherever the page lands. Only a pick is sent. */
  const [picked, setPicked] = useState<Audience | null>(null);
  /** The page as it will read after the merge, which the owner edits in the dialog. Null while it loads. */
  const [mergeText, setMergeText] = useState<string | null>(null);
  /** The page as the merge dialog loaded it: what the owner reviewed, so a change while the dialog is open refuses the merge. */
  const [mergeBase, setMergeBase] = useState<string | null>(null);
  /** The text the merge dialog started from when it put the proposal under another page: merging it unchanged would keep both. */
  const [mergeStart, setMergeStart] = useState<string | null>(null);
  /** Who may hear the merged page: the destination's own audience until the owner changes it. */
  const [mergeAudience, setMergeAudience] = useState<Audience>('owner');
  /** Bumped to reread the selected proposal's diff, after an approval found its page had changed. */
  const [diffVersion, setDiffVersion] = useState(0);

  const reload = useCallback(async (select?: string | null) => {
    const bridge = serra();
    if (!bridge) { setLoadError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      const [all, places] = await Promise.all([bridge.proposals.list(), bridge.proposals.targets()]);
      const list = all.filter((proposal) => proposal.from?.via !== 'meeting');
      setMeetingStubs(all.filter((proposal) => proposal.from?.via === 'meeting'));
      setProposals(list);
      setTargets(places);
      setLoadError(null);
      setSelected((current) => {
        const wanted = select === undefined ? current : select;
        return wanted && list.some((proposal) => proposal.path === wanted) ? wanted : (list[0]?.path ?? null);
      });
    } catch (error) {
      setLoadError(message(error));
    }
    window.dispatchEvent(new Event(REFRESH_COUNTS));
  }, []);

  // `?proposal=<path>` (⌘K › Promote proposal…) selects that proposal, once.
  const [search, setSearch] = useSearchParams();
  const asked = search.get(PROPOSAL_PARAM);
  useEffect(() => {
    if (asked === null) return;
    setSearch((current) => { const next = new URLSearchParams(current); next.delete(PROPOSAL_PARAM); return next; }, { replace: true });
    void reload(asked);
  }, [asked, reload, setSearch]);

  useEffect(() => {
    void reload();
    const bridge = serra();
    if (!bridge) return;
    // Proposals arrive from workers and the interview while the app is open: the main process watches the folder,
    // and a daemon event or coming back to the window rereads them too.
    const refresh = () => { void reload(); };
    const offEvent = bridge.on.event(refresh);
    const offProposals = bridge.on.proposals(refresh);
    window.addEventListener('focus', refresh);
    return () => { offEvent(); offProposals(); window.removeEventListener('focus', refresh); };
  }, [reload]);

  useEffect(() => {
    const bridge = serra();
    setDiff(null);
    setDiffError(null);
    if (!bridge || !selected) return;
    let live = true;
    bridge.proposals.diff(selected).then(
      (next) => { if (live) setDiff(next); },
      (error) => { if (live) setDiffError(message(error)); },
    );
    setSimilar([]);
    setStale(false);
    bridge.proposals.staleRewrite(selected).then((value) => { if (live) setStale(value); }, () => undefined);
    // Only a hint: when it can't be worked out, the screen just doesn't show one.
    bridge.proposals.similar(selected).then((pages) => { if (live) setSimilar(pages.filter((page) => page.shared.length > 0)); }, () => undefined);
    return () => { live = false; };
  }, [selected, diffVersion]);

  // The merge dialog starts from the proposal when it is the whole page for the chosen page, and otherwise from the
  // page as it is now with the proposal's text below it, for the owner to edit into one page.
  useEffect(() => {
    const bridge = serra();
    setMergeText(null);
    setMergeBase(null);
    setMergeStart(null);
    if (!mergeOpen || !bridge || !diff || !mergeTarget) return;
    if (diff.proposal.target === mergeTarget && diff.current !== null) {
      setMergeBase(diff.current); setMergeText(withoutTarget(diff.proposed)); setMergeAudience(approvalAudience(diff.proposed, diff.current).audience);
      return;
    }
    let live = true;
    bridge.pages.read(mergeTarget).then(
      (current) => {
        if (!live) return;
        // A proposal that changes one rule on this page starts as the page with that rule swapped, ready to merge.
        const clash = similar.find((page) => page.path === mergeTarget)?.disagrees;
        const swapped = clash && current.includes(clash.page) ? swapRule(current, clash, proposalBody(diff.proposed), new Date().toISOString().slice(0, 10)) : null;
        const start = swapped ?? `${current.trimEnd()}\n\n${proposalBody(diff.proposed)}\n`;
        setMergeBase(current); setMergeText(start); setMergeStart(swapped ? null : start); setMergeAudience(approvalAudience(diff.proposed, current).audience);
      },
      (error) => { if (live) { setMergeOpen(false); toast({ message: message(error), tone: 'error' }); } },
    );
    return () => { live = false; };
  }, [mergeOpen, mergeTarget, diff, toast, similar]);

  useEffect(() => {
    if (!diff) return;
    // The default follows where the page lands (approvalAudience); only the owner's own pick is sent.
    setPicked(null);
    setFolder(defaultFolder(diff.proposal, targets.folders) ?? '');
    setMergeTarget(diff.proposal.target ?? targets.pages[0] ?? '');
  }, [diff, targets]);

  /** Runs one action on the selected proposal, then shows a toast whose Undo puts everything back. */
  const act = async (run: (path: string) => Promise<UndoHandle>, done: string) => {
    const bridge = serra();
    if (!bridge || !selected || !proposals) return;
    const path = selected;
    setBusy(true);
    try {
      const { undoId } = await run(path);
      await reload(nextSelection(proposals, path));
      toast({
        message: done,
        tone: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            bridge.proposals.undo(undoId).then(
              () => reload(path).then(() => toast({ message: 'Undone.', tone: 'info' })),
              (error) => toast({ message: message(error), tone: 'error' }),
            );
          },
        },
      });
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
      // An approval refused because the page changed shows the refreshed diff to look at again.
      setDiffVersion((version) => version + 1);
    } finally {
      setBusy(false);
    }
  };

  const bridge = serra();
  const title = diff ? proposalTitle(diff.proposal) : '';
  const folders = diff ? folderChoices(diff.proposal, targets.folders) : targets.folders;

  return (
    <Page
      title="Proposals"
      meta={proposals && proposals.length > 0 ? proposals.length : undefined}
      actions={<InterviewButton autoOpen={search.get('interview') === '1'} onOpened={() => setSearch((params) => { params.delete('interview'); return params; }, { replace: true })} />}
    >
      {loadError && <p role="alert" className="text-sm text-down">{loadError}</p>}
      <MeetingReview stubs={meetingStubs} onChanged={() => { void reload(); }} onCount={setMeetingCount} />
      {proposals && proposals.length === 0 && meetingCount === 0 && (
        <EmptyState icon={<Inbox size={18} />} title="Nothing waiting" />
      )}
      {proposals && proposals.length > 0 && (
        <div className="flex flex-col gap-6 border-t border-line lg:h-[calc(100vh-148px)] lg:min-h-96 lg:flex-row lg:gap-0">
          <Queue proposals={proposals} selected={selected} onSelect={setSelected} />
          <div className="flex min-w-0 flex-1 flex-col gap-5 pt-5 lg:h-full lg:overflow-y-auto lg:overscroll-contain lg:border-l lg:border-line lg:pr-1 lg:pl-8">
            {diffError && <p role="alert" className="text-sm text-down">{diffError}</p>}
            {!diff && !diffError && <p className="text-[13px] text-muted">Loading…</p>}
            {diff && bridge && (
              <>
                <header className="flex flex-col gap-1">
                  <h2 className="text-lg leading-7 font-semibold tracking-[-0.01em]">{title}</h2>
                  <Meta diff={diff} />
                </header>
                {stale && (
                  <p role="status" className="flex items-center gap-2 rounded-xl border border-warn/40 bg-warn/5 px-4 py-2.5 text-[13px] text-warn">
                    <AlertTriangle size={14} aria-hidden className="shrink-0" />The page changed since. Approving undoes that change.
                  </p>
                )}
                {!diff.proposal.target && similar[0] && (
                  <div className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-panel px-4 py-3 shadow-card">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {similar[0].disagrees ? (
                        <>
                          <p className="text-[13px] font-medium">Changes a rule on {similar[0].path}</p>
                          <p className="border-l-2 border-line-strong pl-2.5 text-xs text-muted">Now: {similar[0].disagrees.page}</p>
                          <p className="border-l-2 border-line-strong pl-2.5 text-xs text-ink">Proposed: {similar[0].disagrees.proposal}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-[13px] font-medium">Already on {similar[0].path}</p>
                          <p className="truncate border-l-2 border-line-strong pl-2.5 text-xs text-muted">{similar[0].shared[0]}</p>
                        </>
                      )}
                    </div>
                    <Button size="sm" disabled={busy} onClick={() => { setMergeTarget(similar[0]!.path); setMergeOpen(true); }}>Merge into it…</Button>
                  </div>
                )}
                {/* The proposed text first: a new page as it will read, a change as a diff against the page now. */}
                {landing(diff, folder) === null
                  ? <NewPage title={title} text={asWritten(diff, folder, picked)} />
                  : <RuleDiff current={landing(diff, folder)} proposed={asWritten(diff, folder, picked)} />}
                <footer className="sticky bottom-0 flex flex-col gap-3 border-t border-line bg-canvas pt-4 pb-4">
                  <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
                    {/* A rewrite of a page goes where the page is; only a new page asks where. */}
                    {diff.proposal.target ? null : folders.length > 0 ? (
                      <Select
                        label="Folder"
                        className="w-52"
                        value={folder}
                        onChange={setFolder}
                        icon={<Folder size={14} />}
                        options={folders.map((value) => ({ value, label: folderLabel(value), icon: <Folder size={14} />, ...(targets.folders.includes(value) ? {} : { detail: 'New' }) }))}
                      />
                    ) : (
                      <p className="text-[13px] text-muted">No folders yet.</p>
                    )}
                    <AudienceChoice id="proposal-audience" label value={picked ?? approvalAudience(diff.proposed, landing(diff, folder)).audience} disabled={busy} onChange={setPicked} />
                  </div>
                  {picked === null && asks(diff, folder) && <p className="-mt-1 text-xs text-muted">{asks(diff, folder)}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="ghost"
                      icon={<Trash2 size={14} aria-hidden />}
                      className="-ml-3 enabled:hover:bg-down/10 enabled:hover:text-down"
                      disabled={busy}
                      onClick={() => void act((path) => bridge.proposals.discard(path), `Discarded ${title}.`)}
                    >
                      Discard
                    </Button>
                    <div className="ml-auto flex items-center gap-2">
                      <Button disabled={busy || targets.pages.length === 0} onClick={() => setMergeOpen(true)}>Merge into…</Button>
                      <Button
                        variant="primary"
                        disabled={busy || !folder}
                        onClick={() => void act(
                          (path) => bridge.proposals.promote(path, folder, { proposal: diff.proposed, path: diff.proposal.target, page: diff.current }, picked ?? undefined),
                          replaces(diff, folder) ? `Replaced ${diff.proposal.target}.` : `Promoted ${title} to ${folderLabel(folder)}.`,
                        )}
                      >
                        {replaces(diff, folder) ? 'Approve' : 'Add page'}
                      </Button>
                    </div>
                  </div>
                </footer>
              </>
            )}
          </div>
        </div>
      )}
      <Dialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title="Merge into an existing page"
        description="Edit the page as it should read. It replaces the page and is marked verified today."
        actions={(
          <>
            <Button onClick={() => setMergeOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || !mergeTarget || mergeText === null || mergeBase === null || (mergeStart !== null && mergeText === mergeStart)}
              onClick={() => {
                setMergeOpen(false);
                const into = mergeTarget;
                const text = mergeText ?? undefined;
                const reviewed = { proposal: diff!.proposed, path: into, page: mergeBase };
                void act((path) => bridge!.proposals.mergeInto(path, into, text, reviewed, mergeAudience), `Merged ${title} into ${into}.`);
              }}
            >
              Merge
            </Button>
          </>
        )}
      >
        <Select label="Page" value={mergeTarget} onChange={setMergeTarget} options={targets.pages.map((value) => ({ value, label: value }))} />
        <TextArea
          label="Page after the merge"
          className="mt-3"
          value={mergeText ?? ''}
          onChange={(event) => setMergeText(event.target.value)}
          disabled={mergeText === null}
          spellCheck={false}
          hint={mergeStart !== null
            ? 'The proposal is below the page: edit them into one.'
            : mergeText !== null && mergeBase !== null && mergeText !== mergeBase && similar[0]?.disagrees && similar[0].path === mergeTarget ? 'The old rule is swapped for the proposed one.' : undefined}
          textareaClassName="min-h-64 max-h-none resize-y font-mono text-xs leading-5 [field-sizing:fixed]"
        />
        {mergeBase !== null && mergeText !== null && <div className="mt-1.5"><MergeStats before={mergeBase} after={mergeText} /></div>}
        <div className="mt-4 flex flex-col gap-1.5">
          <AudienceChoice id="merge-audience" label value={mergeAudience} disabled={mergeBase === null} onChange={setMergeAudience} />
          {mergeBase !== null && widens(pageAudience(frontmatter(mergeBase)), mergeAudience) && (
            <span className="text-xs text-warn">This shares {mergeTarget}&rsquo;s existing text more widely than now.</span>
          )}
        </div>
      </Dialog>
    </Page>
  );
};

const AUDIENCE_RANK: Record<Audience, number> = { owner: 0, team: 1, external: 2 };
/** Whether `to` lets more people hear a page than `from`. */
const widens = (from: Audience, to: Audience): boolean => AUDIENCE_RANK[to] > AUDIENCE_RANK[from];

/** The page approving into `folder` writes over: the proposal's target when it lands there, else none (a new page). */
const landing = (diff: ProposalDiff, folder: string): string | null => (replaces(diff, folder) ? diff.current : null);

/** The proposal's `sources:` lines: who and which thread the worker says it learned this from. */
const sourcesOf = (text: string): string[] => {
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const lines = header.split('\n');
  const start = lines.findIndex((line) => line.startsWith('sources:'));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (!item) break;
    items.push(item[1]!.trim());
  }
  return items;
};

/** A new page as it will read once added; its header (dates, sources) on request. */
const NewPage = ({ text, title }: { text: string; title: string }) => (
  <section aria-label="Proposed page" className="rounded-xl border border-line bg-panel shadow-card">
    <div className="max-w-[76ch] pt-1"><PageBody strong text={withoutTitle(pageBody(text), title)} onOpen={(href) => void serra()?.app.openExternal(href)} /></div>
  </section>
);

/** The body without its first heading when that heading only repeats the proposal's title ("On-call handover"). */
const withoutTitle = (body: string, title: string): string => {
  const card = aboutCard('', body);
  const [a, b] = [card.title.toLowerCase(), title.toLowerCase()];
  return card.body && (a === b || b.startsWith(a) || a.startsWith(b)) ? card.body : body;
};

/** Where the proposal came from and when, in one line; nothing for what wasn't recorded. Its sources on hover. */
const Meta = ({ diff }: { diff: ProposalDiff }) => {
  const sources = sourcesOf(diff.proposed);
  const from = diff.proposal.from;
  const careful = sourceLine(from)?.careful ?? false;
  const opened = (href: string) => (event: { preventDefault: () => void }) => { event.preventDefault(); void serra()?.app.openExternal(href); };
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-faint" title={sources.length ? `Sources: ${sources.join('; ')}` : undefined}>
      {proposalMeta(diff.proposal).map((part, at) => (
        <span key={part} className="contents">
          {at > 0 && <span aria-hidden>·</span>}
          <span className={cx(at === 0 && careful && 'text-warn')}>{part}</span>
        </span>
      ))}
      {from?.link && <><span aria-hidden>·</span><a href={from.link} onClick={opened(from.link)} className="text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">Thread</a></>}
      {careful && <span className="text-warn">· approve only what you said</span>}
    </p>
  );
};

/** What the proposal asks for, when it differs from the default for where the page lands. */
const asks = (diff: ProposalDiff, folder: string): string | null => {
  const current = landing(diff, folder);
  const { asks: direction } = approvalAudience(diff.proposed, current);
  if (direction === 'narrower') return 'Asks to share less: set as the default.';
  if (direction === 'wider') return current === null
    ? 'Asks to share outside your company. Starts with your team.'
    : 'Asks to share more widely. Stays as it is unless you choose.';
  return null;
};

/** The page as approving into `folder` writes it: no `target:`, verified today, and the audience it will have. */
const asWritten = (diff: ProposalDiff, folder: string, picked: Audience | null): string => {
  const page = setHeaderField(withoutTarget(diff.proposed), 'verified', localDate(new Date()));
  const current = landing(diff, folder);
  const { audience, untagged } = approvalAudience(diff.proposed, current);
  return alignHeader(picked ? setHeaderField(page, 'audience', picked) : untagged ? removeHeaderField(page, 'audience') : setHeaderField(page, 'audience', audience), current);
};

/** Whether approving into `folder` replaces the page the proposal names, rather than adding a new one. */
const replaces = (diff: ProposalDiff, folder: string): boolean =>
  diff.current !== null && diff.proposal.target !== null && diff.proposal.target.split('/').slice(0, -1).join('/') === folder;

/** How the merged page differs from the page now, and a warning when nothing of the old page goes. */
const MergeStats = ({ before, after }: { before: string; after: string }) => {
  const stats = diffStats(diffRows(before, after));
  return (
    <span className={cx('text-xs', stats.removed === 0 ? 'text-warn' : 'text-muted')}>
      {stats.removed} line{stats.removed === 1 ? '' : 's'} removed, {stats.added} added.
      {stats.removed === 0 && ' Check no old rule is left beside the new one.'}
    </span>
  );
};

type Interview = { state: 'closed' } | { state: 'loading' } | { state: 'ready'; preview: InterviewPreview } | { state: 'error'; message: string };

/** The header's Start interview button and its confirm dialog, which shows the brief the thread will get. */
const InterviewButton = ({ autoOpen = false, onOpened }: { autoOpen?: boolean; onOpened?: () => void }) => {
  const toast = useToast();
  const [dialog, setDialog] = useState<Interview>({ state: 'closed' });
  const [starting, setStarting] = useState(false);
  const [showBrief, setShowBrief] = useState(false);

  const open = (): void => {
    const bridge = serra();
    setShowBrief(false);
    if (!bridge) { setDialog({ state: 'error', message: 'Open this screen in the Serra app to start the interview.' }); return; }
    setDialog({ state: 'loading' });
    bridge.tasks.previewInterview().then(
      (preview) => setDialog({ state: 'ready', preview }),
      (error: unknown) => setDialog({ state: 'error', message: message(error) }),
    );
  };  // Arriving from About me's "Start the interview" opens the confirm dialog straight away, once.
  useEffect(() => {
    if (!autoOpen) return;
    onOpened?.();
    open();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- opens once when the flag arrives, not on every render.
  }, [autoOpen]);


  const start = (): void => {
    const bridge = serra();
    if (!bridge || starting) return;
    setStarting(true);
    announceTaskStart(() => bridge.tasks.startInterview()).then(
      (task) => {
        setDialog({ state: 'closed' });
        const link = taskLink(task);
        toast({
          message: interviewStartedText(task),
          tone: 'success',
          ...(link ? { action: { label: 'Open in T3', onClick: () => { void bridge.app.openExternal(link).catch((error: unknown) => toast({ message: message(error), tone: 'error' })); } } } : {}),
        });
      },
      (error: unknown) => setDialog({ state: 'error', message: message(error) }),
    ).finally(() => setStarting(false));
  };

  const resumes = dialog.state === 'ready' && dialog.preview.resumes;
  return (
    <>
      <Button icon={<MessagesSquare size={16} />} onClick={open}>Start interview</Button>
      <Dialog
        open={dialog.state !== 'closed'}
        onClose={() => { if (!starting) setDialog({ state: 'closed' }); }}
        title={resumes ? 'Resume the knowledge interview' : 'Start the knowledge interview'}
        description="A T3 thread asks how you work, one question at a time. Each topic you confirm lands here to review."
        actions={(
          <>
            <Button disabled={starting} onClick={() => setDialog({ state: 'closed' })}>Cancel</Button>
            <Button
              variant="primary"
              disabled={starting || dialog.state !== 'ready'}
              icon={starting ? <LoaderCircle size={16} className="animate-spin" /> : undefined}
              onClick={start}
            >
              {starting ? 'Starting…' : 'Start in T3'}
            </Button>
          </>
        )}
      >
        {dialog.state === 'loading' && <p className="text-sm text-muted">Filling the brief…</p>}
        {dialog.state === 'error' && <p role="alert" className="text-sm text-down">{dialog.message}</p>}
        {dialog.state === 'ready' && (
          <div className="flex flex-col gap-2">
            {dialog.preview.resumes && (
              <p className="text-sm">An earlier interview left notes in onboarding-progress.md. This one carries on from them.</p>
            )}
            <Button size="sm" variant="ghost" flush className="self-start" aria-expanded={showBrief} onClick={() => setShowBrief((shown) => !shown)}>
              {showBrief ? 'Hide the brief' : 'Show the brief'}
            </Button>
            {showBrief && (
              <pre className="max-h-80 overflow-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-ink">{dialog.preview.brief}</pre>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
};
