// New task (APP-25): the owner writes a request and the app starts a T3 thread for it, with the bot's brief and
// knowledge, exactly as the daemon does for a Slack request. The job then shows in Jobs. The worker's replies are read
// in T3: nobody posts them to Slack, since the task never came from there.
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ArrowUp, Copy, Eye, GitBranch, Layers, ListChecks, LoaderCircle, RotateCw, User } from 'lucide-react';
import type { StartedTask } from '../../../src/tasks.ts';
import { serra } from '../bridge.ts';
import { Button, cx, useToast } from '../ui/index.ts';
import { ariaMod, mod } from '../shell/keys.ts';
import { announceTaskStart } from '../shell/events.ts';
import { useBotName } from '../setup/SetupState.tsx';
import { canStart, requestProblem, startedText, taskLink } from './newTask.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Preview = { state: 'closed' } | { state: 'loading' } | { state: 'ready'; text: string; for: string } | { state: 'error'; message: string };

export const NewTask = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const bot = useBotName();
  // Overview's "Tell it" opens here with the start of a "remember" request filled in, for the owner to finish.
  const [search] = useSearchParams();
  const [request, setRequest] = useState(() => search.get('text') ?? '');
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
    announceTaskStart(() => bridge.tasks.start(request)).then(
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

  const copyBrief = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => toast({ message: 'Brief copied', tone: 'success' }),
      (failure: unknown) => toast({ message: message(failure), tone: 'error' }),
    );
  };

  const startedLink = started ? taskLink(started) : undefined;
  const stalePreview = preview.state === 'ready' && preview.for !== request;

  return (
    <div data-screen-label="New task" className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-8 pt-[16vh] pb-10">
      <header className="flex flex-col items-center text-center">
        <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.022em]">What should {bot} do?</h1>
      </header>
      <section className="flex flex-col gap-3.5">
        <div className={cx(
          'flex flex-col rounded-2xl border bg-panel transition-[border-color,box-shadow] duration-150',
          'shadow-composer',
          problem ? 'border-down focus-within:ring-3 focus-within:ring-down/20' : request.trim() ? 'border-line-control' : 'border-line-strong focus-within:border-line-control',
        )}>
          <label htmlFor="new-task-request" className="sr-only">What should {bot} do?</label>
          <textarea
            id="new-task-request"
            autoFocus
            value={request}
            disabled={busy}
            onChange={(event) => { setRequest(event.target.value); setError(null); }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); start(); }
            }}
            placeholder="Describe the task, like “Update the pricing page and open a PR”"
            aria-invalid={problem ? true : undefined}
            aria-describedby="new-task-note"
            className="max-h-[40vh] min-h-[6rem] resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-6 text-ink outline-none [field-sizing:content] placeholder:text-faint disabled:opacity-60"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5">
            {request.trim() && <Button variant="ghost" size="sm" icon={preview.state === 'ready' ? <RotateCw size={13} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />} disabled={busy || !request.trim() || problem !== null} onClick={showPreview}>
              {preview.state === 'ready' ? 'Refresh brief' : 'Preview brief'}
            </Button>}
            <span className="ml-auto" />
            {request.trim() && <kbd className="rounded border border-line px-1 font-sans text-[11px] leading-4 text-faint" aria-hidden>{mod}↩</kbd>}
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
                'disabled:cursor-not-allowed disabled:border disabled:border-line-strong disabled:bg-transparent disabled:text-faint',
              )}
            >
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.25} />}
            </button>
          </div>
        </div>
        <div id="new-task-note" className={cx('flex flex-wrap items-center justify-center gap-x-5 gap-y-1 px-3 text-xs [&>span]:whitespace-nowrap', problem ? 'text-down' : 'text-faint')}>
          {problem ?? (
            <>
              <span className="flex items-center gap-1.5"><User size={13} strokeWidth={1.75} aria-hidden /> You're the requester</span>
              <span className="flex items-center gap-1.5"><Layers size={13} strokeWidth={1.75} aria-hidden /> Replies in T3</span>
              <span className="flex items-center gap-1.5"><GitBranch size={13} strokeWidth={1.75} aria-hidden /> Own worktree</span>
            </>
          )}
        </div>
        {error && <p role="alert" className="text-center text-[13px] text-down">{error}</p>}
      </section>

      {started && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3 shadow-card" aria-live="polite">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="truncate text-[13px] font-medium">{startedText(started)}</p>
            <p className="text-xs text-muted">Track it in Jobs.</p>
          </div>
          <div className="flex gap-2">
            <span title={startedLink ? 'Open the T3 thread' : "T3 didn't return a link for this thread yet"}>
              <Button size="sm" icon={<Layers size={14} />} disabled={!startedLink} onClick={() => { if (startedLink) openLink(startedLink); }}>T3</Button>
            </span>
            <Button size="sm" icon={<ListChecks size={14} />} onClick={() => void navigate('/jobs/running')}>Show in Jobs</Button>
          </div>
        </section>
      )}

      {preview.state !== 'closed' && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-semibold">Brief</h2>
            <span className="-mr-2.5 flex gap-0.5">
              {preview.state === 'ready' && <Button variant="ghost" size="sm" icon={<Copy size={13} aria-hidden />} onClick={() => copyBrief(preview.text)}>Copy</Button>}
              <Button variant="ghost" size="sm" onClick={() => setPreview({ state: 'closed' })}>Hide</Button>
            </span>
          </div>
          {preview.state === 'loading' && <p className="flex items-center gap-2 text-[13px] text-muted"><LoaderCircle size={14} className="animate-spin" /> Filling the brief…</p>}
          {preview.state === 'error' && <p role="alert" className="text-[13px] text-down">{preview.message}</p>}
          {preview.state === 'ready' && (
            <>
              {stalePreview && <p className="text-xs text-warn">Request changed. Refresh to update.</p>}
              <pre tabIndex={0} aria-label="Brief" className="max-h-80 overflow-auto rounded-xl border border-line bg-raised px-4 py-3 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap text-muted focus-visible:outline-2 focus-visible:outline-focus">{preview.text}</pre>
            </>
          )}
        </section>
      )}
    </div>
  );
};
