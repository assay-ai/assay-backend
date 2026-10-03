/**
 * Stake-authority proof challenges.
 *
 * ## Why this is not `PAYOUT_CHALLENGE_*` reused
 *
 * The number below is deliberately identical to
 * `PAYOUT_CHALLENGE_DEFAULT_TTL_SECONDS`, and the reasoning that produced it is
 * the same one: a human in a wallet pop-up, with a second human step (open the
 * extension, find the "sign message" prompt) ahead of the signature. Reusing
 * the payout constant would therefore be free today.
 *
 * What is not free is reusing the *environment variable*.
 * `PROVIDER_PAYOUT_CHALLENGE_TTL_SECONDS` names one flow, and an operator who
 * shortens it during a payout incident would silently shorten the window on a
 * completely unrelated flow — one where the thing being proved is control of
 * the wallet that backs someone's collateral. Two knobs cost one constant now;
 * one knob costs a surprise later, at the moment somebody is already reacting
 * to an incident. The two defaults being equal is a fact about the current UX,
 * not a coupling either side may rely on.
 */

/**
 * How long an issued stake-authority challenge stays open, in seconds. Ten
 * minutes. Re-issue rather than extend — an extended nonce is a nonce whose
 * expiry no longer matches the `expiresAt` inside the signed bytes.
 *
 * A captured stake-authority proof, like a captured payout proof, moves no
 * value on its own (see `StakeAuthorityChallenge`), so the cost of the wider
 * window is console UX rather than exposure.
 *
 * Overridable via `PROVIDER_STAKE_AUTHORITY_CHALLENGE_TTL_SECONDS`.
 */
export const STAKE_AUTHORITY_CHALLENGE_DEFAULT_TTL_SECONDS = 600;

/** The env var `ProviderStakeAuthorityService` reads to override the default above. */
export const STAKE_AUTHORITY_CHALLENGE_TTL_SECONDS_ENV =
  'PROVIDER_STAKE_AUTHORITY_CHALLENGE_TTL_SECONDS';
