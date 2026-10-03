import { CronExpression } from '@nestjs/schedule';

/**
 * How long an intent may sit unresolved before the sweep expires it.
 *
 * Five minutes from creation. The intended design makes it the middle of three
 * bounds — the voucher signature
 * rejects a stale voucher above it, and the ledger hold's own 24-hour expiry
 * catches anything that gets past both. In this codebase there are **two**
 * bounds, not three: the third is unimplemented, so this sweep is the last one
 * that actually runs. See {@link PAYMENT_INTENT_HOLD_TTL_MS}.
 */
export const PAYMENT_INTENT_TTL_MS = 5 * 60 * 1000;

/**
 * The deadline stamped on the hold — **which nothing enforces.**
 *
 * The intended design makes this the backstop that releases an agent's funds
 * if the verification worker crashes and never resumes, so that holds always
 * expire in the agent's favour. That is the target, not the current state.
 *
 * What actually happens: the value reaches `ledger_holds.expires_at` via
 * `LedgerHoldService.createHold`, is mapped into a DTO, and is read by nothing
 * else. No cron sweeps holds by expiry; `PaymentIntentExpiryService`'s repair
 * pass is gated on `status = EXPIRED`, so it never sees a hold left open by a
 * terminal intent. Funds stranded this way stay stranded until somebody
 * releases the hold by hand.
 *
 * It is kept, and kept at 24 hours, because it is the deadline a sweeper will
 * read when one is written — deleting it would delete the only record of what
 * the window is meant to be. **Do not cite it as a guarantee.** Anything
 * relying on funds coming back needs to release them itself.
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

/** Written when a sweep expired the intent but the hold release did not land. */
export const PAYMENT_INTENT_HOLD_REPAIR_REASON =
  'expiry sweep repair: intent was already EXPIRED with its hold still open';

/** Written when funds are secured — the edge that opens the hold. */
export const PAYMENT_INTENT_FUNDS_SECURED_REASON = 'payment authorised; ledger hold opened';
