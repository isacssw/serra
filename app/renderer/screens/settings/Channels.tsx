// Settings › Channels (SB-5): where people reach the bot. Slack, set up in setup, and Telegram, connected here: paste
// the token @BotFather gives, then open the bot from the link to make it yours. One row per chat, one action each.
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Send } from 'lucide-react';
import type { BotStatus, ChannelsView } from '../../../../src/contracts.ts';
import { serra } from '../../bridge.ts';
import { useBotStatus } from '../../shell/live.ts';
import { Badge, BrandMark, Button, Dialog, Input, Page, useToast } from '../../ui/index.ts';
import { slackRow, telegramRow, tokenProblem, type RowState } from './channels.logic.ts';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const Row = ({ icon, name, detail, state, children }: { icon: ReactNode; name: string; detail?: ReactNode; state: RowState; children?: ReactNode }) => (
  <li className="flex items-center gap-3 px-4 py-3.5">
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink">{icon}</span>
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">{name}<Badge tone={state.tone} className="whitespace-nowrap">{state.label}</Badge></span>
      {detail && <span className="truncate text-[13px] text-muted">{detail}</span>}
    </div>
    <div className="flex shrink-0 items-center gap-1.5">{children}</div>
  </li>
);

/** The bot picks up a channel change when it restarts: done for the owner when it is running. */
const useApply = (status: BotStatus | null) => {
  const toast = useToast();
  return useCallback(async () => {
    const bridge = serra();
    if (!bridge || status?.state !== 'up') return;
    try { await bridge.bot.restart(); }
    catch { toast({ message: 'Restart the bot to apply this.', tone: 'info' }); }
  }, [status, toast]);
};

const ConnectDialog = ({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: (view: ChannelsView) => void }) => {
  const formId = useId();
  const [token, setToken] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setToken(''); setTried(false); setError(null); } }, [open]);
  const problem = tokenProblem(token);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setTried(true);
    const bridge = serra();
    if (problem || !bridge) return;
    setBusy(true);
    setError(null);
    try {
      const view = await bridge.channels.connectTelegram(token);
      setToken('');
      onConnected(view);
    } catch (caught) {
      setError(errorText(caught));
    } finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect Telegram"
      description={<>Ask <button type="button" className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink" onClick={() => { void serra()?.app.openExternal('https://t.me/BotFather'); }}>@BotFather</button> for a new bot, then paste its token.</>}
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
        </>
      )}
    >
      <form id={formId} onSubmit={(event) => { void submit(event); }}>
        <Input
          label="Bot token"
          data-autofocus
          type="password"
          autoComplete="off"
          spellCheck={false}
          inputClassName="font-mono placeholder:font-sans"
          placeholder="123456:ABC…"
          value={token}
          error={error ?? (tried ? problem : null)}
          hint="Kept in your Keychain. A 1Password reference (op://…) works too."
          onChange={(event) => { setToken(event.target.value); setError(null); }}
        />
      </form>
    </Dialog>
  );
};

export const Channels = () => {
  const status = useBotStatus();
  const toast = useToast();
  const apply = useApply(status);
  const [view, setView] = useState<ChannelsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) return;
    try { setView(await bridge.channels.status()); setLoadError(null); }
    catch (error) { setLoadError(errorText(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While it waits for the owner to open the bot, look again now and then: pairing happens in Telegram.
  const pairing = view?.telegram.state === 'pairing';
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => { void load(); }, 3_000);
    return () => clearInterval(timer);
  }, [pairing, load]);

  const telegram = view?.telegram ?? null;
  const disconnect = async (): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setConfirming(false);
    try { setView(await bridge.channels.disconnectTelegram()); await apply(); toast({ message: 'Telegram disconnected.', tone: 'success' }); }
    catch (error) { toast({ message: errorText(error), tone: 'error' }); }
  };

  return (
    <Page title="Channels" subtitle="Where people can reach your bot.">
      {loadError && <p role="alert" className="rounded-xl border border-down/30 bg-down/8 px-4 py-2.5 text-[13px]">{loadError}</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-raised">
        <Row icon={<BrandMark brand="slack" />} name="Slack" detail="Mentions, DMs and threads in your workspace." state={slackRow(status)} />
        <Row
          icon={<BrandMark brand="telegram" />}
          name="Telegram"
          detail={telegram && telegram.state !== 'off' ? `@${telegram.username}` : 'Message your bot from your phone.'}
          state={telegramRow(telegram, status)}
        >
          {telegram?.state === 'off' && <Button variant="primary" size="sm" onClick={() => setConnecting(true)}>Connect</Button>}
          {telegram?.state === 'pairing' && (
            <Button variant="primary" size="sm" icon={<Send size={13} aria-hidden />} onClick={() => { void serra()?.app.openExternal(telegram.link); }}>Open in Telegram</Button>
          )}
          {telegram?.state === 'paired' && <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>Disconnect</Button>}
        </Row>
      </ul>
      {telegram?.state === 'pairing' && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          Open your bot in Telegram and tap Start. That makes it yours.
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>Disconnect</Button>
        </p>
      )}
      <ConnectDialog
        open={connecting}
        onClose={() => setConnecting(false)}
        onConnected={(next) => { setView(next); setConnecting(false); void apply(); }}
      />
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Disconnect Telegram?"
        description="Your bot stops answering there. You can connect it again any time."
        actions={(
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { void disconnect(); }}>Disconnect</Button>
          </>
        )}
      />
    </Page>
  );
};
