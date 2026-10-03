/**
 * Every minute.
 *
 * The deadline this races is `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` (2,220s ≈ 37
 * minutes) — after which the program refuses the voucher outright and the
 * platform absorbs the call — so a five-minute cadence would spend an eighth of
 * the budget sitting in a queue. Written out rather than
 * `CronExpression.EVERY_MINUTE` for the reason `RECONCILIATION_CRON` is: the
 * cadence a runbook quotes should be greppable as a literal.
 */
export const VOUCHER_REDEMPTION_CRON = '0 * * * * *';

/**
 * Holds per pass. One transaction each, so this is also a fee
 * budget: 100 × 5,000 lamports ≈ 0.5 SOL per minute at full tilt.
 */
export const VOUCHER_REDEMPTION_BATCH = 100;

/**
 * `MAX_VOUCHER_LIFETIME_SECONDS` (300) + `CLOCK_SKEW_TOLERANCE_SECONDS` (120)
 * + `REDEEM_GRACE_SECONDS` (1,800) — the outer edge of the window in which the
 * program will still accept a voucher, counted from `issued_at`.
 *
 * Written as the sum rather than as 2,220 so that a change to any of the three
 * on chain reads here as an arithmetic disagreement rather than as a number
 * nobody can source.
 */
export const MAX_VOUCHER_LIFETIME_SECONDS = 300;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120;
export const REDEEM_GRACE_SECONDS = 1_800;
export const MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS =
  MAX_VOUCHER_LIFETIME_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + REDEEM_GRACE_SECONDS;

export const VOUCHER_REDEMPTION_ALERTS = {
  /**
   * The chain refused a voucher permanently. The buyer keeps their money and
   * the platform pays the provider out of its own funds, so this is a direct,
   * silent cost — CRITICAL because nothing else reports it.
   */
  UNREDEEMABLE: 'voucher_unredeemable',
  /**
   * A hold has outlived `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` and is still not
   * redeemed — an overdue hold needs an alert. It is about to become
   * an `UNREDEEMABLE`.
   */
  OVERDUE: 'voucher_redemption_overdue',
  /**
   * The program refuses every redemption because this deployment is not its
   * configured redeemer (`Config.redeemer`, `NotRedeemer` 6053).
   *
   * CRITICAL and not WARN: nothing redeems until a human acts, every rail-B
   * hold stays open meanwhile, and each one is on a clock —
   * `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` — after which the platform pays the
   * provider itself. An outage that silently converts into a bill is the shape
   * of failure the alert catalogue exists for.
   */
  MISCONFIGURED: 'voucher_redemption_misconfigured',
} as const;
