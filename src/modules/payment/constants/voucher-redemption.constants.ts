/**
 * Every minute.
 *
 * The deadline this races is `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` (2,220s ≈ 37
 * minutes) — after which the program refuses the voucher outright and the
 * call becomes buyer debt — so a five-minute cadence would spend an eighth of
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
 * review R2-6). The hold stays open either way: closing it without an
 * answer could charge the buyer twice.
 */
export const LANDING_UNKNOWN_ALERT_SECONDS = 3 * 3_600;

export const VOUCHER_REDEMPTION_ALERTS = {
  /**
   * The chain refused a voucher permanently for a reason that is not the
   * provider's, so the served call became BUYER DEBT: the buyer's hold stays
   * open, nobody is credited, and the payer's paid calls are refused until the
   * buyer signs a replacement voucher. The platform pays nothing — CRITICAL
   * because a collection failure is what an outage or a buyer exploit looks
   * like from here.
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
   * `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` — after which the call becomes buyer
   * debt the buyer must re-sign. An outage that silently converts into debt is
   * the shape of failure the alert catalogue exists for.
   */
  MISCONFIGURED: 'voucher_redemption_misconfigured',
  /**
   * The chain refused a voucher and, long after the landing window, whether
   * one of its own transactions redeemed it still cannot be read (the lookup
   * keeps failing). Nothing closes or commits the hold until a human or the
   * RPC answers, so it would otherwise stay open in silence.
   */
  LANDING_UNKNOWN: 'voucher_redemption_landing_unknown',
  /**
   * An open buyer debt was not settled within {@link BUYER_DEBT_WRITE_OFF_DAYS}
   * and was written off: the buyer's hold is released and the provider is not
   * paid. Nobody owes anything afterwards — WARN, so a buyer that walks away
   * from its debts is seen.
   */
  DEBT_WRITTEN_OFF: 'voucher_debt_written_off',
  /**
   * The verdict-deadline sweep settled served calls whose verdict came too
   * late for their vouchers, so they became buyer debt at once
   * (review-buyer-debt M2). One page per incident: a backlog in verification
   * is what this looks like, and every affected buyer is refused paid calls.
   */
  VERDICT_DEADLINE_DEBT: 'voucher_verdict_deadline_debt',
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

/**
 * What `redemption_last_error` carries once an open buyer debt is WRITTEN OFF,
 * followed by the refusal the voucher lapsed on. `WRITTEN_OFF_SQL` in
 * `payment-intent.repository.ts` matches the same literal.
 */
export const UNCOLLECTED_PREFIX = 'uncollected:';

/**
 * What `redemption_last_error` carries once a buyer debt is VOIDED: a FAIL /
 * REFUND / VOID verdict arrived after the call had been settled as served and
 * unverified, and had become debt (review-buyer-debt M2). The hold is
 * released, nobody is credited and the buyer is not charged. Followed by the
 * verdict's outcome. `VOIDED_SQL` in `payment-intent.repository.ts` matches the
 * same literal.
 */
export const DEBT_VOIDED_PREFIX = 'voided:';

/**
 * How close to a voucher's on-chain deadline (`expiresAt + REDEEM_GRACE_SECONDS`)
 * the platform stops waiting on it: one redemption pass. A verdict that lands
 * later settles as debt at once, and a voucher still refused by a buyer
 * tightening (a revoked or expired delegate, a lowered cap) that late becomes
 * debt instead of waiting for `VoucherExpired` (review-buyer-debt M2, M3).
 */
export const REDEMPTION_DEADLINE_MARGIN_SECONDS = 60;

/**
 * Days an open buyer debt waits for its replacement voucher before it is
 * written off: the hold is released and the provider is not paid (owner
 * decision, no-platform-debt design step 10). Counted from the FIRST lapse.
 */
export const BUYER_DEBT_WRITE_OFF_DAYS = 30;

/**
 * How long past a debt's lapsed voucher's `expiresAt` its replacement may be
 * accepted: `REDEEM_GRACE_SECONDS` (the contract refuses the voucher after
 * `expiresAt + grace`) + `CLOCK_SKEW_TOLERANCE_SECONDS` (a block clock ahead of
 * ours). Before then the old voucher may still be redeemable — a debt can
 * lapse before its deadline — and a replacement at a higher seq redeemed after
 * it would charge the buyer twice. `trg_payment_intents_voucher_seq_immutable`
 * (migration 1760900000000) enforces the same 1,920 s.
 */
export const DEBT_REPLACEABLE_AFTER_EXPIRY_SECONDS =
  REDEEM_GRACE_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS;
