// Knowledge → Proposals (APP-13): the review queue for pages the workers proposed. Pick one, read the side-by-side
// diff, then Promote it into a folder, Merge it into an existing page, or Discard it. Each action offers Undo.
// Start interview (APP-26) starts the guided knowledge interview as a T3 thread; what the owner confirms there is
// written to knowledge/proposals/, and the main process tells this screen as soon as a file lands.
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronRight, FileText, Folder, LoaderCircle, MessagesSquare } from 'lucide-react';
import type { Proposal, ProposalDiff, ProposalSource } from '../../../src/contracts.ts';
import type { ProposalTargets } from '../../../src/proposals.ts';
import type { UndoHandle } from '../../main/bridge.ts';
import type { InterviewPreview } from '../../../src/tasks.ts';
import { serra } from '../bridge.ts';
import { REFRESH_COUNTS, announceTaskStart } from '../shell/events.ts';
import { Button, cx, Dialog, Page, useToast } from '../ui/index.ts';
import { DiffView } from './proposals/DiffView.tsx';
import { MeetingReview } from './proposals/MeetingReview.tsx';
import { AudienceChoice } from './AudienceChoice.tsx';
import { alignHeader, frontmatter, removeHeaderField, setHeaderField } from '../../../src/knowledge-rules.ts';
import { localDate } from './pages.logic.ts';
import { approvalAudience, pageAudience, type Audience } from '../../../src/owner-model.ts';
import { useSearchParams } from 'react-router';
import { registerActions } from '../commands/registry.ts';
import {
  defaultFolder, folderChoices, folderLabel, groupByDate, interviewStartedText, nextSelection, pendingLabel, PROPOSAL_PARAM, promoteProposalAction, proposalBody,
  proposalTitle, withoutTarget, diffRows, diffStats,
} from './proposals.logic.ts';

const unregister = registerActions([promoteProposalAction]);
import.meta.hot?.dispose(unregister);
import { taskLink } from './newTask.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const Select = ({ label, value, onChange, options, icon }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  icon?: ReactNode;
}) => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-muted">{label}</label>
      <div className="relative flex items-center">
        {icon && <span className="pointer-events-none absolute left-3 text-muted">{icon}</span>}
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cx(
            'h-9 w-full rounded-md border border-line bg-panel pr-3 text-sm text-ink',
            'focus:outline-2 focus:outline-offset-1 focus:outline-focus',
            icon ? 'pl-9' : 'pl-3',
          )}
        >
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
    </div>
  );
};

const Queue = ({ proposals, selected, onSelect }: { proposals: Proposal[]; selected: string | null; onSelect: (path: string) => void }) => (
  <nav aria-label="Proposals" className="flex w-full shrink-0 lg:w-72 flex-col gap-5">
    {groupByDate(proposals).map((group) => (
      <section key={group.date ?? 'undated'} className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{group.label}</h2>
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
                'flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm',
                'focus-visible:outline-2 focus-visible:outline-focus',
                active ? 'border-line-strong bg-selected' : 'border-line bg-panel hover:bg-raised',
              )}
            >
              <FileText size={16} aria-hidden className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{proposalTitle(proposal)}</span>
              <ChevronRight size={16} aria-hidden className="shrink-0 text-muted" />
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
        const start = `${current.trimEnd()}\n\n${proposalBody(diff.proposed)}\n`;
        setMergeBase(current); setMergeText(start); setMergeStart(start); setMergeAudience(approvalAudience(diff.proposed, current).audience);
      },
      (error) => { if (live) { setMergeOpen(false); toast({ message: message(error), tone: 'error' }); } },
    );
    return () => { live = false; };
  }, [mergeOpen, mergeTarget, diff, toast]);

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
      subtitle={proposals ? pendingLabel(proposals.length + meetingCount) : loadError ? undefined : 'Loading…'}
      actions={<InterviewButton autoOpen={search.get('interview') === '1'} onOpened={() => setSearch((params) => { params.delete('interview'); return params; }, { replace: true })} />}
    >
      {loadError && <p role="alert" className="text-sm text-down">{loadError}</p>}
      <MeetingReview stubs={meetingStubs} onChanged={() => { void reload(); }} onCount={setMeetingCount} />
      {proposals && proposals.length === 0 && meetingCount === 0 && (
        <p className="text-sm text-muted">
          No proposals waiting. Pages the workers propose under knowledge/proposals/ show up here. Start the interview to
          teach the bot how you work: what you confirm in it lands here for review.
        </p>
      )}
      {proposals && proposals.length > 0 && (
        <div className="flex flex-col gap-6 border-t border-line pt-5 lg:flex-row lg:items-start">
          <Queue proposals={proposals} selected={selected} onSelect={setSelected} />
          <div className="flex min-w-0 flex-1 flex-col gap-5 border-line lg:border-l lg:pl-6">
            {diffError && <p role="alert" className="text-sm text-down">{diffError}</p>}
            {!diff && !diffError && <p className="text-sm text-muted">Loading…</p>}
            {diff && bridge && (
              <>
                <div className="flex flex-col gap-1">
                  <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                  {diff.proposal.description && <p className="text-sm text-muted">{diff.proposal.description}</p>}
                  {diff.proposal.target && <p className="text-xs text-muted">Changes <code>{diff.proposal.target}</code></p>}
                  <Sources text={diff.proposed} from={diff.proposal.from} />
                </div>
                <DiffView current={landing(diff, folder)} proposed={asWritten(diff, folder, picked)} />
                {folders.length > 0 ? (
                  <Select
                    label="Target folder"
                    value={folder}
                    onChange={setFolder}
                    icon={<Folder size={16} />}
                    options={folders.map((value) => ({ value, label: targets.folders.includes(value) ? folderLabel(value) : `${folderLabel(value)} (new)` }))}
                  />
                ) : (
                  <p className="text-sm text-muted">knowledge/ has no folders yet. Create one to promote into.</p>
                )}
                <div className="flex flex-col gap-1">
                  <AudienceChoice id="proposal-audience" value={picked ?? approvalAudience(diff.proposed, landing(diff, folder)).audience} disabled={busy} onChange={setPicked} />
                  {picked === null && asks(diff, folder) && <span className="text-xs text-muted">{asks(diff, folder)}</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={busy || !folder}
                    onClick={() => void act(
                      (path) => bridge.proposals.promote(path, folder, { proposal: diff.proposed, path: diff.proposal.target, page: diff.current }, picked ?? undefined),
                      replaces(diff, folder) ? `Replaced ${diff.proposal.target}.` : `Promoted ${title} to ${folderLabel(folder)}.`,
                    )}
                  >
                    {replaces(diff, folder) ? 'Replace page' : 'Add page'}
                  </Button>
                  <Button disabled={busy || targets.pages.length === 0} onClick={() => setMergeOpen(true)}>Merge into…</Button>
                  <Button disabled={busy} onClick={() => void act((path) => bridge.proposals.discard(path), `Discarded ${title}.`)}>Discard</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <Dialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title="Merge into an existing page"
        description="Edit the page as it should read. This text replaces the page, so remove any rule it replaces. Sources are kept and the page is marked verified today."
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
        <label className="mt-3 flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Page after the merge</span>
          {mergeStart !== null && <span className="text-xs text-muted">The proposal is below the page. Edit them into one page, removing any rule it replaces, before merging.</span>}
          {mergeBase !== null && mergeText !== null && <MergeStats before={mergeBase} after={mergeText} />}
          <textarea
            value={mergeText ?? ''}
            onChange={(event) => setMergeText(event.target.value)}
            disabled={mergeText === null}
            spellCheck={false}
            rows={14}
            aria-label="Page after the merge"
            className="w-full resize-y rounded-md border border-line bg-panel p-2 font-mono text-xs leading-5 text-ink focus:outline-2 focus:outline-offset-1 focus:outline-focus disabled:opacity-60"
          />
        </label>
        <div className="mt-3 flex flex-col gap-1">
          <AudienceChoice id="merge-audience" value={mergeAudience} disabled={mergeBase === null} onChange={setMergeAudience} />
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

const Sources = ({ text, from }: { text: string; from?: ProposalSource }) => {
  const sources = sourcesOf(text);
  const opened = (href: string) => (event: { preventDefault: () => void }) => { event.preventDefault(); void serra()?.app.openExternal(href); };
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {from ? (
        <p className={from.owner ? 'text-muted' : 'text-warn'}>
          {from.owner
            ? (from.via === 'app' ? 'From a task you started in the app.' : 'From a Slack thread you started.')
            : `From a Slack thread ${from.who} started. Approve only what you said yourself.`}
          {from.link && <>{' '}<a href={from.link} onClick={opened(from.link)} className="text-ink underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-focus">Open the thread</a></>}
        </p>
      ) : (
        <p className="text-muted">Serra didn&rsquo;t record which thread wrote this (the interview and older briefs write here directly).</p>
      )}
      <p className="text-muted">{sources.length ? <>The worker&rsquo;s sources: {sources.join('; ')}.</> : 'The worker gave no sources.'}</p>
    </div>
  );
};

/** What the proposal asks for, when it differs from the default for where the page lands. */
const asks = (diff: ProposalDiff, folder: string): string | null => {
  const current = landing(diff, folder);
  const { asks: direction } = approvalAudience(diff.proposed, current);
  if (direction === 'narrower') return 'This proposal asks to share the page less. That\u2019s the default.';
  if (direction === 'wider') return current === null
    ? 'This proposal asks to share the page with people outside your company. It starts with your team unless you choose.'
    : 'This proposal asks to share the page more widely. It stays as it is unless you choose.';
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
      {stats.removed === 0 && ' Nothing of the page goes: check that no rule it replaces is left beside the new one.'}
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
        description="A T3 thread asks you how you work, one question at a time. Each topic you confirm is written to knowledge/proposals/ and shows up here to promote, merge or discard. It reads the project but changes nothing in it."
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
            <button type="button" className="self-start text-sm text-accent underline-offset-2 hover:underline" onClick={() => setShowBrief((shown) => !shown)}>
              {showBrief ? 'Hide the brief' : 'Show the brief'}
            </button>
            {showBrief && (
              <pre className="max-h-80 overflow-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-ink">{dialog.preview.brief}</pre>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
};
