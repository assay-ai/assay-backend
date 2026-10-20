/**
 * The payment-key daily summary's schedule and lock (spec §7.10 item 6).
 */

/**
 * Hourly from 00:20 to 05:20 UTC: yesterday (UTC) is closed by the first run,
 * and the later runs catch up an organization a scheduler outage or a crash
 * part-way through left unsent. `ONCE_PER_UTC_DAY` per organization makes
 * every later run send only what is missing.
 */
export const PAYMENT_KEY_DAILY_SUMMARY_CRON = '0 20 0-5 * * *';

/**
 * One run at a time across every scheduler replica: `SET …:{day} NX EX`, not
 * released at the end of a run. Per day and short, so it stops a second
 * replica's concurrent run without stopping the next hour's catch-up. The
 * summary itself is `ONCE_PER_UTC_DAY` per organization, so a run the lock
 * did not stop still sends nothing twice.
 */
export const PAYMENT_KEY_DAILY_SUMMARY_LOCK_KEY_PREFIX = 'payment-key:daily-summary:lock:';
export const PAYMENT_KEY_DAILY_SUMMARY_LOCK_TTL_SECONDS = 15 * 60;

/** Keys named in one notice body; the payload lists them all. */
export const PAYMENT_KEY_DAILY_SUMMARY_MAX_KEYS_IN_BODY = 10;

/** DI token for {@link PaymentKeyDailySummaryConfig}. */
export const PAYMENT_KEY_DAILY_SUMMARY_CONFIG = 'PAYMENT_KEY_DAILY_SUMMARY_CONFIG';

/** `now` as a function, so a test can move the clock. */
export interface PaymentKeyDailySummaryConfig {
  readonly now: () => number;
}
