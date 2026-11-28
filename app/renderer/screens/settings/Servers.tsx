// Settings › App › Servers (SB-33), shown from the first paired server: each server with one dot and one word, and
// its page with Status (and the one thing to do about it), Profiles, the Diagnostics line, the devices that can
// reach it (Revoke for the others) and Forget, which unpairs this Mac and deletes nothing there.
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Laptop, Plus, RotateCw, Server } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import type { ServerDevice, ServerHealth, ServerUpdateView } from '../../../main/bridge.ts';
import { serra } from '../../bridge.ts';
import { profileRows } from '../../profiles.logic.ts';
import {
  ago, deviceLine, forgetBody, forgetToast, newProfileHint, serverAction, serverDiagnostics, serverPath, serverPresence, serverSubtitle,
  updateAction, updateEnding,
} from '../../servers.logic.ts';
import { useBotStatus } from '../../shell/live.ts';
import { useProfiles } from '../../shell/profiles.tsx';
import { openAdd } from '../../shell/AddSheet.tsx';
import { Avatar, Button, cx, Dialog, Page, useToast } from '../../ui/index.ts';

/** The time, ticking each minute, for `last seen` and `last used`. */
const useNow = (): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

const message = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

const Dot = ({ server }: { server: ServerHealth }) => {
  const look = serverPresence(server);
  return (
    <span className="flex shrink-0 items-center gap-2 text-[13px] text-muted" data-server-state={server.state}>
      <span
        aria-hidden
        className={cx(
          'size-2 rounded-full',
          look.dot === 'hollow' ? 'border-[1.5px] border-faint' : { up: 'bg-up', warn: 'bg-warn', down: 'bg-down', faint: 'bg-faint', none: '' }[look.dot],
          look.pulse && 'motion-safe:animate-pulse',
        )}
      />
      {look.word}
    </span>
  );
};

const ServerIcon = ({ size }: { size: 'sm' | 'lg' }) => (
  <span aria-hidden className={cx('grid shrink-0 place-items-center border border-line bg-canvas text-muted', size === 'sm' ? 'size-9 rounded-lg' : 'size-11 rounded-[10px]')}>
    <Server size={size === 'sm' ? 16 : 20} strokeWidth={1.75} />
  </span>
);

const List = ({ servers }: { servers: ServerHealth[] }) => {
  const navigate = useNavigate();
  const now = useNow();
  return (
    <ul aria-label="Servers" className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line bg-panel shadow-card">
      {servers.map((server) => (
        <li key={server.id}>
          <button
            type="button"
            data-server={server.id}
            aria-label={`${server.name}, ${serverPresence(server).word}`}
            onClick={() => void navigate(serverPath(server.id))}
            className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
          >
            <ServerIcon size="sm" />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium">{server.name}</span>
              <span className="truncate text-xs text-muted">{serverSubtitle(server, now)}</span>
            </span>
            <Dot server={server} />
            <ChevronRight size={14} aria-hidden className="shrink-0 text-faint" />
          </button>
        </li>
      ))}
    </ul>
  );
};

const RevokeDialog = ({ server, device, onClose, onDone }: {
  server: ServerHealth; device: ServerDevice; onClose: () => void; onDone: (devices: ServerDevice[]) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try { onDone(await serra()!.servers.revoke(server.id, device.id)); } catch (failure) { setError(message(failure)); setBusy(false); }
  };
  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`Revoke ${device.name}?`}
      actions={(
        <>
          <Button data-autofocus onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void revoke()} disabled={busy}>{busy ? 'Revoking…' : `Revoke ${device.name}`}</Button>
        </>
      )}
    >
      <p className="text-[13px] text-muted">It loses access to {server.name} right away.</p>
      {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
    </Dialog>
  );
};

const ForgetDialog = ({ server, onClose }: { server: ServerHealth; onClose: () => void }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const { servers } = useProfiles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forget = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { revoked } = await serra()!.servers.forget(server.id);
      toast({ message: forgetToast(server.name, revoked), tone: 'success' });
      // The last one gone, Settings › Servers hides again (UX rule D4).
      void navigate(servers.length > 1 ? '/settings/servers' : '/settings/profiles');
    } catch (failure) { setError(message(failure)); setBusy(false); }
  };
  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`Forget ${server.name}?`}
      actions={(
        <>
          <Button data-autofocus onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void forget()} disabled={busy}>{busy ? 'Forgetting…' : `Forget ${server.name}`}</Button>
        </>
      )}
    >
      <p className="text-[13px] text-muted">{forgetBody(server)}</p>
      {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
    </Dialog>
  );
};

/** Update t480: one confirm, then `Updating t480` until it says how it went. Its bots keep running their own copy. */
const UpdateDialog = ({ server, onClose }: { server: ServerHealth; onClose: () => void }) => {
  const toast = useToast();
  const [state, setState] = useState<ServerUpdateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const updating = busy || state?.state === 'updating';
  useEffect(() => {
    if (!updating) return;
    // The gateway restarts on the way: a call that fails meanwhile is just asked again.
    const timer = setInterval(() => {
      serra()?.servers.updateState(server.id).then((next) => {
        if (next.state && next.state !== 'updating') {
          setBusy(false);
          setState(next);
          if (next.state === 'done') { toast({ message: `${server.name} is updated`, tone: 'success' }); void serra()?.servers.retry(server.id); onClose(); }
        }
      }, () => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [updating, server.id, server.name, toast, onClose]);
  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try { setState(await serra()!.servers.update(server.id)); } catch (failure) { setError(message(failure)); setBusy(false); }
  };
  const ended = state?.state && state.state !== 'updating' && state.state !== 'done' ? updateEnding(server.name, state.state, state.message) : null;
  return (
    <Dialog
      open
      onClose={() => { if (!updating) onClose(); }}
      title={ended ? ended.title : updating ? `Updating ${server.name}` : `Update ${server.name}?`}
      actions={ended
        ? <Button variant="primary" data-autofocus onClick={onClose}>Close</Button>
        : (
          <>
            <Button data-autofocus onClick={onClose} disabled={updating}>Cancel</Button>
            <Button variant="primary" onClick={() => void start()} disabled={updating}>{updating ? 'Updating…' : `Update ${server.name}`}</Button>
          </>
        )}
    >
      <p className="text-[13px] text-muted" data-server-update={state?.state ?? 'confirm'}>
        {ended ? ended.body : `${server.name} is out of reach for about a minute. Its profiles keep running.`}
      </p>
      {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
    </Dialog>
  );
};

const Detail = ({ server }: { server: ServerHealth }) => {
  const navigate = useNavigate();
  const toast = useToast();
  const status = useBotStatus();
  const { view, servers } = useProfiles();
  const [devices, setDevices] = useState<ServerDevice[] | null>(null);
  const [revoking, setRevoking] = useState<ServerDevice | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [updating, setUpdating] = useState(false);
  const update = updateAction(server);
  const now = useNow();
  const up = server.state === 'up';
  const rows = profileRows(view, status, '⌘', servers).filter((row) => row.server?.id === server.id);
  const action = serverAction(server);

  // The devices are the server's to say: read when it is up, and again after each revoke.
  const loadDevices = useCallback(() => {
    if (!up) { setDevices(null); return; }
    serra()?.servers.devices(server.id).then(setDevices, () => setDevices(null));
  }, [server.id, up]);
  useEffect(loadDevices, [loadDevices]);

  const retry = async (): Promise<void> => {
    setRetrying(true);
    try { await serra()?.servers.retry(server.id); } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
    // The word changes when an answer comes; the button only stays busy for a moment.
    setTimeout(() => setRetrying(false), 1500);
  };

  const line = 'flex min-h-14 items-center gap-4 px-5 py-3';
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-8 pt-3 pb-10" data-server-detail={server.id}>
      <button type="button" onClick={() => void navigate('/settings/servers')} className="-ml-1 flex w-fit items-center gap-1 rounded text-[13px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
        <ChevronLeft size={14} aria-hidden />Servers
      </button>
      <header className="flex items-center gap-4">
        <ServerIcon size="lg" />
        <h1 className="text-xl leading-7 font-semibold tracking-[-0.012em]">{server.name}</h1>
      </header>
      <section className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line bg-panel shadow-card">
        <div className={line}>
          <span className="w-24 shrink-0 text-[13px] text-muted">Status</span>
          <span className="flex flex-1 items-center gap-2">
            <Dot server={server} />
            {server.state === 'offline' && server.lastSeen && <span className="text-xs text-faint">· last seen {ago(server.lastSeen, now)}</span>}
          </span>
          {action === 'retry' && <Button size="sm" icon={<RotateCw size={13} aria-hidden />} disabled={retrying} onClick={() => void retry()}>{retrying ? 'Retrying…' : 'Retry'}</Button>}
          {action === 'pair' && <Button size="sm" variant="primary" onClick={() => openAdd('server')}>Pair again</Button>}
          {!action && update?.target === 'server' && <Button size="sm" variant="primary" onClick={() => setUpdating(true)}>{update.label}</Button>}
          {!action && update?.target === 'app' && <Button size="sm" onClick={() => void navigate('/settings/updates')}>{update.label}</Button>}
        </div>
        <div className={line}>
          <span className="w-24 shrink-0 self-start pt-0.5 text-[13px] text-muted">Profiles</span>
          {rows.length ? (
            <span className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-2">
              {rows.map((row) => (
                <span key={row.ref} className="flex items-center gap-2 text-[13px]" aria-label={`${row.name}, ${row.presence.phrase.replace(` · ${server.name}`, '')}`}>
                  <Avatar letters={row.letters} color={row.color} size={18} dot={row.presence.dot} pulse={row.presence.pulse} surface="panel" />
                  {row.name}
                </span>
              ))}
            </span>
          ) : (
            <span className="flex flex-1 flex-col text-[13px]">
              <span>No profiles yet</span>
              <span className="text-xs text-muted">{newProfileHint(server.name)}</span>
            </span>
          )}
        </div>
        <div className={line}>
          <span className="w-24 shrink-0 text-[13px] text-muted">Diagnostics</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={serverDiagnostics(server)}>{serverDiagnostics(server)}</span>
        </div>
      </section>
      {devices && devices.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] text-muted">Devices that can reach {server.name}</h2>
          <ul className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line bg-panel shadow-card">
            {devices.map((device) => (
              <li key={device.id} className="flex min-h-12 items-center gap-3 px-5 py-2.5 text-[13px]" data-device={device.thisMac ? 'this-mac' : device.id}>
                <Laptop size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
                <span className="min-w-0 truncate">{device.name}</span>
                <span className="flex-1 truncate text-muted">· {deviceLine(device, now)}</span>
                {!device.thisMac && <Button size="sm" onClick={() => setRevoking(device)}>Revoke</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex items-center gap-4 rounded-xl border border-line bg-panel px-5 py-4 shadow-card">
        <div className="flex flex-1 flex-col">
          <h2 className="text-[13px] font-medium">Forget {server.name}</h2>
          <p className="text-xs text-muted">Disconnects this Mac. Nothing on {server.name} is deleted.</p>
        </div>
        <Button size="sm" className="text-down!" onClick={() => setForgetting(true)}>Forget…</Button>
      </section>
      {revoking && <RevokeDialog server={server} device={revoking} onClose={() => setRevoking(null)} onDone={(next) => { setDevices(next); setRevoking(null); toast({ message: `${revoking.name} revoked`, tone: 'success' }); }} />}
      {forgetting && <ForgetDialog server={server} onClose={() => setForgetting(false)} />}
      {updating && <UpdateDialog server={server} onClose={() => setUpdating(false)} />}
    </div>
  );
};

export const Servers = () => {
  const { servers } = useProfiles();
  const [params] = useSearchParams();
  const selected = servers.find((server) => server.id === params.get('server'));
  if (selected) return <Detail server={selected} />;
  return (
    <Page title="Servers" actions={<Button icon={<Plus size={14} aria-hidden />} onClick={() => openAdd('server')}>Add…</Button>}>
      {servers.length ? <List servers={servers} /> : <p className="text-[13px] text-muted">No servers yet.</p>}
    </Page>
  );
};
