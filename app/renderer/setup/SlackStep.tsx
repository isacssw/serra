// Step 2: the Slack app and its two tokens, in one step. Tokens already in `.env` or the Keychain are checked with
// Slack as the step opens (1Password ones wait for a click, so nothing prompts to unlock), and shown for the owner
// to confirm. A missing token is pasted here and stored in the Keychain; other sources use the Secrets editor.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SecretName, SecretStatus } from '../../../src/contracts.ts';
import type { SlackManifest } from '../../../src/setup.ts';
import { serra } from '../bridge.ts';
import { SecretCard } from '../screens/Secrets.tsx';
import { SECRET_PREFIXES, saveRequest } from '../screens/secrets.logic.ts';
import { BrandMark, Button, cx, Input, useToast } from '../ui/index.ts';
import { Alert, Card, errorText, StateIcon, StepFooter, StepHeader, type Tone } from './parts.tsx';
import { FLOW, nextPath, previousPath, tokenRefused, tokensToPrecheck, tokenText, toToken } from './setup.logic.ts';
import { setupChanged, useSetup } from './SetupState.tsx';

const step = FLOW[1]!;
const LABELS: Record<SecretName, string> = { SLACK_BOT_TOKEN: 'Bot token', SLACK_APP_TOKEN: 'App token' };

const TokenRow = ({ status, checking, workspace, onChange }: { status: SecretStatus; checking: boolean; workspace: string | null; onChange: (next: SecretStatus) => void }) => {
  const token = toToken(status);
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
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
    } catch (failure) { setValue(''); setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  const fieldId = `token-${status.name}`;
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5" data-token={status.name} data-state={token.state}>
      <div className="flex items-center gap-3">
        <StateIcon tone={tone} />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-[14px] font-medium">{label} <span className="font-mono text-[12px] font-normal text-muted">{SECRET_PREFIXES[status.name]}…</span></p>
          <p className={cx('text-[13px] break-words', token.state === 'rejected' && !busy ? 'text-down' : 'text-muted')} role="status" title={token.error ?? undefined}>
            {checking || busy ? 'Checking with Slack…' : tokenText(token, workspace)}
          </p>
        </div>
        {(token.state === 'found' || (token.state === 'rejected' && !refused)) && !checking && (
          <Button size="sm" onClick={() => void check()} disabled={busy}>{token.state === 'found' ? 'Check' : 'Check again'}</Button>
        )}
        {(token.state === 'verified' || (token.state === 'rejected' && !refused)) && !replacing && (
          <Button ref={replaceButton} size="sm" variant="ghost" onClick={startReplacing}>Replace</Button>
        )}
      </div>
      {showField && (
        <form className="flex items-start gap-2 pl-8" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input ref={field} id={fieldId} aria-label={`${label} value`} type="password" autoComplete="off" spellCheck={false} className="min-w-0 flex-1"
            placeholder={`Paste the ${SECRET_PREFIXES[status.name]} token`} value={value} disabled={busy}
            onChange={(event) => { setValue(event.target.value); setError(null); }} error={error} hint={status.source.kind !== 'keychain' && status.set ? `Saving moves it from ${token.where} to your Keychain.` : 'Stored in your Keychain. It never comes back to this window.'} />
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
  // Any token there means the app was made; whether each one works is the rows' business.
  const haveTokens = tokens.length > 0 && tokens.every((token) => token.state !== 'missing');
  const proceed = async () => {
    if (!connected) return;
    const latest = await refresh();
    void navigate(nextPath(latest ?? progress, step.path));
  };

  return (
    <div className="flex flex-col gap-8">
      <StepHeader step={step} icon={<BrandMark brand="slack" size={18} />} />
      {error && <Alert>{error}</Alert>}

      <section aria-labelledby="slack-app" className="flex flex-col gap-3">
        <h2 id="slack-app" className="text-[13px] font-medium text-muted">1 · The Slack app</h2>
        <Card className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <StateIcon tone={haveTokens ? 'done' : 'todo'} />
            <p className="min-w-0 flex-1 text-[13px]">
              {haveTokens ? 'Your app’s tokens are here.' : 'Create it from Serra’s manifest, then install it to your workspace.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            <Button variant={haveTokens ? 'secondary' : 'primary'} size="sm" icon={<ExternalLink size={13} aria-hidden />} disabled={!manifest}
              onClick={() => { if (manifest) serra()?.app.openExternal(manifest.createUrl).catch((failure) => setError(errorText(failure))); }}>
              Create in Slack
            </Button>
            <Button size="sm" icon={<Copy size={13} aria-hidden />} disabled={!manifest} onClick={() => void copy()}>Copy manifest</Button>
          </div>
          {manifest && (
            <details className="pl-8 text-[13px]">
              <summary className="w-fit cursor-pointer rounded text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">Show manifest</summary>
              <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-[11px]" data-manifest>{manifest.json}</pre>
            </details>
          )}
        </Card>
      </section>

      <section aria-labelledby="slack-tokens" className="flex flex-col gap-3">
        <h2 id="slack-tokens" className="text-[13px] font-medium text-muted">2 · Its tokens</h2>
        <p className="text-[13px] text-muted">
          The bot token is under <span className="text-ink">Install App</span>. The app token is under <span className="text-ink">Basic Information › App-Level Tokens</span>, with the <span className="font-mono text-[12px]">connections:write</span> scope.
        </p>
        <Card>
          {statuses
            ? <ul className="flex flex-col divide-y divide-line-subtle">{statuses.map((status) => <TokenRow key={status.name} status={status} checking={checking.includes(status.name)} workspace={workspace} onChange={replace} />)}</ul>
            : <p className="px-4 py-3.5 text-[13px] text-muted" role="status">Looking for tokens…</p>}
        </Card>
        <div>
          <Button variant="ghost" size="sm" className="-ml-2.5 text-muted" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            {advanced ? 'Hide other sources' : 'Use 1Password or .env instead'}
          </Button>
        </div>
        {advanced && statuses?.map((status) => (
          <SecretCard key={status.name} status={status} now={new Date()} onSaved={replace} onChecked={replace} />
        ))}
      </section>

      <StepFooter back={previousPath(step.path)}>
        {!connected && <span id="slack-continue-note" className="text-[13px] text-muted">Both tokens need a passing check.</span>}
        <Button variant="primary" aria-disabled={connected ? undefined : true} aria-describedby={connected ? undefined : 'slack-continue-note'} onClick={() => void proceed()}>
          Continue
        </Button>
      </StepFooter>
    </div>
  );
};
