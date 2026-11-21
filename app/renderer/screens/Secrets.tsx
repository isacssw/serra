// Secrets (APP-15): one card per Slack token with its source, Check and the last result. The value is never shown
// or sent back to the window; a Keychain value typed here goes to main once and the field is cleared.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, KeyRound, RotateCw } from 'lucide-react';
import type { SecretStatus } from '../../../src/contracts.ts';
import { serra } from '../bridge.ts';
import { Badge, Button, cx, Input, Page, useToast } from '../ui/index.ts';
import {
  draftFor, isDirty, keychainHint, saveRequest, SECRET_LABELS, SECRET_PREFIXES, SOURCE_OPTIONS, statusLine,
  type SecretDraft, type SourceKind, type StatusTone,
} from './secrets.logic.ts';

const toneIcon: Record<StatusTone, ReactNode> = {
  ok: <CircleCheck size={18} className="shrink-0 text-up" aria-hidden />,
  error: <CircleAlert size={18} className="shrink-0 text-down" aria-hidden />,
  unverified: <CircleDashed size={18} className="shrink-0 text-muted" aria-hidden />,
  unset: <CircleDashed size={18} className="shrink-0 text-warn" aria-hidden />,
};

/** Re-renders every 30 s so "verified N min ago" stays current. */
const useNow = (): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface CardProps {
  status: SecretStatus;
  now: Date;
  /** A new source was saved: it applies after a restart. */
  onSaved: (status: SecretStatus) => void;
  onChecked: (status: SecretStatus) => void;
}

export const SecretCard = ({ status, now, onSaved, onChecked }: CardProps) => {
  const toast = useToast();
  const [draft, setDraft] = useState<SecretDraft>(() => draftFor(status));
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => { setDraft(draftFor(status)); setFormError(null); }, [status]);

  const line = statusLine(status, now);
  const dirty = isDirty(status, draft);
  const label = SECRET_LABELS[status.name];

  const save = async () => {
    const request = saveRequest(status, draft);
    if ('error' in request) { setFormError(request.error); return; }
    const bridge = serra();
    if (!bridge) return;
    setBusy('save');
    setFormError(null);
    try {
      const saved = await bridge.secrets.setSource(status.name, request.source, request.value);
      // The value is gone from the form whether or not the owner saves again.
      setDraft((current) => ({ ...current, value: '' }));
      onSaved(saved);
      toast({ message: `${label} source saved. Restart the bot to use it.`, tone: 'success' });
    } catch (error) {
      setDraft((current) => ({ ...current, value: '' }));
      setFormError(errorText(error));
    } finally { setBusy(null); }
  };

  const check = async () => {
    const bridge = serra();
    if (!bridge) return;
    setBusy('check');
    try { onChecked(await bridge.secrets.check(status.name)); }
    catch (error) { toast({ message: errorText(error), tone: 'error' }); }
    finally { setBusy(null); }
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-panel px-5 py-4" data-secret={status.name}>
      <h2 className="text-lg font-semibold">{label}</h2>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${status.name}-source`} className="text-sm text-muted">Source</label>
        <select
          id={`${status.name}-source`}
          value={draft.kind}
          disabled={busy !== null}
          onChange={(event) => { setDraft({ ...draft, kind: event.target.value as SourceKind }); setFormError(null); }}
          className="h-9 w-60 rounded-md border border-line bg-panel px-2.5 text-sm text-ink focus:outline-2 focus:outline-offset-1 focus:outline-focus"
        >
          {SOURCE_OPTIONS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
        </select>
        <Button onClick={check} disabled={busy !== null || dirty} title={dirty ? 'Save the new source first' : undefined}>
          {busy === 'check' ? 'Checking…' : 'Check'}
        </Button>
        <span className={cx('flex min-w-0 items-center gap-2 text-sm', line.tone === 'error' && 'text-down')} data-secret-status={line.tone}>
          {toneIcon[line.tone]}
          {status.set && <span aria-hidden className="tracking-widest text-muted">••••</span>}
          <span className="break-words">{line.text}</span>
        </span>
      </div>

      {draft.kind === '1password' && (
        <Input
          aria-label={`${label} 1Password reference`}
          inputClassName="font-mono"
          placeholder="op://vault/item/field"
          spellCheck={false}
          autoComplete="off"
          value={draft.reference}
          disabled={busy !== null}
          onChange={(event) => { setDraft({ ...draft, reference: event.target.value }); setFormError(null); }}
          hint="Read with the 1Password CLI (op) when the bot starts and when you press Check."
        />
      )}
      {draft.kind === 'keychain' && (
        <Input
          aria-label={`${label} value`}
          type="password"
          placeholder={`${SECRET_PREFIXES[status.name]}…`}
          spellCheck={false}
          autoComplete="off"
          value={draft.value}
          disabled={busy !== null}
          onChange={(event) => { setDraft({ ...draft, value: event.target.value }); setFormError(null); }}
          hint={keychainHint(status)}
        />
      )}
      {draft.kind === 'env' && status.source.kind !== 'env' && (
        <p className="text-sm text-muted">The token will be read from the profile&apos;s .env file, as the CLI does.</p>
      )}

      {formError && <p role="alert" className="text-sm text-down">{formError}</p>}
      {dirty && (
        <div className="flex gap-2">
          <Button variant="primary" onClick={save} disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          <Button variant="ghost" onClick={() => { setDraft(draftFor(status)); setFormError(null); }} disabled={busy !== null}>Cancel</Button>
        </div>
      )}
    </section>
  );
};

export const Secrets = () => {
  const toast = useToast();
  const now = useNow();
  const [statuses, setStatuses] = useState<SecretStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setLoadError('The Serra bridge is not available in this window.'); return; }
    try { setStatuses(await bridge.secrets.list()); setLoadError(null); }
    catch (error) { setLoadError(errorText(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const replace = (next: SecretStatus) =>
    setStatuses((list) => list?.map((status) => (status.name === next.name ? next : status)) ?? [next]);

  const restart = async () => {
    const bridge = serra();
    if (!bridge) return;
    setRestarting(true);
    try { await bridge.bot.restart(); setChanged(false); toast({ message: 'Restarting the bot.', tone: 'success' }); }
    catch (error) { toast({ message: errorText(error), tone: 'error' }); }
    finally { setRestarting(false); }
  };

  return (
    <Page
      title="Secrets"
      subtitle="Where the Slack tokens come from. Values are never shown."
      actions={(
        <>
          <Badge tone={changed ? 'warn' : 'neutral'} title="The bot reads its tokens when it starts">Applies after restart</Badge>
          <Button variant={changed ? 'primary' : 'secondary'} icon={<RotateCw size={14} aria-hidden />} onClick={restart} disabled={restarting}>
            Restart
          </Button>
        </>
      )}
    >
      {loadError && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-down/40 px-4 py-3 text-sm text-down">
          <CircleAlert size={16} aria-hidden />
          <span className="flex-1">{loadError}</span>
          <Button size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      {!statuses && !loadError && (
        <p className="flex items-center gap-2 text-sm text-muted"><KeyRound size={16} aria-hidden /> Reading token sources…</p>
      )}
      {statuses?.map((status) => (
        <SecretCard
          key={status.name}
          status={status}
          now={now}
          onSaved={(next) => { replace(next); setChanged(true); }}
          onChecked={replace}
        />
      ))}
    </Page>
  );
};
