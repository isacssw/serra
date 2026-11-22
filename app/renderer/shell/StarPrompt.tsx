// The GitHub star request (SERRA-53): a small card in the toast corner, shown right after a job finishes, once the
// owner has used Serra for a few days. The rules are in star.logic.ts. The card never takes focus or blocks anything.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { Star } from 'lucide-react';
import type { BotStatus, JobSummary } from '../../../src/contracts.ts';
import { serra } from '../bridge.ts';
import { WELCOME_PATH } from '../screens/Welcome/welcome.logic.ts';
import {
  answer, countFinished, IDLE_MS, markShown, newlyFinished, openRepo, shouldAsk, startClock, updateStarPrompt,
  type StarChoice,
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

export const StarPrompt = ({ status }: { status: BotStatus | null }) => {
  const { pathname } = useLocation();
  const stack = useToastStack();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const version = useRef<string | null>(null);
  // Once per session, like T3 Code: a run of finished jobs asks at most once until the app restarts.
  const asked = useRef(false);
  // What the idle wait reads when it ends: the moment may have passed (a job started, setup opened).
  const live = useRef({ status, pathname });
  useEffect(() => { live.current = { status, pathname }; }, [status, pathname]);

  useEffect(() => {
    void serra()?.app.info().then((info) => { version.current = info.version; }, () => {});
  }, []);

  // The days-of-use clock starts the first time the bot is up, so setup time doesn't count.
  useEffect(() => {
    const bridge = serra();
    if (!bridge || status?.state !== 'up') return;
    void updateStarPrompt(bridge.app, (state) => startClock(state, new Date())).catch(() => {});
  }, [status?.state]);

  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    let alive = true;
    let before: JobSummary[] | null = null;
    let cancelWait = (): void => {};
    const context = () => ({
      now: new Date(), version: version.current ?? '', status: live.current.status, path: live.current.pathname, welcomePath: WELCOME_PATH,
    });
    const showIfStillRight = async (): Promise<void> => {
      try {
        const state = (await bridge.app.getPrefs()).starPrompt;
        if (!alive || !shouldAsk(state, context()).ask) { asked.current = false; return; }
        // Saved before it shows: a card whose answer can't be kept would come back every time, so it never shows.
        await bridge.app.setPrefs({ starPrompt: markShown(state, context().version, new Date()) });
        if (alive) setOpen(true);
      } catch {
        asked.current = false;
      }
    };
    const reload = async (): Promise<void> => {
      let after: JobSummary[];
      try { after = await bridge.jobs.list(); } catch { return; }
      if (!alive) return;
      const finished = newlyFinished(before, after);
      before = after;
      if (finished === 0 || asked.current || !version.current) return;
      let state;
      try { state = await updateStarPrompt(bridge.app, (current) => countFinished(current, finished)); } catch { return; }
      if (!alive || asked.current || !shouldAsk(state, context()).ask) return;
      asked.current = true;
      cancelWait = whenIdle(() => void showIfStillRight());
    };
    void reload();
    const offEvent = bridge.on.event(() => void reload());
    const offStatus = bridge.on.status(() => void reload());
    return () => { alive = false; cancelWait(); offEvent(); offStatus(); };
  }, []);

  const choose = (choice: StarChoice): void => {
    setOpen(false);
    const bridge = serra();
    if (!bridge) return;
    if (choice === 'star') {
      openRepo(bridge.app).then(
        () => toast({ message: 'Opened Serra on GitHub. Thank you!', tone: 'success' }),
        (error: unknown) => toast({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
      );
      return;
    }
    void updateStarPrompt(bridge.app, (state) => answer(state, choice, new Date())).catch(() => {});
  };

  if (!open || !stack) return null;
  return createPortal(<StarCard onChoose={choose} />, stack);
};
