/**
 * Pairing the owner with their Telegram bot. Telegram can't say who made a bot, so the app shows a one-time code (in
 * an `https://t.me/<bot>?start=<code>` link) and the first person to open the bot with it becomes the owner there. The
 * code lives in the profile (`telegram/pairing.json`, owner-only) for a day; the owner's ID goes into `profile.json`.
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

const pairingPath = (profileDir: string): string => join(profileDir, 'telegram', 'pairing.json');

const readPairing = (profileDir: string): { code: string; expiresAt: number } | null => {
  const path = pairingPath(profileDir);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) && typeof value.code === 'string' && CODE.test(value.code) && typeof value.expiresAt === 'number'
      ? { code: value.code, expiresAt: value.expiresAt } : null;
  } catch { return null; }
};

/** The code waiting to be used, or a new one when there is none or it expired. */
export const pairingCode = (profileDir: string, now = Date.now()): string => {
  const current = readPairing(profileDir);
  if (current && current.expiresAt > now) return current.code;
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  mkdirSync(join(profileDir, 'telegram'), { recursive: true, mode: 0o700 });
  writeFileAtomic(pairingPath(profileDir), JSON.stringify({ code, expiresAt: now + PAIRING_MS }), { mode: 0o600 });
  return code;
};

/** True when `code` is the waiting code, unexpired. It can't be used again either way once it matched. */
export const takePairingCode = (profileDir: string, code: string, now = Date.now()): boolean => {
  const current = readPairing(profileDir);
  if (!current || current.expiresAt <= now || current.code !== code.trim().toUpperCase()) return false;
  rmSync(pairingPath(profileDir), { force: true });
  return true;
};

export const clearPairing = (profileDir: string): void => { rmSync(pairingPath(profileDir), { force: true }); };

/** Writes `channels.telegram` with `change` applied, or removes it (`null`). Validated before the write. */
export const updateTelegramChannel = (profileDir: string, change: (current: NonNullable<Profile['channels']>['telegram']) => NonNullable<Profile['channels']>['telegram'] | null): Profile => {
  const profile = readProfileFile(profileDir);
  const next = change(profile.channels?.telegram);
  const { channels, ...rest } = profile;
  const others = { ...channels };
  delete others.telegram;
  const merged = next ? { ...others, telegram: next } : others;
  return writeProfileFile(profileDir, Object.keys(merged).length ? { ...rest, channels: merged } : rest);
};

/** Makes `userId` the owner on Telegram. */
export const pairTelegramOwner = (profileDir: string, userId: string): Profile =>
  updateTelegramChannel(profileDir, (current) => {
    if (!current) throw new Error('Telegram is not connected');
    return { ...current, ownerId: userId };
  });
