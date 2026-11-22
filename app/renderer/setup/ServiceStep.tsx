// Step 4: install the bot under launchd and see it running. "Running" means the daemon answers on its status socket,
// not only that a release was activated, so the step waits for it to report in before it calls setup done.
import { useEffect, useRef, useState } from 'react';
import { Power } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { ActivationOutcome } from '../../../src/releases.ts';
import { serra } from '../bridge.ts';
import { useBotStatus } from '../shell/live.ts';
import { Button } from '../ui/index.ts';
import { Alert, Card, errorText, StateIcon, StepFooter, StepHeader } from './parts.tsx';
import { FLOW, nextPath, outcomeText, previousPath, stepDone } from './setup.logic.ts';
import { setupChanged, useSetup } from './SetupState.tsx';

const step = FLOW[3]!;
/** How long to wait for a freshly started bot to answer before saying so. */
const ANSWER_WITHIN_MS = 45_000;

export const ServiceStep = () => {
  const navigate = useNavigate();
  const { progress, refresh } = useSetup();
  const status = useBotStatus();
  const installed = progress?.installed === true;
  // Really running: the daemon answers and is connected to Slack.
  const running = status?.state === 'up' && status.slackConnected;
  const disconnected = status?.state === 'up' && !status.slackConnected;
  const name = progress?.bot?.name ?? 'The bot';
  const [busy, setBusy] = useState<'install' | 'start' | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<ActivationOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [late, setLate] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => serra()?.on.releaseLog((line) => setLog((lines) => [...lines.slice(-400), line])), []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);
  useEffect(() => {
    if (!waiting || running) { setLate(false); return; }
    const timer = setTimeout(() => setLate(true), ANSWER_WITHIN_MS);
    return () => clearTimeout(timer);
  }, [waiting, running]);

  const install = async () => {
    const bridge = serra();
    if (!bridge) return;
    setBusy('install');
    setLog([]);
    setOutcome(null);
    setError(null);
    try {
      const result = await bridge.setup.installService();
      setOutcome(result);
      if (result.ok) setWaiting(true);
      setupChanged();
      await refresh();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(null); }
  };

  const start = async () => {
    const bridge = serra();
    if (!bridge) return;
    setBusy('start');
    setError(null);
    try { await bridge.bot.start(); setWaiting(true); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(null); }
  };

  const result = outcome && !outcome.ok ? outcomeText(outcome) : null;
  const tone = running ? 'done' : disconnected && !busy ? 'problem' : busy || waiting ? (late ? 'problem' : 'busy') : result ? 'problem' : 'todo';
  // Setup counts the step done once the bot has answered; stopped since, Continue still goes on (Done offers Start).
  const canContinue = (running && installed) || stepDone(progress, 'service');
  const line = running ? `${name} is running and connected to Slack.`
    : disconnected && !busy ? `${name} is running but not connected to Slack yet.`
    : busy === 'install' ? (log.at(-1) ?? 'Preparing…')
    : busy === 'start' ? `Starting ${name}…`
    : waiting ? (late ? `${name} hasn’t answered yet. Diagnostics shows why; Skip for now keeps setup open.` : `Waiting for ${name} to answer…`)
    : installed ? `${name} is installed but not running.`
    : 'Not installed yet.';
  const latest = log.at(-1);

  return (
    <div className="flex flex-col gap-8">
      <StepHeader step={step} icon={<Power size={18} strokeWidth={1.75} />} />
      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-center gap-3">
          <StateIcon tone={tone} />
          <p className="min-w-0 flex-1 text-[14px] break-words" role="status">{line}</p>
          {!running && !disconnected && !busy && !waiting && installed && <Button size="sm" onClick={() => void start()}>Start</Button>}
          {!running && !busy && !disconnected && (!waiting || late) && (
            <Button size="sm" variant={installed ? 'ghost' : 'primary'} onClick={() => void install()}>
              {installed ? 'Install again' : 'Install and start'}
            </Button>
          )}
          {(late || (disconnected && !busy)) && <Button size="sm" variant={disconnected ? 'primary' : 'ghost'} onClick={() => void navigate('/settings/diagnostics')}>Diagnostics</Button>}
        </div>
        {log.length > 0 && (
          <details className="pl-8 text-[13px]" open={Boolean(result)}>
            <summary className="w-fit cursor-pointer rounded text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
              Details{busy && latest ? '' : ` · ${log.length} lines`}
            </summary>
            <pre ref={logRef} className="mt-2 max-h-56 overflow-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-[11px] whitespace-pre-wrap" data-setup-log>
              {log.join('\n')}
            </pre>
          </details>
        )}
      </Card>
      {result && <Alert>{result.text}</Alert>}
      {error && <Alert>{error}</Alert>}
      <p className="text-[13px] text-muted">It starts again on its own when you log in.</p>
      <StepFooter back={previousPath(step.path)}>
        <Button variant="primary" aria-disabled={canContinue ? undefined : true} onClick={() => { if (canContinue) void refresh().then((latest) => navigate(nextPath(latest ?? progress, step.path))); }}>
          Continue
        </Button>
      </StepFooter>
    </div>
  );
};
