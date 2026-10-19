/**
 * The payment-key daily summary's schedule and lock (spec §7.10 item 6).
 */

/** Daily at 00:20 UTC: yesterday (UTC) is closed by then. */
export const PAYMENT_KEY_DAILY_SUMMARY_CRON = '0 20 0 * * *';

/**
 * One run per window across every scheduler replica: `SET … NX EX`, not
 * released at the end of a run, so a second run inside the hour is a no-op.
 * The summary itself is also `ONCE_PER_UTC_DAY` per organization, so a run
 * the lock did not stop still sends nothing twice.
 */
export const PAYMENT_KEY_DAILY_SUMMARY_LOCK_KEY = 'payment-key:daily-summary:lock';
export const PAYMENT_KEY_DAILY_SUMMARY_LOCK_TTL_SECONDS = 3600;

/** Keys named in one notice body; the payload lists them all. */
export const PAYMENT_KEY_DAILY_SUMMARY_MAX_KEYS_IN_BODY = 10;

/** DI token for {@link PaymentKeyDailySummaryConfig}. */
export const PAYMENT_KEY_DAILY_SUMMARY_CONFIG = 'PAYMENT_KEY_DAILY_SUMMARY_CONFIG';

/** `now` as a function, so a test can move the clock. */
export interface PaymentKeyDailySummaryConfig {
  readonly now: () => number;
}
