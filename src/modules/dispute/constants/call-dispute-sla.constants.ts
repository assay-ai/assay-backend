import { HELD_TIMEOUT_SECONDS } from '@modules/payment/ports/held-payments.port';

const HOUR_MS = 3_600_000;

/** The provider's one reply must come within this many hours of the filing. */
export const PROVIDER_REPLY_HOURS = 24;

/**
 * The decision SLA, from the filing (analysis §5). One copy: the SLA sweep
 * acts on these, and every dispute view states the instants they give, so a
 * screen never computes a deadline the backend does not keep.
 */
export const CALL_DISPUTE_SLA = Object.freeze({
  providerReplyMs: PROVIDER_REPLY_HOURS * HOUR_MS,
  pageMs: 48 * HOUR_MS,
  decideMs: 72 * HOUR_MS,
  lastPageMs: 6 * 24 * HOUR_MS,
});

/** The escrow's hold timeout: after `collectableAt` + this, anyone may collect to the provider. */
export const CALL_DISPUTE_HOLD_TIMEOUT_MS = HELD_TIMEOUT_SECONDS * 1000;
