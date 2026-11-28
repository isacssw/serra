// Step 2: the Slack app and its two tokens, in one step. Tokens already in `.env` or the Keychain are checked with
// Slack as the step opens (1Password ones wait for a click, so nothing prompts to unlock), and shown for the owner
// to confirm. A missing token is pasted here and stored in the Keychain; other sources use the Secrets editor.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Copy, ExternalLink, KeyRound } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SecretName, SecretStatus } from '../../../src/contracts.ts';
import type { SlackManifest } from '../../../src/setup.ts';
import { serra } from '../bridge.ts';
import { SecretCard } from '../screens/Secrets.tsx';
import { SECRET_PREFIXES, saveRequest } from '../screens/secrets.logic.ts';
import { BrandMark, Button, cx, Input, useToast } from '../ui/index.ts';
import { Alert, Card, errorText, StateIcon, StepFooter, StepHeader, type Tone } from './parts.tsx';
import { FLOW, nextPath, previousPath, slackAppCard, tokenRefused, tokensToPrecheck, tokenText, toToken } from './setup.logic.ts';
import { setupChanged, useSetup } from './SetupState.tsx';

const step = FLOW[1]!;
const LABELS: Record<SecretName, string> = { SLACK_BOT_TOKEN: 'Bot token', SLACK_APP_TOKEN: 'App token', TELEGRAM_BOT_TOKEN: 'Telegram token', DISCORD_BOT_TOKEN: 'Discord token' };
/** Where each token is in the Slack app's settings, said where it's pasted. */
const WHERE: Record<SecretName, string> = {
  SLACK_BOT_TOKEN: 'Install App › Bot User OAuth Token',
  SLACK_APP_TOKEN: 'Basic Information › App-Level Tokens (connections:write)',
  TELEGRAM_BOT_TOKEN: 'Settings › Channels',
  DISCORD_BOT_TOKEN: 'Settings › Channels',
};

const TokenRow = ({ status, checking, workspace, onChange }: { status: SecretStatus; checking: boolean; workspace: string | null; onChange: (next: SecretStatus) => void }) => {
  const token = toToken(status);
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLLIElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  // Opening the field puts focus in it; Cancel gives it back to Replace, so a screen reader never loses its place.
  const startReplacing = (): void => { setReplacing(true); requestAnimationFrame(() => field.current?.focus()); };
  const stopReplacing = (): void => { setReplacing(false); setValue(''); setError(null); requestAnimationFrame(() => replaceButton.current?.focus()); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = LABELS[status.name];
  // A token Slack refused needs a new value; one whose check couldn't run (offline, a locked source) only a retry.
  const refused = token.state === 'rejected' && tokenRefused(token.error);
  const showField = replacing || token.state === 'missing' || refused;
  const tone: Tone = checking || busy ? 'busy' : token.state === 'verified' ? 'done' : token.state === 'rejected' ? 'problem' : 'todo';

  const check = async () => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try { onChange(await bridge.secrets.check(status.name)); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    const bridge = serra();
    if (!bridge) return;
    const request = saveRequest(status, { kind: 'keychain', reference: '', value });
    if ('error' in request) { setError(request.error); return; }
    if (!request.value) { setError(`Paste the ${label.toLowerCase()} first.`); return; }
    setBusy(true);
    setError(null);
    try {
      const saved = await bridge.secrets.setSource(status.name, request.source, request.value);
      setValue('');
      onChange(saved);
      onChange(await bridge.secrets.check(status.name));
      setReplacing(false);
      // The field just went away: if focus was in it, it moves on to the next token still to paste or check, or to
      // Continue. Someone who moved elsewhere during a slow check stays where they are.
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body && !row.current?.contains(document.activeElement)) return;
        const next = document.querySelector<HTMLElement>('[data-token][data-state="missing"] input, [data-token][data-state="rejected"] input, [data-token] [data-token-check]')
          ?? document.querySelector<HTMLElement>('[data-slack-continue]');
        next?.focus();
      });
    } catch (failure) { setValue(''); setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  const fieldId = `token-${status.name}`;
  return (
    <li ref={row} className="flex flex-col gap-3 px-4 py-3.5" data-token={status.name} data-state={token.state}>
      <div className="flex items-center gap-3">
        <StateIcon tone={tone} />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-[14px] font-medium">{label}</p>
          {/* A missing token's empty field says it; the line stays for screen readers. */}
          <p className={cx('text-[13px] break-words', token.state === 'rejected' && !busy ? 'text-down' : 'text-muted', token.state === 'missing' && !checking && !busy && 'sr-only')} role="status" title={token.error ?? undefined}>
            {checking || busy ? 'Checking with Slack…' : tokenText(token, workspace)}
          </p>
        </div>
        {(token.state === 'found' || (token.state === 'rejected' && !refused)) && !checking && (
          <Button data-token-check size="sm" onClick={() => void check()} disabled={busy}>{token.state === 'found' ? 'Check' : 'Check again'}</Button>
        )}
        {(token.state === 'verified' || (token.state === 'rejected' && !refused)) && !replacing && (
          <Button ref={replaceButton} size="sm" variant="ghost" onClick={startReplacing}>Replace</Button>
        )}
      </div>
      {showField && (
        <form className="flex items-start gap-2 pl-8" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input ref={field} id={fieldId} aria-label={`${label} value`} type="password" autoComplete="off" spellCheck={false} className="min-w-0 flex-1" inputClassName="font-mono"
            placeholder={`Paste the ${SECRET_PREFIXES[status.name]} token`} value={value} disabled={busy}
            onChange={(event) => { setValue(event.target.value); setError(null); }} error={error} hint={status.source.kind !== 'keychain' && status.set ? `Saving moves it from ${token.where} to your Keychain` : WHERE[status.name]} />
          <Button type="submit" disabled={busy || !value.trim()}>Save</Button>
          {replacing && <Button variant="ghost" onClick={stopReplacing}>Cancel</Button>}
        </form>
      )}
      {!showField && error && <p role="alert" className="pl-8 text-[13px] text-down">{error}</p>}
    </li>
  );
};

export const SlackStep = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const { progress, refresh } = useSetup();
  const [statuses, setStatuses] = useState<SecretStatus[] | null>(null);
  const [checking, setChecking] = useState<SecretName[]>([]);
  const [manifest, setManifest] = useState<SlackManifest | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const prechecked = useRef(false);

  /** The workspace the bot token last checked against, so a verified row says which Slack it is. */
  const loadWorkspace = useCallback(() => {
    serra()?.setup.detect().then((found) => setWorkspace(found.selected?.workspace ?? null), () => {});
  }, []);
  const replace = useCallback((next: SecretStatus) => {
    setStatuses((list) => list?.map((status) => (status.name === next.name ? next : status)) ?? [next]);
    setupChanged();
    if (next.name === 'SLACK_BOT_TOKEN') loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    const bridge = serra();
    if (!bridge) return;
    loadWorkspace();
    bridge.setup.manifest().then(setManifest, (failure) => setError(errorText(failure)));
    bridge.secrets.list().then(async (list) => {
      setStatuses(list);
      if (prechecked.current) return;
      prechecked.current = true;
      // Found tokens are checked once, so the owner only has to confirm what Serra already has.
      const names = tokensToPrecheck(list);
      setChecking(names);
      for (const name of names) {
        try { replace(await bridge.secrets.check(name)); }
        catch { /* the row shows the stored error */ }
        setChecking((current) => current.filter((item) => item !== name));
      }
    }, (failure) => setError(errorText(failure)));
  }, [replace, loadWorkspace]);

  const copy = async () => {
    if (!manifest) return;
    try { await navigator.clipboard.writeText(manifest.json); toast({ message: 'Manifest copied.', tone: 'success' }); }
    catch (failure) { toast({ message: `Couldn’t copy: ${errorText(failure)}`, tone: 'error' }); }
  };

  const tokens = statuses?.map(toToken) ?? [];
  const connected = tokens.length > 0 && tokens.every((token) => token.state === 'verified');
  const appCard = slackAppCard(tokens);
  const proceed = async () => {
    if (!connected) return;
    const latest = await refresh();
    void navigate(nextPath(latest ?? progress, step.path));
  };

  // Once the app's tokens are in, the create and manifest tools step aside (a refused token brings them back).
  const making = appCard.create || appCard.tone === 'problem';
  return (
    <div className="flex flex-1 flex-col gap-6">
      <StepHeader step={step} icon={<BrandMark brand="slack" size={18} />} />
      {error && <Alert>{error}</Alert>}

      <section aria-label="The Slack app">
        <Card className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <StateIcon tone={appCard.tone} />
            <p className="min-w-0 flex-1 text-[13px]" role="status">{appCard.text}</p>
            {making && (
              <Button variant={appCard.create && !connected ? 'primary' : 'secondary'} size="sm" icon={<ExternalLink size={13} aria-hidden />} disabled={!manifest}
                onClick={() => { if (manifest) serra()?.app.openExternal(manifest.createUrl).catch((failure) => setError(errorText(failure))); }}>
                Create in Slack
              </Button>
            )}
          </div>
          {manifest && making && (
            <details className="group pl-8 text-[13px]">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden"><ChevronRight size={13} aria-hidden className="transition-transform group-open:rotate-90" />Manifest</summary>
              <div className="mt-2 flex flex-col items-start gap-2">
                <Button size="sm" icon={<Copy size={13} aria-hidden />} onClick={() => void copy()}>Copy manifest</Button>
                <pre className="max-h-56 w-full overflow-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-[11px]" data-manifest>{manifest.json}</pre>
              </div>
            </details>
          )}
        </Card>
      </section>

      <section aria-label="Its tokens" className="flex flex-col gap-3">
        <Card>
          {statuses
            ? <ul className="flex flex-col divide-y divide-line-subtle">{statuses.map((status) => <TokenRow key={status.name} status={status} checking={checking.includes(status.name)} workspace={workspace} onChange={replace} />)}</ul>
            : <p className="px-4 py-3.5 text-[13px] text-muted" role="status">Looking for tokens…</p>}
          <div className="flex items-center justify-between gap-3 border-t border-line-subtle py-1.5 pr-2 pl-4">
            <p className="flex items-center gap-1.5 text-xs text-faint"><KeyRound size={12} aria-hidden /> Pasted tokens go to your Keychain</p>
            <Button variant="ghost" size="sm" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}
              icon={<ChevronRight size={13} aria-hidden className={cx('transition-transform', advanced && 'rotate-90')} />}>
              {advanced ? 'Hide other token storage' : 'Other token storage'}
            </Button>
          </div>
        </Card>
        {advanced && statuses?.map((status) => (
          <SecretCard key={status.name} status={status} now={new Date()} onSaved={replace} onChecked={replace} />
        ))}
      </section>

      <StepFooter back={previousPath(step.path)}>
        {!connected && <span id="slack-continue-note" className="text-xs text-faint">Add and check both tokens to continue</span>}
        <Button data-slack-continue variant="primary" aria-disabled={connected ? undefined : true} aria-describedby={connected ? undefined : 'slack-continue-note'} onClick={() => void proceed()}>
          Continue
        </Button>
      </StepFooter>
    </div>
  );
};
