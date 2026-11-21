// Diagnostics (APP-22): `diagnose()` for the profile, rerun on demand and when the daemon starts, stops, restarts
// or its Slack connection changes, plus the tail of the daemon's log. Token values never reach this window: main
// scrubs every detail and log line first.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Copy, RefreshCw, Sparkles, Stethoscope } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { Diagnostic } from '../../../src/contracts.ts';
import type { AppInfo } from '../../main/bridge.ts';
import { serra } from '../bridge.ts';
import { useBotStatus } from '../shell/live.ts';
import { Button, cx, Page, useToast } from '../ui/index.ts';
import { WELCOME_PATH } from './Welcome/welcome.logic.ts';
import {
  DEFAULT_LOG_LINES, LOG_LINE_CHOICES, reportText, runtimeLine, statusKey, summarize,
} from './diagnostics.logic.ts';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const CheckRow = ({ result }: { result: Diagnostic }) => (
  <li className="flex items-start gap-3 px-5 py-3" data-check={result.name} data-check-ok={result.ok}>
    {result.ok
      ? <CircleCheck size={18} className="mt-0.5 shrink-0 text-up" aria-label="Passes" />
      : <CircleAlert size={18} className="mt-0.5 shrink-0 text-down" aria-label="Fails" />}
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-medium">{result.name}</span>
      <span className={cx('text-sm break-words', result.ok ? 'text-muted' : 'text-down')}>{result.detail}</span>
    </div>
  </li>
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
      toast({ message: 'Diagnostics copied. Token values are never included.', tone: 'success' });
    } catch (failure) { toast({ message: `Could not copy: ${errorText(failure)}`, tone: 'error' }); }
  };

  const summary = checks.results ? summarize(checks.results) : null;
  const navigate = useNavigate();

  return (
    <Page
      title="Diagnostics"
      subtitle="Read-only health checks for the bot and the end of its log. Nothing here posts to chat or starts work."
      actions={(
        <>
          {checks.checkedAt && (
            <span className="text-xs text-muted" title={checks.checkedAt.toLocaleString()}>
              Checked {checks.checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <Button icon={<Sparkles size={14} aria-hidden />} onClick={() => void navigate(WELCOME_PATH)} title="The first-run wizard: profile, Slack app, tokens, owner and service">Setup guide</Button>
          <Button icon={<Copy size={14} aria-hidden />} onClick={() => void copy()} disabled={!checks.results}>Copy report</Button>
          <Button variant="primary" icon={<RefreshCw size={14} aria-hidden className={cx(checks.running && 'animate-spin')} />} onClick={refresh} disabled={checks.running}>
            {checks.running ? 'Checking…' : 'Run checks'}
          </Button>
        </>
      )}
    >
      {checks.error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-down/40 px-4 py-3 text-sm text-down">
          <CircleAlert size={16} aria-hidden />
          <span className="flex-1">{checks.error}</span>
        </div>
      )}

      {!checks.results && !checks.error && (
        <p className="flex items-center gap-2 text-sm text-muted"><Stethoscope size={16} aria-hidden /> Running checks… Network checks can take a few seconds.</p>
      )}

      {checks.results && summary && (
        <section className="flex flex-col rounded-lg border border-line bg-panel" aria-label="Checks">
          <header className={cx('flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-medium', summary.tone === 'up' ? 'text-up' : 'text-down')} data-diagnostics-summary={summary.tone}>
            {summary.tone === 'up' ? <CircleCheck size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />}
            {summary.text}
          </header>
          <ul className="flex flex-col divide-y divide-line">
            {checks.results.map((result) => <CheckRow key={result.name} result={result} />)}
          </ul>
        </section>
      )}

      {info && <p className="text-xs text-muted" data-app-runtime>{runtimeLine(info)}</p>}

      <section className="flex flex-col gap-3" aria-label="Daemon log">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col">
            <h2 className="text-lg font-semibold">Daemon log</h2>
            <p className="text-xs text-muted">logs/bot.log in the profile folder. Anything shaped like a token is hidden.</p>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="log-lines" className="text-sm text-muted">Lines</label>
            <select
              id="log-lines"
              value={lines}
              onChange={(event) => setLines(Number(event.target.value))}
              className="h-7 rounded-md border border-line bg-panel px-2 text-xs text-ink focus:outline-2 focus:outline-offset-1 focus:outline-focus"
            >
              {LOG_LINE_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
            </select>
            <Button size="sm" icon={<RefreshCw size={12} aria-hidden />} onClick={() => void reloadLog()}>Reload</Button>
          </div>
        </div>
        {tail.error && <p role="alert" className="text-sm text-down">{tail.error}</p>}
        {tail.log && tail.log.length === 0 && !tail.error && (
          <p className="text-sm text-muted">The log is empty or hasn&apos;t been written yet. It starts when the bot runs as a service.</p>
        )}
        {tail.log && tail.log.length > 0 && (
          <pre ref={logBox} className="max-h-96 overflow-auto rounded-lg border border-line bg-raised px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all" data-log-tail>
            {tail.log.join('\n')}
          </pre>
        )}
      </section>
    </Page>
  );
};
