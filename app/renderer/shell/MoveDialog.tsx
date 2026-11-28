// Moving a profile, moving it back, and restoring it (SB-34): one dialog, open from anywhere through `openMove`.
// It confirms (three promises, at most one thing in the way, how long the bot is away, one button naming the
// profile), then follows the steps as main pushes them. Hidden, it keeps going; the end is one toast. A move left
// part way by a quit settles by itself when the app is back (council): the dialog only shows it if a server was away.
import { useEffect, useState } from 'react';
import { Archive, ArrowRight, Check, CircleAlert, Clock, Laptop, LoaderCircle, Server, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { BackupView, MovePreflight, MoveView } from '../../main/bridge.ts';
import { serra } from '../bridge.ts';
import {
  awayLine, moveEnding, movePromises, moveSteps, moveTitle, progressTitle, restorePromises, restoreTitle, stopLabel, type StepLine,
} from '../moves.logic.ts';
import { serverPath } from '../servers.logic.ts';
import { Button, cx, Dialog, useToast } from '../ui/index.ts';
import { useProfiles } from './profiles.tsx';

export type MoveRequest =
  | { kind: 'move'; ref: string; to: string }
  | { kind: 'restore'; ref: string; backup: BackupView };

const OPEN_MOVE = 'serra:open-move';

const isRequest = (value: unknown): value is MoveRequest => {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = Reflect.get(value, 'kind');
  return typeof Reflect.get(value, 'ref') === 'string' && (kind === 'move' ? typeof Reflect.get(value, 'to') === 'string' : kind === 'restore');
};

/** Opens the confirm for a move or a restore. */
export const openMove = (request: MoveRequest): void => { window.dispatchEvent(new CustomEvent(OPEN_MOVE, { detail: request })); };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const HostIcon = ({ where }: { where: string }) => (
  <span aria-hidden className="grid size-8 place-items-center rounded-lg border border-line bg-canvas text-muted">
    {where === 'local' ? <Laptop size={15} strokeWidth={1.75} /> : <Server size={15} strokeWidth={1.75} />}
  </span>
);

const Route = ({ from, to }: { from: string; to: string }) => (
  <span className="flex items-center gap-2">
    <HostIcon where={from} />
    {from !== to && <><ArrowRight size={14} aria-hidden className="text-faint" /><HostIcon where={to} /></>}
  </span>
);

const StepIcon = ({ state }: { state: StepLine['state'] }) => {
  if (state === 'done') return <span aria-hidden className="grid size-4 place-items-center rounded-full border-[1.5px] border-up text-up"><Check size={10} strokeWidth={3} /></span>;
  if (state === 'now') return <LoaderCircle size={16} aria-hidden className="text-muted motion-safe:animate-spin" />;
  if (state === 'blocked') return <CircleAlert size={16} aria-hidden className="text-warn" />;
  return <span aria-hidden className="size-4 rounded-full border-[1.5px] border-line-control" />;
};

const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line">{children}</ul>
);

/** The confirm: what it promises, what is in the way (one thing at most), and the one button. */
const Confirm = ({ request, onClose, onStarted }: { request: MoveRequest; onClose: () => void; onStarted: (move: MoveView) => void }) => {
  const navigate = useNavigate();
  const [check, setCheck] = useState<MovePreflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    const asked = request.kind === 'move' ? bridge.moves.preflight(request.ref, request.to) : bridge.moves.restorePreflight(request.ref, request.backup.id);
    asked.then(setCheck, (failure: unknown) => setError(message(failure)));
  }, [request]);
  const go = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try { onStarted(request.kind === 'move' ? await bridge.moves.start(request.ref, request.to) : await bridge.moves.restore(request.ref, request.backup.id)); }
    catch (failure) { setError(message(failure)); setBusy(false); }
  };
  const name = check?.name ?? '';
  const words = request.kind === 'move' ? moveTitle(name, check?.toName ?? '') : restoreTitle(name, request.backup);
  const promises = request.kind === 'move' ? movePromises(check?.fromName ?? '') : restorePromises(name);
  const icons = request.kind === 'move' ? [Clock, ShieldCheck, Archive] : [Archive, ShieldCheck];
  const block = check?.blocks[0] ?? null;
  const server = request.kind === 'move' ? (request.to !== 'local' ? request.to : request.ref.split('/')[0]!) : request.ref.split('/')[0]!;
  const fromKey = request.ref.split('/')[0]!;
  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={check ? words.title : 'Checking…'}
      actions={(
        <>
          <Button data-autofocus onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void go()} disabled={busy || !check || block !== null}>{busy ? 'Starting…' : check ? words.button : 'Move'}</Button>
        </>
      )}
    >
      <div data-move-confirm={request.kind} className="flex flex-col gap-4">
        <Route from={fromKey} to={request.kind === 'move' ? request.to : fromKey} />
        <List>
          {promises.map((text, index) => {
            const Icon = icons[index]!;
            return <li key={text} className="flex items-center gap-3 px-4 py-2.5 text-[13px]"><Icon size={15} strokeWidth={1.75} aria-hidden className="text-muted" />{text}</li>;
          })}
        </List>
        {block && (
          <p role="status" data-move-block={block.kind} className="flex items-center gap-2 text-[13px]">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-warn" />
            <span className="flex-1">{block.text}</span>
            {block.kind === 'waiting' && <Button size="sm" onClick={() => { onClose(); void navigate('/jobs'); }}>Open</Button>}
            {block.kind === 'update' && <Button size="sm" onClick={() => { onClose(); void navigate(serverPath(server)); }}>Update</Button>}
          </p>
        )}
        {check && !block && <p className="text-[13px] text-muted">{awayLine(name, check.awayMinutes)}</p>}
        {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
      </div>
    </Dialog>
  );
};

/** The steps as they go. Hide keeps it running; Move later or Cancel while it still can stop. */
const Progress = ({ move, onHide }: { move: MoveView; onHide: () => void }) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = stopLabel(move);
  const steps = moveSteps(move);
  const resume = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try { await serra()?.moves.resume(move.id); } catch (failure) { setError(message(failure)); }
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onHide}
      title={progressTitle(move)}
      actions={(
        <>
          {stop && <Button onClick={() => { void serra()?.moves.stop(move.id); }}>{stop}</Button>}
          {move.state === 'interrupted' && <Button disabled={busy} onClick={() => void resume()}>{busy ? 'Trying…' : 'Try again'}</Button>}
          <Button variant="primary" data-autofocus onClick={onHide}>Hide</Button>
        </>
      )}
    >
      <div data-move-progress={move.step} className="flex flex-col gap-4">
        <Route from={move.from} to={move.to} />
        <List>
          {steps.map((step) => (
            <li key={step.text} data-step-state={step.state} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <StepIcon state={step.state} />
              <span className={cx('flex-1', step.state === 'todo' && 'text-muted', step.state === 'now' && 'font-medium')}>{step.text}</span>
              {step.detail && <span className={cx('text-xs', step.state === 'blocked' ? 'text-warn' : 'text-muted')}>{step.detail}</span>}
            </li>
          ))}
        </List>
        {move.state === 'interrupted'
          ? <p className="text-[13px] text-muted">{move.error ? `${move.error.replace(/\.$/, '')}. ` : ''}It finishes when {move.to === 'local' ? move.fromName : move.toName} answers.</p>
          : <p className="text-[13px] text-muted">Your other profiles keep working.</p>}
        {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
      </div>
    </Dialog>
  );
};

export const MoveDialog = () => {
  const toast = useToast();
  const { refresh } = useProfiles();
  const [request, setRequest] = useState<MoveRequest | null>(null);
  const [move, setMove] = useState<MoveView | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    const told = new Set<string>();
    const ended = (view: MoveView): void => {
      const ending = moveEnding(view);
      // The last step's push and the end's both say it ended: one toast.
      if (!ending || told.has(view.id)) return;
      told.add(view.id);
      void bridge.moves.dismiss(view.id).catch(() => {});
      void refresh();
      toast({
        message: ending.message, tone: ending.tone,
        ...(ending.moveBack ? { action: { label: 'Move back', onClick: () => openMove({ kind: 'move', ref: `${view.to}/${view.ref.split('/')[1]}`, to: view.from }) } } : {}),
      });
    };
    const seen = (view: MoveView): void => {
      setMove(view.state === 'running' || view.state === 'interrupted' ? view : null);
      ended(view);
    };
    // Back after a quit: one still going (or waiting on a server) shows again; one that ended says how.
    bridge.moves.list().then((views) => {
      for (const view of views) {
        seen(view);
        if (view.state === 'interrupted') setShown(true);
      }
    }, () => {});
    const off = bridge.on.move(seen);
    const onOpen = (event: Event): void => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (isRequest(detail)) setRequest(detail);
    };
    window.addEventListener(OPEN_MOVE, onOpen);
    return () => { off?.(); window.removeEventListener(OPEN_MOVE, onOpen); };
  }, [toast, refresh]);

  // A move running hides its confirm: the progress takes its place.
  if (move && (shown || request)) return <Progress move={move} onHide={() => { setShown(false); setRequest(null); }} />;
  if (request && !move) return <Confirm request={request} onClose={() => setRequest(null)} onStarted={(started) => { setMove(started); setShown(true); setRequest(null); }} />;
  return null;
};

/** Reopens the progress of the move running now (the profile's page shows `moving`). */
export const useRunningMove = (): MoveView | null => {
  const [move, setMove] = useState<MoveView | null>(null);
  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    bridge.moves.list().then((views) => setMove(views.find((view) => view.state === 'running' || view.state === 'interrupted') ?? null), () => {});
    return bridge.on.move((view) => setMove(view.state === 'running' || view.state === 'interrupted' ? view : null));
  }, []);
  return move;
};
