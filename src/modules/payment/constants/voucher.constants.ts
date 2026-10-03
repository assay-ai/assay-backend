/**
 * Voucher bounds (voucher v2).
 *
 * Replay protection requires a ceiling on voucher lifetime; the rest are the
 * shapes that make the `seq` a `seq`.
 */

/**
 * The longest a voucher's window (`expiresAt - issuedAt`) may claim to be, in
 * seconds.
 *
 * A voucher is signed locally in about a millisecond, so there is no reason
 * for one to claim to live longer than the request it pays for takes to
 * arrive. The bound matters because both ends of the window are chosen by the
 * *agent*: without a ceiling an agent could sign a voucher good for a year,
 * and the only thing standing between a captured copy of it and a replay
 * would be the single-use index.
 *
 * This is also `MAX_VOUCHER_LIFETIME_SECONDS` on chain — the program enforces
 * the identical rule in `redeem_voucher` because the backend that used to be
 * the sole enforcer is assumed compromised. The two constants must not drift:
 * a backend ceiling looser than the chain's just costs a transaction fee to
 * find out; a backend ceiling *tighter* than the chain's is merely redundant.
 *
 * It is also the intent TTL (`PAYMENT_INTENT_TTL_MS`) on purpose — a voucher
 * that outlived the intent it creates would authorise a call the expiry sweep
 * has already given the money back for.
 */
export const VOUCHER_MAX_TTL_SECONDS = 300;

/**
 * How far ahead of this server's clock a voucher's `issuedAt` may claim to be,
 * in seconds.
 *
 * Named identically to `CLOCK_SKEW_TOLERANCE_SECONDS` on chain
 * because a divergence between the two shows up as a voucher this backend
 * accepts and the chain refuses — after the call has been served and the
 * money held. Skew is checked only against `issuedAt`'s lower bound (the
 * agent's clock running fast); `expiresAt`'s own check has no skew allowance,
 * because leniency there would extend the window a captured voucher stays
 * spendable in, and the single-use index is the only thing defending it.
 */
export const VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS = 120;

/**
 * A decimal `u64`, no leading zeros and no sign — voucher v2's `seq`.
 *
 * Strict, because `"1"`, `" 1"` and `"01"` are three strings and one number,
 * and the index that makes a voucher single-use
 * (`uq_payment_intents_account_voucher_seq`) compares bytes. The signature
 * covers `seq`, so a variant would not verify — but the index must not depend
 * on a check that happens somewhere else.
 */
export const VOUCHER_SEQ_RE = /^(0|[1-9][0-9]{0,19})$/;

/** Written to `status_reason` when a voucher creates the intent. */
export const VOUCHER_REDEEMED_REASON = 'voucher redeemed; signature and sequence verified';
