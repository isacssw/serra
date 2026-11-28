// Channels (SB-5): Telegram beside Slack. Connecting checks the bot token with Telegram (`getMe`), keeps it the way
// every token is kept (`secrets.ts`: the Keychain, or a 1Password reference), and writes `channels.telegram` to the
// profile. The owner then pairs by opening the bot with a one-time code (`src/telegram/pairing.ts`). The token never
// comes back to the window, and no error carries it.
//
// Discord the same way: the token is checked with Discord (`/users/@me`, and `/applications/@me` for the Message
// Content intent, which must be on), kept like Telegram's, and `channels.discord` names the bot. The owner adds the bot
// to a server with the invite link and DMs it the one-time code (`src/chat/pairing.ts`).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readProfileFile } from '../config.ts';
import type { ChannelsView, DiscordView, SecretName, SecretSource } from '../contracts.ts';
import type { Handlers } from '../api.ts';
import {
  checkSecret, checkShape, defaultKeychainSource, discordWhoAmI, resolveConfiguredSecretSync, scrub, setSecret, telegramGetMe,
  type DiscordBot, type SecretOptions, type TelegramBot,
} from '../secrets.ts';
import { chatPairingCode, clearChatPairing, updateChannel } from '../chat/pairing.ts';
import { clearPairing, pairingCode, updateTelegramChannel } from '../telegram/pairing.ts';
import { isRecord, isString, readJsonOrNull } from '../lib/guards.ts';
import type { CoreContext } from './context.ts';

const TOKEN = 'TELEGRAM_BOT_TOKEN';
const DISCORD_TOKEN = 'DISCORD_BOT_TOKEN';
/**
 * What the bot may do in a server, and nothing more (no Administrator): view channels, send messages and send them in
 * threads, start public threads, attach files, read message history, add reactions. Scope `bot` only: no slash commands.
 */
export const DISCORD_PERMISSIONS = '309237746752';

/** The link that adds the bot to a server the owner picks. */
export const discordInvite = (applicationId: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${DISCORD_PERMISSIONS}`;

export interface ChannelsHandlerOptions extends SecretOptions {
  /** Telegram's `getMe` for a token. Tests answer it themselves. */
  getMe?: (token: string) => Promise<TelegramBot>;
  /** Discord's answer about a token. Tests answer it themselves. */
  whoAmI?: (token: string) => Promise<DiscordBot>;
}

export const channelsView = (profileDir: string, now = Date.now()): ChannelsView => {
  const { telegram, discord } = readProfileFile(profileDir).channels ?? {};
  const discordView = ((): DiscordView => {
    if (!discord) return { state: 'off' };
    const { username, applicationId } = discord.bot;
    const invite = discordInvite(applicationId);
    if (discord.ownerId) return { state: 'paired', username, invite };
    return { state: 'pairing', username, invite, code: chatPairingCode(profileDir, 'discord', now) };
  })();
  if (!telegram) return { telegram: { state: 'off' }, discord: discordView };
  const { username } = telegram.bot;
  if (telegram.ownerId) return { telegram: { state: 'paired', username }, discord: discordView };
  return { telegram: { state: 'pairing', username, link: `https://t.me/${username}?start=${pairingCode(profileDir, now)}` }, discord: discordView };
};

/**
 * Refuses a chat the installed bot can't run: its active release has no code for it. A bot from before Telegram and
 * Discord (alpha.9) refuses a profile that names one, so connecting it while that bot still runs (the bot updates once
 * no job is running) would stop the bot at its next start. Nothing installed yet, or a release gone: nothing to protect.
 */
const needsNewerBot = (dir: string, chat: 'telegram' | 'discord'): void => {
  const release = readJsonOrNull(join(dir, 'active.json'), isRecord)?.release;
  if (!isString(release) || !existsSync(join(release, 'src')) || existsSync(join(release, 'src', chat))) return;
  const name = chat === 'telegram' ? 'Telegram' : 'Discord';
  throw new Error(`Update the bot first: it runs an older Serra without ${name}. It updates once no job is running, or press Update now in Settings › Updates.`);
};

/** Discord's answer as the owner reads it: a refused token says so, anything else is a failed check. */
const askedDiscord = async (whoAmI: (token: string) => Promise<DiscordBot>, token: string): Promise<DiscordBot> => {
  let bot: DiscordBot;
  try { bot = await whoAmI(token); }
  catch (error) {
    const refused = isRecord(error) && isRecord(error.data) ? error.data.error : undefined;
    throw new Error(typeof refused === 'string' ? 'Discord didn’t accept that token. Reset it on your bot’s page in the Developer Portal and paste the new one.' : 'Couldn’t reach Discord. Check the connection and try again.');
  }
  if (!bot.messageContent) throw new Error('Turn on Message Content Intent under Bot in the Developer Portal, then connect again.');
  return bot;
};

/**
 * Keeps a pasted token in the Keychain, or points at a 1Password reference, once `ask` accepts it. A reference is
 * pointed at first and read once to ask; a refusal points the token back at nothing.
 */
const keepToken = async <T>(dir: string, name: SecretName, value: string, ask: (token: string) => Promise<T>, options: SecretOptions): Promise<T> => {
  if (value.startsWith('op://')) {
    const source: SecretSource = { kind: '1password', reference: value };
    await setSecret(dir, name, source, undefined, options);
    try { return await ask(resolveConfiguredSecretSync(dir, name, { security: 'security', op: 'op', timeoutMs: 30_000, ...options.tools }) ?? ''); }
    catch (error) { await setSecret(dir, name, { kind: 'env' }, undefined, options).catch(() => {}); throw error; }
  }
  checkShape(name, value, 'what you pasted');
  const answer = await ask(value);
  await setSecret(dir, name, defaultKeychainSource(readProfileFile(dir), name), value, options);
  return answer;
};

/** Telegram's answer as the owner reads it: a refused token says so, anything else is a failed check. */
const asked = async (getMe: (token: string) => Promise<TelegramBot>, token: string): Promise<TelegramBot> => {
  try { return await getMe(token); }
  catch (error) {
    const refused = isRecord(error) && isRecord(error.data) ? error.data.error : undefined;
    throw new Error(typeof refused === 'string' ? 'Telegram didn’t accept that token. Copy it again from @BotFather.' : 'Couldn’t reach Telegram. Check the connection and try again.');
  }
};

export const channelsHandlers = (context: CoreContext, options: ChannelsHandlerOptions = {}): Handlers<'channels'> => {
  const getMe = options.getMe ?? ((token: string) => telegramGetMe(token));
  const whoAmI = options.whoAmI ?? ((token: string) => discordWhoAmI(token));
  return {
    status: () => channelsView(context.profileDir()),

    async connectTelegram(input) {
      if (typeof input !== 'string' || !input.trim()) throw new Error('Paste the token @BotFather gave you.');
      const dir = context.profileDir();
      needsNewerBot(dir, 'telegram');
      const value = input.trim();
      try {
        let bot: TelegramBot;
        if (value.startsWith('op://')) {
          // A 1Password reference: point at it, then read it once to ask Telegram whose it is.
          const source: SecretSource = { kind: '1password', reference: value };
          await setSecret(dir, TOKEN, source, undefined, options);
          try { bot = await asked(getMe, resolveConfiguredSecretSync(dir, TOKEN, { security: 'security', op: 'op', timeoutMs: 30_000, ...options.tools }) ?? ''); }
          catch (error) { await setSecret(dir, TOKEN, { kind: 'env' }, undefined, options).catch(() => {}); throw error; }
        } else {
          checkShape(TOKEN, value, 'what you pasted');
          bot = await asked(getMe, value);
          await setSecret(dir, TOKEN, defaultKeychainSource(readProfileFile(dir), TOKEN), value, options);
        }
        // Recorded as checked: Telegram just accepted it.
        await checkSecret(dir, TOKEN, { ...options, verify: async () => ({}) }).catch(() => {});
        // Reconnecting the same bot keeps its owner; another bot pairs again.
        updateTelegramChannel(dir, (current) => ({
          bot: { id: bot.id, username: bot.username },
          ...(current?.bot.id === bot.id && current.ownerId ? { ownerId: current.ownerId } : {}),
        }));
        clearPairing(dir);
        return channelsView(dir);
      } catch (error) {
        throw new Error(scrub(error instanceof Error ? error.message : String(error), [value]));
      }
    },

    async disconnectTelegram() {
      const dir = context.profileDir();
      updateTelegramChannel(dir, () => null);
      clearPairing(dir);
      // The token's source is forgotten; a Keychain item stays, unread, until the owner connects again.
      await setSecret(dir, TOKEN, { kind: 'env' }, undefined, options).catch(() => {});
      return channelsView(dir);
    },

    async connectDiscord(input) {
      if (typeof input !== 'string' || !input.trim()) throw new Error('Paste your bot’s token from the Developer Portal.');
      const dir = context.profileDir();
      needsNewerBot(dir, 'discord');
      const value = input.trim();
      try {
        const bot = await keepToken(dir, DISCORD_TOKEN, value, (token) => askedDiscord(whoAmI, token), options);
        // Recorded as checked: Discord just accepted it.
        await checkSecret(dir, DISCORD_TOKEN, { ...options, verify: async () => ({}) }).catch(() => {});
        // Reconnecting the same bot keeps its owner; another bot pairs again.
        updateChannel(dir, 'discord', (current) => ({
          bot: { id: bot.id, username: bot.username, applicationId: bot.applicationId },
          ...(current?.bot.id === bot.id && current.ownerId ? { ownerId: current.ownerId } : {}),
        }));
        clearChatPairing(dir, 'discord');
        return channelsView(dir);
      } catch (error) {
        throw new Error(scrub(error instanceof Error ? error.message : String(error), [value]));
      }
    },

    async disconnectDiscord() {
      const dir = context.profileDir();
      updateChannel(dir, 'discord', () => null);
      clearChatPairing(dir, 'discord');
      await setSecret(dir, DISCORD_TOKEN, { kind: 'env' }, undefined, options).catch(() => {});
      return channelsView(dir);
    },
  };
};
