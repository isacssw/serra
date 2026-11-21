// New task (APP-25): the owner writes a request and the app starts a T3 thread for it, with the bot's brief and
// knowledge, exactly as the daemon does for a Slack request. The job then shows in Jobs. The worker's replies are read
// in T3: nobody posts them to Slack, since the task never came from there.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUp, Eye, GitBranch, Layers, ListChecks, LoaderCircle, User } from 'lucide-react';
import type { StartedTask } from '../../../src/tasks.ts';
import { serra } from '../bridge.ts';
import { Button, cx, useToast } from '../ui/index.ts';
import { ariaMod, mod } from '../shell/keys.ts';
import { canStart, requestProblem, startedText, taskLink } from './newTask.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Preview = { state: 'closed' } | { state: 'loading' } | { state: 'ready'; text: string; for: string } | { state: 'error'; message: string };

export const NewTask = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedTask | null>(null);
  const [preview, setPreview] = useState<Preview>({ state: 'closed' });
  const problem = requestProblem(request);

  const openLink = (url: string): void => {
    serra()?.app.openExternal(url).catch((failure: unknown) => toast({ message: message(failure), tone: 'error' }));
  };

  const start = (): void => {
    const bridge = serra();
    if (!bridge) { setError('Open this screen in the Serra app to start a task.'); return; }
    if (!canStart(request, busy)) return;
    setBusy(true);
    setError(null);
    bridge.tasks.start(request).then(
      (task) => {
        setStarted(task);
        setRequest('');
        setPreview({ state: 'closed' });
        const link = taskLink(task);
        toast({
          message: startedText(task),
          tone: 'success',
          ...(link ? { action: { label: 'Open in T3', onClick: () => openLink(link) } } : {}),
        });
      },
      (failure: unknown) => setError(message(failure)),
    ).finally(() => setBusy(false));
  };

  const showPreview = (): void => {
    const bridge = serra();
    if (!bridge) { setPreview({ state: 'error', message: 'Open this screen in the Serra app to preview the brief.' }); return; }
    const asked = request;
    setPreview({ state: 'loading' });
    bridge.tasks.preview(asked).then(
      (text) => setPreview({ state: 'ready', text, for: asked }),
      (failure: unknown) => setPreview({ state: 'error', message: message(failure) }),
    );
  };

  const startedLink = started ? taskLink(started) : undefined;
  const stalePreview = preview.state === 'ready' && preview.for !== request;

  return (
    <div data-screen-label="New task" className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-8 pt-[14vh] pb-10">
      <header className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-[28px] font-semibold tracking-tight">What should the bot do?</h1>
        <p className="text-sm text-muted">The worker gets the bot's brief and knowledge, as it would for a request from chat.</p>
      </header>
      <section className="flex flex-col gap-2">
        <div className={cx('flex flex-col rounded-2xl border bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.3)] transition-[border-color,box-shadow] duration-150 focus-within:ring-1', problem ? 'border-down focus-within:ring-down' : 'border-line focus-within:border-focus/50 focus-within:ring-focus/10')}>
          <label htmlFor="new-task-request" className="sr-only">What should the bot do?</label>
          <textarea
            id="new-task-request"
            autoFocus
            value={request}
            disabled={busy}
            onChange={(event) => { setRequest(event.target.value); setError(null); }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); start(); }
            }}
            placeholder="Update the onboarding page for the new pricing, and open a PR."
            aria-invalid={problem ? true : undefined}
            aria-describedby="new-task-note"
            className="max-h-[40vh] min-h-[5.5rem] resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-6 text-ink outline-none [field-sizing:content] placeholder:text-muted disabled:opacity-50"
          />
          <div className="flex items-center gap-2 px-3 pb-3">
            <Button variant="ghost" size="sm" className="text-muted hover:text-ink" icon={<Eye size={14} strokeWidth={1.75} />} disabled={busy || !request.trim() || problem !== null} onClick={showPreview}>
              {preview.state === 'ready' ? 'Refresh brief' : 'Preview brief'}
            </Button>
            <kbd className="ml-auto font-sans text-[11px] text-muted" aria-hidden>{mod}↩</kbd>
            <button
              type="button"
              aria-label="Start task"
              aria-keyshortcuts={`${ariaMod}+Enter`}
              title={`Start task (${mod}↩)`}
              disabled={!canStart(request, busy)}
              onClick={start}
              className={cx(
                'grid size-8 place-items-center rounded-full bg-accent text-accent-ink transition-colors duration-150 hover:bg-accent/85',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                'disabled:bg-raised disabled:text-muted',
              )}
            >
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.25} />}
            </button>
          </div>
        </div>
        <div id="new-task-note" className={cx('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-3 text-xs [&>span]:whitespace-nowrap', problem ? 'text-down' : 'text-muted')}>
          {problem ?? (
            <>
              <span className="flex items-center gap-1.5"><User size={13} strokeWidth={1.75} aria-hidden /> You're the requester</span>
              <span className="flex items-center gap-1.5"><Layers size={13} strokeWidth={1.75} aria-hidden /> Replies in T3, not in chat</span>
              <span className="flex items-center gap-1.5"><GitBranch size={13} strokeWidth={1.75} aria-hidden /> Own worktree</span>
            </>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-down">{error}</p>}
      </section>

      {started && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3" aria-live="polite">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="truncate text-sm font-medium">{startedText(started)}</p>
            <p className="text-xs text-muted">It is listed in Jobs while it runs, and under Done today once it finishes.</p>
          </div>
          <div className="flex gap-2">
            <span title={startedLink ? 'Open the T3 thread' : "T3 didn't return a link for this thread yet"}>
              <Button size="sm" icon={<Layers size={14} />} disabled={!startedLink} onClick={() => { if (startedLink) openLink(startedLink); }}>T3</Button>
            </span>
            <Button size="sm" icon={<ListChecks size={14} />} onClick={() => navigate('/jobs/running')}>Show in Jobs</Button>
          </div>
        </section>
      )}

      {preview.state !== 'closed' && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[15px] font-semibold">Brief the worker gets</h2>
          {preview.state === 'loading' && <p className="flex items-center gap-2 text-sm text-muted"><LoaderCircle size={14} className="animate-spin" /> Filling the brief…</p>}
          {preview.state === 'error' && <p role="alert" className="text-sm text-down">{preview.message}</p>}
          {preview.state === 'ready' && (
            <>
              {stalePreview && <p className="text-xs text-warn">The request changed since this preview. Refresh it to see the new brief.</p>}
              <pre className="max-h-[32rem] overflow-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-ink">{preview.text}</pre>
            </>
          )}
        </section>
      )}
    </div>
  );
};
