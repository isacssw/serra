// The Jobs screen (APP-12): Needs you, Running and Done today, with links out to Slack, T3 and the PR, a channel
// filter and worktree cleanup behind a dry run. It reads the profile's files through the bridge, so it works with the
// daemon stopped, and reloads on every daemon event. No conversation view: that is read in T3.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  BrushCleaning, CheckCheck, CircleCheck, CirclePause, GitPullRequest, Hash, Layers, LoaderCircle, MessageSquareText, Radio, ListChecks, Play,
  Plus, RefreshCw,
} from 'lucide-react';
import { useSearchParams } from 'react-router';
import type { CleanupVerdict, JobGroup } from '../../../src/contracts.ts';
import { serra } from '../bridge.ts';
import { useBotStatus } from '../shell/live.ts';
import { resumePath } from '../setup/setup.logic.ts';
import { useSetup } from '../setup/SetupState.tsx';
import { Badge, BrandMark, Button, Dialog, EmptyState, Page, Select, cx, useToast } from '../ui/index.ts';
import { registerActions } from '../commands/registry.ts';
import { RunChat, type ChatRun } from './chat/RunChat.tsx';
import {
  ageLabel, channelChoices, channelTag, CLEANUP_PARAM, cleanupView, cleanupWorktreesAction, filterJobs, groupJobs, ICON_LABELS,
  linkButtons, rowIcon, rowNote, rowParts, rowPill, verdictLabel, type JobRow, type JobSection, type LinkKind, type RowIcon,
} from './jobs.logic.ts';

const unregister = registerActions([cleanupWorktreesAction]);
import.meta.hot?.dispose(unregister);

/** The current time, ticking so age labels stay right without a reload. */
const useNow = (everyMs: number): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
};

type Load = { state: 'loading' } | { state: 'ready'; rows: JobRow[] } | { state: 'error'; message: string };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The job list, reloaded on daemon events, status changes and window focus. Keeps showing the last list on a failed reload. */
const useJobs = (statusState: string | undefined): { load: Load; reload: () => void } => {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const live = useRef(true);
  const reload = useCallback(() => {
    const bridge = serra();
    if (!bridge) { setLoad({ state: 'error', message: 'Open this screen in the Serra app to see jobs.' }); return; }
    bridge.jobs.list().then(
      (rows) => { if (live.current) setLoad({ state: 'ready', rows }); },
      (error: unknown) => { if (live.current) setLoad((seen) => (seen.state === 'ready' ? seen : { state: 'error', message: message(error) })); },
    );
  }, []);
  useEffect(() => {
    live.current = true;
    reload();
    const bridge = serra();
    // Events come in bursts (a reply is several), so one reload covers each burst.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = (): void => { clearTimeout(timer); timer = setTimeout(reload, 250); };
    const off = bridge?.on.event(soon) ?? (() => {});
    // Slack names main looked up after the last list (APP-29).
    const offNames = bridge?.on.jobs(soon) ?? (() => {});
    window.addEventListener('focus', soon);
    return () => { live.current = false; clearTimeout(timer); off(); offNames(); window.removeEventListener('focus', soon); };
  }, [reload, statusState]);
  return { load, reload };
};

const ROW_ICONS: Record<RowIcon, ReactNode> = {
  'needs-you': <span className="size-2 rounded-full bg-warn" />,
  failed: <span className="size-2 rounded-full bg-down" />,
  // A frozen spinner reads as broken, so Reduce Motion shows a steady dot instead.
  running: <><LoaderCircle size={14} strokeWidth={2} className="animate-spin text-ink motion-reduce:hidden" /><span className="hidden size-2 rounded-full bg-up ring-3 ring-up/25 motion-reduce:block" /></>,
  paused: <CirclePause size={14} strokeWidth={1.75} className="text-muted" />,
  done: <CircleCheck size={14} strokeWidth={1.75} className="text-up" />,
};

const LINK_ICONS: Record<LinkKind, ReactNode> = {
  slack: <BrandMark brand="slack" size={13} />,
  t3: <Layers size={14} strokeWidth={1.75} />,
  chat: <MessageSquareText size={14} strokeWidth={1.75} />,
  pr: <GitPullRequest size={14} strokeWidth={1.75} />,
};

const open = (url: string, onError: (text: string) => void): void => {
  const bridge = serra();
  if (!bridge) return;
  bridge.app.openExternal(url).catch((error: unknown) => onError(message(error)));
};

/** One job: the task first, then who asked, where and how long ago; a pill when it waits on you; its links as icons. */
const JobRowView = ({ job, icon, now, kinds, onError, onChat, focused = false }: { job: JobRow; icon: RowIcon; now: Date; kinds: readonly LinkKind[]; onError: (text: string) => void; onChat: (run: ChatRun) => void; focused?: boolean }) => {
  const { requester, title, tooltip } = rowParts(job);
  const note = rowNote(job);
  const pill = rowPill(job, icon);
  const age = ageLabel(job.lastActivityAt, now);
  return (
    <li
      data-job-key={job.key}
      aria-current={focused ? 'true' : undefined}
      className={cx(
        'flex scroll-mt-6 items-center gap-3 py-2.5 pr-2 pl-4 transition-colors duration-150',
        focused && 'bg-selected shadow-[inset_2px_0_0_var(--color-ink)]',
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center" role="img" aria-label={ICON_LABELS[icon]} title={ICON_LABELS[icon]}>{ROW_ICONS[icon]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p title={tooltip} className={cx('truncate text-[13px] leading-5 font-medium', job.title ? 'text-ink' : 'text-muted')}>{title}</p>
        <p className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-faint">
          <span className="shrink-0 text-muted">{requester}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{channelTag(job)}</span>
          {note && (
            <>
              <span aria-hidden>·</span>
              <span className={cx('min-w-0 truncate', icon === 'failed' ? 'text-down' : 'text-muted')} title={note}>{note}</span>
            </>
          )}
          {age && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums" title={new Date(job.lastActivityAt).toLocaleString()}>{age}</span>
            </>
          )}
        </p>
      </div>
      <span className="flex w-28 shrink-0 justify-end">{pill && <Badge tone={pill.tone}>{pill.label}</Badge>}</span>
      {/* One slot per link kind any row in the list has, so an icon stays in its column; a link this job lacks leaves its slot empty. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {kinds.map((kind) => linkButtons(job).find((link) => link.kind === kind)).map((link, index) => (link && (link.url || link.chat) ? (
          <Button
            key={link.kind}
            variant="ghost"
            size="sm"
            className="w-7 px-0!"
            icon={LINK_ICONS[link.kind]}
            title={link.hint}
            aria-label={`${link.label}: ${link.hint}`}
            onClick={() => { if (link.chat) onChat({ ...link.chat, title: job.title }); else if (link.url) open(link.url, onError); }}
          />
        ) : <span key={`empty-${kinds[index]}`} aria-hidden className="w-7" />))}
      </div>
    </li>
  );
};

type Cleanup =
  | { step: 'closed' }
  | { step: 'checking' }
  | { step: 'review'; verdicts: CleanupVerdict[] }
  | { step: 'applying'; verdicts: CleanupVerdict[] }
  | { step: 'error'; message: string };

const VerdictList = ({ verdicts, tone }: { verdicts: CleanupVerdict[]; tone: 'remove' | 'keep' }) => (
  <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-sm">
    {verdicts.map((verdict, index) => (
      <li key={`${verdict.threadId}-${index}`} className="flex flex-col rounded-md bg-raised px-3 py-1.5">
        <span className={cx('font-medium', tone === 'remove' && 'text-down')} title={verdict.path ?? undefined}>{verdictLabel(verdict)}</span>
        <span className="text-xs text-muted">{verdict.reason}</span>
      </li>
    ))}
  </ul>
);

/** Clean up worktrees: always a dry run first, and Remove only lists what that dry run allowed. */
const CleanupDialog = ({ cleanup, onClose, onApply }: { cleanup: Cleanup; onClose: () => void; onApply: () => void }) => {
  const verdicts = cleanup.step === 'review' || cleanup.step === 'applying' ? cleanup.verdicts : [];
  const view = cleanupView(verdicts, false);
  const busy = cleanup.step === 'checking' || cleanup.step === 'applying';
  return (
    <Dialog
      open={cleanup.step !== 'closed'}
      onClose={() => { if (!busy) onClose(); }}
      title="Clean up worktrees"
      description="Clean, pushed worktrees quiet for 3 days with no open PR. Nothing goes until you confirm."
      actions={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="danger"
            disabled={cleanup.step !== 'review' || view.remove.length === 0}
            onClick={onApply}
            icon={cleanup.step === 'applying' ? <LoaderCircle size={14} className="animate-spin" /> : undefined}
          >
            {view.remove.length > 0 ? `Remove ${view.remove.length}` : 'Remove'}
          </Button>
        </>
      )}
    >
      {cleanup.step === 'checking' && (
        <p className="flex items-center gap-2 text-sm text-muted"><LoaderCircle size={14} className="animate-spin" /> Checking each job's worktree…</p>
      )}
      {cleanup.step === 'error' && <p role="alert" className="text-sm text-down">{cleanup.message}</p>}
      {(cleanup.step === 'review' || cleanup.step === 'applying') && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{view.summary}</p>
          {view.remove.length > 0 && <VerdictList verdicts={view.remove} tone="remove" />}
          {view.keep.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">Kept ({view.keep.length})</summary>
              <div className="mt-2"><VerdictList verdicts={view.keep} tone="keep" /></div>
            </details>
          )}
        </div>
      )}
    </Dialog>
  );
};

const ChannelFilter = ({ options, value, onChange }: { options: { value: string; label: string }[]; value: string | null; onChange: (channel: string | null) => void }) => (
  <Select
    aria-label="Channel"
    icon={<Hash size={15} strokeWidth={1.75} />}
    value={value ?? ''}
    options={[{ value: '', label: 'All channels' }, ...options]}
    onChange={(channel) => onChange(channel || null)}
  />
);

/** Each tab's empty state: a title and at most one way forward. */
const EMPTY_STATES: Record<JobGroup, { icon: ReactNode; title: string; start: boolean }> = {
  'needs you': { icon: <CircleCheck size={18} strokeWidth={1.75} className="text-up" />, title: "You're all caught up", start: false },
  running: { icon: <Play size={18} strokeWidth={1.75} />, title: 'Nothing running', start: true },
  done: { icon: <CheckCheck size={18} strokeWidth={1.75} />, title: 'Nothing finished today', start: true },
};

/** The link kinds any row in the list has, in their usual order: each gets a column. */
const linkKinds = (rows: readonly JobRow[]): LinkKind[] => {
  const present = new Set(rows.flatMap((job) => linkButtons(job).filter((link) => link.url || link.chat).map((link) => link.kind)));
  return (['slack', 't3', 'chat', 'pr'] as const).filter((kind) => present.has(kind));
};

/** A quiet empty state: a hairline panel, not the dashed drop-zone look. */
const EMPTY_CLASS = 'border-none bg-transparent py-20';

const PATHS: Record<JobGroup, string> = { 'needs you': '/jobs/needs-you', running: '/jobs/running', done: '/jobs/done' };
const TAB_IDS: Record<JobGroup, string> = { 'needs you': 'jobs-tab-needs-you', running: 'jobs-tab-running', done: 'jobs-tab-done' };

/** Needs you, Running and Done today as tabs: one is shown, each with its count. Arrow keys move between them. */
const JobTabs = ({ sections, group, onPick }: { sections: JobSection[]; group: JobGroup; onPick: (group: JobGroup, focus: boolean) => void }) => {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = sections.findIndex((section) => section.group === group);
    const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = sections[(to + sections.length) % sections.length];
    if (next) onPick(next.group, true);
  };
  return (
    <div role="tablist" aria-label="Jobs by state" onKeyDown={onKeyDown} className="flex items-center gap-0.5 rounded-lg border border-line bg-hover p-0.5">
      {sections.map((section) => {
        const selected = section.group === group;
        const urgent = section.group === 'needs you' && section.rows.length > 0;
        return (
          <button
            key={section.group}
            id={TAB_IDS[section.group]}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="jobs-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onPick(section.group, false)}
            className={cx(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[13px] whitespace-nowrap transition-colors duration-150',
              'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus',
              selected ? 'border-line-strong bg-overlay font-medium text-ink shadow-field' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {section.title}
            <span
              aria-label={`${section.rows.length} ${section.rows.length === 1 ? 'job' : 'jobs'}`}
              className={cx('min-w-4 text-center text-xs tabular-nums', urgent ? 'font-semibold text-warn' : 'text-faint')}
            >
              {section.rows.length}
            </span>
          </button>
        );
      })}
    </div>
  );
};

/** One screen for every Jobs state: `group` is the tab shown. The sidebar's Jobs item opens Needs you. */
export const Jobs = ({ group }: { group: JobGroup }) => {
  const status = useBotStatus();
  const navigate = useNavigate();
  const setup = useSetup();
  // Before setup is done, an empty Needs you isn't good news: say what's missing instead.
  const setupLeft = setup.progress?.next != null;
  const { load, reload } = useJobs(status?.state);
  const now = useNow(30_000);
  const toast = useToast();
  const [channel, setChannel] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<Cleanup>({ step: 'closed' });
  const [chat, setChat] = useState<ChatRun | null>(null);
  const ready = load.state === 'ready';

  // `?job=<key>` (a clicked notification, APP-24) opens that job's tab, marks its row and scrolls to it.
  const [search, setSearch] = useSearchParams();
  const focusedKey = search.get('job');
  useEffect(() => { if (focusedKey) setChannel(null); }, [focusedKey]);

  useEffect(() => {
    if (!ready || !focusedKey) return;
    const job = load.rows.find((row) => row.key === focusedKey);
    if (job && job.group !== group) { void navigate(`${PATHS[job.group]}?job=${encodeURIComponent(focusedKey)}`, { replace: true }); return; }
    const row = [...document.querySelectorAll<HTMLElement>('[data-job-key]')].find((element) => element.dataset.jobKey === focusedKey);
    row?.scrollIntoView({ block: 'center' });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- scroll when the focused job or tab changes, not on every list refresh.
  }, [group, ready, focusedKey]);

  const pick = (next: JobGroup, focus: boolean): void => {
    void navigate(PATHS[next]);
    if (focus) requestAnimationFrame(() => document.getElementById(TAB_IDS[next])?.focus());
  };

  const onLinkError = useCallback((text: string) => toast({ message: text, tone: 'error' }), [toast]);

  const startCleanup = (): void => {
    const bridge = serra();
    if (!bridge) return;
    setCleanup({ step: 'checking' });
    bridge.jobs.cleanupWorktrees({ apply: false }).then(
      (verdicts) => setCleanup((current) => (current.step === 'checking' ? { step: 'review', verdicts } : current)),
      (error: unknown) => setCleanup((current) => (current.step === 'checking' ? { step: 'error', message: message(error) } : current)),
    );
  };

  const applyCleanup = (): void => {
    const bridge = serra();
    if (!bridge || cleanup.step !== 'review') return;
    setCleanup({ step: 'applying', verdicts: cleanup.verdicts });
    bridge.jobs.cleanupWorktrees({ apply: true }).then(
      (verdicts) => {
        const view = cleanupView(verdicts, true);
        setCleanup({ step: 'closed' });
        toast({
          message: view.failed.length ? `${view.summary} ${view.failed.map((v) => `${verdictLabel(v)}: ${v.error ?? 'unknown error'}`).join('; ')}` : view.summary,
          tone: view.failed.length ? 'error' : 'success',
        });
        reload();
      },
      (error: unknown) => setCleanup({ step: 'error', message: message(error) }),
    );
  };

  // `?cleanup=1` (⌘K › Clean up worktrees) opens the same dry run as the button, once. Only the parameter
  // appearing triggers it; the dialog's own steps don't.
  const cleanupAsked = search.get(CLEANUP_PARAM) !== null;
  useEffect(() => {
    if (!cleanupAsked) return;
    setSearch((current) => { const next = new URLSearchParams(current); next.delete(CLEANUP_PARAM); return next; }, { replace: true });
    if (cleanup.step === 'closed') startCleanup();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- only the parameter appearing triggers it; the dialog's own steps must not.
  }, [cleanupAsked]);

  const rows = ready ? load.rows : [];
  const sections = groupJobs(filterJobs(rows, channel));
  const current = sections.find((section) => section.group === group) ?? sections[0]!;
  const empty = EMPTY_STATES[group];

  return (
    <div data-screen-label="Jobs">
      <Page
        title="Jobs"
        titleAside={ready ? <JobTabs sections={sections} group={group} onPick={pick} /> : undefined}
        actions={(
          <>
            <ChannelFilter
              // Named Slack channels carry the # as an icon, so the button reads "# eng" whichever is picked.
              options={channelChoices(rows, channel).map((option) => (rows.some((job) => job.channel === option.value && job.channelName) && option.value !== 'app'
                ? { ...option, label: option.label.replace(/^#/, ''), icon: <Hash size={14} strokeWidth={1.75} /> }
                : option))}
              value={channel}
              onChange={setChannel}
            />
            <Button icon={<BrushCleaning size={14} strokeWidth={1.75} />} aria-label="Clean up worktrees" title="Clean up worktrees" onClick={startCleanup}>Clean up</Button>
          </>
        )}
      >
        {status?.state === 'stopped' && (
          <p className="-mt-2 flex items-start gap-2 text-[13px] leading-5 text-muted">
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-down" aria-hidden />
            Bot is stopped. Showing saved jobs.
          </p>
        )}
        {load.state === 'loading' && <p className="flex items-center gap-2 text-sm text-muted"><LoaderCircle size={14} className="animate-spin" /> Loading jobs…</p>}
        {load.state === 'error' && (
          <div role="alert" className="flex items-center justify-between gap-4 rounded-lg border border-down/40 px-3 py-2 text-sm text-down">
            <span>{load.message}</span>
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={reload}>Retry</Button>
          </div>
        )}
        {ready && (
          <div className="flex flex-col gap-4">
            <div
              id="jobs-panel"
              role="tabpanel"
              aria-labelledby={TAB_IDS[current.group]}
              // The panel takes focus itself, so Tab from the tabs always reaches it, even when its rows have no
              // enabled link to land on.
              tabIndex={0}
              className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {current.rows.length === 0
                ? (channel
                  ? (
                    <EmptyState className={EMPTY_CLASS} icon={<Radio size={16} strokeWidth={1.75} />} title={`Nothing here in ${channelChoices(rows, channel).find((c) => c.value === channel)?.label ?? 'this channel'}`} action={<Button size="sm" onClick={() => setChannel(null)}>Show all channels</Button>} />
                  )
                  : setupLeft && current.group === 'needs you'
                  ? (
                    <EmptyState
                      className={EMPTY_CLASS}
                      icon={<ListChecks size={18} strokeWidth={1.75} />}
                      title="Finish setup to get requests"
                      action={<Button size="sm" onClick={() => void navigate(resumePath(setup.progress))}>Continue setup</Button>}
                    />
                  )
                  : (
                    <EmptyState
                      className={EMPTY_CLASS}
                      icon={empty.icon}
                      title={empty.title}
                      action={empty.start ? <Button size="sm" icon={<Plus size={14} />} onClick={() => void navigate('/jobs/new')}>New task</Button> : undefined}
                    />
                  ))
                : (
                  <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {current.rows.map((job) => <JobRowView key={job.key} job={job} icon={rowIcon(job, status)} now={now} kinds={linkKinds(current.rows)} onError={onLinkError} onChat={setChat} focused={job.key === focusedKey} />)}
                  </ul>
                )}
            </div>
          </div>
        )}
        <CleanupDialog cleanup={cleanup} onClose={() => setCleanup({ step: 'closed' })} onApply={applyCleanup} />
        <RunChat run={chat} onClose={() => setChat(null)} />
      </Page>
    </div>
  );
};
