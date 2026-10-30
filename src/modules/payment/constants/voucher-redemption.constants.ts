import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';

/**
 * Every minute.
 *
 * The deadline this races is {@link maxVoucherRedeemableLifeSeconds} (2,220s ≈
 * 37 minutes on Solana, 7,620s ≈ 2 h 7 min on eip155) — after which the chain
 * refuses the voucher outright and the call is closed (buyer debt or, when
 * the platform failed to redeem it, voided) — so a five-minute cadence would spend an eighth of the Solana budget sitting in a
 * queue. Written out rather than
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
 * `MAX_VOUCHER_LIFETIME_SECONDS` (300) and `CLOCK_SKEW_TOLERANCE_SECONDS` (120)
 * are the same on both chains. The redemption grace is not (assay-evm D-24):
 * the Solana program keeps `REDEEM_GRACE_SECONDS = 30 * 60`, `AssayEscrow`
 * raised it to `2 * 3600` (`EVM_CONSTANTS.REDEEM_GRACE_SECONDS`). So the grace
 * and everything derived from it is asked per chain, through
 * {@link redeemGraceSeconds} and {@link maxVoucherRedeemableLifeSeconds}, and
 * in SQL through {@link redeemGraceIntervalSql}.
 */
export const MAX_VOUCHER_LIFETIME_SECONDS = 300;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120;
/** The Solana program's `REDEEM_GRACE_SECONDS` (`constants.rs`, `30 * 60`). */
export const SOLANA_REDEEM_GRACE_SECONDS = 1_800;

/**
 * Whether a CAIP identifier (chain, account or asset) is on `eip155`. Every
 * other namespace the platform serves is Solana, whose values are the
 * defaults below. A plain prefix read rather than a full CAIP parse: a
 * deadline computation must not throw on a malformed row.
 */
function isEip155(caipId: string): boolean {
  return caipId.split(':', 1)[0] === 'eip155';
}

/**
 * How long after `expiresAt` the chain still redeems a voucher: 7,200 s on
 * eip155 (`Constants.sol` `REDEEM_GRACE_SECONDS`, D-24), 1,800 s on Solana.
 * `caipId` is the intent's chain id, payer account or asset id.
 */
export function redeemGraceSeconds(caipId: string): number {
  return isEip155(caipId) ? EVM_CONSTANTS.REDEEM_GRACE_SECONDS : SOLANA_REDEEM_GRACE_SECONDS;
}

/**
 * `MAX_VOUCHER_LIFETIME_SECONDS` + `CLOCK_SKEW_TOLERANCE_SECONDS` + the
 * chain's {@link redeemGraceSeconds} — the outer edge of the window in which
 * the chain will still accept a voucher, counted from `issued_at`: 7,620 s on
 * eip155, 2,220 s on Solana.
 *
 * Written as the sum rather than as a literal so that a change to any of the
 * three on chain reads here as an arithmetic disagreement rather than as a
 * number nobody can source.
 */
export function maxVoucherRedeemableLifeSeconds(caipId: string): number {
  return MAX_VOUCHER_LIFETIME_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + redeemGraceSeconds(caipId);
}

/**
 * {@link redeemGraceSeconds} as a SQL `interval`, decided per row on the CAIP-2
 * `chain_id` column named by `chainIdColumn` — for queries that read rows of
 * both chains at once. Both values are literals from the constants above,
 * never input.
 */
export function redeemGraceIntervalSql(chainIdColumn: string): string {
  return (
    `(CASE WHEN split_part(${chainIdColumn}, ':', 1) = 'eip155' ` +
    `THEN interval '${EVM_CONSTANTS.REDEEM_GRACE_SECONDS} seconds' ` +
    `ELSE interval '${SOLANA_REDEEM_GRACE_SECONDS} seconds' END)`
  );
}

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
   * A served call's voucher could not be redeemed because of the PLATFORM —
   * the redeemer could not send (unfunded, transport/RPC failure), the chain
   * reverted with no named reason, or sends were deferred on a fee spike —
   * and it was VOIDED (incident 2026-10-29): the buyer's hold is released,
   * the buyer is not charged, the provider is not paid. CRITICAL: providers
   * are losing served calls until a human fixes the redeemer. Aggregated per
   * asset and cause (`ONCE_PER_INCIDENT`), so an outage that voids hundreds
   * of vouchers pages once per incident window, not once per voucher.
   */
  PLATFORM_VOIDED: 'voucher_platform_voided',
  /**
   * A hold has outlived {@link maxVoucherRedeemableLifeSeconds} and is still not
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
   * {@link maxVoucherRedeemableLifeSeconds} — after which the call is voided
   * and the provider is not paid ({@link VOUCHER_REDEMPTION_ALERTS.PLATFORM_VOIDED}).
   * An outage that silently costs providers their served calls is the shape of
   * failure the alert catalogue exists for.
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
  /**
   * The chain refused a voucher `VoucherSeqUsed`, none of its own recorded
   * transactions shows the landing, and the escrow's `held(payer, seq)` record
   * names this voucher's provider and amount: it landed unobserved, and the
   * hold was committed from the record — never turned into buyer debt. WARN:
   * nothing is owed, but a landing this process did not record needs a look.
   */
  SEQ_USED_UNOBSERVED: 'voucher_seq_used_unobserved',
  /**
   * The chain refused a voucher `VoucherSeqUsed`, none of its own recorded
   * transactions shows the landing, and `held(payer, seq)` does NOT match this
   * voucher (another provider or amount). Not buyer debt: the hold stays open
   * and a human decides. CRITICAL — the seq this platform issued was used by
   * somebody else's voucher.
   */
  SEQ_USED_ANOMALY: 'voucher_seq_used_anomaly',
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
 * What follows {@link DEBT_VOIDED_PREFIX} when the voucher was voided because
 * the PLATFORM failed to redeem it, then the cause tag:
 * `voided:PLATFORM_UNREDEEMED`, `voided:PLATFORM_UNKNOWN_REVERT`,
 * `voided:PLATFORM_FEE_SPIKE_DEFERRED`. The hand fix of the 2026-10-29
 * incident wrote `voided:PLATFORM_REDEEMER_UNFUNDED` the same way.
 */
export const PLATFORM_VOID_OUTCOME_PREFIX = 'PLATFORM_';

/**
 * The refusal the redemption job records when it DEFERS a send because L1
 * fees spiked: the platform chose not to send. Not about the voucher, so a
 * voucher that expires with it as its last refusal is voided, never buyer
 * debt. Defined once, beside the redeemer port that returns it.
 */
export { FEE_SPIKE_DEFERRED } from '../ports/voucher-redeemer.port';

/**
 * How close to a voucher's on-chain deadline (`expiresAt + redeemGraceSeconds`)
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
 * accepted: the chain's {@link redeemGraceSeconds} (the chain refuses the
 * voucher after `expiresAt + grace`) + `CLOCK_SKEW_TOLERANCE_SECONDS` (a block
 * clock ahead of ours) — 7,320 s on eip155, 1,920 s on Solana. Before then the
 * old voucher may still be redeemable — a debt can lapse before its deadline —
 * and a replacement at a higher seq redeemed after it would charge the buyer
 * twice. `trg_payment_intents_voucher_seq_immutable` (migration
 * 1762400000070) enforces the same bounds per chain.
 */
export function debtReplaceableAfterExpirySeconds(caipId: string): number {
  return redeemGraceSeconds(caipId) + CLOCK_SKEW_TOLERANCE_SECONDS;
}

/**
 * The back-off of a voucher the chain refused with a retryable error, on a
 * chain that admits any seq order (review 2026-10-23 I-1): 60 s, doubling,
 * at most 600 s between attempts — well under the 7,200 s grace — and never
 * past the voucher's last pass ({@link REDEMPTION_DEADLINE_MARGIN_SECONDS}
 * before its deadline). `PaymentIntentRepository.recordRedemptionRetry`.
 */
export const REDEMPTION_RETRY_BASE_SECONDS = 60;
export const REDEMPTION_RETRY_MAX_SECONDS = 600;
