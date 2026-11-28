// Telegram and Discord in setup, for an owner who picked one on the first screen. Connect: paste the bot's token
// (checked with Telegram or Discord, kept in the Keychain; the same call as Settings › Channels). Make it yours, once
// the bot runs: open it in Telegram and tap Start, or add it to a server and send it the code. Both go on by
// themselves when they're done.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Copy, Plus, Send } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { ChannelsView } from '../../../src/contracts.ts';
import type { SetupChat } from '../../../src/setup.ts';
import { serra } from '../bridge.ts';
import { discordTokenProblem, spacedCode, tokenProblem } from '../screens/settings/channels.logic.ts';
import { BrandMark, Button, Input, useToast } from '../ui/index.ts';
import { Alert, Card, errorText, StateIcon, StepFooter, StepHeader } from './parts.tsx';
import { DONE_PATH, firstTry, flowFor, nextPath, previousPath } from './setup.logic.ts';
import { setupChanged, useSetup } from './SetupState.tsx';

type OtherChat = Exclude<SetupChat, 'slack'>;

const linkClass = 'rounded-sm font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const open = (url: string): void => { void serra()?.app.openExternal(url); };

/** What each chat asks for its token. */
const ASK: Record<OtherChat, { how: ReactNode; placeholder: string; problem: (token: string) => string | null }> = {
  telegram: {
    how: <>Ask <button type="button" className={linkClass} onClick={() => open('https://t.me/BotFather')}>@BotFather</button> for a new bot, then paste its token.</>,
    placeholder: '123456:ABC…',
    problem: tokenProblem,
  },
  discord: {
    how: <>Make a bot in the <button type="button" className={linkClass} onClick={() => open('https://discord.com/developers/applications')}>Developer Portal</button>, turn on Message Content Intent, then paste its token.</>,
    placeholder: 'MTI…',
    problem: discordTokenProblem,
  },
};

const stepOf = (chat: OtherChat, id: 'chat' | 'owner') => flowFor(chat).find((step) => step.id === id)!;

/** The chat's view from Settings › Channels' status, read again every few seconds while `watch` is on. */
const useChannel = (chat: OtherChat, watch: boolean) => {
  const [view, setView] = useState<ChannelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setView(await serra()?.channels.status() ?? null); setError(null); }
    catch (failure) { setError(errorText(failure)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => { void load(); }, 3_000);
    return () => clearInterval(timer);
  }, [watch, load]);
  return { channel: view?.[chat] ?? null, setView, error };
};

/** The first thing to try with this bot (setup.logic.ts `firstTry`), with the Telegram or Discord bot's username. */
export const useFirstTry = (): { lead: string; example: string } | null => {
  const { progress } = useSetup();
  const chat = progress?.chat ?? 'slack';
  const [handle, setHandle] = useState<string | null>(null);
  useEffect(() => {
    if (chat === 'slack') return;
    serra()?.channels.status().then((view) => { const entry = view[chat]; setHandle(entry.state === 'off' ? null : entry.username); }, () => {});
  }, [chat]);
  return progress?.bot ? firstTry(chat, progress.bot.id, handle) : null;
};

export const ChatTokenStep = ({ chat }: { chat: OtherChat }) => {
  const navigate = useNavigate();
  const { progress, refresh } = useSetup();
  const step = stepOf(chat, 'chat');
  const ask = ASK[chat];
  const { channel, setView, error: loadError } = useChannel(chat, false);
  const [token, setToken] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = channel !== null && channel.state !== 'off';
  const problem = ask.problem(token);

  const connect = async (): Promise<void> => {
    setTried(true);
    const bridge = serra();
    if (problem || !bridge) return;
    setBusy(true);
    setError(null);
    try {
      const view = await (chat === 'telegram' ? bridge.channels.connectTelegram(token) : bridge.channels.connectDiscord(token));
      setToken('');
      setView(view);
      setupChanged();
      // Connected: nothing is left on this step, so the next one opens.
      const latest = await refresh();
      void navigate(nextPath(latest ?? progress, step.path));
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <StepHeader step={step} icon={<BrandMark brand={chat} size={18} />} />
      {loadError && <Alert>{loadError}</Alert>}
      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-center gap-3">
          <StateIcon tone={busy ? 'busy' : connected ? 'done' : error ? 'problem' : 'todo'} />
          <p className="min-w-0 flex-1 text-[13px]" role="status">
            {busy ? `Checking with ${step.short}…` : connected ? <><span className="font-medium">@{channel.username}</span> is connected.</> : ask.how}
          </p>
        </div>
        {!connected && (
          <form className="flex items-start gap-2 pl-8" noValidate onSubmit={(event) => { event.preventDefault(); void connect(); }}>
            <Input aria-label="Bot token" type="password" autoComplete="off" spellCheck={false} className="min-w-0 flex-1" inputClassName="font-mono"
              placeholder={ask.placeholder} value={token} disabled={busy} error={error ?? (tried ? problem : null)} hint="Kept in your Keychain"
              onChange={(event) => { setToken(event.target.value); setError(null); }} />
            <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
          </form>
        )}
      </Card>
      <StepFooter back={previousPath(step.path, chat)}>
        {connected && <Button variant="primary" onClick={() => void refresh().then((latest) => navigate(nextPath(latest ?? progress, step.path)))}>Continue</Button>}
      </StepFooter>
    </div>
  );
};

export const YoursStep = ({ chat }: { chat: OtherChat }) => {
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useSetup();
  const step = stepOf(chat, 'owner');
  const { channel, error } = useChannel(chat, true);
  const paired = channel?.state === 'paired';

  // Made yours in the chat: the end opens by itself.
  useEffect(() => {
    if (!paired) return;
    setupChanged();
    void refresh().then(() => navigate(DONE_PATH));
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the pairing lands.
  }, [paired]);

  const copy = (code: string): void => {
    void navigator.clipboard.writeText(code)
      .then(() => toast({ message: 'Copied.', tone: 'success' }))
      .catch((failure: unknown) => toast({ message: errorText(failure), tone: 'error' }));
  };

  const pairing = channel?.state === 'pairing' ? channel : null;
  return (
    <div className="flex flex-1 flex-col gap-6">
      <StepHeader step={step} icon={<BrandMark brand={chat} size={18} />} />
      {error && <Alert>{error}</Alert>}
      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-center gap-3">
          {/* Your turn, not Serra's: the to-do ring while it waits for you in the chat. */}
          <StateIcon tone={paired ? 'done' : 'todo'} />
          <p className="min-w-0 flex-1 text-[13px]" role="status">
            {paired ? 'It’s yours.'
              : !pairing ? 'Looking for your bot…'
              : pairing && 'link' in pairing ? <>Open <span className="font-medium">@{pairing.username}</span> in Telegram and tap Start.</>
              : <>Add <span className="font-medium">@{channel?.state === 'pairing' ? channel.username : ''}</span> to your Discord, then DM it this code.</>}
          </p>
          {pairing && 'link' in pairing && <Button variant="primary" size="sm" icon={<Send size={13} aria-hidden />} onClick={() => open(pairing.link)}>Open in Telegram</Button>}
          {pairing && 'invite' in pairing && <Button variant="primary" size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => open(pairing.invite)}>Add to Discord</Button>}
        </div>
        {pairing && 'code' in pairing && (
          <div className="pl-8">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-line-control bg-control px-2.5 py-1 font-mono text-[14px] tracking-wider text-ink hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              aria-label={`Copy the code ${pairing.code}`}
              data-code
              onClick={() => copy(pairing.code)}
            >
              {spacedCode(pairing.code)}<Copy size={13} aria-hidden />
            </button>
          </div>
        )}
      </Card>
      <StepFooter back={previousPath(step.path, chat)} />
    </div>
  );
};
