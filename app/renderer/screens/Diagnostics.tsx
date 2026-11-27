// Diagnostics (APP-22): `diagnose()` for the profile, rerun on demand and when the daemon starts, stops, restarts
// or its Slack connection changes, plus the tail of the daemon's log. Token values never reach this window: main
// scrubs every detail and log line first.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Copy, ListChecks, RefreshCw, Stethoscope } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { Diagnostic } from '../../../src/contracts.ts';
import type { AppInfo } from '../../main/bridge.ts';
import { serra } from '../bridge.ts';
import { useBotStatus } from '../shell/live.ts';
import { Button, cx, Page, Select, useToast } from '../ui/index.ts';
import { SETUP_PATH } from '../setup/setup.logic.ts';
import {
  DEFAULT_LOG_LINES, explainFailure, LOG_LINE_CHOICES, orderChecks, passValue, reportText, runtimeLine, sharedCauses, statusKey, summarize, tildePaths,
} from './diagnostics.logic.ts';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One check: a passing one is a quiet line, a failing one leads with its name and keeps the reason readable. */
const CheckRow = ({ result, home, sameAs, onOpen }: { result: Diagnostic; home: string | undefined; sameAs?: string; onOpen: (path: string) => void }) => {
  const detail = tildePaths(result.detail, home);
  const failure = result.ok ? null : sameAs ? { reason: `Same cause as ${sameAs}`, raw: null } : explainFailure(detail);
  const value = passValue(detail);
  const [open, setOpen] = useState(false);
  const rawId = useId();
  return (
    <li className={cx('flex items-start gap-3 px-4', result.ok ? 'py-2.5' : 'py-3')} data-check={result.name} data-check-ok={result.ok}>
      {result.ok
        ? <CircleCheck size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-up" aria-label="Passes" />
        : <CircleAlert size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-down" aria-label="Fails" />}
      <div className={cx('flex min-w-0 flex-1 gap-x-4 gap-y-0.5', result.ok ? 'flex-wrap items-baseline' : 'flex-col')}>
        <span className="w-44 shrink-0 text-[13px] font-medium">{result.name}</span>
        {failure ? (
          <span className="flex min-w-0 flex-col items-start gap-1.5">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] text-ink">
              <span className="break-words">{failure.reason}</span>
              {failure.raw && (
                <button
                  type="button" aria-expanded={open} aria-controls={rawId} onClick={() => setOpen(!open)}
                  className="rounded text-xs text-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {open ? 'Hide details' : 'Details'}
                </button>
              )}
            </span>
            {failure.raw && open && <code id={rawId} className="block w-full rounded-lg border border-line-subtle bg-field px-2.5 py-1.5 font-mono text-[11px] leading-4 break-words whitespace-pre-wrap text-muted">{failure.raw}</code>}
          </span>
        ) : (
          <span className={cx('min-w-0 flex-1 truncate text-muted', /^[~/]/.test(value) ? 'font-mono text-xs' : 'text-[13px]')} title={detail}>{value}</span>
        )}
      </div>
      {failure && 'action' in failure && failure.action && (
        <Button size="sm" className="shrink-0" onClick={() => onOpen(failure.action!.path)}>{failure.action.label}</Button>
      )}
    </li>
  );
};

/** Rows that hold the list's shape while the first run goes. */
const Skeleton = () => (
  <ul aria-hidden className="flex flex-col divide-y divide-line-subtle">
    {[44, 60, 36, 52, 40, 56].map((width, index) => (
      <li key={index} className="flex items-center gap-3 px-4 py-3">
        <span className="size-4 shrink-0 rounded-full bg-raised" />
        <span className="h-3 w-40 rounded bg-raised motion-safe:animate-pulse" />
        <span className="h-3 rounded bg-raised motion-safe:animate-pulse" style={{ width: `${width}%` }} />
      </li>
    ))}
  </ul>
);

/** Runs `diagnose()` once at a time. A request while a run is going queues one more run after it. */
const useChecks = () => {
  const [results, setResults] = useState<Diagnostic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const run = useCallback(async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) { setError('The Serra bridge is not available in this window.'); return; }
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    setRunning(true);
    try {
      do {
        again.current = false;
        try {
          const next = await bridge.diagnostics.run();
          if (!live.current) return;
          setResults(next); setError(null); setCheckedAt(new Date());
        } catch (failure) { if (live.current) setError(errorText(failure)); }
      } while (again.current && live.current);
    } finally {
      busy.current = false;
      if (live.current) setRunning(false);
    }
  }, []);
  return { results, error, running, checkedAt, run };
};

const useLogTail = (lines: number) => {
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const bridge = serra();
    if (!bridge) return;
    try { setLog(await bridge.diagnostics.logTail(lines)); setError(null); }
    catch (failure) { setError(errorText(failure)); }
  }, [lines]);
  return { log, error, reload };
};

export const Diagnostics = () => {
  const toast = useToast();
  const status = useBotStatus();
  const key = statusKey(status);
  const checks = useChecks();
  const [lines, setLines] = useState<number>(DEFAULT_LOG_LINES);
  const tail = useLogTail(lines);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const logBox = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void serra()?.app.info().then(setInfo, () => {});
  }, []);

  // Checks run on open, and again whenever the daemon starts, stops, restarts or its Slack connection changes.
  // The first status report after open isn't a change, so it doesn't run them twice.
  const { run } = checks;
  const reloadLog = tail.reload;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastKey.current;
    lastKey.current = key;
    if (previous === null || previous !== 'unknown') void run();
  }, [key, run]);
  // The log follows the same changes, and the line count.
  useEffect(() => { void reloadLog(); }, [key, reloadLog]);

  // Keep the newest log line in view.
  useEffect(() => {
    const box = logBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [tail.log]);

  const refresh = () => { void run(); void reloadLog(); };

  const copy = async () => {
    if (!checks.results) return;
    try {
      await navigator.clipboard.writeText(reportText({ results: checks.results, checkedAt: checks.checkedAt, info, log: tail.log ?? [] }));
      toast({ message: 'Report copied', tone: 'success' });
    } catch (failure) { toast({ message: `Could not copy: ${errorText(failure)}`, tone: 'error' }); }
  };

  const summary = checks.results ? summarize(checks.results) : null;
  const shared = sharedCauses(summary?.failing ?? []);
  const navigate = useNavigate();

  return (
    <Page
      title="Diagnostics"
      actions={(
        <>
          <Button variant="ghost" icon={<ListChecks size={14} aria-hidden />} onClick={() => void navigate(SETUP_PATH)} title="Profile, Slack, owner and service, step by step">Setup</Button>
          <Button icon={<Copy size={14} aria-hidden />} onClick={() => void copy()} disabled={!checks.results}>Copy report</Button>
          <Button variant="primary" icon={<RefreshCw size={14} aria-hidden className={cx(checks.running && 'animate-spin')} />} onClick={refresh} disabled={checks.running}>
            {checks.running ? 'Checking…' : 'Run checks'}
          </Button>
        </>
      )}
    >
      {checks.error && (
        <div role="alert" className="flex items-center gap-3 rounded-xl border border-down/40 bg-down/8 px-4 py-3 text-[13px] text-down">
          <CircleAlert size={16} aria-hidden />
          <span className="flex-1">{checks.error}</span>
        </div>
      )}

      {!checks.results && !checks.error && (
        <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-card" aria-label="Checks" aria-busy>
          <header className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] font-medium text-muted" role="status">
            <Stethoscope size={15} aria-hidden /> Running checks…
          </header>
          <Skeleton />
        </section>
      )}

      {checks.results && summary && (
        <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-card" aria-label="Checks">
          <header className={cx('flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] font-medium', summary.tone === 'up' ? 'text-up' : 'text-down')} data-diagnostics-summary={summary.tone}>
            {summary.tone === 'up' ? <CircleCheck size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />}
            <span className="flex-1">{summary.tone === 'up' ? summary.text : `${summary.failing.length} of ${checks.results.length} checks fail`}</span>
            {checks.checkedAt && (
              <span className="text-xs font-normal text-faint tabular-nums" title={checks.checkedAt.toLocaleString()}>
                Checked {checks.checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </header>
          <ul className="flex flex-col divide-y divide-line-subtle">
            {orderChecks(checks.results).map((result) => (
              <CheckRow key={result.name} result={result} home={info?.home} sameAs={shared.get(result.name)} onOpen={(path) => void navigate(path)} />
            ))}
          </ul>
          {info && <p className="border-t border-line-subtle px-4 py-2.5 text-xs text-faint tabular-nums" data-app-runtime>{runtimeLine(info)}</p>}
        </section>
      )}

      <section className="flex flex-col gap-3" aria-label="Daemon log">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col">
            <h2 className="text-[15px] leading-5 font-semibold">Daemon log</h2>
            <p className="font-mono text-xs text-faint">logs/bot.log · tokens hidden</p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              id="log-lines"
              aria-label="Lines"
              size="sm"
              className="w-28"
              value={String(lines)}
              options={LOG_LINE_CHOICES.map((choice) => ({ value: String(choice), label: `${choice} lines` }))}
              onChange={(choice) => setLines(Number(choice))}
            />
            <Button size="sm" icon={<RefreshCw size={12} aria-hidden />} onClick={() => void reloadLog()}>Reload</Button>
          </div>
        </div>
        {tail.error && <p role="alert" className="text-sm text-down">{tail.error}</p>}
        {tail.log && tail.log.length === 0 && !tail.error && (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">No log yet. It starts with the service.</p>
        )}
        {tail.log && tail.log.length > 0 && (
          <pre ref={logBox} tabIndex={0} aria-label="Log lines" className="max-h-96 overflow-auto rounded-xl border border-line bg-field px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-muted focus-visible:outline-2 focus-visible:outline-focus" data-log-tail>
            {tildePaths(tail.log.join('\n'), info?.home)}
          </pre>
        )}
      </section>
    </Page>
  );
};
