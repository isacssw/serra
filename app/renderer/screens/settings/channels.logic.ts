// Settings › Channels: where people reach the bot. Pure: what each row says, from the profile's view and the daemon's
// live status. One line and one tone per row; the screen adds the one action that fits.
import type { BotStatus, DiscordView, TelegramView } from '../../../../src/contracts.ts';

type RowTone = 'up' | 'warn' | 'down' | 'neutral';
export interface RowState { tone: RowTone; label: string }

/** Whether the running bot reaches a chat now: null when the bot isn't running or doesn't serve it. */
const reached = (status: BotStatus | null, kind: string): boolean | null => {
  if (status?.state !== 'up') return null;
  if (kind === 'slack') return status.slackConnected;
  return status.chats?.find((chat) => chat.kind === kind)?.connected ?? null;
};

export const slackRow = (status: BotStatus | null): RowState => {
  if (status === null) return { tone: 'neutral', label: 'Checking…' };
  if (status.state !== 'up') return { tone: 'neutral', label: 'Bot stopped' };
  return reached(status, 'slack') ? { tone: 'up', label: 'Connected' } : { tone: 'down', label: 'Not reachable' };
};

/** A chat connected in Settings › Channels (Telegram, Discord): off, waiting for its owner, or as the running bot reaches it. */
const channelRow = (kind: 'telegram' | 'discord', view: TelegramView | DiscordView | null, status: BotStatus | null): RowState => {
  if (view === null) return { tone: 'neutral', label: 'Checking…' };
  if (view.state === 'off') return { tone: 'neutral', label: 'Not connected' };
  if (view.state === 'pairing') return { tone: 'warn', label: 'Waiting for you' };
  if (status?.state !== 'up') return { tone: 'neutral', label: 'Bot stopped' };
  const now = reached(status, kind);
  // A bot started before the chat was connected doesn't serve it until it restarts.
  if (now === null) return { tone: 'warn', label: 'Restart to start' };
  return now ? { tone: 'up', label: 'Connected' } : { tone: 'down', label: 'Not reachable' };
};

export const telegramRow = (view: TelegramView | null, status: BotStatus | null): RowState => channelRow('telegram', view, status);
export const discordRow = (view: DiscordView | null, status: BotStatus | null): RowState => channelRow('discord', view, status);

/** What's wrong with a pasted token, before Telegram is asked; null when it may be one (or a 1Password reference). */
export const tokenProblem = (input: string): string | null => {
  const value = input.trim();
  if (!value) return 'Paste the token @BotFather gave you.';
  if (value.startsWith('op://')) return null;
  return /^\d{5,20}:[A-Za-z0-9_-]{30,}$/.test(value) ? null : 'That doesn’t look like a bot token. It looks like 123456:ABC…';
};

/** What's wrong with a pasted Discord bot token, before Discord is asked; null when it may be one (or a 1Password reference). */
export const discordTokenProblem = (input: string): string | null => {
  const value = input.trim();
  if (!value) return 'Paste your bot’s token from the Developer Portal.';
  if (value.startsWith('op://')) return null;
  return /^[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}$/.test(value) ? null : 'That doesn’t look like a Discord bot token. Copy it from Bot › Reset Token.';
};

/** A pairing code as the screen shows it: two groups of four, easier to read and retype. */
export const spacedCode = (code: string): string => (code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code);
