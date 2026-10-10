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
