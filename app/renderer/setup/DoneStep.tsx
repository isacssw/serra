// The end of setup: the bot is ready, and the way into the app. Teaching it comes next, as an option.
import { useState } from 'react';
import { Check, MessagesSquare, Power } from 'lucide-react';
import { serra } from '../bridge.ts';
import { useNavigate } from 'react-router';
import { defaultPath } from '../routes.ts';
import { useBotStatus } from '../shell/live.ts';
import { Button } from '../ui/index.ts';
import { useSetup } from './SetupState.tsx';

export const DoneStep = () => {
  const navigate = useNavigate();
  const { progress } = useSetup();
  const status = useBotStatus();
  const name = progress?.bot?.name ?? 'Your bot';
  // The same "running" setup counts: answering and connected to Slack.
  const running = status?.state === 'up' && status.slackConnected;
  const answering = status?.state === 'up';
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setStarting(true);
    setError(null);
    try { await serra()?.bot.start(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setStarting(false); }
  };
  if (!running) {
    // Reached only if the bot stopped since setup finished: say so, and offer to start it.
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-8 py-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <span aria-hidden className="grid size-14 place-items-center rounded-full border border-line-strong text-muted"><Power size={24} /></span>
          <h1 className="text-[28px] font-semibold tracking-tight">{name} is installed</h1>
          <p className="max-w-sm text-[15px] text-muted">{answering ? 'It’s running, but not connected to Slack. Diagnostics shows why.' : 'It isn’t running right now.'}</p>
          {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
        </div>
        <div className="flex flex-col items-center gap-3">
          {answering
            ? <Button variant="primary" className="h-10 px-5 text-[14px]" onClick={() => void navigate('/settings/diagnostics')}>Open Diagnostics</Button>
            : <Button variant="primary" className="h-10 px-5 text-[14px]" onClick={() => void start()} disabled={starting}>{starting ? 'Starting…' : `Start ${name}`}</Button>}
          <Button variant="ghost" size="sm" className="text-muted" onClick={() => void navigate(defaultPath)}>Open Serra</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <span aria-hidden className="grid size-14 place-items-center rounded-full bg-up text-status-ink motion-safe:animate-[serra-pop_420ms_ease-out]">
          <Check size={28} strokeWidth={2.5} />
        </span>
        <h1 className="text-[28px] font-semibold tracking-tight">{name} is ready</h1>
        <p className="max-w-sm text-[15px] text-muted">
          Mention <span className="font-mono text-[14px] text-ink">@{progress?.bot?.id}</span> in Slack to try it.
        </p>
      </div>
      <div className="flex flex-col items-center gap-3">
        <Button variant="primary" className="h-10 px-5 text-[14px]" onClick={() => void navigate(defaultPath)}>Open Serra</Button>
        <Button variant="ghost" size="sm" className="text-muted" icon={<MessagesSquare size={14} aria-hidden />} onClick={() => void navigate('/knowledge/proposals')}>
          Teach it how you work
        </Button>
      </div>
    </div>
  );
};
