// Knowledge → Proposals (APP-13): the review queue for pages the workers proposed. Pick one, read the side-by-side
// diff, then Promote it into a folder, Merge it into an existing page, or Discard it. Each action offers Undo.
// Start interview (APP-26) starts the guided knowledge interview as a T3 thread; what the owner confirms there is
// written to knowledge/proposals/, and the main process tells this screen as soon as a file lands.
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronRight, FileText, Folder, LoaderCircle, MessagesSquare } from 'lucide-react';
import type { Proposal, ProposalDiff } from '../../../src/contracts.ts';
import type { ProposalTargets } from '../../../src/proposals.ts';
import type { UndoHandle } from '../../main/bridge.ts';
import type { InterviewPreview } from '../../../src/tasks.ts';
import { serra } from '../bridge.ts';
import { REFRESH_COUNTS } from '../shell/events.ts';
import { Button, cx, Dialog, Page, useToast } from '../ui/index.ts';
import { DiffView } from './proposals/DiffView.tsx';
import { useSearchParams } from 'react-router';
import { registerActions } from '../commands/registry.ts';
import {
  defaultFolder, folderChoices, folderLabel, groupByDate, interviewStartedText, nextSelection, pendingLabel, PROPOSAL_PARAM, promoteProposalAction, proposalTitle,
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<ProposalDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [targets, setTargets] = useState<ProposalTargets>({ folders: [], pages: [] });
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState('');

  const reload = useCallback(async (select?: string | null) => {
    const bridge = serra();
    if (!bridge) { setLoadError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      const [list, places] = await Promise.all([bridge.proposals.list(), bridge.proposals.targets()]);
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
  }, [selected]);

  useEffect(() => {
    if (!diff) return;
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
      subtitle={proposals ? pendingLabel(proposals.length) : loadError ? undefined : 'Loading…'}
      actions={<InterviewButton />}
    >
      {loadError && <p role="alert" className="text-sm text-down">{loadError}</p>}
      {proposals && proposals.length === 0 && (
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
                </div>
                <DiffView current={diff.current} proposed={diff.proposed} />
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={busy || !folder}
                    onClick={() => void act((path) => bridge.proposals.promote(path, folder), `Promoted ${title} to ${folderLabel(folder)}.`)}
                  >
                    Promote
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
        description="The proposal's text is added to the end of the page and its sources are kept. The page is marked verified today."
        actions={(
          <>
            <Button onClick={() => setMergeOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || !mergeTarget}
              onClick={() => {
                setMergeOpen(false);
                const into = mergeTarget;
                void act((path) => bridge!.proposals.mergeInto(path, into), `Merged ${title} into ${into}.`);
              }}
            >
              Merge
            </Button>
          </>
        )}
      >
        <Select label="Page" value={mergeTarget} onChange={setMergeTarget} options={targets.pages.map((value) => ({ value, label: value }))} />
      </Dialog>
    </Page>
  );
};

type Interview = { state: 'closed' } | { state: 'loading' } | { state: 'ready'; preview: InterviewPreview } | { state: 'error'; message: string };

/** The header's Start interview button and its confirm dialog, which shows the brief the thread will get. */
const InterviewButton = () => {
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
  };

  const start = (): void => {
    const bridge = serra();
    if (!bridge || starting) return;
    setStarting(true);
    bridge.tasks.startInterview().then(
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
