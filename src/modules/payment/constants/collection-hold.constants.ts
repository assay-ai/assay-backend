/**
 * The dispute hold (G3.B1, "redeem into hold", analysis §5).
 *
 * Rail B: `redeemVoucher` puts the money in the escrow's `held[payer][seq]`,
 * out of the buyer's balance and not yet the provider's, with `collectableAt =
 * redeemed + Config.collectHoldSeconds()` (default 3,600 s, frozen per record).
 * `HeldCollectionJob` collects it after `collectableAt` unless a dispute holds
 * it; an upheld dispute refunds it into the buyer's escrow. The voucher's own
 * clock (expiry, redeem grace) is untouched, so the hold can never make a
 * voucher expire before redemption.
 *
 * Rail A (the facilitator settles at call time): there is no chain hold, so the
 * provider's ledger credit — and so its payout — is withheld for
 * `CALL_DISPUTE_HOLD_WINDOW_MINUTES` instead.
 */

/** A dispute filed at or after `collectable_at − 60 s` is not guaranteed a refund. */
export const DISPUTE_FILING_GUARD_SECONDS = 60;

const MAX_WINDOW_MINUTES = 24 * 60;
const DEFAULT_WINDOW_MINUTES = 60;

/**
 * `CALL_DISPUTE_HOLD_WINDOW_MINUTES` — rail A's hold, an integer from 1 to
 * 1440 (the chain's own bounds for rail B are 60 s to 86,400 s). A malformed
 * value refuses to boot: a silently different window changes who is refunded.
 */
export function loadCollectionHoldWindowSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CALL_DISPUTE_HOLD_WINDOW_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_WINDOW_MINUTES * 60;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_WINDOW_MINUTES) {
    throw new Error(
      `CALL_DISPUTE_HOLD_WINDOW_MINUTES must be an integer from 1 to ${MAX_WINDOW_MINUTES}, ` +
        `got "${raw}"`,
    );
  }
  return Number(raw) * 60;
}

export const COLLECTION_HOLD_WINDOW_SECONDS = loadCollectionHoldWindowSeconds();

/** `held_status` values. */
export const HELD = 'HELD';
export const HELD_COLLECTED = 'COLLECTED';
export const HELD_REFUNDED = 'REFUNDED';

/**
 * The last instant a dispute is still guaranteed a refund: `collectable_at`
 * less the filing guard. `null` while the payment is not held yet (a rail-B
 * voucher not redeemed yet — a dispute filed then is guaranteed too).
 */
export function disputeWindowEndOf(collectableAt: Date | null | undefined): Date | null {
  if (!collectableAt) return null;
  return new Date(collectableAt.getTime() - DISPUTE_FILING_GUARD_SECONDS * 1000);
}
