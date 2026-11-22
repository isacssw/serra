// The end of setup: the bot is ready, and the way into the app. Teaching it comes next, as an option.
import { Check, MessagesSquare } from 'lucide-react';
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
  const running = status?.state === 'up';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <span aria-hidden className="grid size-14 place-items-center rounded-full bg-up text-status-ink motion-safe:animate-[serra-pop_420ms_ease-out]">
          <Check size={28} strokeWidth={2.5} />
        </span>
        <h1 className="text-[28px] font-semibold tracking-tight">{name} is ready</h1>
        <p className="max-w-sm text-[15px] text-muted">
          {running ? <>Mention <span className="font-mono text-[14px] text-ink">@{progress?.bot?.id}</span> in Slack to try it.</> : 'Start it from the menu bar when you want it to answer.'}
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
