// Setup as its own full-window mode (SERRA-51): no sidebar, a progress rail in the title bar, one step per screen.
// It opens on launch while a step is left, from the sidebar's "Finish setup" row, from ⌘K and from the app menu.
// Every step reads its state from the profile's files, so quitting at any point loses nothing.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { defaultPath } from '../routes.ts';
import { isMac } from '../shell/keys.ts';
import { Button, cx } from '../ui/index.ts';
import { DoneStep } from './DoneStep.tsx';
import { OwnerStep } from './OwnerStep.tsx';
import { ServiceStep } from './ServiceStep.tsx';
import { announcement, capitalize, DONE_PATH, FLOW, hasProfile, lockedReason, resumePath, stepDone, stepOpen, SETUP_PATH } from './setup.logic.ts';
import type { SetupStepId } from '../../../src/setup.ts';
import type { ReactElement } from 'react';
import { useSetup } from './SetupState.tsx';
import { SlackStep } from './SlackStep.tsx';
import { Start } from './Start.tsx';
import { YouStep } from './YouStep.tsx';

/** The steps along the title bar. Done steps and the current one can be opened; the rest wait for the profile. */
const Rail = ({ pathname }: { pathname: string }) => {
  const navigate = useNavigate();
  const { progress } = useSetup();
  return (
    <nav aria-label="Setup steps" className="no-drag">
      <ol className="flex items-center gap-1">
        {FLOW.map((step, index) => {
          const current = step.path === pathname;
          const done = stepDone(progress, step.id);
          const open = stepOpen(progress, step.id);
          return (
            <li key={step.id} className="flex items-center gap-1">
              {index > 0 && <span aria-hidden className={cx('h-px w-3 sm:w-5', done || current ? 'bg-line-strong' : 'bg-line')} />}
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                aria-disabled={open ? undefined : true}
                onClick={() => { if (open) void navigate(step.path); }}
                data-setup-step={step.id}
                title={open ? undefined : capitalize(lockedReason(progress, step.id))}
                className={cx(
                  'flex h-7 items-center gap-1.5 rounded-full px-2 text-xs transition-colors duration-150',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
                  current ? 'bg-selected font-medium text-ink' : open ? 'text-muted hover:bg-hover hover:text-ink' : 'cursor-default text-muted',
                )}
              >
                <span
                  aria-hidden
                  className={cx(
                    'grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums',
                    done ? 'bg-ink text-canvas' : current ? 'border-[1.5px] border-ink text-ink' : 'border border-line-strong',
                  )}
                >
                  {done ? <Check size={10} strokeWidth={3.5} /> : index + 1}
                </span>
                {/* Narrow windows show the numbers only; the name stays for screen readers. */}
                <span className="max-md:sr-only">{step.short}</span>
                {(done || !open) && <span className="sr-only">{done ? ', done' : `, ${lockedReason(progress, step.id)}`}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

export const SetupFlow = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { progress } = useSetup();
  const main = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const onStart = pathname === SETUP_PATH;

  // Each step opens at the top, and focus moves to its heading so the next Tab starts in the step. The first screen
  // after launch keeps focus where the window put it.
  useLayoutEffect(() => { main.current?.scrollTo({ top: 0 }); }, [pathname]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    let tries = 20;
    const focus = (): void => {
      const heading = main.current?.querySelector<HTMLElement>('h1');
      if (!heading) { if (tries-- > 0) requestAnimationFrame(focus); return; }
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    };
    focus();
  }, [pathname]);

  const profile = hasProfile(progress);
  /** A step not open yet (its prerequisite isn't done) sends the owner to the first one that is. */
  const guard = (id: SetupStepId, element: ReactElement): ReactElement =>
    (stepOpen(progress, id) ? element : <Navigate to={resumePath(progress)} replace />);
  return (
    <div className="flex h-full flex-col bg-canvas" data-serra-main data-serra-setup data-path={pathname}>
      {/* Equal side tracks keep the rail centred on the window; the left one keeps clear of the traffic lights. */}
      <div className="drag grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-3">
        <span className={isMac ? 'min-w-[72px]' : undefined} />
        {onStart ? <span /> : <Rail pathname={pathname} />}
        <div className="flex justify-end">
          {/* Hidden where the screen's own main button already opens Serra (the end, or a finished summary). */}
          {profile && progress?.next && pathname !== DONE_PATH && (
            <Button variant="ghost" size="sm" className="no-drag text-muted" onClick={() => void navigate(defaultPath)}>
              Skip for now
            </Button>
          )}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">{announcement(pathname)}</p>
      <div ref={main} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div key={pathname} className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-6 pt-6 pb-14 motion-safe:animate-[serra-rise_260ms_ease-out]">
          <Routes>
            <Route index element={<Start />} />
            <Route path="you" element={<YouStep />} />
            <Route path="slack" element={guard('slack', <SlackStep />)} />
            <Route path="owner" element={guard('owner', <OwnerStep />)} />
            <Route path="service" element={guard('service', <ServiceStep />)} />
            <Route path="done" element={progress && !progress.next ? <DoneStep /> : <Navigate to={progress ? resumePath(progress) : SETUP_PATH} replace />} />
            <Route path="*" element={<Navigate to={SETUP_PATH} replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
};
