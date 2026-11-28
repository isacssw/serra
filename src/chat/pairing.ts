/**
 * Pairing the owner with a chat's bot, for a chat that can't say who made a bot (Telegram, and a Discord bot whose
 * token anyone could have pasted). The app shows a one-time code; the first person to send it to the bot becomes the
 * owner there. The code lives in the profile (`<chat>/pairing.json`, owner-only) for a day; the owner's ID goes into
 * `profile.json` under `channels.<chat>`.
 */
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readProfileFile, writeProfileFile, type Profile } from '../config.ts';
import { writeFileAtomic } from '../lib/atomic.ts';
import { isRecord } from '../lib/guards.ts';

const PAIRING_MS = 24 * 60 * 60 * 1000;
/** No 0/O or 1/I, so a code read aloud or retyped survives. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-Z2-9]{8}$/;

/** A chat with a pairing code: its folder in the profile and its key under `channels`. */
export type PairedChat = keyof NonNullable<Profile['channels']>;

const pairingPath = (profileDir: string, chat: PairedChat): string => join(profileDir, chat, 'pairing.json');

const readPairing = (profileDir: string, chat: PairedChat): { code: string; expiresAt: number } | null => {
  const path = pairingPath(profileDir, chat);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) && typeof value.code === 'string' && CODE.test(value.code) && typeof value.expiresAt === 'number'
      ? { code: value.code, expiresAt: value.expiresAt } : null;
  } catch { return null; }
};

/** The code waiting to be used, or a new one when there is none or it expired. */
export const chatPairingCode = (profileDir: string, chat: PairedChat, now = Date.now()): string => {
  const current = readPairing(profileDir, chat);
  if (current && current.expiresAt > now) return current.code;
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  mkdirSync(join(profileDir, chat), { recursive: true, mode: 0o700 });
  writeFileAtomic(pairingPath(profileDir, chat), JSON.stringify({ code, expiresAt: now + PAIRING_MS }), { mode: 0o600 });
  return code;
};

/** True when `code` is the waiting code, unexpired. It can't be used again either way once it matched. */
export const takeChatPairingCode = (profileDir: string, chat: PairedChat, code: string, now = Date.now()): boolean => {
  const current = readPairing(profileDir, chat);
  if (!current || current.expiresAt <= now || current.code !== code.trim().toUpperCase()) return false;
  rmSync(pairingPath(profileDir, chat), { force: true });
  return true;
};

export const clearChatPairing = (profileDir: string, chat: PairedChat): void => { rmSync(pairingPath(profileDir, chat), { force: true }); };

type Channels = NonNullable<Profile['channels']>;

/** Writes `channels[chat]` with `change` applied, or removes it (`null`). Validated before the write. */
export const updateChannel = <K extends PairedChat>(profileDir: string, chat: K, change: (current: Channels[K]) => Channels[K] | null): Profile => {
  const profile = readProfileFile(profileDir);
  const next = change(profile.channels?.[chat]);
  const { channels, ...rest } = profile;
  const others: Channels = { ...channels };
  delete others[chat];
  const merged: Channels = next ? { ...others, [chat]: next } : others;
  return writeProfileFile(profileDir, Object.keys(merged).length ? { ...rest, channels: merged } : rest);
};

/** Makes `userId` (the chat's own ID for them) the owner there. */
export const pairChatOwner = (profileDir: string, chat: PairedChat, userId: string): Profile =>
  updateChannel(profileDir, chat, (current) => {
    if (!current) throw new Error(`${chat} is not connected`);
    return { ...current, ownerId: userId };
  });
