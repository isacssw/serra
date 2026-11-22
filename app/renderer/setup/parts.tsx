// The setup flow's shared pieces: a step's header and footer, a state icon, an alert and a card.
import type { ReactNode } from 'react';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button, cx } from '../ui/index.ts';
import { FLOW, type FlowStep } from './setup.logic.ts';

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A step's heading. The flow moves focus to the h1 whenever the step changes. */
export const StepHeader = ({ step, icon }: { step: FlowStep; icon?: ReactNode }) => (
  <header className="flex flex-col gap-2">
    <p className="text-xs font-medium text-muted">Step {FLOW.indexOf(step) + 1} of {FLOW.length}</p>
    <div className="flex items-center gap-3">
      {icon && <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-panel text-ink">{icon}</span>}
      <h1 className="text-[24px] font-semibold tracking-tight">{step.title}</h1>
    </div>
    <p className="text-[14px] text-muted">{step.summary}</p>
  </header>
);

/** Back on the left, the step's main action on the right. */
export const StepFooter = ({ back, children }: { back: string | null; children?: ReactNode }) => {
  const navigate = useNavigate();
  return (
    <footer className="flex items-center justify-between gap-3 pt-2">
      {back ? <Button variant="ghost" className="-ml-3" onClick={() => void navigate(back)}>Back</Button> : <span />}
      <div className="flex items-center gap-2">{children}</div>
    </footer>
  );
};

export type Tone = 'done' | 'busy' | 'problem' | 'todo';

/** A row's state as an icon. The row's text says the same in words, so the icon is hidden from screen readers. */
export const StateIcon = ({ tone }: { tone: Tone }) => {
  if (tone === 'done') return <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-up text-status-ink"><Check size={12} strokeWidth={3} /></span>;
  if (tone === 'busy') return <LoaderCircle aria-hidden size={20} className="shrink-0 animate-spin text-muted" />;
  if (tone === 'problem') return <CircleAlert aria-hidden size={20} className="shrink-0 text-down" />;
  return <span aria-hidden className="size-5 shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong" />;
};

export const Alert = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="flex items-start gap-2 rounded-lg border border-down/40 px-3.5 py-2.5 text-[13px] text-down">
    <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

/** A bordered group of rows. */
export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx('rounded-xl border border-line bg-panel', className)}>{children}</div>
);
