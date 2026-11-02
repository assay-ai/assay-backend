import { HELD_COLLECTED } from '../constants/collection-hold.constants';

/** The fields of a payment intent the payout view reads. */
export interface PayoutViewIntent {
  heldStatus?: string | null;
  heldAt?: Date | null;
  heldTxRef?: string | null;
  holdReleasedAt?: Date | null;
  collectableAt?: Date | null;
  voucherFormat?: string | null;
  channelCumulative?: string | null;
  channelCalls?: number | null;
}

/** A channel call's lane position and bucket, as the call list and the receipt show it. */
export interface ChannelCallView {
  cumulative: string;
  calls: number;
  settled: boolean;
  bucketMaturesAt: Date | null;
  refundWindowExtended: boolean;
}

/**
 * Whether, when and by which transaction the call's held payment (per call)
 * or the channel bucket holding it was paid to the provider: the collect
 * booking (`PaymentIntentService.bookHeldCollected`) sets `held_status =
 * 'COLLECTED'`, the collect transaction and `hold_released_at` on each
 * collected call. One reading for the call list, the receipt and the provider
 * CSV, so they cannot disagree (BUG-R2-BUY-05).
 */
export function payoutOf(intent: PayoutViewIntent): {
  collectedAt: Date | null;
  payoutTxRef: string | null;
} {
  if (intent.heldStatus !== HELD_COLLECTED) return { collectedAt: null, payoutTxRef: null };
  return {
    collectedAt: intent.holdReleasedAt ?? null,
    payoutTxRef: intent.heldTxRef ?? null,
  };
}

export function voucherFormatOf(intent: PayoutViewIntent): 'PER_CALL' | 'CHANNEL' {
  return intent.voucherFormat === 'CHANNEL' ? 'CHANNEL' : 'PER_CALL';
}

/** `null` for a per-call payment. */
export function channelViewOf(intent: PayoutViewIntent): ChannelCallView | null {
  if (intent.voucherFormat !== 'CHANNEL') return null;
  return {
    cumulative: String(intent.channelCumulative),
    calls: Number(intent.channelCalls),
    settled: intent.heldAt !== null && intent.heldAt !== undefined,
    bucketMaturesAt: intent.collectableAt ?? null,
    refundWindowExtended: foldedLater(intent.heldAt, intent.collectableAt),
  };
}

/**
 * Whether a channel bucket's maturity moved past where this call's own hold
 * put it (a later settlement folded into the bucket, `ChannelBucketDeferred`):
 * the receipt then says "refund window extended". The call's own maturity is
 * the next full hour after `heldAt` + the 1-hour hold.
 */
function foldedLater(
  heldAt: Date | null | undefined,
  collectableAt: Date | null | undefined,
): boolean {
  if (!heldAt || !collectableAt) return false;
  const own = Math.ceil((heldAt.getTime() / 1000 + 3_600) / 3_600) * 3_600;
  return collectableAt.getTime() / 1000 > own;
}
