// Settings › App › Profiles (SB-10): every profile in ⌘ order, dragged (or Alt+↑↓) to reorder, and a detail with its
// state, agent, colour and Remove. Remove stops the bot, saves a checked backup, then moves the folder to the Trash.
import { useEffect, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Archive, ChevronLeft, ChevronRight, GripVertical, Laptop, Plus, Power, Server, Trash2 } from 'lucide-react';
import type { BackupView } from '../../../main/bridge.ts';
import { backupLine } from '../../moves.logic.ts';
import { openMove, useRunningMove } from '../../shell/MoveDialog.tsx';
import { useNavigate } from 'react-router';
import { serra } from '../../bridge.ts';
import { profileRows, takenColors, type ProfileRow } from '../../profiles.logic.ts';
import { useBotStatus } from '../../shell/live.ts';
import { mod } from '../../shell/keys.ts';
import { useProfiles } from '../../shell/profiles.tsx';
import { openAdd } from '../../shell/AddSheet.tsx';
import { serverPath } from '../../servers.logic.ts';
import { Avatar, Button, cx, Dialog, Page, useToast } from '../../ui/index.ts';

const message = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

const dotText: Record<string, string> = { up: 'text-up', warn: 'text-warn', down: 'text-down', faint: 'text-faint', hollow: 'text-faint', none: 'text-faint' };

const List = ({ rows, onOpen }: { rows: ProfileRow[]; onOpen: (ref: string) => void }) => {
  const { view, servers, refresh } = useProfiles();
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  // Only this Mac's profiles have a place in the ⌘ order for now; a server's follow them (SB-33).
  const many = rows.filter((row) => !row.server).length > 1;
  // Where shows from the first paired server (UX rule D4); before that the list is as it was.
  const where = servers.length > 0;
  const open = (row: ProfileRow): void => { onOpen(row.ref); };

  const move = async (ref: string, index: number): Promise<void> => {
    try { await serra()?.profiles.move(ref, index); await refresh(); }
    catch (failure) { toast({ message: message(failure), tone: 'error' }); }
  };
  const onKey = (event: KeyboardEvent<HTMLLIElement>, row: ProfileRow, index: number): void => {
    if (event.key === 'Enter') { open(row); return; }
    if (row.server) return;
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    void move(row.ref, index + (event.key === 'ArrowUp' ? -1 : 1));
  };
  const onDrop = (event: DragEvent<HTMLLIElement>, index: number): void => {
    event.preventDefault();
    if (dragging) void move(dragging, index);
    setDragging(null);
  };

  return (
    <>
      <ul aria-label="Profiles" className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line bg-panel shadow-card">
        {rows.map((row, index) => (
          <li
            key={row.ref}
            tabIndex={0}
            draggable={many && !view?.pinned && !row.server}
            aria-label={`${row.name}, ${row.presence.phrase}${row.shortcut && many ? `, ${row.shortcut}` : ''}`}
            aria-keyshortcuts={many && !row.server ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
            data-profile={row.ref}
            onClick={() => open(row)}
            onKeyDown={(event) => onKey(event, row, index)}
            onDragStart={() => setDragging(row.ref)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => { if (dragging && !row.server) event.preventDefault(); }}
            onDrop={(event) => { if (!row.server) onDrop(event, index); }}
            className={cx(
              'group flex cursor-default items-center gap-3 px-4 py-3 outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
              dragging === row.ref && 'opacity-50',
            )}
          >
            {many && <GripVertical size={14} aria-hidden className={cx('shrink-0 cursor-grab text-faint', row.server && 'invisible')} />}
            <Avatar letters={row.letters} color={row.color} size={28} dot={row.presence.dot} pulse={row.presence.pulse} dashed={!row.setupDone} surface="panel" />
            <span className="flex min-w-24 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium">{row.name}</span>
              <span className="truncate text-xs text-muted">{row.server ? row.presence.phrase.replace(` · ${row.server.name}`, '') : row.presence.phrase}</span>
            </span>
            {where && (
              <span className="flex w-32 shrink-0 items-center gap-2 truncate text-[13px] text-muted" data-where>
                {row.server ? <Server size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" /> : <Laptop size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" />}
                <span className="truncate">{row.server ? row.server.name : 'This Mac'}</span>
              </span>
            )}
            {!row.server && <span className="w-28 shrink-0 truncate text-[13px] text-muted">{row.agent}</span>}
            {row.server && <span aria-hidden className="w-28 shrink-0" />}
            <ChevronRight size={14} aria-hidden className="shrink-0 text-faint" />
          </li>
        ))}
      </ul>
      {many && <p className="text-xs text-faint">This order is {mod}1…{mod}9.</p>}
    </>
  );
};

const RemoveDialog = ({ row, onClose, onRemoved }: { row: ProfileRow; onClose: () => void; onRemoved: () => void }) => {
  const toast = useToast();
  const { refresh } = useProfiles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const { backup } = await bridge.profiles.remove(row.ref);
      onRemoved();
      await refresh();
      toast({ message: `${row.name} removed · backup saved`, tone: 'success', action: { label: 'Show', onClick: () => { void bridge.profiles.showBackup(backup).catch(() => {}); } } });
    } catch (failure) { setError(message(failure)); setBusy(false); }
  };
  const steps = [
    { icon: Power, text: `Stop ${row.name}` },
    { icon: Archive, text: 'Save a backup' },
    { icon: Trash2, text: 'Remove it from this Mac' },
  ];
  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`Remove ${row.name}?`}
      actions={(
        <>
          <Button data-autofocus onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>{busy ? 'Removing…' : `Remove ${row.name}`}</Button>
        </>
      )}
    >
      <ul className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line">
        {steps.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-3 px-4 py-2.5 text-[13px]"><Icon size={15} strokeWidth={1.75} aria-hidden className="text-muted" />{text}</li>
        ))}
      </ul>
      <p className="text-[13px] text-muted">Its Slack app stays in Slack.</p>
      {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
    </Dialog>
  );
};

/** A profile's checked backups, on every host, each with Restore or why it can't (shown only when there are some). */
const Backups = ({ row }: { row: ProfileRow }) => {
  const [backups, setBackups] = useState<BackupView[]>([]);
  const move = useRunningMove();
  useEffect(() => {
    serra()?.moves.backups(row.ref).then(setBackups, () => setBackups([]));
  }, [row.ref, move?.state]);
  if (!backups.length) return null;
  return (
    <section className="flex flex-col gap-2" data-backups>
      <h2 className="text-[13px] text-muted">Backups</h2>
      <ul className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line bg-panel shadow-card">
        {backups.map((backup) => (
          <li key={`${backup.host}/${backup.id}`} className="flex min-h-12 items-center gap-3 px-5 py-2.5 text-[13px]" data-backup={backup.id}>
            <Archive size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate">{backupLine(backup)}</span>
              <span className="truncate text-xs text-muted">{[backup.hostName === 'this Mac' ? 'This Mac' : backup.hostName, backup.blocked].filter(Boolean).join(' · ')}</span>
            </span>
            <Button size="sm" disabled={backup.blocked !== null || move !== null} onClick={() => openMove({ kind: 'restore', ref: row.ref, backup })}>Restore…</Button>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Move to a server, or back to this Mac: one button per place it can go (shown from the first server, D4). */
const MoveSection = ({ row }: { row: ProfileRow }) => {
  const { servers } = useProfiles();
  const move = useRunningMove();
  if (!servers.length || !row.setupDone) return null;
  const ref = row.ref;
  const moving = move !== null && move.ref === ref;
  const places = row.server ? [{ to: 'local', label: 'Move back to this Mac…' }] : servers.map((server) => ({ to: server.id, label: `Move to ${server.name}…` }));
  return (
    <section className="flex items-center gap-4 rounded-xl border border-line bg-panel px-5 py-4 shadow-card" data-move-section>
      <div className="flex flex-1 flex-col">
        <h2 className="text-[13px] font-medium">{row.server ? `Move ${row.name} back` : `Move ${row.name}`}</h2>
        <p className="text-xs text-muted">{row.server ? row.server.name : 'This Mac'} keeps a backup.</p>
      </div>
      {moving
        ? <Button size="sm" onClick={() => openMove({ kind: 'move', ref, to: move.to })}>Show progress</Button>
        : places.map((place) => <Button key={place.to} size="sm" disabled={move !== null} onClick={() => openMove({ kind: 'move', ref, to: place.to })}>{place.label}</Button>)}
    </section>
  );
};

const Detail = ({ row, onBack }: { row: ProfileRow; onBack: () => void }) => {
  const navigate = useNavigate();
  const toast = useToast();
  const { view, refresh, servers } = useProfiles();
  const [removing, setRemoving] = useState(false);
  const remote = row.server !== null;
  const taken = takenColors(view?.profiles ?? [], row.ref);
  const pick = async (color: string): Promise<void> => {
    try { await serra()?.profiles.setColor(row.ref, color); await refresh(); }
    catch (failure) { toast({ message: message(failure), tone: 'error' }); }
  };
  const line = 'flex min-h-14 items-center gap-4 px-5 py-3';
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-8 pt-3 pb-10">
      <button type="button" onClick={onBack} className="-ml-1 flex w-fit items-center gap-1 rounded text-[13px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
        <ChevronLeft size={14} aria-hidden />Profiles
      </button>
      <header className="flex items-center gap-4">
        <Avatar letters={row.letters} color={row.color} size={44} dashed={!row.setupDone} />
        <h1 className="text-xl leading-7 font-semibold tracking-[-0.012em]">{row.name}</h1>
      </header>
      <section className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line bg-panel shadow-card">
        <div className={line}>
          <span className="w-24 shrink-0 text-[13px] text-muted">Status</span>
          <span className="flex flex-1 items-center gap-2 text-[13px]">
            {row.presence.dot !== 'none' && <span aria-hidden className={cx('text-[10px]', dotText[row.presence.dot])}>●</span>}
            {row.presence.phrase}
          </span>
          {!row.setupDone && row.active && <Button size="sm" onClick={() => void navigate('/setup')}>Finish setup</Button>}
        </div>
        {servers.length > 0 && (
          <div className={line}>
            <span className="w-24 shrink-0 text-[13px] text-muted">Where</span>
            <span className="flex-1 text-[13px]">{row.server ? row.server.name : 'This Mac'}</span>
            {row.server && <Button size="sm" variant="ghost" onClick={() => void navigate(serverPath(row.server!.id))}>Open</Button>}
          </div>
        )}
        {!remote && <div className={line}>
          <span className="w-24 shrink-0 text-[13px] text-muted">Agent</span>
          <span className="flex-1 text-[13px]">{row.agent}</span>
          {row.active && <Button size="sm" variant="ghost" onClick={() => void navigate('/settings/worker')}>Change</Button>}
        </div>}
        {!remote && <div className={line}>
          <span id="colour-label" className="w-24 shrink-0 text-[13px] text-muted">Colour</span>
          <div role="radiogroup" aria-labelledby="colour-label" className="flex flex-wrap gap-2">
            {(view?.palette ?? []).map((color) => {
              const chosen = color === row.color;
              const off = taken.has(color) && !chosen;
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-label={off ? `${color}, taken` : color}
                  disabled={off}
                  onClick={() => void pick(color)}
                  className={cx(
                    'relative size-7 rounded-[7px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    chosen && 'ring-2 ring-ink ring-offset-2 ring-offset-panel',
                  )}
                  style={{ backgroundColor: color }}
                >
                  {off && <span aria-hidden className="absolute inset-0 m-auto h-[1.5px] w-[130%] -translate-x-[12%] -rotate-45 bg-avatar-ink/90" />}
                </button>
              );
            })}
          </div>
        </div>}
      </section>
      <MoveSection row={row} />
      <Backups row={row} />
      {!remote && !(view?.pinned && row.active) && (
        <section className="flex items-center gap-4 rounded-xl border border-line bg-panel px-5 py-4 shadow-card">
          <div className="flex flex-1 flex-col">
            <h2 className="text-[13px] font-medium">Remove {row.name}</h2>
            <p className="text-xs text-muted">Stops it and keeps a backup first.</p>
          </div>
          <Button size="sm" className="text-down!" onClick={() => setRemoving(true)}>Remove…</Button>
        </section>
      )}
      {removing && <RemoveDialog row={row} onClose={() => setRemoving(false)} onRemoved={onBack} />}
    </div>
  );
};

export const Profiles = () => {
  const status = useBotStatus();
  const { view, servers } = useProfiles();
  const [open, setOpen] = useState<string | null>(null);
  const rows = profileRows(view, status, mod, servers);
  const selected = rows.find((row) => row.ref === open);
  if (selected) return <Detail row={selected} onBack={() => setOpen(null)} />;
  return (
    <Page
      title="Profiles"
      actions={view && !view.pinned ? <Button icon={<Plus size={14} aria-hidden />} onClick={() => openAdd()}>Add…</Button> : undefined}
    >
      {view === null ? <p role="status" className="text-[13px] text-muted">Loading…</p> : <List rows={rows} onOpen={setOpen} />}
    </Page>
  );
};
