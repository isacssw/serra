// Settings → Updates (APP-19, SERRA-46). The app card: the installed version, a newer release from GitHub with its
// notes, the download and Restart to update. Under it, the bot: in release mode it follows the app's version on its own;
// in developer mode (Settings › Worker › Developer: update from a checkout) the owner builds from a checkout and switches by hand.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowDownToLine, CircleCheck, ExternalLink, GitBranch, GitCommitHorizontal, Hammer, Info, LoaderCircle, Play, RefreshCw,
  RotateCw, TriangleAlert, Undo2,
} from 'lucide-react';
import { serra } from '../bridge.ts';
import { WELCOME_PATH } from './Welcome/welcome.logic.ts';
import { Button, cx, Dialog, Page, useToast } from '../ui/index.ts';
import {
  actionStates, activateDialog, keepVersions, activationNotice, appCard, botLine, branch, busyLabel, canCheck, commitsHeading, homeOf, noteLines,
  preparedLabel, progressPercent, releaseLabel, rollbackDialog, rollbackNotice, sourceLabel, syncDialog,
  type AppCard, type CardAction, type CardTone, type Notice, type UpdatesStatus,
} from './updates.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ToneIcon = ({ tone, size = 18 }: { tone: CardTone; size?: number }) => {
  const props = { size, 'aria-hidden': true, className: 'shrink-0' } as const;
  switch (tone) {
    case 'up': return <CircleCheck {...props} className="shrink-0 text-up" />;
    case 'busy': return <LoaderCircle {...props} className="shrink-0 animate-spin text-muted" />;
    case 'new': return <ArrowDownToLine {...props} className="shrink-0 text-ink" />;
    case 'down': return <TriangleAlert {...props} className="shrink-0 text-down" />;
    default: return <Info {...props} className="shrink-0 text-muted" />;
  }
};

const Notes = ({ markdown }: { markdown: string }) => {
  const lines = noteLines(markdown);
  if (!lines.length) return null;
  return (
    <section aria-label="What's new" className="flex flex-col gap-1.5 border-t border-line pt-3">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">What's new</h3>
      <div tabIndex={0} className="max-h-56 overflow-auto rounded-md pr-2 text-[13px] leading-relaxed focus-visible:outline-2 focus-visible:outline-focus">
        <ul className="flex flex-col gap-1">
          {lines.map((line, index) => line.kind === 'item'
            ? <li key={index} className="ml-4 list-disc">{line.text}</li>
            : <li key={index} className={cx('list-none', line.kind === 'heading' && 'pt-1 font-medium')}>{line.text}</li>)}
        </ul>
      </div>
    </section>
  );
};

const Progress = ({ percent }: { percent: number | null }) => (
  <div
    role="progressbar"
    aria-label="Download progress"
    aria-valuemin={0}
    aria-valuemax={100}
    {...(percent === null ? {} : { 'aria-valuenow': percent })}
    className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
  >
    <div className={cx('h-full rounded-full bg-ink transition-[width] duration-300', percent === null && 'w-1/3 animate-pulse')} style={percent === null ? undefined : { width: `${percent}%` }} />
  </div>
);

const CARD_ICONS: Record<CardAction, ReactNode> = {
  check: <RefreshCw size={16} aria-hidden />,
  download: <ArrowDownToLine size={16} aria-hidden />,
  cancel: null,
  install: <RotateCw size={16} aria-hidden />,
  openInstaller: <ExternalLink size={16} aria-hidden />,
};

const AppUpdateCard = ({ status, card, onAction, onLink, children }: {
  status: NonNullable<UpdatesStatus['app']>; card: AppCard; onAction: (action: CardAction) => void; onLink: (url: string) => void; children?: ReactNode;
}) => {
  const notes = status.state === 'available' || status.state === 'ready' ? status.release.notes : '';
  // The button just used (Download, Cancel) goes away with the state: keep keyboard focus in the card.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) heading.current?.focus();
  }, [status.state]);
  return (
    <section aria-labelledby="app-update-title" className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5"><ToneIcon tone={card.tone} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
            <h2 id="app-update-title" ref={heading} tabIndex={-1} className="text-[15px] font-semibold outline-none">{keepVersions(card.title)}</h2>
            {card.meta && <span className="text-xs text-muted">{keepVersions(card.meta)}</span>}
          </div>
          {card.body && <p className={cx('text-[13px]', card.tone === 'down' ? 'text-ink' : 'text-muted')}>{keepVersions(card.body)}</p>}
        </div>
      </div>
      {status.state === 'downloading' && <Progress percent={progressPercent(status.received, status.total)} />}
      {notes && <Notes markdown={notes} />}
      {(card.primary || card.secondary || card.link) && (
        <div className="flex flex-wrap items-center gap-2">
          {card.primary && <Button variant="primary" icon={CARD_ICONS[card.primary.action]} onClick={() => onAction(card.primary!.action)}>{card.primary.label}</Button>}
          {card.secondary && <Button icon={CARD_ICONS[card.secondary.action]} onClick={() => onAction(card.secondary!.action)}>{card.secondary.label}</Button>}
          {card.link && (
            <Button variant="ghost" icon={<ExternalLink size={14} aria-hidden />} onClick={() => onLink(card.link!)}>
              Release on GitHub
            </Button>
          )}
        </div>
      )}
      {children}
    </section>
  );
};

/** The bot's line under the app: whether it runs the app's version, and what happens next. */
const BotSection = ({ bot, onAction, log }: { bot: NonNullable<ReturnType<typeof botLine>>; onAction: () => void; log: ReactNode }) => (
  <div className="flex flex-col gap-2 border-t border-line pt-3">
    <div className="flex items-start gap-3">
      <span className="mt-px"><ToneIcon tone={bot.tone} size={16} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="text-[13px] font-medium">{keepVersions(bot.text)}</h3>
        {bot.detail && <p className={cx('text-[13px] break-words', bot.tone === 'down' ? 'text-ink' : 'text-muted')}>{keepVersions(bot.detail)}</p>}
      </div>
      {bot.action && (
        <Button
          size="sm"
          icon={bot.action.kind === 'rollback' ? <Undo2 size={14} aria-hidden /> : bot.action.kind === 'sync' ? <RefreshCw size={14} aria-hidden /> : undefined}
          onClick={onAction}
        >
          {bot.action.label}
        </Button>
      )}
    </div>
    {log}
  </div>
);

const LogPanel = ({ lines, running, open, onToggle }: { lines: string[]; running: UpdatesStatus['running']; open: boolean; onToggle: (open: boolean) => void }) => {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, open]);
  if (!lines.length && !running) return null;
  return (
    <details open={open} onToggle={(event) => onToggle(event.currentTarget.open)} className="group flex flex-col gap-2">
      <summary className="w-fit cursor-pointer rounded text-[13px] text-muted select-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {open ? 'Hide details' : 'Show details'}
        {running && <span className="ml-2 inline-flex items-center gap-1.5"><LoaderCircle size={12} className="animate-spin" aria-hidden />{busyLabel(running)}</span>}
      </summary>
      <pre
        ref={ref}
        aria-label="Details"
        tabIndex={0}
        className="mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-panel px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink focus-visible:outline-2 focus-visible:outline-focus"
      >
        {lines.join('\n') || ' '}
      </pre>
    </details>
  );
};

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-line px-4 py-3 first:border-t-0">
    <span className="w-32 shrink-0 text-[13px] text-muted">{label}</span>
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">{children}</span>
  </div>
);

type Confirm = { action: 'activate' | 'rollback' | 'sync'; jobs: number } | null;

export const Updates = () => {
  const toast = useToast();
  const navigate = useNavigate();
  const [status, setStatus] = useState<UpdatesStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState<UpdatesStatus['running']>(null);
  const [fetching, setFetching] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [details, setDetails] = useState(false);

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
    const offApp = bridge.on.appUpdate((app) => setStatus((current) => (current ? { ...current, app } : current)));
    // The bot started or stopped (menu bar, launchd): reread, at most every two seconds.
    // The last change in a burst (stopping → stopped) is read too, once the two seconds are over.
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const offStatus = bridge.on.status(() => {
      const now = Date.now();
      if (now - last > 2000) { last = now; void reload(); return; }
      trailing ??= setTimeout(() => { trailing = null; last = Date.now(); void reload(); }, 2000 - (now - last));
    });
    const refresh = () => { void reload(); };
    window.addEventListener('focus', refresh);
    return () => { offLog(); offApp(); offStatus(); if (trailing) clearTimeout(trailing); window.removeEventListener('focus', refresh); };
  }, [reload]);

  // While the bot is updating or waiting for jobs, follow it.
  const botBusy = status?.bot.state === 'updating' || status?.bot.state === 'waiting' || running !== null;
  useEffect(() => {
    if (!botBusy) return;
    const timer = setInterval(() => { void reload(); }, 3000);
    return () => clearInterval(timer);
  }, [botBusy, reload]);

  const openLink = (url: string) => {
    serra()?.app.openExternal(url).catch((error: unknown) => toast({ message: message(error), tone: 'error' }));
  };

  const appAction = async (action: CardAction) => {
    const bridge = serra();
    if (!bridge) return;
    try {
      const call = {
        check: bridge.updates.check, download: bridge.updates.download, cancel: bridge.updates.cancelDownload,
        install: bridge.updates.install, openInstaller: bridge.updates.openInstaller,
      }[action];
      const app = await call();
      setStatus((current) => (current ? { ...current, app } : current));
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    }
  };

  const setPrereleases = async (on: boolean) => {
    const bridge = serra();
    if (!bridge || !status?.app) return;
    // Back to the default when the choice matches it, so a later stable version turns them off again.
    const fallback = status.app.prereleases.byDefault;
    try {
      const app = await bridge.updates.setPrereleases(on === fallback ? null : on);
      setStatus((current) => (current ? { ...current, app } : current));
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    }
  };

  const fetchCommits = async () => {
    setFetching(true);
    await reload(true);
    setFetching(false);
  };

  const prepare = async () => {
    const bridge = serra();
    if (!bridge) return;
    setNotice(null);
    setLines([]);
    setRunning('prepare');
    setDetails(true);
    try {
      const prepared = await bridge.updates.prepare();
      toast({ message: `Built ${releaseLabel(prepared)}. The bot keeps running its current build until you restart it.`, tone: 'success' });
    } catch (error) {
      setNotice({ tone: 'error', message: `The build failed. ${message(error)}`, offerRollback: false });
    }
    await reload();
  };

  /** Opens the confirm dialog with the jobs running now, read fresh so the count is current. */
  const ask = async (action: 'activate' | 'rollback' | 'sync') => {
    const bridge = serra();
    if (!bridge) return;
    try {
      const jobs = await bridge.updates.runningJobs();
      setConfirm({ action, jobs: jobs.length });
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    }
  };

  const run = async (action: 'activate' | 'rollback' | 'sync') => {
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
        setNotice(activationNotice(outcome, next?.releases?.active ?? null));
      } else if (action === 'rollback') {
        const outcome = await bridge.updates.rollback();
        const next = await reload();
        setNotice(rollbackNotice(outcome, next?.releases?.active ?? null));
      } else {
        await bridge.updates.syncBot();
        await reload();
      }
    } catch (error) {
      setNotice({ tone: 'error', message: message(error), offerRollback: false });
      await reload();
    }
  };

  if (loadError && !status) {
    return <Page title="Updates"><p className="text-sm text-down" role="alert">{loadError}</p></Page>;
  }
  if (!status) return <Page title="Updates"><p className="text-sm text-muted">Loading…</p></Page>;

  const releases = status.releases;
  const developer = releases?.mode === 'developer';
  const home = homeOf(releases?.source ?? null);
  const app = status.app && status.app.state !== 'unavailable' ? status.app : null;
  const card = app ? appCard(app) : null;
  const bot = botLine(status.bot);
  const syncTarget = ('to' in status.bot ? status.bot.to : null) ?? status.appVersion;
  const dialog = confirm?.action === 'activate'
    ? activateDialog(releases?.prepared ?? null, confirm.jobs)
    : confirm?.action === 'rollback' ? rollbackDialog(confirm.jobs, developer ? 'build' : 'version')
    : confirm ? syncDialog(syncTarget, confirm.jobs, {
      stopped: status.bot.state === 'stopped' || (status.bot.state === 'failed' && status.bot.stopped),
      // A move back to an older version says so, whatever state offered it.
      older: status.bot.state === 'ahead' || ((status.bot.state === 'stopped' || status.bot.state === 'failed') && status.bot.downgrade)
        ? status.bot.from : null,
    }) : null;

  const noticeBox = notice && (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={cx('flex items-start gap-3 rounded-lg border px-4 py-3 text-[13px]', notice.tone === 'error' ? 'border-down/50 bg-down/10' : 'border-up/50 bg-up/10')}
    >
      {notice.tone === 'error' ? <TriangleAlert size={16} className="mt-0.5 shrink-0 text-down" aria-hidden /> : <CircleCheck size={16} className="mt-0.5 shrink-0 text-up" aria-hidden />}
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{notice.message}</span>
      {notice.offerRollback && releases?.canRollback && (
        <Button size="sm" variant="danger" icon={<Undo2 size={14} aria-hidden />} onClick={() => void ask('rollback')}>Undo last switch</Button>
      )}
    </div>
  );

  return (
    <Page
      title="Updates"
      subtitle={developer && releases ? (
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <GitBranch size={13} aria-hidden className="self-center" />
          Developer mode · bot built from {sourceLabel(releases, home)} ·
          <button type="button" className="rounded underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus" onClick={() => void navigate('/settings/worker')}>
            Change
          </button>
        </span>
      ) : undefined}
      actions={(
        <>
          {app && (
            <Button variant="ghost" icon={<RefreshCw size={16} aria-hidden className={cx(app.state === 'checking' && 'animate-spin')} />} disabled={!canCheck(app)} onClick={() => void appAction('check')}>
              Check for updates
            </Button>
          )}
        </>
      )}
    >
      {/* One short line for screen readers when the state changes; the details stay on demand. */}
      <p aria-live="polite" className="sr-only">{[card?.title, app?.state === 'downloading' ? '' : card?.body, bot?.text, bot?.tone === 'down' || bot?.action ? bot.detail : ''].filter(Boolean).map((part) => part!.replace(/\.$/, '')).join('. ')}</p>
      {status.app?.updatedFrom && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
          <CircleCheck size={16} aria-hidden className="text-up" />
          {keepVersions(`Updated from ${status.app.updatedFrom} to ${status.app.current}.`)}
        </p>
      )}

      {(() => {
        const botAction = () => {
          if (!bot?.action) return;
          if (bot.action.kind === 'setup') void navigate(WELCOME_PATH);
          else if (bot.action.kind === 'rollback') void ask('rollback');
          else void ask('sync');
        };
        const botSection = !developer && bot
          ? <BotSection bot={bot} onAction={botAction} log={<LogPanel lines={lines} running={running} open={details} onToggle={setDetails} />} />
          : null;
        if (app && card) return <AppUpdateCard status={app} card={card} onAction={(action) => void appAction(action)} onLink={openLink}>{botSection}</AppUpdateCard>;
        if (developer) return null;
        return (
          <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5"><Info size={18} aria-hidden className="text-muted" /></span>
              <div className="flex flex-col gap-1">
                <h2 className="text-[15px] font-semibold">Serra {status.appVersion}</h2>
                <p className="text-[13px] text-muted">{status.app?.state === 'unavailable' ? status.app.reason : 'Updates are available in the Serra app.'}</p>
              </div>
            </div>
            {botSection}
          </section>
        );
      })()}
      {app && (
        <label className="flex w-fit cursor-pointer items-start gap-2.5 text-[13px]">
          <input
            type="checkbox"
            className="mt-0.5 size-4 cursor-pointer accent-[var(--color-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            checked={app.prereleases.on}
            disabled={app.state === 'installing' || app.state === 'verifying'}
            onChange={(event) => void setPrereleases(event.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span>Include pre-releases</span>
            <span className="text-xs text-muted">Alpha and beta versions. On by default while you're on one.</span>
          </span>
        </label>
      )}
      {!developer && noticeBox}

      {developer && releases && <DeveloperMode
        releases={releases}
        running={running}
        lines={lines}
        details={details}
        setDetails={setDetails}
        notice={noticeBox}
        fetching={fetching}
        onFetch={() => void fetchCommits()}
        onPrepare={() => void prepare()}
        onAsk={(action) => void ask(action)}
      />}


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
              {confirm?.action === 'rollback' ? 'Undo' : confirm?.action === 'sync' ? 'Update now' : 'Restart bot'}
            </Button>
          </>
        )}
      />
    </Page>
  );
};

const DeveloperMode = ({ releases, running, lines, details, setDetails, notice, fetching, onFetch, onPrepare, onAsk }: {
  fetching: boolean;
  onFetch: () => void;
  releases: NonNullable<UpdatesStatus['releases']>;
  running: UpdatesStatus['running'];
  lines: string[];
  details: boolean;
  setDetails: (open: boolean) => void;
  notice: ReactNode;
  onPrepare: () => void;
  onAsk: (action: 'activate' | 'rollback') => void;
}) => {
  const states = actionStates({ ...releases, running });
  return (
    <>
      <div className="rounded-lg border border-line bg-panel" role="group" aria-label="Bot builds">
        <Row label="Bot runs">
          {releases.active
            ? <><span className="font-mono text-[13px] font-semibold">{releaseLabel(releases.active)}</span><span className="text-xs text-muted">{preparedLabel(releases.active)}</span></>
            : <span className="text-[13px] text-muted">Nothing yet</span>}
        </Row>
        <Row label="Built, not running">
          {releases.prepared
            ? <><span className="font-mono text-[13px] font-semibold">{releaseLabel(releases.prepared)}</span><span className="text-xs text-muted">{preparedLabel(releases.prepared)}</span></>
            : <span className="text-[13px] text-muted">Nothing. Build from the checkout to try new commits.</span>}
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button icon={<Hammer size={16} aria-hidden />} disabled={!states.prepare.enabled} title={states.prepare.reason} onClick={onPrepare}>Build from checkout</Button>
        <Button icon={<Play size={16} aria-hidden />} disabled={!states.activate.enabled} title={states.activate.reason} onClick={() => onAsk('activate')}>Restart bot on it</Button>
        {releases.canRollback && (
          <Button variant="ghost" icon={<Undo2 size={16} aria-hidden />} disabled={!states.rollback.enabled} title={states.rollback.reason} onClick={() => onAsk('rollback')}>Undo last switch</Button>
        )}
        {!running && releases.prepared && states.activate.reason && <span className="text-[13px] text-muted">{states.activate.reason}</span>}
      </div>

      {notice}

      <section className="flex flex-col gap-2" aria-labelledby="commits-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="commits-title" className="text-[15px] font-semibold">{commitsHeading(releases)}</h2>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden className={cx(fetching && 'animate-spin')} />} disabled={fetching} onClick={onFetch}>
            Fetch commits
          </Button>
        </div>
        {releases.commitsProblem
          ? <p className="text-[13px] text-muted">{releases.commitsProblem}</p>
          : releases.newCommits.length > 0 && (
            <ul className="overflow-hidden rounded-lg border border-line bg-panel">
              {releases.newCommits.map((commit) => (
                <li key={commit.sha} className="flex items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
                  <GitCommitHorizontal size={16} className="shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{commit.subject}</span>
                  <span className="font-mono text-xs text-muted">{commit.sha.slice(0, 7)}</span>
                </li>
              ))}
            </ul>
          )}
      </section>

      <LogPanel lines={lines} running={running} open={details} onToggle={setDetails} />
    </>
  );
};
