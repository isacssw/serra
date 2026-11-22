// The GitHub star request (SERRA-53): a small card in the toast corner, shown right after a job finishes, once the
// owner has used Serra for a few days. The rules are in star.logic.ts. The card never takes focus or blocks anything.
// It loads nothing of its own: finishes are the daemon's reply events, app tasks come from the sidebar's jobs list.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { Star } from 'lucide-react';
import type { BotStatus, JobSummary } from '../../../src/contracts.ts';
import { serra } from '../bridge.ts';
import { WELCOME_PATH } from '../screens/Welcome/welcome.logic.ts';
import {
  answer, calmMoment, countFinished, dueToAsk, finishedWell, IDLE_MS, MAX_WAIT_MS, markShown, openRepo, shouldAsk,
  startClock, updateStarPrompt, type StarChoice,
} from '../star.logic.ts';
import { Button, GitHubMark, useToast, useToastStack } from '../ui/index.ts';

// Input that means the owner is busy in the window; the card waits for a pause.
const ACTIVITY = ['pointerdown', 'keydown', 'wheel'] as const;

/** Calls `ready` once the window has focus and has had no input for IDLE_MS. Returns a cancel. */
const whenIdle = (ready: () => void): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restart = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Away in another app: the next focus starts the wait again.
      if (!document.hasFocus()) return;
      stop();
      ready();
    }, IDLE_MS);
  };
  const stop = (): void => {
    clearTimeout(timer);
    for (const type of ACTIVITY) window.removeEventListener(type, restart, true);
    window.removeEventListener('focus', restart);
  };
  for (const type of ACTIVITY) window.addEventListener(type, restart, { capture: true, passive: true });
  window.addEventListener('focus', restart);
  restart();
  return stop;
};

export const StarCard = ({ onChoose }: { onChoose: (choice: StarChoice) => void }) => {
  const id = useId();
  // Escape anywhere in the card is Not now, like closing a toast.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') { event.stopPropagation(); onChoose('not now'); }
  };
  return (
    <aside
      data-toast
      data-star-prompt
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5 text-[13px] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink" aria-hidden>
          <GitHubMark size={16} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={`${id}-title`} className="font-medium text-ink">Enjoying Serra?</h2>
          <p id={`${id}-body`} className="text-muted">A star on GitHub helps other people find it.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="mr-auto text-muted" onClick={() => onChoose('never')}>Don’t ask again</Button>
        <Button variant="ghost" size="sm" onClick={() => onChoose('not now')}>Not now</Button>
        <Button variant="primary" size="sm" icon={<Star size={13} aria-hidden />} onClick={() => onChoose('star')}>Star on GitHub</Button>
      </div>
    </aside>
  );
};

export const StarPrompt = ({ status, jobs }: { status: BotStatus | null; jobs: JobSummary[] | null }) => {
  const { pathname } = useLocation();
  const stack = useToastStack();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const version = useRef<string | null>(null);
  // Once per session, like T3 Code: a run of finished jobs asks at most once until the app restarts.
  const asked = useRef(false);
  const cancelWait = useRef((): void => {});
  // What the idle wait reads when it ends: the moment may have passed (a job started, setup opened).
  const moment = { status, jobs, path: pathname, welcomePath: WELCOME_PATH };
  const live = useRef(moment);
  live.current = moment;

  useEffect(() => {
    void serra()?.app.info().then((info) => { version.current = info.version; }, () => {});
    return () => cancelWait.current();
  }, []);

  // The days-of-use clock starts the first time the bot is up, so setup time doesn't count.
  useEffect(() => {
    const bridge = serra();
    if (!bridge || status?.state !== 'up') return;
    void updateStarPrompt(bridge.app, (state) => startClock(state, new Date())).catch(() => {});
  }, [status?.state]);

  // Each job that finishes well: count it, then wait for the owner to be idle here before asking.
  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    const onFinish = async (): Promise<void> => {
      const finishedAt = Date.now();
      let state;
      try { state = await updateStarPrompt(bridge.app, (current) => countFinished(current, 1)); } catch { return; }
      // Only what's saved decides here; whether the moment is calm is checked when the card would show.
      if (asked.current || !version.current || !dueToAsk(state, { now: new Date(), version: version.current }).ask) return;
      asked.current = true;
      cancelWait.current = whenIdle(() => {
        // Came back too late: this finish is old news. The next one can ask.
        if (Date.now() - finishedAt > MAX_WAIT_MS) { asked.current = false; return; }
        let shown = false;
        updateStarPrompt(bridge.app, (current) => {
          const context = { ...live.current, now: new Date(), version: version.current ?? '' };
          if (!shouldAsk(current, context).ask) return current;
          shown = true;
          // Saved before it shows: a card whose answer can't be kept would come back every time, so it never shows.
          return markShown(current, context.version, context.now);
        }).then(() => {
          // Not calm any more: the session's next finish can try again. If it was saved as shown in the instant
          // between, that ask is spent; a rare cost that keeps "shown" honest about what was saved.
          if (shown && calmMoment(live.current).ask) setOpen(true);
          else asked.current = shown;
        }, () => { asked.current = false; });
      });
    };
    return bridge.on.event((event) => { if (finishedWell(event)) void onFinish(); });
  }, []);

  // The moment passed while the card was up (a job started, setup opened): close it. It was saved as shown.
  const calm = calmMoment(moment).ask;
  useEffect(() => { if (open && !calm) setOpen(false); }, [open, calm]);

  const choose = (choice: StarChoice): void => {
    setOpen(false);
    const bridge = serra();
    if (!bridge) return;
    const failed = (error: unknown): void =>
      toast({ message: `Couldn’t save your answer: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' });
    if (choice === 'star') {
      openRepo(bridge.app).then(
        (saved) => toast(saved
          ? { message: 'Opened Serra on GitHub. Thanks for the support!', tone: 'success' }
          : { message: 'Opened Serra on GitHub. Couldn’t save your answer, so it may ask again.', tone: 'info' }),
        (error: unknown) => toast({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
      );
      return;
    }
    updateStarPrompt(bridge.app, (state) => answer(state, choice, new Date())).catch(failed);
  };

  if (!open || !stack) return null;
  return createPortal(<StarCard onChoose={choose} />, stack);
};
