// The Secrets screen's logic (APP-15): labels, the status line and turning a card's form into a `setSource` call.
// The window never sees a token's value. The only value it handles is one the owner types for a Keychain item,
// which goes straight to main in `setSource` and is cleared from the form afterwards.
import type { SecretName, SecretSource, SecretStatus } from '../../../src/contracts.ts';

export type SourceKind = SecretSource['kind'];

export const SECRET_LABELS: Record<SecretName, string> = {
  SLACK_BOT_TOKEN: 'Slack bot token',
  SLACK_APP_TOKEN: 'Slack app token',
};

/** The token prefix, for the value field's placeholder. */
export const SECRET_PREFIXES: Record<SecretName, string> = { SLACK_BOT_TOKEN: 'xoxb-', SLACK_APP_TOKEN: 'xapp-' };

/** The source picker, in the order it shows. `.env` is the CLI fallback and is listed last. */
export const SOURCE_OPTIONS: { kind: SourceKind; label: string }[] = [
  { kind: 'keychain', label: 'Keychain' },
  { kind: '1password', label: '1Password reference' },
  { kind: 'env', label: 'Profile .env (fallback)' },
];

/** "just now", "2 min ago", "3 h ago", "4 d ago". */
export const ago = (iso: string, now: Date): string => {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

export type StatusTone = 'ok' | 'error' | 'unverified' | 'unset';

/** The line next to Check: "set · verified 2 min ago", the last error, or what is missing. */
export const statusLine = (status: SecretStatus, now: Date): { tone: StatusTone; text: string } => {
  if (status.error) return { tone: 'error', text: status.error };
  if (!status.set) {
    return {
      tone: 'unset',
      text: status.source.kind === 'env' ? 'not set in the profile .env' : status.source.kind === 'keychain' ? 'no Keychain item yet' : 'not set',
    };
  }
  if (status.verifiedAt) return { tone: 'ok', text: `set · verified ${ago(status.verifiedAt, now)}` };
  return { tone: 'unverified', text: 'set · not checked yet' };
};

/** One card's editable form. `value` is only for Keychain and never comes from main. */
export interface SecretDraft {
  kind: SourceKind;
  reference: string;
  value: string;
}

export const draftFor = (status: SecretStatus): SecretDraft => ({
  kind: status.source.kind,
  reference: status.source.kind === '1password' ? status.source.reference : '',
  value: '',
});

const OP_REFERENCE = /^op:\/\/[^/\s]+(\/[^/]+){2,3}$/;

export type SaveRequest = { source: SecretSource; value?: string };

/**
 * What Save sends, or a message to show instead. A Keychain source keeps the item it already points at; otherwise
 * service and account go blank and main uses the bot's default item. Main validates again either way.
 */
export const saveRequest = (status: SecretStatus, draft: SecretDraft): SaveRequest | { error: string } => {
  if (draft.kind === 'env') return { source: { kind: 'env' } };
  if (draft.kind === '1password') {
    const reference = draft.reference.trim();
    if (!OP_REFERENCE.test(reference)) return { error: 'A 1Password reference looks like op://vault/item/field' };
    return { source: { kind: '1password', reference } };
  }
  const value = draft.value.trim();
  if (value && !value.startsWith(SECRET_PREFIXES[status.name])) return { error: `A ${SECRET_LABELS[status.name]} starts with ${SECRET_PREFIXES[status.name]}` };
  const source: SecretSource = status.source.kind === 'keychain'
    ? status.source
    : { kind: 'keychain', service: '', account: '' };
  return value ? { source, value } : { source };
};

/** Whether the form differs from what is saved, so Save has something to do. */
export const isDirty = (status: SecretStatus, draft: SecretDraft): boolean => {
  if (draft.kind !== status.source.kind) return true;
  if (draft.kind === '1password') return draft.reference.trim() !== (status.source.kind === '1password' ? status.source.reference : '');
  if (draft.kind === 'keychain') return draft.value.trim() !== '';
  return false;
};

/** The hint under the value field. */
export const keychainHint = (status: SecretStatus): string =>
  status.source.kind === 'keychain'
    ? `Stored in the Keychain item ${status.source.service} / ${status.source.account}. Paste a new value to replace it.`
    : 'Paste the token to store it in the Keychain, or leave it empty to use an item that already exists.';
