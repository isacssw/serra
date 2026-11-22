// What a failed token check means: a verdict on the token (refused, wrong kind, missing a scope), or a check that
// never reached one (offline, Slack busy or down, a locked Keychain, 1Password not answering). Pure: imported by
// setup's progress in main and by the setup screens.

/** Slack refusing the token, or the token not being the right kind: a new token is needed. These win over the rest. */
const VERDICT = /isn't a real x(?:oxb|app)- token|is empty|isn't an item|no item|item not found|not found in vault|contains whitespace|missing_scope|invalid_auth|not_authed|token_revoked|token_expired|account_inactive|not_allowed_token_type|invalid_token/;

/** Failures a retry can fix: the network, Slack itself, or a source that couldn't be read just now. */
const RETRYABLE = /Couldn't reach Slack|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|fetch failed|socket hang up|network|rate.?limit|ratelimited|fatal_error|internal_error|service_unavailable|request_timeout|Keychain|security|User interaction is not allowed|1Password|\bop\b/i;

/**
 * True when the error is a verdict on the token itself and a new value is needed. Unknown failures count as verdicts,
 * so the owner can always paste a new token; known transient ones don't, so they never undo an earlier pass.
 */
export const isTokenVerdict = (error: string | null | undefined): boolean =>
  typeof error === 'string' && error !== '' && (VERDICT.test(error) || !RETRYABLE.test(error));

/** A locked Keychain, as `security` reports it to an app that may not prompt. */
export const isKeychainLocked = (error: string | null | undefined): boolean =>
  typeof error === 'string' && /User interaction is not allowed|SecKeychainSearchCopyNext|keychain is locked/i.test(error);
