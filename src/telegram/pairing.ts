/**
 * Pairing the owner with their Telegram bot (`src/chat/pairing.ts`). Telegram can't say who made a bot, so the app
 * shows a one-time code in an `https://t.me/<bot>?start=<code>` link, and the first person to open the bot with it
 * becomes the owner there.
 */
import type { Profile } from '../config.ts';
import { chatPairingCode, clearChatPairing, pairChatOwner, takeChatPairingCode, updateChannel } from '../chat/pairing.ts';

export const pairingCode = (profileDir: string, now = Date.now()): string => chatPairingCode(profileDir, 'telegram', now);
export const takePairingCode = (profileDir: string, code: string, now = Date.now()): boolean => takeChatPairingCode(profileDir, 'telegram', code, now);
export const clearPairing = (profileDir: string): void => clearChatPairing(profileDir, 'telegram');

/** Writes `channels.telegram` with `change` applied, or removes it (`null`). Validated before the write. */
export const updateTelegramChannel = (profileDir: string, change: (current: NonNullable<Profile['channels']>['telegram']) => NonNullable<Profile['channels']>['telegram'] | null): Profile =>
  updateChannel(profileDir, 'telegram', change);

/** Makes `userId` the owner on Telegram. */
export const pairTelegramOwner = (profileDir: string, userId: string): Profile => pairChatOwner(profileDir, 'telegram', userId);
