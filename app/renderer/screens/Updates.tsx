// Settings → Updates (APP-19): the active and prepared releases, the commits on main the active one lacks, and
// Prepare, Activate and Roll back with the log streamed in. Activate and Roll back ask first and name the running
// jobs. Everything goes through files, git and launchd in the main process, so it works while the bot is stopped.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GitCommitHorizontal, Layers, LoaderCircle, Play, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';
import { serra } from '../bridge.ts';
import { Button, cx, Dialog, Page, useToast } from '../ui/index.ts';
import {
  actionStates, activateDialog, activationNotice, busyLabel, commitsHeading, preparedLabel, releaseLabel, rollbackDialog, sourceLabel,
  rollbackNotice, type Notice, type UpdateAction, type UpdatesStatus,
} from './updates.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ReleaseRow = ({ label, release, empty }: { label: string; release: UpdatesStatus['active']; empty: string }) => (
  <div className="flex items-baseline gap-6 border-t border-line px-4 py-3 first:border-t-0">
    <span className="w-36 shrink-0 text-muted">{label}</span>
    {release
      ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <span className="font-mono font-semibold" title={release.release}>{releaseLabel(release)}</span>
          <span className="text-sm text-muted">{preparedLabel(release)}</span>
        </span>
      )
      : <span className="text-muted">{empty}</span>}
  </div>
);

const LogPanel = ({ lines, running }: { lines: string[]; running: UpdateAction | null }) => {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);
  if (!lines.length && !running) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Log">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        Log
        {running && <span className="flex items-center gap-1.5 text-sm font-normal text-muted"><LoaderCircle size={14} className="animate-spin" aria-hidden />{busyLabel(running)}</span>}
      </h2>
      <pre
        ref={ref}
        aria-live="polite"
        className="max-h-72 overflow-auto rounded-lg border border-line bg-panel px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink"
      >
        {lines.join('\n') || ' '}
      </pre>
    </section>
  );
};

type Confirm = { action: 'activate' | 'rollback'; jobs: number } | null;

export const Updates = () => {
  const toast = useToast();
  const [status, setStatus] = useState<UpdatesStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState<UpdateAction | null>(null);
  const [fetching, setFetching] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = useCallback(async (fetch = false): Promise<UpdatesStatus | null> => {
    const bridge = serra();
    if (!bridge) { setLoadError('Open this screen in the Serra app to manage updates.'); return null; }
    try {
      const next = await bridge.updates.status({ fetch });
      setStatus(next);
      setRunning(next.running);
      // The main process keeps the log of the running or last action; take it when coming back to the screen.
      setLines((seen) => (next.running || !seen.length ? next.log : seen));
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(message(error));
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
    const bridge = serra();
    if (!bridge) return;
    const offLog = bridge.on.releaseLog((line) => setLines((seen) => [...seen, line]));
    const refresh = () => { void reload(); };
    window.addEventListener('focus', refresh);
    return () => { offLog(); window.removeEventListener('focus', refresh); };
  }, [reload]);

  const fetchCommits = async () => {
    setFetching(true);
    const next = await reload(true);
    setFetching(false);
    if (next?.commitsProblem) toast({ message: next.commitsProblem, tone: 'error' });
  };

  const prepare = async () => {
    const bridge = serra();
    if (!bridge) return;
    setNotice(null);
    setLines([]);
    setRunning('prepare');
    try {
      const prepared = await bridge.updates.prepare();
      toast({ message: `Prepared ${releaseLabel(prepared)}. The live bot is unchanged until you activate it.`, tone: 'success' });
    } catch (error) {
      setNotice({ tone: 'error', message: `Prepare failed. ${message(error)}`, offerRollback: false });
    }
    await reload();
  };

  /** Opens the confirm dialog with the jobs running now, read fresh so the count is current. */
  const ask = async (action: 'activate' | 'rollback') => {
    const bridge = serra();
    if (!bridge) return;
    try {
      const jobs = await bridge.updates.runningJobs();
      setConfirm({ action, jobs: jobs.length });
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    }
  };

  const run = async (action: 'activate' | 'rollback') => {
    const bridge = serra();
    if (!bridge) return;
    setConfirm(null);
    setNotice(null);
    setLines([]);
    setRunning(action);
    try {
      if (action === 'activate') {
        const outcome = await bridge.updates.activate();
        const next = await reload();
        setNotice(activationNotice(outcome, next?.active ?? null));
      } else {
        const outcome = await bridge.updates.rollback();
        const next = await reload();
        setNotice(rollbackNotice(outcome, next?.active ?? null));
      }
    } catch (error) {
      setNotice({ tone: 'error', message: message(error), offerRollback: false });
      await reload();
    }
  };

  if (loadError && !status) {
    return <Page title="Updates"><p className="text-sm text-down">{loadError}</p></Page>;
  }
  if (!status) return <Page title="Updates"><p className="text-sm text-muted">Loading…</p></Page>;

  const states = actionStates({ ...status, running });
  const dialog = confirm?.action === 'activate'
    ? activateDialog(status.prepared, confirm.jobs)
    : confirm ? rollbackDialog(confirm.jobs) : null;

  return (
    <Page
      title="Updates"
      actions={(
        <Button variant="ghost" icon={<RefreshCw size={16} className={cx(fetching && 'animate-spin')} />} disabled={fetching} onClick={() => void fetchCommits()}>
          Check for commits
        </Button>
      )}
    >
      <div className="rounded-lg border border-line bg-panel">
        <ReleaseRow label="Active release" release={status.active} empty="None yet" />
        <ReleaseRow label="Prepared release" release={status.prepared} empty="None. Prepare one from the latest code." />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button icon={<Layers size={16} />} disabled={!states.prepare.enabled} title={states.prepare.reason} onClick={() => void prepare()}>Prepare</Button>
        <Button icon={<Play size={16} />} disabled={!states.activate.enabled} title={states.activate.reason} onClick={() => void ask('activate')}>Activate</Button>
        <Button icon={<RotateCcw size={16} />} disabled={!states.rollback.enabled} title={states.rollback.reason} onClick={() => void ask('rollback')}>Roll back</Button>
        {!running && status.prepared && states.activate.reason && (
          <span className="text-sm text-muted">{states.activate.reason}</span>
        )}
      </div>

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={cx(
            'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
            notice.tone === 'error' ? 'border-down/50 bg-down/10' : 'border-up/50 bg-up/10',
          )}
        >
          {notice.tone === 'error' && <TriangleAlert size={16} className="mt-0.5 shrink-0 text-down" aria-hidden />}
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{notice.message}</span>
          {notice.offerRollback && states.rollback.enabled && (
            <Button size="sm" variant="danger" icon={<RotateCcw size={14} />} onClick={() => void ask('rollback')}>Roll back</Button>
          )}
        </div>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{commitsHeading(status)}</h2>
        <p className="break-all text-xs text-muted">{sourceLabel(status)}</p>
        {status.commitsProblem
          ? <p className="text-sm text-muted">{status.commitsProblem}</p>
          : status.newCommits.length > 0 && (
            <ul className="overflow-hidden rounded-lg border border-line bg-panel">
              {status.newCommits.map((commit) => (
                <li key={commit.sha} className="flex items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
                  <GitCommitHorizontal size={16} className="shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                  <span className="font-mono text-xs text-muted">{commit.sha.slice(0, 7)}</span>
                </li>
              ))}
            </ul>
          )}
      </section>

      <LogPanel lines={lines} running={running} />

      <Dialog
        open={dialog !== null}
        onClose={() => setConfirm(null)}
        title={dialog?.title ?? ''}
        description={dialog?.body}
        actions={(
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant={confirm?.action === 'rollback' ? 'danger' : 'primary'}
              onClick={() => { if (confirm) void run(confirm.action); }}
            >
              {confirm?.action === 'rollback' ? 'Roll back' : 'Activate'}
            </Button>
          </>
        )}
      />
    </Page>
  );
};
