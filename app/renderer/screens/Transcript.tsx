// An ACP run's transcript (Jobs › Transcript): what was asked and answered, a question it waits on with its choices,
// and a reply box. ACP runs have no web link, so this is where the owner reads, answers and carries one on. It reads
// the run's record every couple of seconds while open; replies and answers go through the bot, where the agent runs.
import { useEffect, useState } from 'react';
import type { RunTranscript } from '../../../src/agent/runs-view.ts';
import { serra } from '../bridge.ts';
import { Button, Dialog, cx, useToast } from '../ui/index.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const TranscriptDialog = ({ threadId, title, onClose }: { threadId: string | null; title: string; onClose: () => void }) => {
  const toast = useToast();
  const [run, setRun] = useState<RunTranscript | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const bridge = serra();
    if (!bridge || !threadId) return undefined;
    let live = true;
    const load = (): void => { bridge.jobs.transcript(threadId).then((next) => { if (live) setRun(next); }, () => {}); };
    load();
    const timer = setInterval(load, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [threadId]);

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try { await work(); } catch (error) { toast({ message: message(error), tone: 'error' }); } finally { setBusy(false); }
  };
  const bridge = serra();
  const question = run?.waiting[0];
  const current = question?.questions[0];
  const send = (): Promise<void> => act(async () => {
    if (!bridge || !threadId) return;
    const text = reply.trim();
    if (!text) return;
    // A question waiting takes the typed text as its answer; otherwise it's the next message.
    if (question && current) await bridge.jobs.answer(threadId, question.requestId, { [current.id]: text });
    else await bridge.jobs.reply(threadId, text);
    setReply('');
  });

  return (
    <Dialog
      open={threadId !== null}
      onClose={onClose}
      title={title || 'Transcript'}
      description={run ? (run.running ? 'Working…' : question ? 'Waiting for you.' : 'Idle.') : 'Loading…'}
    >
      <ol className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto text-sm" aria-live="polite">
        {run?.entries.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className={cx(entry.role === 'tool' ? 'text-xs text-muted' : 'whitespace-pre-wrap', entry.role === 'user' && 'rounded-md bg-raised px-3 py-2')}>
            {entry.role === 'tool' ? `· ${entry.text}` : entry.text}
          </li>
        ))}
      </ol>
      {question && current && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
          <p className="text-sm font-medium">{current.question}</p>
          <div className="flex flex-wrap gap-2">
            {current.options.map((option) => (
              <Button key={option.label} size="sm" disabled={busy} onClick={() => void act(async () => {
                if (bridge && threadId) await bridge.jobs.answer(threadId, question.requestId, { [current.id]: current.multiSelect ? [option.value ?? option.label] : option.value ?? option.label });
              })}>{option.label}</Button>
            ))}
          </div>
        </div>
      )}
      <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea
          aria-label={question ? 'Your answer' : 'Reply'}
          className="min-h-9 flex-1 resize-y rounded-md border border-line-control bg-panel px-2 py-1.5 text-sm text-ink focus:outline-2 focus:outline-offset-1 focus:outline-focus"
          rows={2}
          value={reply}
          placeholder={question ? 'Or type an answer' : 'Reply'}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }}
        />
        <Button type="submit" variant="primary" disabled={busy || !reply.trim()}>Send</Button>
      </form>
    </Dialog>
  );
};
