// Channels (SB-5): Telegram beside Slack. Connecting checks the bot token with Telegram (`getMe`), keeps it the way
// every token is kept (`secrets.ts`: the Keychain, or a 1Password reference), and writes `channels.telegram` to the
// profile. The owner then pairs by opening the bot with a one-time code (`src/telegram/pairing.ts`). The token never
// comes back to the window, and no error carries it.
import { readProfileFile } from '../config.ts';
import type { ChannelsView, SecretSource } from '../contracts.ts';
import type { Handlers } from '../api.ts';
import {
  checkSecret, checkShape, defaultKeychainSource, resolveConfiguredSecretSync, scrub, setSecret, telegramGetMe,
  type SecretOptions, type TelegramBot,
} from '../secrets.ts';
import { clearPairing, pairingCode, updateTelegramChannel } from '../telegram/pairing.ts';
import { isRecord } from '../lib/guards.ts';
import type { CoreContext } from './context.ts';

const TOKEN = 'TELEGRAM_BOT_TOKEN';

export interface ChannelsHandlerOptions extends SecretOptions {
  /** Telegram's `getMe` for a token. Tests answer it themselves. */
  getMe?: (token: string) => Promise<TelegramBot>;
}

export const channelsView = (profileDir: string, now = Date.now()): ChannelsView => {
  const telegram = readProfileFile(profileDir).channels?.telegram;
  if (!telegram) return { telegram: { state: 'off' } };
  const { username } = telegram.bot;
  if (telegram.ownerId) return { telegram: { state: 'paired', username } };
  return { telegram: { state: 'pairing', username, link: `https://t.me/${username}?start=${pairingCode(profileDir, now)}` } };
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
  return {
    status: () => channelsView(context.profileDir()),

    async connectTelegram(input) {
      if (typeof input !== 'string' || !input.trim()) throw new Error('Paste the token @BotFather gave you.');
      const dir = context.profileDir();
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
  };
};
