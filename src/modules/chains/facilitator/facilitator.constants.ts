/**
 * Configuration seams for both halves of the self-hosted facilitator.
 *
 * The values are injected rather than read from `ConfigService` inside the
 * classes so a unit test can construct either half without a Nest container
 * and without `process.env`.
 */

/** DI token — base URL of the facilitator the platform talks to. */
export const FACILITATOR_BASE_URL = 'FACILITATOR_BASE_URL';

/** DI token — per-request timeout in milliseconds. */
export const FACILITATOR_TIMEOUT_MS = 'FACILITATOR_TIMEOUT_MS';

/**
 * Default timeout for a facilitator call.
 *
 * Long enough for `/settle` to broadcast and reach `confirmed`, which is the
 * slow one: a Solana confirmation is typically well under a second but tails
 * badly under congestion. Shorter than the blockhash lifetime, because a
 * settle that has not confirmed by then cannot confirm at all.
 */
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 30_000;
