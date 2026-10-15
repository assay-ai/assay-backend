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

/**
 * How long past a voucher's on-chain deadline "not found" is still read as
 * "unknown" (final review N-7). Far beyond the few blocks a load-balanced node
 * lags, and short against the 24 h the hold may stay open.
 */
export const LANDING_SETTLE_SECONDS = 600;

/**
 * How long past {@link LANDING_SETTLE_SECONDS} a refused voucher's landing may
 * stay unknown — the lookup itself keeps failing — before it pages (round-two
 * review R2-6). The hold stays open either way: absorbing it without an
 * answer could pay the provider twice.
 */
export const LANDING_UNKNOWN_ALERT_SECONDS = 3 * 3_600;

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
  /**
   * The chain refused a voucher and, long after the landing window, whether
   * one of its own transactions redeemed it still cannot be read (the lookup
   * keeps failing). Nothing absorbs or commits the hold until a human or the
   * RPC answers, so it would otherwise stay open in silence.
   */
  LANDING_UNKNOWN: 'voucher_redemption_landing_unknown',
  /**
   * The provider forfeited a voucher it caused to fail: its stake fell below
   * the program's minimum, or the provider or its payee is blocked. The buyer's
   * hold is released and nobody is credited, so it costs the platform nothing —
   * WARN, so a provider that keeps forfeiting is seen.
   */
  PROVIDER_FORFEIT: 'voucher_provider_forfeit',
} as const;

/**
 * What `redemption_last_error` carries once the provider forfeited the
 * voucher, followed by the cause: a program error (`ProviderBelowMinimumStake`)
 * or a block (`ProviderBlocked`, `PayeeBlocked`, `PayeeBlockedOnChain`).
 * `FORFEITED_SQL` in `payment-intent.repository.ts` matches the same literal.
 */
export const PROVIDER_FORFEIT_PREFIX = 'provider_forfeit:';
