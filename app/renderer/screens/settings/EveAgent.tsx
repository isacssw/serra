// eve on Vercel in Settings › Worker (SB-17). Without one: a "Connect eve agent" card beside "Add ACP agent", opening
// the same form as Add… › Profile; its button names the host and Checks before anything is saved. With one: a calm
// row under the agent cards with its host, the last Check's one line, Check, and a Remove that names the host.
import { useId, useState, type FormEvent } from 'react';
import { Cloud } from 'lucide-react';
import { serra } from '../../bridge.ts';
import { emptyEveForm, EveFields, type EveForm } from '../../setup/EveFields.tsx';
import { eveContinueLabel, eveHost } from '../../setup/eve.logic.ts';
import { Button, cx, Dialog, useToast } from '../../ui/index.ts';
import type { AgentBackend } from './AgentBackend.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The card that adds eve on Vercel to this profile. Hidden once it has one. */
export const ConnectEveCard = ({ backend }: { backend: AgentBackend }) => {
  const toast = useToast();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EveForm>(emptyEveForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { view, setView } = backend;
  if (!view || view.eve) return null;
  const host = eveHost(form.url);

  const close = (): void => { if (!busy) setOpen(false); };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const bridge = serra();
    if (!bridge) return;
    if (!host) { setError('Enter the agent’s URL, like https://researcher.vercel.app.'); return; }
    setBusy(true);
    setError(null);
    try {
      setView(await bridge.meetings.connectEve({ url: form.url, team: form.team, secret: form.secret, accept: host }));
      setOpen(false);
      toast({ message: `Connected ${host}. New jobs run there.`, tone: 'success' });
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { setForm(emptyEveForm); setError(null); setOpen(true); }}
        className={cx(
          'flex min-h-[3.75rem] items-center gap-3 rounded-xl border border-dashed border-line-control px-3 py-2.5 text-left text-[13px] font-medium text-ink',
          'transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring',
        )}
      >
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-muted"><Cloud size={15} strokeWidth={1.75} /></span>
        Connect eve agent
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Connect eve agent"
        description="An eve agent deployed on Vercel, signed in with your own Vercel login."
        actions={(
          <>
            <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Checking…' : eveContinueLabel(host, 'Connect')}</Button>
          </>
        )}
      >
        <form id={formId} noValidate onSubmit={(event) => { void submit(event); }}>
          <EveFields form={form} onChange={(next) => { setForm(next); setError(null); }} error={error} autoFocus />
        </form>
      </Dialog>
    </>
  );
};

/** The connected eve: its host, the last Check in one line, Check, and Remove {host}. */
export const EveStatus = ({ backend }: { backend: AgentBackend }) => {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { view, setView } = backend;
  const eve = view?.eve;
  if (!eve) return null;
  const ok = eve.check?.result === 'ok';

  const check = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setChecking(true);
    try {
      // Blank secret: the saved one. The notice for this host was accepted when it was connected.
      await bridge.meetings.checkEve({ url: eve.url, team: eve.team, secret: null, accept: eve.host });
      setView(await bridge.meetings.agentBackend());
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
    finally { setChecking(false); }
  };
  const remove = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setRemoving(true);
    try {
      setView(await bridge.meetings.disconnectEve());
      setConfirm(false);
      toast({ message: `Removed ${eve.host}. New jobs run on T3.`, tone: 'success' });
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); }
    finally { setRemoving(false); }
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5" data-eve-status>
      <Cloud size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-5 font-medium">{eve.host}</span>
        <span role="status" className={cx('text-xs leading-4 text-pretty', !eve.check ? 'text-faint' : ok ? 'text-muted' : 'text-down')}>
          {checking ? 'Checking…' : eve.check ? eve.check.sentence : 'Not checked yet'}
        </span>
      </div>
      <Button size="sm" disabled={checking || removing} onClick={() => void check()}>Check</Button>
      <Button size="sm" variant="ghost" aria-label={`Remove ${eve.host}`} disabled={checking || removing} onClick={() => setConfirm(true)}>Remove</Button>
      <Dialog
        open={confirm}
        onClose={() => { if (!removing) setConfirm(false); }}
        title={`Remove ${eve.host}?`}
        description="New jobs run on T3. Its bypass secret is deleted from Keychain."
        actions={(
          <>
            <Button variant="ghost" disabled={removing} onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={removing} onClick={() => void remove()}>{removing ? 'Removing…' : `Remove ${eve.host}`}</Button>
          </>
        )}
      />
    </div>
  );
};
