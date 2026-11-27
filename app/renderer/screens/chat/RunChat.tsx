// A job's run as a chat (Jobs › Chat), on either backend: what was asked, what the agent said and did (tool calls and
// permissions as compact rows), its images, the turn streaming now, and a box to follow up or answer. It reads the
// run through the bridge (an ACP run's record; a T3 run through its backend) while open, faster while a turn runs.
// A T3 run keeps its T3 link in the header: T3 holds its tool calls. Replies and answers go through the bot.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bot, ChevronRight, CircleAlert, ShieldQuestion, ExternalLink, Layers, LoaderCircle, Lock, X } from 'lucide-react';
import type { RunChat as Chat } from '../../../../src/agent/runs-view.ts';
import { serra } from '../../bridge.ts';
import { ariaMod, mod } from '../../shell/keys.ts';
import { useBotStatus } from '../../shell/live.ts';
import { ToolIcon } from '../../ui/ToolIcon.tsx';
import { Button, cx, useToast } from '../../ui/index.ts';
import { AskRow, ChatImageView, ChatText, ToolGroup } from './ChatParts.tsx';
import { composerClass, composerInputClass, composerKbdClass, sendButtonClass } from '../../ui/composer.ts';
import { chatItems, composer, contentSize, follow, statusLabel, type ChatItem, type Follow } from './chat.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface ChatRun { threadId: string; backend: 'acp' | 't3'; title: string }

/** How often the open chat reads the run: often while a turn streams, less when it's idle. T3 is a CLI call each time. */
const pollMs = (chat: Chat | null, backend: ChatRun['backend']): number => {
  if (backend === 't3') return 4000;
  return chat?.status === 'running' ? 800 : 2500;
};

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const AGENT_BRANDS: Record<string, 'claude' | 'google'> = { claude: 'claude', gemini: 'google' };

const StatusPill = ({ chat }: { chat: Chat }) => {
  const tone = { running: 'border-line-strong text-ink', waiting: 'border-warn/40 bg-warn/10 text-warn', idle: 'border-line-strong text-muted', failed: 'border-down/40 bg-down/10 text-down' }[chat.status];
  const dot = { running: 'bg-up', waiting: 'bg-warn', idle: 'bg-faint', failed: 'bg-down' }[chat.status];
  return (
    <span className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium', tone)} role="status">
      <span aria-hidden className={cx('size-1.5 rounded-full', dot, chat.status === 'running' && 'animate-pulse')} />
      {statusLabel(chat.status)}
    </span>
  );
};

const Item = ({ item }: { item: ChatItem }) => {
  if (item.type === 'user') {
    return (
      <div className="flex flex-col items-end gap-2 pl-12">
        {item.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">{item.images.map((image) => <ChatImageView key={image.path} image={image} small />)}</div>
        )}
        {item.text && <div className="max-w-full rounded-2xl rounded-br-md border border-line bg-raised px-4 py-2.5 text-[14.5px] leading-[1.6] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{item.text}</div>}
        {item.brief && (
          <details className="group max-w-full text-xs text-muted">
            <summary className="-mr-1.5 ml-auto flex w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-0.5 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
              <ChevronRight size={12} aria-hidden className="transition-transform duration-150 group-open:rotate-90" />
              <span className="group-open:hidden">Show brief</span><span className="hidden group-open:inline">Hide brief</span>
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-line bg-raised px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus text-left font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-muted" tabIndex={0}>{item.brief}</pre>
          </details>
        )}
      </div>
    );
  }
  if (item.type === 'agent') {
    return (
      <div className="flex flex-col gap-3" aria-busy={item.streaming || undefined}>
        {item.parts.map((part, index) => (part.type === 'image'
          ? <ChatImageView key={`${index}`} image={part.image} />
          : <ChatText key={`${index}`} text={part.text} caret={item.streaming && index === item.parts.length - 1} />))}
        {item.streaming && item.parts.length === 0 && (
          <p className="flex items-center gap-2 text-[13px] text-muted"><LoaderCircle size={14} className="animate-spin motion-reduce:hidden" aria-hidden /><span aria-hidden className="hidden size-1.5 rounded-full bg-up motion-reduce:inline-block" />Working</p>
        )}
      </div>
    );
  }
  if (item.type === 'tools') return <ToolGroup tools={item.tools} />;
  return <AskRow item={item} />;
};

/** The question a run waits on, with its choices: picking one answers it. A typed answer goes in the box below. */
const QuestionCard = ({ chat, busy, onAnswer }: { chat: Chat; busy: boolean; onAnswer: (value: string) => void }) => {
  const question = chat.waiting[0]?.questions[0];
  if (!question) return null;
  const permission = question.id === 'permission';
  return (
    <div className={cx('flex flex-col gap-3 rounded-xl border px-4 py-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus', permission ? 'border-warn/70 bg-warn/5' : 'border-line-control bg-raised')} role="group" aria-label={permission ? 'Permission' : 'Question'} data-question-card tabIndex={-1}>
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted">{permission && <ShieldQuestion size={13} aria-hidden className="text-warn" />}{permission ? `${chat.agent} wants to run` : question.header || 'Question'}</p>
        <p className={cx('text-ink [overflow-wrap:anywhere]', permission ? 'font-mono text-[13px] leading-5' : 'text-[14px] leading-5 font-medium')}>
          {permission ? question.question.replace(/^.+? wants to: /, '') : question.question}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {question.options.map((option, index) => (
          <Button
            key={option.label}
            size="md"
            variant={permission ? (index === 0 ? 'primary' : 'secondary') : 'secondary'}
            className={permission && index === 0 ? undefined : 'enabled:border-line-control'}
            disabled={busy}
            title={option.description || undefined}
            onClick={() => onAnswer(option.value ?? option.label)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
};

export const RunChat = ({ run, onClose }: { run: ChatRun | null; onClose: () => void }) => {
  const toast = useToast();
  const status = useBotStatus();
  const dialog = useRef<HTMLDialogElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [chat, setChat] = useState<Chat | null | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [follows, setFollows] = useState<Follow>({ stuck: true, unseen: 0 });
  const seen = useRef({ size: 0, count: 0 });
  const runKey = run ? `${run.backend}:${run.threadId}` : null;

  // Open and close the sheet with the run; a new run starts fresh, at its end.
  useEffect(() => {
    const sheet = dialog.current;
    if (!sheet) return;
    if (run && !sheet.open) { sheet.showModal(); input.current?.focus(); }
    if (!run && sheet.open) sheet.close();
  }, [run]);
  useEffect(() => {
    setChat(undefined); setFailure(null); setDraft(''); setFollows({ stuck: true, unseen: 0 });
    seen.current = { size: 0, count: 0 };
  }, [runKey]);

  // Read the run while open, again after each read (never two at once), sooner while a turn runs.
  const latest = useRef<Chat | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => {
    const bridge = serra();
    if (!bridge || !run) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      bridge.jobs.chat({ threadId: run.threadId, backend: run.backend, title: run.title }).then(
        (next) => { if (!live) return; latest.current = next; setChat(next); setFailure(null); },
        (error: unknown) => { if (live) setFailure(message(error)); },
      ).finally(() => { if (live) timer = setTimeout(read, pollMs(latest.current, run.backend)); });
    };
    read();
    return () => { live = false; clearTimeout(timer); };
  }, [run, tick]);

  const items = chat ? chatItems(chat) : [];
  const size = contentSize(items);

  // Follow the end while stuck to it; otherwise count what arrived, for the jump button.
  const count = items.length;
  const streaming = chat?.live != null;
  useLayoutEffect(() => {
    const box = log.current;
    if (!box) return;
    const before = seen.current;
    seen.current = { size, count };
    if (size === before.size) return;
    if (follows.stuck || before.size === 0) box.scrollTop = box.scrollHeight;
    // A reply streaming below counts once as new, however many times it grows; new items count each.
    else setFollows((state) => follow(state, { type: 'grew', added: count - before.count > 0 ? count - before.count : streaming && state.unseen === 0 ? 1 : 0 }));
  }, [size, count, follows.stuck, streaming]);

  const jump = (): void => {
    const box = log.current;
    if (!box) return;
    box.scrollTo({ top: box.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
    setFollows(follow(follows, { type: 'jumped' }));
  };

  const act = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try { await work(); reload(); return true; } catch (error) { toast({ message: message(error), tone: 'error' }); return false; } finally { setBusy(false); }
  };
  const bridge = serra();
  const question = chat?.waiting[0];
  const current = question?.questions[0];
  const answer = (value: string): void => {
    if (!bridge || !run || !question || !current) return;
    void act(() => bridge.jobs.answer(run.threadId, question.requestId, { [current.id]: current.multiSelect ? [value] : value }));
  };
  const box = chat ? composer(chat, status?.state === 'up') : null;
  // The composer mounts once the run is read: focus lands there if nothing else has it yet.
  const ready = box !== null && box.mode !== 'blocked';
  useEffect(() => {
    const sheet = dialog.current;
    const active = document.activeElement;
    if (ready && sheet?.open && (!active || active === sheet || active === document.body || !sheet.contains(active))) input.current?.focus();
  }, [ready, runKey]);
  // A question with only choices takes focus on its first choice, so the keyboard lands where the answer is.
  const pickOnly = current?.allowCustomAnswer === false ? question?.requestId : undefined;
  useEffect(() => {
    if (!pickOnly) return;
    const sheet = dialog.current;
    const active = document.activeElement;
    if (!sheet || (active && active !== sheet && active !== document.body && sheet.contains(active) && active.id !== 'run-chat-input')) return;
    // The card, not Allow: Enter or Space must never approve a command by accident.
    sheet.querySelector<HTMLElement>('[data-question-card]')?.focus();
  }, [pickOnly]);
  const send = (): void => {
    const text = draft.trim();
    if (!bridge || !run || !text || busy || !box || box.mode === 'blocked') return;
    void act(async () => {
      if (box.mode === 'answer' && question && current) await bridge.jobs.answer(run.threadId, question.requestId, { [current.id]: text });
      else await bridge.jobs.reply({ threadId: run.threadId, backend: run.backend }, text);
    }).then((sent) => {
      if (!sent) return;
      setDraft('');
      setFollows({ stuck: true, unseen: 0 });
    });
  };

  const brand = chat ? AGENT_BRANDS[chat.agentId] ?? null : null;
  const canSend = box !== null && box.mode !== 'blocked' && !busy && draft.trim().length > 0 && !(box.mode === 'answer' && current?.allowCustomAnswer === false);

  return (
    <dialog
      ref={dialog}
      data-sheet
      aria-label={run?.title || 'Run'}
      data-chat-status={chat?.status}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
      className="m-0 ml-auto h-dvh max-h-none w-[min(50rem,calc(100vw-3rem))] max-w-none border-0 border-l border-line-strong bg-panel p-0 text-ink shadow-[-24px_0_64px_-16px_rgb(0_0_0/0.22)] backdrop:bg-scrim"
    >
      {run && (
        <div className="flex h-full flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 pt-4 pb-3.5">
            {/* TODO(SERRA-96): T3 and Codex have no mark in ui/brand-icons.ts (Simple Icons has neither T3 Code nor OpenAI), so
                they show a generic icon. Add them here once an official mark is licensed for use. */}
            {run.backend === 't3'
              ? <ToolIcon brand={null} fallback={<Layers size={14} />} label="T3" className="size-8 bg-raised!" />
              : <ToolIcon brand={brand} fallback={<Bot size={15} />} label={chat?.agent ?? 'Agent'} className="size-8 bg-raised!" />}
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="truncate text-[15px] leading-5 font-semibold" title={run.title || chat?.title}>{run.title || chat?.title || 'Untitled'}</h2>
              <p className="truncate text-xs leading-4 text-muted">{chat?.agent ?? (run.backend === 't3' ? 'T3' : 'Agent')}</p>
            </div>
            {chat && <StatusPill chat={chat} />}
            {chat?.link && (
              <Button size="sm" className="enabled:border-line-control" icon={<ExternalLink size={13} />} onClick={() => { bridge?.app.openExternal(chat.link!).catch((error: unknown) => toast({ message: message(error), tone: 'error' })); }}>
                Open in T3
              </Button>
            )}
            <Button variant="ghost" size="sm" className="-mr-1.5" aria-label="Close" title="Close (Esc)" onClick={onClose} icon={<X size={16} />} />
          </header>

          <div className="relative min-h-0 flex-1">
            <div
              ref={log}
              role="log"
              aria-label="Messages"
              tabIndex={0}
              onScroll={(event) => { const next = follow(follows, { type: 'scrolled', box: event.currentTarget }); if (next.stuck !== follows.stuck || next.unseen !== follows.unseen) setFollows(next); }}
              className="h-full scroll-pb-20 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            >
              <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-5 px-6 pt-6 pb-16">
                {chat === undefined && !failure && <p className="flex items-center gap-2 text-sm text-muted"><LoaderCircle size={14} className="animate-spin motion-reduce:hidden" aria-hidden />Loading</p>}
                {chat === null && <p className="text-sm text-muted">Serra has no record of this run.</p>}
                {chat && items.length === 0 && <p className="text-sm text-muted">No messages yet</p>}
                {items.filter((item) => !(question && item.type === 'ask' && item.outcome === 'waiting')).map((item, index, shown) => {
                  // Tool and question rows next to each other sit close: they're one step of a turn, not turns.
                  const compact = (it: ChatItem | undefined): boolean => it?.type === 'tools' || it?.type === 'ask';
                  return <div key={item.key} className={compact(item) && compact(shown[index - 1]) ? '-mt-4' : undefined}><Item item={item} /></div>;
                })}
                {chat?.status === 'running' && !chat.live && (
                  <p className="flex items-center gap-2 text-[13px] text-muted">
                    <span aria-hidden className="flex gap-1 motion-reduce:hidden">{[0, 1, 2].map((dot) => <span key={dot} className="size-1.5 animate-pulse rounded-full bg-faint" style={{ animationDelay: `${dot * 200}ms` }} />)}</span>
                    <span aria-hidden className="hidden size-1.5 rounded-full bg-up motion-reduce:inline-block" />
                    <span className="sr-only motion-reduce:not-sr-only">Working</span>
                  </p>
                )}
                {chat?.status === 'failed' && (
                  <p className="flex items-start gap-2 rounded-lg border border-down/40 px-3 py-2 text-[13px] text-down" role="alert">
                    <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />{chat.error ?? 'The run failed.'}
                  </p>
                )}
                {failure && <p role="alert" className="text-sm text-down">{failure}</p>}
              </div>
            </div>
            {/* The log fades into the composer, so its last line reads as scrolled, not cut. */}
            <div aria-hidden className={cx('pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-linear-to-t from-panel via-panel/70 to-transparent transition-opacity duration-150', follows.stuck && 'opacity-0')} />
            {!follows.stuck && (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto flex w-full max-w-[42rem] justify-center px-6">
              <button
                type="button"
                onClick={jump}
                className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-line-control bg-overlay px-3 text-xs font-medium text-ink shadow-overlay transition-colors hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <ArrowDown size={13} aria-hidden />{follows.unseen > 0 ? `${follows.unseen} new` : 'Latest'}
              </button>
              </div>
            )}
          </div>

          <footer className="shrink-0 pt-1 pb-5 [scrollbar-gutter:stable] overflow-hidden">
            <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-2.5 px-6">
              {chat && question && <QuestionCard chat={chat} busy={busy} onAnswer={answer} />}
              {!box ? null : box.mode === 'blocked'
                ? <p className="flex h-11 items-center justify-center gap-2 rounded-2xl border border-dashed border-line-control text-[13px] text-muted"><Lock size={13} aria-hidden />{box.reason}</p>
                : (
                  <div className={cx('flex items-end gap-2 py-2 pr-2 pl-4', composerClass({ filled: draft.trim() !== '' }))}>
                    <label htmlFor="run-chat-input" className="sr-only">{box?.mode === 'answer' ? 'Your answer' : 'Follow up'}</label>
                    <textarea
                      id="run-chat-input"
                      ref={input}
                      rows={1}
                      value={draft}
                      disabled={busy}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); send(); } }}
                      placeholder={box?.placeholder ?? 'Follow up'}
                      aria-describedby={box?.mode === 'reply' && box.note ? 'run-chat-note' : undefined}
                      className={cx('max-h-[30vh] min-h-8 flex-1 self-center py-1 text-[14px] leading-6', composerInputClass)}
                    />
                    <div className="flex shrink-0 items-center gap-2">
                      <kbd className={cx(composerKbdClass, 'transition-opacity duration-150', !draft.trim() && 'opacity-0')} aria-hidden>{mod}↩</kbd>
                      <button
                        type="button"
                        aria-label={box?.mode === 'answer' ? 'Send answer' : 'Send'}
                        aria-keyshortcuts={`${ariaMod}+Enter`}
                        title={`Send (${mod}↩)`}
                        disabled={!canSend}
                        onClick={send}
                        className={sendButtonClass}
                      >
                        {busy
                          ? <><LoaderCircle size={15} className="animate-spin motion-reduce:hidden" /><span className="hidden text-sm leading-none motion-reduce:inline">…</span></>
                          : <ArrowUp size={16} strokeWidth={2.25} />}
                      </button>
                    </div>
                  </div>
                )}
              {box?.mode === 'reply' && box.note && <p id="run-chat-note" className="-mt-1 px-4 text-xs text-muted">{box.note}</p>}
            </div>
          </footer>
        </div>
      )}
    </dialog>
  );
};
