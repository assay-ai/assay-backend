/**
 * How many buffered entries force an immediate flush.
 *
 * Per-call ledger cost is what sets the minimum viable tool price, so credits
 * are written a batch at a time rather than a row at a time.
 */
export const LEDGER_BATCH_SIZE = 500;

/**
 * The flush cadence, and therefore the worst-case durability lag on a buffered
 * entry. A crash loses at most this much un-written credit, which the reconciler
 * re-derives from chain state and the intent record.
 */
export const LEDGER_FLUSH_INTERVAL_MS = 200;

/** Above this, the buffer is refusing work rather than quietly growing forever. */
export const LEDGER_BUFFER_HARD_LIMIT = LEDGER_BATCH_SIZE * 20;

/**
 * Consecutive failed flushes before the offending batch is quarantined.
 *
 * A failed batch is re-queued, which is correct — nothing was applied, so a
 * retry cannot double-apply. But an entry that can *never* be written (a
 * malformed id, a row that violates a constraint) would then be retried
 * forever, and because it sits at the front of the buffer it takes every
 * healthy entry behind it down on every attempt. Retrying is right; retrying
 * unboundedly turns one bad row into a stalled ledger.
 */
export const LEDGER_MAX_FLUSH_ATTEMPTS = 3;
