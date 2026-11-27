// Secrets (APP-15): a row per Slack token with where it comes from, its status and Replace…. The value is never
// shown or sent back to the window; a Keychain value typed here goes to main once and the field is cleared.
// `SecretCard` is the same editor as a card, for setup's Slack step.
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, FileText, KeyRound, RotateCw } from 'lucide-react';
import type { SecretName, SecretStatus } from '../../../src/contracts.ts';
import { serra } from '../bridge.ts';
import { Badge, BrandMark, Button, cx, Dialog, Input, Page, Select, useToast } from '../ui/index.ts';
import {
  draftFor, isDirty, keychainHint, saveRequest, SECRET_LABELS, SECRET_PREFIXES, sourceDetail, SOURCE_OPTIONS, statusLine,
  statusPill, type SecretDraft, type SourceKind, type StatusTone,
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
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-panel px-5 py-4" data-secret={status.name}>
      <h2 className="text-[15px] leading-5 font-semibold">{label}</h2>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          id={`${status.name}-source`}
          aria-label={`${label} source`}
          className="w-60"
          value={draft.kind}
          disabled={busy !== null}
          options={SOURCE_OPTIONS.map((option) => ({ value: option.kind, label: option.label }))}
          onChange={(kind) => { setDraft({ ...draft, kind }); setFormError(null); }}
        />
        <Button onClick={() => void check()} disabled={busy !== null || dirty} title={dirty ? 'Save the new source first' : undefined}>
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
          inputClassName="font-mono placeholder:font-sans"
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
          <Button variant="primary" onClick={() => void save()} disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          <Button variant="ghost" onClick={() => { setDraft(draftFor(status)); setFormError(null); }} disabled={busy !== null}>Cancel</Button>
        </div>
      )}
    </section>
  );
};

const SOURCE_ICONS: Record<SourceKind, ReactNode> = {
  keychain: <KeyRound size={14} strokeWidth={1.75} />,
  '1password': <BrandMark brand="onepassword" size={13} />,
  env: <FileText size={14} strokeWidth={1.75} />,
};

const PILL_TONES: Record<StatusTone, 'up' | 'down' | 'warn' | 'neutral'> = { ok: 'up', error: 'down', unset: 'warn', unverified: 'neutral' };

/** What the source dialog is for: a new source picked in the row, or Replace… on the current one. */
type SourceDialog = { kind: SourceKind; replace: boolean } | null;

const DIALOG_TITLES: Record<SourceKind, string> = { keychain: 'Store in Keychain', '1password': 'Use 1Password', env: 'Use the .env file' };

/** One token: its name and status, where it comes from, Check and Replace…. Changing the source goes through a dialog. */
const SecretRow = ({ status, now, onSaved, onChecked }: CardProps) => {
  const toast = useToast();
  const formId = useId();
  const [dialog, setDialog] = useState<SourceDialog>(null);
  const [draft, setDraft] = useState<SecretDraft>(() => draftFor(status));
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const label = SECRET_LABELS[status.name];
  const pill = statusPill(status, now);

  const open = (kind: SourceKind, replace: boolean): void => {
    setDraft({ ...draftFor(status), kind, value: '' });
    setFormError(null);
    setDialog({ kind, replace });
  };
  const close = (): void => { if (busy !== 'save') { setDialog(null); setDraft(draftFor(status)); } };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const missing = dialog?.kind === '1password' ? !draft.reference.trim() : dialog?.replace === true && dialog.kind === 'keychain' && !draft.value.trim();
    if (missing) { setFormError(dialog?.kind === '1password' ? 'Enter a 1Password reference.' : 'Paste the new token.'); return; }
    const request = saveRequest(status, draft);
    if ('error' in request) { setFormError(request.error); return; }
    const bridge = serra();
    if (!bridge) return;
    setBusy('save');
    setFormError(null);
    try {
      const saved = await bridge.secrets.setSource(status.name, request.source, request.value);
      setDialog(null);
      onSaved(saved);
      toast({ message: `${label} saved. Applies after a restart.`, tone: 'success' });
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      // The value is gone from the form whether or not the owner saves again.
      setDraft((current) => ({ ...current, value: '' }));
      setBusy(null);
    }
  };

  const check = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setBusy('check');
    try { onChecked(await bridge.secrets.check(status.name)); }
    catch (error) { toast({ message: errorText(error), tone: 'error' }); }
    finally { setBusy(null); }
  };

  const replacing = dialog?.replace === true;
  const needsValue = dialog?.kind === 'keychain' && (replacing || status.source.kind !== 'keychain');
  return (
    <li data-secret={status.name} className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3.5 pr-3 pl-4">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-canvas text-ink"><BrandMark brand="slack" size={14} /></span>
      <div className="flex min-w-[12rem] flex-1 basis-0 flex-col gap-0.5">
        <p className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{label}</span>
          <Badge tone={PILL_TONES[pill.tone]} title={status.error ?? undefined}>
            <span data-secret-status={pill.tone}>{pill.label}</span>
          </Badge>
        </p>
        <p className="truncate text-xs text-faint" title={status.error ?? pill.detail}>
          {status.set && <span aria-hidden className="mr-1.5 tracking-[0.2em]">••••</span>}{pill.detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span title={sourceDetail(status)}>
          <Select
            id={`${status.name}-source`}
            aria-label={`${label} source`}
            className="w-36"
            value={status.source.kind}
            disabled={busy !== null}
            options={SOURCE_OPTIONS.map((option) => ({ value: option.kind, label: option.label, icon: SOURCE_ICONS[option.kind] }))}
            onChange={(kind) => open(kind, false)}
          />
        </span>
        <Button variant="ghost" onClick={() => void check()} disabled={busy !== null}>{busy === 'check' ? 'Checking…' : 'Check'}</Button>
        {status.source.kind !== 'env' && (
          <Button onClick={() => open(status.source.kind, true)} disabled={busy !== null} aria-label={`Replace ${label}`}>
            {status.source.kind === '1password' ? 'Edit…' : 'Replace…'}
          </Button>
        )}
      </div>
      <Dialog
        open={dialog !== null}
        onClose={close}
        title={replacing ? `${status.source.kind === '1password' ? 'Edit' : 'Replace'} ${label}` : dialog ? DIALOG_TITLES[dialog.kind] : ''}
        description={dialog?.kind === 'env' ? 'Read from the profile’s .env, as the CLI does.' : 'Applies after a restart.'}
        actions={(
          <>
            <Button variant="ghost" onClick={close} disabled={busy === 'save'}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          </>
        )}
      >
        <form id={formId} onSubmit={(event) => { void save(event); }} className="flex flex-col gap-3">
          {dialog?.kind === 'keychain' && (
            <Input
              label="Token"
              type="password"
              data-autofocus
              placeholder={`${SECRET_PREFIXES[status.name]}…`}
              spellCheck={false}
              autoComplete="off"
              inputClassName="font-mono placeholder:font-sans"
              value={draft.value}
              hint={needsValue && !replacing ? 'Empty uses an item already in the Keychain.' : undefined}
              onChange={(event) => { setDraft({ ...draft, value: event.target.value }); setFormError(null); }}
            />
          )}
          {dialog?.kind === '1password' && (
            <Input
              label="Reference"
              data-autofocus
              inputClassName="font-mono placeholder:font-sans"
              placeholder="op://vault/item/field"
              spellCheck={false}
              autoComplete="off"
              value={draft.reference}
              hint="Read with the op CLI."
              onChange={(event) => { setDraft({ ...draft, reference: event.target.value }); setFormError(null); }}
            />
          )}
          {formError && <p role="alert" className="text-xs text-down">{formError}</p>}
        </form>
      </Dialog>
    </li>
  );
};

export const Secrets = () => {
  const toast = useToast();
  const now = useNow();
  const [statuses, setStatuses] = useState<SecretStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changed, setChanged] = useState<SecretName[]>([]);
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
    try { await bridge.bot.restart(); setChanged([]); toast({ message: 'Restarting the bot.', tone: 'success' }); }
    catch (error) { toast({ message: errorText(error), tone: 'error' }); }
    finally { setRestarting(false); }
  };

  return (
    <Page title="Secrets" subtitle="Where the bot reads its Slack tokens." width="narrow">
      {changed.length > 0 && (
        <div role="status" className="flex items-center gap-3 rounded-xl bg-raised py-2 pr-2 pl-4 text-[13px]">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
          <span className="min-w-0 flex-1"><span className="font-medium text-ink">Restart to apply</span><span className="text-muted"> · {changed.map((name) => SECRET_LABELS[name]).join(', ')}</span></span>
          <Button size="sm" icon={<RotateCw size={13} aria-hidden />} onClick={() => void restart()} disabled={restarting}>Restart bot</Button>
        </div>
      )}
      {loadError && (
        <div role="alert" className="flex items-center gap-3 rounded-xl border border-down/30 bg-down/8 px-4 py-2.5 text-[13px] text-ink">
          <CircleAlert size={15} className="text-down" aria-hidden />
          <span className="flex-1">{loadError}</span>
          <Button size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      {!statuses && !loadError && <p className="text-[13px] text-muted">Reading token sources…</p>}
      {statuses && (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {statuses.map((status) => (
            <SecretRow
              key={status.name}
              status={status}
              now={now}
              onSaved={(next) => { replace(next); setChanged((list) => (list.includes(next.name) ? list : [...list, next.name])); }}
              onChecked={replace}
            />
          ))}
        </ul>
      )}
    </Page>
  );
};
