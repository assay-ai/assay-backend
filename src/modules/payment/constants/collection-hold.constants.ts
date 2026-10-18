import {
  MAX_VOUCHER_LIFETIME_SECONDS,
  REDEEM_GRACE_SECONDS,
  REDEMPTION_DEADLINE_MARGIN_SECONDS,
} from './voucher-redemption.constants';

/**
 * The dispute hold (G3.B1): a served rail-B call's voucher is not redeemed
 * until `collectable_at`, so a buyer who disputes inside the window is refunded
 * from money that never left its escrow.
 *
 * ## The window is capped by the voucher, never the other way round
 *
 * A voucher is redeemable on chain only until `expires_at + REDEEM_GRACE_SECONDS`
 * (the contract's own grace, 30 minutes). A hold that ran past it would kill
 * every voucher it held and turn every paid call into buyer debt. So:
 *
 * ```text
 * collectable_at = LEAST(settled + CALL_DISPUTE_HOLD_WINDOW,
 *                        expires_at + REDEEM_GRACE_SECONDS − COLLECTION_DEADLINE_RESERVE_SECONDS)
 * ```
 *
 * The reserve leaves room for the redemption passes after the window: it must
 * cover a later voucher of the same buyer that waits for an earlier one (seq
 * order, see `findAwaitingRedemption`) — a later voucher's own deadline is at
 * most `MAX_VOUCHER_LIFETIME_SECONDS` before the earlier one's — plus the last
 * pass's margin and a few retries. 600 s does; the assertion below keeps it so.
 * With the contract's 30-minute grace the effective rail-B window is therefore
 * at most 20 minutes after the voucher expires, whatever the configured value.
 *
 * ## An open dispute outlives the voucher
 *
 * A human decision takes longer than the voucher lives. A disputed voucher is
 * kept out of the redemption queue until the decision and is not allowed to
 * block the buyer's later vouchers (they are redeemed past it). Upheld: its hold
 * is released and it is never redeemed. Rejected: it goes back to the queue; if
 * it can no longer be redeemed it becomes buyer debt through the existing flow
 * (the buyer re-signs a replacement; its paid calls are refused until it does).
 */
export const COLLECTION_DEADLINE_RESERVE_SECONDS = 600;

/** A dispute filed this close to `collectable_at` is not guaranteed a refund. */
export const DISPUTE_FILING_GUARD_SECONDS = 30;

const MAX_WINDOW_MINUTES = 24 * 60;
const DEFAULT_WINDOW_MINUTES = 60;

if (
  REDEEM_GRACE_SECONDS - COLLECTION_DEADLINE_RESERVE_SECONDS <= 0 ||
  COLLECTION_DEADLINE_RESERVE_SECONDS <
    MAX_VOUCHER_LIFETIME_SECONDS + REDEMPTION_DEADLINE_MARGIN_SECONDS + 3 * 60
) {
  throw new Error('collection hold reserve does not fit the voucher redemption grace');
}

/**
 * `CALL_DISPUTE_HOLD_WINDOW_MINUTES`: an integer from 0 (no hold) to 1440.
 * Unlike the operational dials elsewhere, a malformed value refuses to boot:
 * a silently different window changes who is refunded.
 */
export function loadCollectionHoldWindowSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CALL_DISPUTE_HOLD_WINDOW_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_WINDOW_MINUTES * 60;
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_WINDOW_MINUTES) {
    throw new Error(
      `CALL_DISPUTE_HOLD_WINDOW_MINUTES must be an integer from 0 to ${MAX_WINDOW_MINUTES}, ` +
        `got "${raw}"`,
    );
  }
  return Number(raw) * 60;
}

export const COLLECTION_HOLD_WINDOW_SECONDS = loadCollectionHoldWindowSeconds();

/**
 * The SQL that stamps `collectable_at` on the edge to `SETTLED` (see the file
 * comment). Evaluated by Postgres, in the status update itself, so a redemption
 * pass can never read a SETTLED row without it.
 */
export function collectableAtSql(windowSeconds: number = COLLECTION_HOLD_WINDOW_SECONDS): string {
  const cap = REDEEM_GRACE_SECONDS - COLLECTION_DEADLINE_RESERVE_SECONDS;
  return (
    `LEAST(now() + interval '${Math.floor(windowSeconds)} seconds', ` +
    `"expires_at" + interval '${cap} seconds')`
  );
}

/**
 * The last instant a dispute is still guaranteed a refund: `collectable_at`
 * less the filing guard. `null` when the call has no hold.
 */
export function disputeWindowEndOf(collectableAt: Date | null | undefined): Date | null {
  if (!collectableAt) return null;
  return new Date(collectableAt.getTime() - DISPUTE_FILING_GUARD_SECONDS * 1000);
}
