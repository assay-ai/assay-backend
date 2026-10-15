import { CronExpression } from '@nestjs/schedule';

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
 * verification enqueue already follows. The chain accepts the voucher until
 * `expiresAt + CLOCK_SKEW_TOLERANCE_SECONDS + REDEEM_GRACE_SECONDS` (120 +
 * 1,800 s), so settling at 900 s leaves the per-minute redemption job about
 * 17 minutes to collect it. Without it a late verdict (judge queue backed up,
 * worker down) left a served call whose voucher could no longer be redeemed
 * (no-platform-debt design, A13).
 */
export const PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS = 900;

/**
 * The latest the verdict-deadline sweep still settles, in seconds past the
 * voucher's `expiresAt`.
 *
 * The chain refuses a voucher after `expiresAt + CLOCK_SKEW_TOLERANCE_SECONDS +
 * REDEEM_GRACE_SECONDS` (1,920 s). Settling a row the chain already refuses
 * hands the redemption job a `VoucherExpired` it cannot collect, so the sweep
 * stops this margin (300 s, five redemption passes) before that. Older rows are
 * left to the 24-hour hold backstop, which releases the buyer's hold and pays
 * nobody (review 2026-10-15, H1). Kept here rather than imported from
 * `voucher-redemption.constants.ts` so the arithmetic is in one line:
 * 120 + 1,800 - 300.
 */
export const PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS = 120 + 1_800 - 300;

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
