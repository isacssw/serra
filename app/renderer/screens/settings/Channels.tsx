// Settings › Channels (SB-5, SB-6): where people reach the bot. Slack, set up in setup (not set up on a bot that began on
// Telegram or Discord); Telegram and Discord, connected
// here: paste the bot's token, then make the bot yours (Telegram: open it from the link; Discord: add it to a server
// and DM it the code). One row per chat, one action each.
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Copy, Plus, Send } from 'lucide-react';
import type { BotStatus, ChannelsView } from '../../../../src/contracts.ts';
import { serra } from '../../bridge.ts';
import { useBotStatus } from '../../shell/live.ts';
import { useSetup } from '../../setup/SetupState.tsx';
import { Badge, BrandMark, Button, Dialog, Input, Page, useToast } from '../../ui/index.ts';
import { discordRow, discordTokenProblem, slackRow, spacedCode, telegramRow, tokenProblem, type RowState } from './channels.logic.ts';

type Chat = 'telegram' | 'discord';
const CHAT_NAMES: Record<Chat, string> = { telegram: 'Telegram', discord: 'Discord' };

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

const linkButton = 'font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink';

/** What the Connect dialog asks for each chat. */
const CONNECT: Record<Chat, { description: ReactNode; placeholder: string; problem: (token: string) => string | null; connect: (token: string) => Promise<ChannelsView> | undefined }> = {
  telegram: {
    description: <>Ask <button type="button" className={linkButton} onClick={() => { void serra()?.app.openExternal('https://t.me/BotFather'); }}>@BotFather</button> for a new bot, then paste its token.</>,
    placeholder: '123456:ABC…',
    problem: tokenProblem,
    connect: (token) => serra()?.channels.connectTelegram(token),
  },
  discord: {
    description: <>Make a bot in the <button type="button" className={linkButton} onClick={() => { void serra()?.app.openExternal('https://discord.com/developers/applications'); }}>Developer Portal</button>, turn on Message Content Intent, then paste its token.</>,
    placeholder: 'MTI…',
    problem: discordTokenProblem,
    connect: (token) => serra()?.channels.connectDiscord(token),
  },
};

const ConnectDialog = ({ chat, onClose, onConnected }: { chat: Chat | null; onClose: () => void; onConnected: (view: ChannelsView) => void }) => {
  const open = chat !== null;
  const ask = CONNECT[chat ?? 'telegram'];
  const formId = useId();
  const [token, setToken] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setToken(''); setTried(false); setError(null); } }, [open]);
  const problem = ask.problem(token);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setTried(true);
    if (problem || !serra()) return;
    setBusy(true);
    setError(null);
    try {
      const view = await ask.connect(token);
      if (!view) return;
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
      title={`Connect ${CHAT_NAMES[chat ?? 'telegram']}`}
      description={ask.description}
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
          placeholder={ask.placeholder}
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
  // A bot set up on Telegram or Discord has no Slack app yet.
  const { progress } = useSetup();
  const onSlack = (progress?.chat ?? 'slack') === 'slack';
  const [view, setView] = useState<ChannelsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Chat | null>(null);
  const [confirming, setConfirming] = useState<Chat | null>(null);

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) return;
    try { setView(await bridge.channels.status()); setLoadError(null); }
    catch (error) { setLoadError(errorText(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While it waits for the owner, look again now and then: pairing happens in the chat.
  const pairing = view?.telegram.state === 'pairing' || view?.discord.state === 'pairing';
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => { void load(); }, 3_000);
    return () => clearInterval(timer);
  }, [pairing, load]);

  const telegram = view?.telegram ?? null;
  const discord = view?.discord ?? null;
  const disconnect = async (which: Chat): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setConfirming(null);
    try {
      setView(await (which === 'telegram' ? bridge.channels.disconnectTelegram() : bridge.channels.disconnectDiscord()));
      await apply();
      toast({ message: `${CHAT_NAMES[which]} disconnected.`, tone: 'success' });
    } catch (error) { toast({ message: errorText(error), tone: 'error' }); }
  };
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text)
      .then(() => toast({ message: 'Copied.', tone: 'success' }))
      .catch((failure: unknown) => toast({ message: errorText(failure), tone: 'error' }));
  };

  return (
    <Page title="Channels" subtitle="Where people can reach your bot.">
      {loadError && <p role="alert" className="rounded-xl border border-down/30 bg-down/8 px-4 py-2.5 text-[13px]">{loadError}</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-raised">
        <Row icon={<BrandMark brand="slack" />} name="Slack" detail="Mentions, DMs and threads in your workspace." state={slackRow(status, onSlack)} />
        <Row
          icon={<BrandMark brand="telegram" />}
          name="Telegram"
          detail={telegram && telegram.state !== 'off' ? `@${telegram.username}` : 'Message your bot from your phone.'}
          state={telegramRow(telegram, status)}
        >
          {telegram?.state === 'off' && <Button variant="primary" size="sm" onClick={() => setConnecting('telegram')}>Connect</Button>}
          {telegram?.state === 'pairing' && (
            <Button variant="primary" size="sm" icon={<Send size={13} aria-hidden />} onClick={() => { void serra()?.app.openExternal(telegram.link); }}>Open in Telegram</Button>
          )}
          {telegram?.state === 'paired' && <Button variant="ghost" size="sm" onClick={() => setConfirming('telegram')}>Disconnect</Button>}
        </Row>
        <Row
          icon={<BrandMark brand="discord" />}
          name="Discord"
          detail={discord && discord.state !== 'off' ? discord.username : 'Mentions, DMs and threads in your server.'}
          state={discordRow(discord, status)}
        >
          {discord?.state === 'off' && <Button variant="primary" size="sm" onClick={() => setConnecting('discord')}>Connect</Button>}
          {discord?.state === 'pairing' && (
            <Button variant="primary" size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => { void serra()?.app.openExternal(discord.invite); }}>Add to server</Button>
          )}
          {discord?.state === 'paired' && <Button variant="ghost" size="sm" onClick={() => setConfirming('discord')}>Disconnect</Button>}
        </Row>
      </ul>
      {telegram?.state === 'pairing' && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          Open your bot in Telegram and tap Start. That makes it yours.
          <Button variant="ghost" size="sm" onClick={() => setConfirming('telegram')}>Disconnect</Button>
        </p>
      )}
      {discord?.state === 'pairing' && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span>Add your bot to a server, then DM it this code. That makes it yours.</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-control px-2 py-0.5 font-mono text-[13px] tracking-wider text-ink hover:bg-control-hover"
            aria-label={`Copy the code ${discord.code}`}
            onClick={() => copy(discord.code)}
          >
            {spacedCode(discord.code)}<Copy size={12} aria-hidden />
          </button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming('discord')}>Disconnect</Button>
        </p>
      )}
      <ConnectDialog
        chat={connecting}
        onClose={() => setConnecting(null)}
        onConnected={(next) => { setView(next); setConnecting(null); void apply(); }}
      />
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={`Disconnect ${CHAT_NAMES[confirming ?? 'telegram']}?`}
        description="Your bot stops answering there. You can connect it again any time."
        actions={(
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { if (confirming) void disconnect(confirming); }}>Disconnect</Button>
          </>
        )}
      />
    </Page>
  );
};
