/**
 * Payout-address proof challenges.
 */

/**
 * How long an issued challenge stays open, in seconds. Ten minutes.
 *
 * Mirrors `WITHDRAWAL_MAX_TTL_SECONDS`'s reasoning, not its number: both are
 * signed by a human in a wallet pop-up rather than by an agent process, so
 * both need a window a person can actually act inside. This one gets the same
 * ten minutes rather than a voucher's five because it carries a second
 * human step ahead of the signature itself — opening the wallet extension and
 * finding the "sign message" prompt, which a withdrawal's "sign this
 * transaction" flow does not require. Unlike a withdrawal, a captured payout
 * proof cannot move any value on its own — see `PayoutProofChallenge` — so
 * there is no cost to the extra room beyond the console UX of a stale
 * challenge, which is exactly what re-issuing (never extending) trades away.
 *
 * Overridable via `PROVIDER_PAYOUT_CHALLENGE_TTL_SECONDS` for environments
 * that need a shorter window for testing.
 */
export const PAYOUT_CHALLENGE_DEFAULT_TTL_SECONDS = 600;

/** The env var `ProviderPayoutAddressService` reads to override the default above. */
export const PAYOUT_CHALLENGE_TTL_SECONDS_ENV = 'PROVIDER_PAYOUT_CHALLENGE_TTL_SECONDS';
