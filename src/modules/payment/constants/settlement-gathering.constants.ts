import type { RedemptionExclusions } from '@database/postgres/repositories/payment-intent.repository';

import { MAX_HELD_BATCH } from '../ports/held-payments.port';
import { VOUCHER_REDEMPTION_BATCH } from './voucher-redemption.constants';

/**
 * Gathering: wait for a larger batch before an on-chain send (owner decision
 * 2026-10-30).
 *
 * A batched send has a fixed part paid once per transaction (redeem about
 * 121k gas, collect about 80k) and a part per item (81k, 40k). One voucher
 * redeemed alone costs 181k; twenty in one batch cost about 87k each. So a
 * pass that would send a handful waits, until there are enough to send — or
 * until waiting longer would cost more than gas:
 *
 * - **Redeem** (`VoucherRedemptionService.run`, batched chains only): a pass
 *   runs when at least `REDEEM_MIN_BATCH` vouchers await, OR the oldest was
 *   issued `REDEEM_MAX_WAIT_SECONDS` ago, OR any is within
 *   `EVM_FEE_CAP_WAIVED_WITHIN_SECONDS` of its on-chain deadline.
 * - **Collect** (`HeldCollectionService`, the batched rail-B path before the
 *   timeout): a pass collects an asset when at least `COLLECT_MIN_BATCH` are
 *   collectable, OR the oldest has been collectable for
 *   `COLLECT_MAX_WAIT_SECONDS`, OR any is close to the 7-day timeout. The
 *   timeout queue, blocked-provider refunds and rail A run every pass.
 *
 * A minimum batch of 1 turns gathering off. A gathering check that fails
 * (the count query throws) runs the pass: gathering saves gas, it must never
 * cost a payment.
 *
 * ## What waiting does to everything else
 *
 * - **Dispute before redemption** (`holdForDispute`, `dispute-hold.ts`): a
 *   served rail-B call not redeemed yet is refund-guaranteed — a dispute filed
 *   then is recorded on the intent, the voucher is still redeemed into the
 *   escrow's hold as usual, and the full `collectHoldSeconds` window starts at
 *   the redemption. Waiting up to 15 minutes only lengthens the time a dispute
 *   is guaranteed; it never shortens the window.
 * - **Voucher deadline**: a voucher is redeemable until `expiresAt + 7,200 s`
 *   on eip155 (about 7,620 s after issue). The age trigger (900 s, at most
 *   3,600 s) fires long before, and the deadline trigger fires before the fee
 *   cap is waived — gathering never pushes a voucher towards expiry.
 * - **`collectHoldSeconds` (1 h)**: frozen per record at redemption and
 *   counted from it, so a later redemption moves `collectableAt` later by the
 *   same amount. The dispute guard (`collectableAt − 60 s`) is unchanged.
 * - **Collect gathering**: only AFTER `collectableAt`, when no dispute can be
 *   filed with a guaranteed refund any more (`holdForDispute` requires
 *   `collectableAt − 60 s > now()`), so waiting adds no refund right. A
 *   dispute decided upheld meanwhile is still refunded (`disputeOutcome` keeps
 *   the row out of collection).
 * - **Provider earnings**: the provider's ledger credit is booked only when
 *   the chain says `COLLECTED`, so a call stays pending in the provider's
 *   earnings up to `REDEEM_MAX_WAIT_SECONDS` + 1 h + `COLLECT_MAX_WAIT_SECONDS`
 *   (by default about 7 h 15 min) instead of about 1 h.
 * - **Timeout**: anyone may collect `collectableAt + 7 days`; the age trigger
 *   (6 h, at most 24 h) fires days before the timeout queue takes over.
 */
export interface GatheringPolicy {
  /** Run when at least this many are waiting. 1 turns gathering off. */
  readonly minBatch: number;
  /** …or when the oldest has waited this long, in seconds. */
  readonly maxWaitSeconds: number;
}

export const DEFAULT_REDEEM_MIN_BATCH = 20;
export const DEFAULT_REDEEM_MAX_WAIT_SECONDS = 900;
/** Far inside the 7,620 s an eip155 voucher stays redeemable. */
export const MAX_REDEEM_MAX_WAIT_SECONDS = 3_600;

export const DEFAULT_COLLECT_MIN_BATCH = 20;
export const DEFAULT_COLLECT_MAX_WAIT_SECONDS = 21_600;
/** Far inside the 7-day held timeout. */
export const MAX_COLLECT_MAX_WAIT_SECONDS = 86_400;

/** Injection tokens. Unprovided, the env values below are used. */
export const REDEEM_GATHERING = 'REDEEM_GATHERING';
export const COLLECT_GATHERING = 'COLLECT_GATHERING';

/** No gathering: every pass runs, as before. */
export const NO_GATHERING: GatheringPolicy = Object.freeze({ minBatch: 1, maxWaitSeconds: 0 });

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    // A malformed value refuses to boot rather than silently gather differently.
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  }
  return Number(raw);
}

/** `REDEEM_MIN_BATCH` (1–100, default 20) and `REDEEM_MAX_WAIT_SECONDS` (0–3,600, default 900). */
export function loadRedeemGathering(env: NodeJS.ProcessEnv = process.env): GatheringPolicy {
  return {
    minBatch: integer(
      env,
      'REDEEM_MIN_BATCH',
      DEFAULT_REDEEM_MIN_BATCH,
      1,
      VOUCHER_REDEMPTION_BATCH,
    ),
    maxWaitSeconds: integer(
      env,
      'REDEEM_MAX_WAIT_SECONDS',
      DEFAULT_REDEEM_MAX_WAIT_SECONDS,
      0,
      MAX_REDEEM_MAX_WAIT_SECONDS,
    ),
  };
}

/** `COLLECT_MIN_BATCH` (1–64, default 20) and `COLLECT_MAX_WAIT_SECONDS` (0–86,400, default 21,600). */
export function loadCollectGathering(env: NodeJS.ProcessEnv = process.env): GatheringPolicy {
  return {
    minBatch: integer(env, 'COLLECT_MIN_BATCH', DEFAULT_COLLECT_MIN_BATCH, 1, MAX_HELD_BATCH),
    maxWaitSeconds: integer(
      env,
      'COLLECT_MAX_WAIT_SECONDS',
      DEFAULT_COLLECT_MAX_WAIT_SECONDS,
      0,
      MAX_COLLECT_MAX_WAIT_SECONDS,
    ),
  };
}

export const REDEEM_GATHERING_FROM_ENV: GatheringPolicy = loadRedeemGathering();
export const COLLECT_GATHERING_FROM_ENV: GatheringPolicy = loadCollectGathering();

/** What the count query reports about one asset's waiting items. */
export interface WaitingSummary {
  readonly count: number;
  /** When the oldest started waiting (issued, or became collectable); `null` when none. */
  readonly oldestAt: Date | null;
  /** The earliest on-chain deadline among them; `null` when none or not known. */
  readonly earliestDeadlineAt: Date | null;
}

/**
 * Whether a pass should send now: enough are waiting, the oldest has waited
 * long enough, or one is within `urgentWithinSeconds` of its deadline.
 */
export function gatheringReady(
  policy: GatheringPolicy,
  waiting: WaitingSummary,
  nowMs: number,
  urgentWithinSeconds: number,
): boolean {
  if (waiting.count === 0) return false;
  if (waiting.count >= policy.minBatch) return true;
  if (waiting.oldestAt && nowMs - waiting.oldestAt.getTime() >= policy.maxWaitSeconds * 1000) {
    return true;
  }
  return (
    waiting.earliestDeadlineAt !== null &&
    waiting.earliestDeadlineAt.getTime() - nowMs <= urgentWithinSeconds * 1000
  );
}

/** The repository read {@link redemptionPassReady} needs. */
export interface AwaitingRedemptionSummarySource {
  summarizeAwaitingRedemption(
    assetId: string,
    settledStatus: string,
    rail: string,
    options?: { readonly orderedBySeq?: boolean; readonly exclude?: RedemptionExclusions },
  ): Promise<{ count: number; oldestIssuedAt: Date | null; earliestExpiresAt: Date | null }>;
}

/**
 * Whether the redemption pass of `asset` runs now (see the file comment).
 * Only a chain that batches (`batchSize > 1`) gathers: a voucher sent alone
 * costs the same whenever it goes. The deadline is the chain's own
 * (`expiresAt` + `graceSeconds`), and `urgentWithinSeconds` is the window in
 * which the redeemer already waives its fee cap
 * (`EVM_FEE_CAP_WAIVED_WITHIN_SECONDS`). `exclude` is the pass's own
 * blocked-party set, so a voucher the pass would hold is not counted either
 * (review 2026-10-30 M-2). A failed count runs the pass.
 */
export async function redemptionPassReady(input: {
  readonly policy: GatheringPolicy;
  readonly payments: AwaitingRedemptionSummarySource;
  readonly asset: string;
  readonly settledStatus: string;
  readonly rail: string;
  readonly batchSize: number;
  readonly orderedBySeq: boolean;
  readonly exclude?: RedemptionExclusions;
  readonly graceSeconds: number;
  readonly urgentWithinSeconds: number;
  readonly nowMs: number;
  readonly onError?: (error: unknown) => void;
}): Promise<boolean> {
  if (input.batchSize <= 1 || input.policy.minBatch <= 1) return true;
  try {
    const waiting = await input.payments.summarizeAwaitingRedemption(
      input.asset,
      input.settledStatus,
      input.rail,
      { orderedBySeq: input.orderedBySeq, exclude: input.exclude },
    );
    return gatheringReady(
      input.policy,
      {
        count: waiting.count,
        oldestAt: waiting.oldestIssuedAt,
        earliestDeadlineAt: waiting.earliestExpiresAt
          ? new Date(waiting.earliestExpiresAt.getTime() + input.graceSeconds * 1000)
          : null,
      },
      input.nowMs,
      input.urgentWithinSeconds,
    );
  } catch (error) {
    input.onError?.(error);
    return true;
  }
}
