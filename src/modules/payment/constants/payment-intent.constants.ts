import { CronExpression } from '@nestjs/schedule';

import {
  REDEEM_GRACE_SECONDS,
  REDEMPTION_DEADLINE_MARGIN_SECONDS,
} from './voucher-redemption.constants';

/**
 * How long an intent may sit unresolved before the sweep expires it.
 *
 * Five minutes from creation, and only for intents that never got moving
 * (`CREATED`, `FUNDS_SECURED`). The middle of three bounds: the voucher
 * signature rejects a stale voucher above it, and the ledger hold's own
 * 24-hour expiry ({@link PAYMENT_INTENT_HOLD_TTL_MS}) catches a call a worker
 * took and never resolved.
 */
export const PAYMENT_INTENT_TTL_MS = 5 * 60 * 1000;

/**
 * The deadline stamped on the hold, and the backstop that enforces it.
 *
 * `LedgerHoldService.createHold` writes it to `ledger_holds.expires_at`. When
 * it passes with the intent still `PROVIDER_EXECUTING` or `VERIFYING` — the
 * worker died and never answered — `PaymentIntentExpiryService` moves the
 * intent to `EXPIRED` and releases the hold, so a hold always expires in the
 * agent's favour.
 */
export const PAYMENT_INTENT_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/** The sweep runs on the scheduler, which is a single instance by design. */
export const PAYMENT_INTENT_EXPIRY_SWEEP_CRON = CronExpression.EVERY_MINUTE;

/**
 * Intents expired per pass.
 *
 * A bound rather than "everything due": a backlog after an outage should drain
 * over several passes instead of opening one transaction per intent in a burst
 * that starves the API of connections.
 */
export const PAYMENT_INTENT_EXPIRY_SWEEP_BATCH = 200;

/**
 * The deadline on verdicts, in seconds past the voucher's `expiresAt`.
 *
 * A rail-B intent still `VERIFYING` this long after its voucher's `expiresAt`
 * is settled as served and unverified by the expiry sweep — the rule a failed
 * verification enqueue already follows. The EVM contract accepts the voucher
 * until `expiresAt + REDEEM_GRACE_SECONDS` (1,800 s) with NO clock-skew
 * allowance (`X402Escrow.sol:784`, mirrored by `evm-voucher-prevalidation.ts`),
 * so settling at 900 s leaves the per-minute redemption job about 15 minutes to
 * collect it. Without it a late verdict (judge queue backed up, worker down)
 * left a served call whose voucher could no longer be redeemed
 * (no-platform-debt design, A13).
 */
export const PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS = 900;

/**
 * How long before the chain's redemption deadline a voucher must still have
 * when its intent settles to be handed to the redemption job: 60 s, one
 * redemption pass (`VOUCHER_REDEMPTION_CRON` runs every minute). Any earlier
 * and the chain would still redeem it, so a passing verdict that lands then is
 * collected normally rather than turned into debt (review-buyer-debt M2). The
 * redemption job lapses it itself if the chain refuses it after all.
 */
export const PAYMENT_INTENT_REDEMPTION_MARGIN_SECONDS = REDEMPTION_DEADLINE_MARGIN_SECONDS;

/**
 * The latest a rail-B intent may settle, in seconds past its voucher's
 * `expiresAt`, and still be handed to the redemption job: the chain's deadline
 * (`expiresAt + REDEEM_GRACE_SECONDS`, no skew on EVM) less
 * {@link PAYMENT_INTENT_REDEMPTION_MARGIN_SECONDS} — 1,740 s.
 *
 * A passing verdict that lands later — the worker or the sweep was down — is
 * still applied (`SETTLED`: the call was served), but its voucher is NOT handed
 * to the redemption job to die on `VoucherExpired`: `PaymentIntentService.resolve`
 * turns it into buyer debt in the same statement (the hold stays open, nobody
 * is credited, the buyer re-signs). The platform never pays for a late verdict.
 */
export const PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS =
  REDEEM_GRACE_SECONDS - PAYMENT_INTENT_REDEMPTION_MARGIN_SECONDS;

/** What `redemption_last_error` names when a verdict settled past the latest above. */
export const LATE_VERDICT_LAPSE_CAUSE = 'VerdictPastRedemptionDeadline';

/** Written to `status_reason` so the row itself says who moved it and why. */
export const PAYMENT_INTENT_EXPIRY_REASON =
  'expiry sweep: expiresAt elapsed before the call reached a terminal state';

/** Written when the 24-hour hold backstop expired an intent a worker never resolved. */
export const PAYMENT_INTENT_HOLD_BACKSTOP_REASON =
  'hold backstop: the 24-hour hold deadline passed before the call was resolved';

/** Written when a sweep expired the intent but the hold release did not land. */
export const PAYMENT_INTENT_HOLD_REPAIR_REASON =
  'expiry sweep repair: intent was already EXPIRED with its hold still open';

/** Written when funds are secured — the edge that opens the hold. */
export const PAYMENT_INTENT_FUNDS_SECURED_REASON = 'payment authorised; ledger hold opened';
