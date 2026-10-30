import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, QueryRunner, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WITHHELD_STATUSES } from '@modules/ledger/domain/withheld';
import {
  REDEMPTION_DEADLINE_MARGIN_SECONDS,
  REDEMPTION_RETRY_BASE_SECONDS,
  REDEMPTION_RETRY_MAX_SECONDS,
  redeemGraceIntervalSql,
} from '@modules/payment/constants/voucher-redemption.constants';
import { exactInstantSql } from '@shared/api';
import { PaymentIntentEntity } from '../entities/payment-intent.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `created_at`, for comparing against an instant.
 *
 * Plain, with no conversion, and that is now the correct form: the
 * `1755900000000-timestamptz-timestamps` migration made `created_at`
 * `timestamptz` across every table, so the column and the bound parameter are
 * both absolute times and Postgres compares them without consulting the session
 * time zone.
 *
 * Until that migration the column was `timestamp WITHOUT time zone`, and this
 * constant carried an `AT TIME ZONE 'UTC'` to supply the offset the type was
 * missing — otherwise the same query over the same rows answered differently
 * depending on which host ran it, which is how the defect was found (a correct
 * one-day window reporting zero calls for a day that had six). That workaround
 * is gone because the thing it worked around is gone; leaving it would now be
 * actively wrong, since `timestamptz AT TIME ZONE 'UTC'` strips the offset back
 * off and reintroduces the mismatch in the other direction.
 */
const CREATED_AT = 'intent.created_at';

/**
 * `created_at` as a UTC **calendar day**, for the `day` bucket.
 *
 * This one keeps its explicit conversion, and the asymmetry with `CREATED_AT`
 * above is deliberate rather than an oversight. `to_char` on a `timestamptz`
 * renders it in the *session* time zone, so without the conversion the day a
 * call is bucketed into would depend on where the process runs — the same class
 * of bug the migration just removed from the predicates, arriving through a
 * different door.
 *
 * The filter and the bucket must agree about what "day" means: a row counted
 * inside the period but bucketed into a day outside it is worse than both being
 * wrong together.
 */
const CREATED_AT_UTC_DAY = "(intent.created_at AT TIME ZONE 'UTC')";

/** A window of time a query is scoped to. Either edge may be omitted for an open bound. */
export interface PaymentIntentPeriod {
  readonly from?: Date;
  readonly to?: Date;
}

/**
 * `Σ` held amount over the withheld intents that had a hold, grouped by asset
 * and by status so `LedgerWithheldService` can fold rows into `WithheldBucket`s
 * without loading one row per intent.
 */
export interface WithheldStatusAssetTotal {
  readonly asset: string;
  readonly decimals: number;
  readonly status: string;
  /**
   * The row is `SETTLED` and never collected ({@link NOT_CHARGED_SETTLED_SQL}).
   * Always true on a `SETTLED` row here, since no other `SETTLED` row is read.
   */
  readonly notCollected: boolean;
  readonly calls: number;
  readonly amount: bigint;
}

/** How `GET /receipts/summary` may group its rows. */
export enum ReceiptsSummaryGroupBy {
  TOOL = 'tool',
  PROVIDER = 'provider',
  DAY = 'day',
  STATUS = 'status',
  VERDICT = 'verdict',
  /**
   * `payment_intents.agent_id`: the agent whose credential made the call, so a
   * call an agent paid for with its delegate key is attributed to that agent.
   */
  AGENT = 'agent',
  /**
   * `payment_intents.credential_id`: the agent CREDENTIAL that made the call.
   * Two credentials of one agent hold two delegate keys, so they are two
   * groups here. A row written before the column has no credential and is
   * keyed `agent:<agent id>` instead.
   */
  CREDENTIAL = 'credential',
}

/** One row of a summary grouping, still in atomic units. */
export interface ReceiptsSummaryRow {
  /** The group's label — a tool id, a provider id, a day, a status, a verdict, an agent id. */
  readonly key: string;
  readonly asset: string;
  readonly decimals: number;
  readonly calls: number;
  readonly listedTotal: bigint;
  readonly chargedTotal: bigint;
  readonly withheldTotal: bigint;
  /** Calls that landed `REFUNDED` — the numerator of `failRate`. */
  readonly refundedCalls: number;
  /**
   * The buyer was not charged: refunded, voided or expired, or served but never
   * collected (forfeited, written off, voided debt). Every finished call that is
   * neither charged nor owed, so `listed = charged + notCharged + owed + inProgress`
   * holds by construction.
   */
  readonly notChargedTotal: bigint;
  readonly notChargedCalls: number;
  /** Served, payment not collected yet: an open buyer debt. Neither charged nor not charged. */
  readonly owedTotal: bigint;
  readonly owedCalls: number;
  /** Not finished yet (`CREATED`, `FUNDS_SECURED`, `PROVIDER_EXECUTING`, `VERIFYING`). */
  readonly inProgressTotal: bigint;
  readonly inProgressCalls: number;
  /**
   * Intents listed at zero, counted in `calls`. A free-tier call has no intent:
   * `ReceiptSummaryService` adds those from `tool_call_records`, outside `calls`.
   */
  readonly freeCalls: number;
  /** The UTC day (`YYYY-MM-DD`), present only when asked for with `byUtcDay`. */
  readonly day?: string;
}

/**
 * One paid call that ended without a charge, as the public Explorer reads it.
 *
 * Carries no identifier of the call, the hold or the buyer. `buyer` is an
 * opaque digest of the buying organization, present only so the service can
 * apply the k-anonymity rule to the rows it is about to publish; it is never
 * copied into a response. See `PaymentIntentRepository.findNotChargedCandidates`.
 */
export interface NotChargedCallRow {
  readonly toolId: string;
  readonly providerId: string | null;
  readonly status: string;
  readonly classification: string | null;
  readonly verificationVerdict: string | null;
  readonly asset: string;
  readonly decimals: number;
  readonly priceAmount: bigint;
  readonly createdAt: Date;
  /**
   * Why a `SETTLED` row is in the feed at all ({@link NOT_CHARGED_SETTLED_SQL}),
   * `null` for a `REFUNDED` / `VOIDED` / `EXPIRED` row. A fixed label derived
   * in SQL — never the raw `redemption_last_error`, whose cause text stays out
   * of the process as well as the response.
   */
  readonly settledCause: NotChargedSettledCause | null;
  /** md5 of the buying organization id. In-process only — never published. */
  readonly buyer: string;
}

/**
 * A served (`SETTLED`) paid call the buyer was nevertheless not charged for and
 * does not owe — the `notCharged` share of `GET /receipts/summary` beyond the
 * withheld statuses:
 *
 * - `FORFEITED`: the provider caused the voucher to fail ({@link FORFEITED_SQL}).
 * - `VOIDED_REFUND` / `VOIDED_VOID`: a buyer debt voided by a late REFUND or
 *   VOID verdict ({@link VOIDED_SQL}).
 *
 * A WRITTEN-OFF debt is not here: the buyer still owes it (receipts `owed`).
 */
export type NotChargedSettledCause = 'FORFEITED' | 'VOIDED_REFUND' | 'VOIDED_VOID';

/** The Explorer's query window, and who counts as a buyer within it. */
export interface NotChargedWindow {
  /** Calls created in `[from, to)`. */
  readonly from: Date;
  readonly to: Date;
  /**
   * The call's outcome must be final and recorded strictly before this
   * instant (`hold_released_at`), so a late forfeit or voided debt on an old
   * call surfaces only once this cut-off passes it — never inside one cache
   * period (audit 2026-10-17 P2-3).
   */
  readonly outcomeBefore: Date;
  /** A buyer organization must have been created at or before this instant. */
  readonly buyerCreatedBefore: Date;
  /** A buyer organization must have a call collected strictly before this instant. */
  readonly buyerCollectedBefore: Date;
}

/** Platform-wide totals for one asset over the Explorer's window. */
export interface NotChargedTotalsRow {
  readonly asset: string;
  readonly decimals: number;
  /**
   * Paid calls of eligible buyers whose outcome is final and can no longer
   * change ({@link FINAL_OUTCOME_SQL}): collected, or not charged. An open or
   * written-off buyer debt, and a call still awaiting redemption, are not
   * counted until they resolve.
   */
  readonly calls: number;
  /** Distinct ELIGIBLE buying organizations behind `calls` — a count, never an id. */
  readonly buyers: number;
  /** Withheld statuses plus `SETTLED` rows not charged and not owed (`NOT_CHARGED_SETTLED_SQL`). */
  readonly notChargedCalls: number;
  /** The subset that failed verification: `REFUNDED`, or a debt voided by a late REFUND verdict. */
  readonly failedCheckCalls: number;
  readonly notChargedAmount: bigint;
}

/**
 * Why a not-charged call that did NOT fail the check ended without a charge —
 * the `NotChargedReason` keys other than `FAILED_CHECK`, derived in SQL by
 * {@link NOT_CHARGED_OTHER_REASON_SQL} with the same precedence as the
 * domain's `notChargedReason()`. Kept as literals here so the repository takes
 * no import edge on the catalogue module; a unit spec pins them to the enum.
 */
export const NOT_CHARGED_OTHER_REASONS = [
  'OUT_OF_SCOPE',
  'PROVIDER_ERROR',
  'REQUEST_REJECTED',
  'NO_USABLE_RESULT',
  'EXPIRED',
  'NOT_COLLECTED',
] as const;
export type NotChargedOtherReason = (typeof NOT_CHARGED_OTHER_REASONS)[number];

/**
 * One cell of the not-charged reason breakdown: an asset and a reason, the
 * calls in it, and how many distinct ELIGIBLE buyers stand behind them — a
 * count, never an id. The input to the per-reason k rule.
 */
export interface NotChargedReasonTotalsRow {
  readonly asset: string;
  readonly decimals: number;
  readonly reason: NotChargedOtherReason;
  readonly calls: number;
  readonly buyers: number;
}

/** Mirrors `PaymentIntentCallClass.PAID`, kept local like the statuses below. */
const PAID_CALL_CLASS = 'PAID';

/**
 * Mirrors `PaymentIntentStatus.SETTLED` / `.REFUNDED`. Kept as local literals
 * rather than an import of the payment domain's enum — this repository
 * already treats `status` as an opaque string everywhere else
 * (`transitionIfInStatus` takes `from`/`to` as strings supplied by the
 * caller), and a CHECK constraint in the migration is the actual authority.
 */
const SETTLED_STATUS = 'SETTLED';
const REFUNDED_STATUS = 'REFUNDED';

/**
 * One row of the per-call export, still in atomic units and with
 * `classification` a raw response-classifier string rather than the enum — same
 * convention as everywhere else in this repository: `status` is treated as an
 * opaque string here, and the CHECK constraint in the migration is the real
 * authority.
 */
/**
 * A rail-B intent whose hold is still open. `resolve()` leaves it open on
 * `SETTLED` and only `commitRedeemedHold` — after `redeem_voucher` lands —
 * retires it and writes `PROVIDER_CREDIT`. A debt whose replacement voucher
 * was accepted (`redemption_replaced_at`) is awaiting redemption again.
 */
export const AWAITING_REDEMPTION_SQL =
  `(intent.rail = 'RAIL_B_VOUCHER' AND intent.hold_id IS NOT NULL ` +
  `AND intent.hold_released_at IS NULL ` +
  `AND (intent.redemption_lapsed_at IS NULL OR intent.redemption_replaced_at IS NOT NULL))`;

/**
 * Read on a `SETTLED` intent: the provider FORFEITED the voucher — it caused
 * the voucher to fail (stake below the minimum, or blocked), so the buyer's
 * hold was released and nobody was credited. The literal is
 * `VoucherRedemptionService`'s `PROVIDER_FORFEIT_PREFIX`.
 */
export const FORFEITED_SQL = `(intent.redemption_last_error LIKE 'provider_forfeit:%')`;

/**
 * Read on a `SETTLED` intent: BUYER DEBT, still open. The voucher lapsed for a
 * reason that is not the provider's, the buyer's hold is still open (so the
 * amount stays out of the buyer's spendable balance), nobody is credited yet,
 * and the payer's paid calls are refused until the buyer signs a replacement
 * voucher (no-platform-debt design, steps 9 and 10).
 */
export const DEBT_OUTSTANDING_SQL = `(intent.redemption_lapsed_at IS NOT NULL AND intent.hold_released_at IS NULL)`;

/**
 * Read on a `SETTLED` intent: buyer debt WRITTEN OFF — not settled within
 * `BUYER_DEBT_WRITE_OFF_DAYS`, so the hold was released and the provider is
 * not paid. The literal is `UNCOLLECTED_PREFIX`
 * (`voucher-redemption.constants.ts`).
 */
export const WRITTEN_OFF_SQL = `(intent.redemption_last_error LIKE 'uncollected:%')`;

/**
 * Read on a `SETTLED` intent: buyer debt VOIDED — a FAIL / REFUND / VOID
 * verdict arrived after the call had been settled as served and unverified
 * and had become debt (review-buyer-debt M2): the hold was released, nobody
 * is credited, the buyer is not charged. The literal is `DEBT_VOIDED_PREFIX`
 * (`voucher-redemption.constants.ts`).
 */
export const VOIDED_SQL = `(intent.redemption_last_error LIKE 'voided:%')`;

/**
 * The payer's paid calls are refused while ANY of its rows matches this (raw
 * column names, no alias): an open debt, a debt whose replacement is not
 * collected yet, or — until the contract change ships (H1 interim) — a debt
 * that was WRITTEN OFF. The write-off ends the hold and the provider's wait;
 * it never ends the refusal. Re-signing (`replaceLapsedVoucher`) is the only
 * way out, and then the provider is paid normally. A voided or forfeited row,
 * and a collected replacement, have their hold released and no `uncollected:`
 * mark, so they stop refusing. `idx_payment_intents_open_debt` has exactly
 * this predicate.
 */
export const DEBT_REFUSING_SQL =
  `("redemption_lapsed_at" IS NOT NULL ` +
  `AND ("hold_released_at" IS NULL OR "redemption_last_error" LIKE 'uncollected:%'))`;

/** A `redemption_last_error` that closed the row for good: nothing may redeem it any more. */
/** The mark an upheld call dispute's refund writes (`voided:DISPUTE_UPHELD`). */
export const DISPUTE_REFUND_MARK = 'voided:DISPUTE_UPHELD';

/**
 * A provider-block cause recorded on the row (`ProviderBlocked`,
 * `PayeeBlocked`, `PayeeBlockedOnChain`, with any suffix): written by the
 * redemption pass and just before a blocked provider's refund is sent.
 */
const RECORDED_BLOCK_CAUSE_SQL = (alias: string): string =>
  `(${alias}.redemption_last_error LIKE 'ProviderBlocked%' ` +
  `OR ${alias}.redemption_last_error LIKE 'PayeeBlocked%')`;

const CLOSED_OUTCOME_SQL = (alias: string): string =>
  `(${alias}.redemption_last_error LIKE 'provider_forfeit:%' ` +
  `OR ${alias}.redemption_last_error LIKE 'uncollected:%' ` +
  `OR ${alias}.redemption_last_error LIKE 'voided:%')`;

/**
 * The organizations that count as buyers for the Explorer's k-anonymity rule:
 * created at least a week ago, and with at least one paid call whose payment
 * was COLLECTED before `:buyerCollectedBefore`. Both raise the cost of lifting
 * a tool over k with throwaway organizations.
 *
 * "Collected" is {@link CREDITED_SQL} spelled on the alias `s`: `SETTLED`, the
 * hold committed (released, and not by a forfeit, write-off, void or legacy
 * absorb). That is deliberately stricter than the receipts summary's
 * "charged" bucket, which also holds a rail-B call still awaiting redemption:
 * such a call can later lapse into buyer debt, and an organization whose only
 * call did would lose eligibility retroactively — the tool or asset would
 * drop under k and the change would reveal a buyer debt (audit 2026-10-17
 * P2-2). A collected call never changes again, so eligibility only ever goes
 * forwards; and the time bound pins it to the caller's cut-off.
 * Bound parameters: `:buyerCreatedBefore`, `:buyerCollectedBefore`, `:paid`,
 * `:settledStatus`.
 */
const ELIGIBLE_BUYER_SQL =
  `intent.organization_id IN (SELECT o.id FROM organizations o ` +
  `WHERE o.created_at <= :buyerCreatedBefore AND EXISTS (` +
  `SELECT 1 FROM payment_intents s WHERE s.organization_id = o.id ` +
  `AND s.call_class = :paid AND s.status = :settledStatus ` +
  `AND s.hold_id IS NOT NULL AND s.hold_released_at IS NOT NULL ` +
  `AND s.hold_released_at < :buyerCollectedBefore ` +
  `AND NOT COALESCE(${CLOSED_OUTCOME_SQL('s')}, false)))`;

/**
 * Read on a `SETTLED` intent: the buyer was NOT charged although the verdict
 * passed — the provider forfeited, or the debt was written off or voided. The
 * one predicate every buyer-facing "charged" figure
 * and the spend caps leave out (review 2026-10-15 #2, M4).
 */
export const NOT_COLLECTED_SQL =
  `(COALESCE(${FORFEITED_SQL}, false) OR COALESCE(${WRITTEN_OFF_SQL}, false) ` +
  `OR COALESCE(${VOIDED_SQL}, false))`;

/**
 * `GET /receipts/summary`'s buckets. Every call is in exactly one, so
 * `listed = charged + notCharged + owed + inProgress`:
 *
 * - charged: served and collected (or being collected): `SETTLED`, not
 *   {@link NOT_COLLECTED_SQL}, not an open debt.
 * - owed: served, payment not collected yet, and the buyer still owes it — an
 *   open buyer debt ({@link DEBT_OUTSTANDING_SQL}) or a WRITTEN-OFF one
 *   ({@link WRITTEN_OFF_SQL}). The buyer has not been charged and has not been
 *   let off either, so it is neither of the other two (R17b-B-01). A write-off
 *   only ends the provider's wait (it is uncollected on the provider side);
 *   the buyer's paid calls stay refused until it re-signs, so it is still owed
 *   (final review M2).
 * - in progress: not finished yet.
 * - not charged: the rest — `REFUNDED`, `VOIDED`, `EXPIRED`, and a served call
 *   that was never collected and is not owed (forfeited, voided debt).
 *   Derived by subtraction so it cannot drift from the other three.
 */
const SUMMARY_OWED_SQL =
  `(intent.status = '${SETTLED_STATUS}' ` +
  `AND (${DEBT_OUTSTANDING_SQL} OR COALESCE(${WRITTEN_OFF_SQL}, false)) ` +
  `AND NOT COALESCE(${FORFEITED_SQL}, false) AND NOT COALESCE(${VOIDED_SQL}, false))`;
const SUMMARY_CHARGED_SQL = `(intent.status = '${SETTLED_STATUS}' AND NOT ${DEBT_OUTSTANDING_SQL} AND NOT ${NOT_COLLECTED_SQL})`;
const SUMMARY_IN_PROGRESS_SQL = `(intent.status IN ('CREATED', 'FUNDS_SECURED', 'PROVIDER_EXECUTING', 'VERIFYING'))`;

/**
 * A terminal call that withheld nothing because nothing was ever reserved
 * (`domain/withheld.ts`: "a hold must have existed"): an unfunded keyed call
 * moved `CREATED → EXPIRED`, for one. It never ran, so the summary leaves it
 * out of every bucket, listed included — otherwise it is "not charged" here
 * and absent from `GET /withheld` (UX review 2026-10-18, B1 I1).
 * Bound parameter: `:...withheldStatuses`.
 */
const SUMMARY_NEVER_RESERVED_SQL = `(intent.status IN (:...withheldStatuses) AND intent.hold_id IS NULL)`;

/**
 * Read on a `SETTLED` intent: the provider has been credited OUT OF THE
 * BUYER'S ESCROW — its hold was committed, which is exactly when
 * `PROVIDER_CREDIT` is written (rail A inline in `PaymentIntentService.resolve`,
 * rail B in `commitRedeemedHold` once `redeem_voucher` lands). Every "earned"
 * figure filters on this, so it matches the earnings ledger by construction.
 *
 * A released hold is not a committed one: a forfeit and a write-off both
 * released the buyer's hold and are left out (review 2026-10-15, M2;
 * review #2, M4).
 */
export const CREDITED_SQL =
  `(intent.hold_id IS NOT NULL AND intent.hold_released_at IS NOT NULL ` +
  `AND NOT ${NOT_COLLECTED_SQL})`;

/**
 * The public Explorer's "not charged" share of `SETTLED` rows: served, never
 * collected, and NOT owed — forfeited, or voided debt. Exactly
 * {@link NOT_COLLECTED_SQL} without {@link WRITTEN_OFF_SQL}: a written-off debt
 * is still owed by the buyer (receipts `owed`), so the feed never calls it
 * "not charged". With the withheld statuses this is the receipts summary's
 * `notCharged` bucket.
 */
const NOT_CHARGED_SETTLED_SQL =
  `(intent.status = '${SETTLED_STATUS}' AND NOT COALESCE(${WRITTEN_OFF_SQL}, false) ` +
  `AND (COALESCE(${FORFEITED_SQL}, false) OR COALESCE(${VOIDED_SQL}, false)))`;

/** {@link NotChargedSettledCause} for a row, `NULL` when it is not {@link NOT_CHARGED_SETTLED_SQL}. */
const NOT_CHARGED_SETTLED_CAUSE_SQL =
  `CASE WHEN NOT ${NOT_CHARGED_SETTLED_SQL} THEN NULL ` +
  `WHEN COALESCE(${FORFEITED_SQL}, false) THEN 'FORFEITED' ` +
  `WHEN intent.redemption_last_error = 'voided:REFUND' THEN 'VOIDED_REFUND' ` +
  `WHEN COALESCE(${VOIDED_SQL}, false) THEN 'VOIDED_VOID' END`;

/** Every paid call the Explorer reports as not charged: withheld statuses, or {@link NOT_CHARGED_SETTLED_SQL}. */
const NOT_CHARGED_SQL = `(intent.status IN (:...withheldStatuses) OR ${NOT_CHARGED_SETTLED_SQL})`;

/** The guarantee firing: `REFUNDED`, or a buyer debt voided by a late REFUND verdict. */
const FAILED_CHECK_SQL =
  `(intent.status = :refundedStatus OR (${NOT_CHARGED_SETTLED_SQL} ` +
  `AND intent.redemption_last_error = 'voided:REFUND'))`;

/**
 * The reason of a not-charged call that is NOT {@link FAILED_CHECK_SQL}, as
 * `notChargedReason()` reads it: a remaining `SETTLED` row (forfeit, debt
 * voided by a VOID verdict, legacy absorb) is `NOT_COLLECTED`; `EXPIRED` is
 * itself; a `VOIDED` row is read from its verdict, then its classification.
 * Only meaningful on a row that matches `NOT_CHARGED_SQL AND NOT FAILED_CHECK_SQL`.
 */
const NOT_CHARGED_OTHER_REASON_SQL =
  `CASE WHEN intent.status = '${SETTLED_STATUS}' THEN 'NOT_COLLECTED' ` +
  `WHEN intent.status = 'EXPIRED' THEN 'EXPIRED' ` +
  `WHEN intent.verification_verdict = 'MISAPPLIED' THEN 'OUT_OF_SCOPE' ` +
  `WHEN intent.classification = 'SYSTEM_ERROR' THEN 'PROVIDER_ERROR' ` +
  `WHEN intent.classification = 'REQUEST_ERROR' THEN 'REQUEST_REJECTED' ` +
  `ELSE 'NO_USABLE_RESULT' END`;

/**
 * The Explorer's "final outcome, recorded before the cut-off": the hold was
 * released before `:outcomeBefore`, and the call is either not charged
 * ({@link NOT_CHARGED_SQL}) or collected ({@link CREDITED_SQL}). Both are
 * terminal. Every other paid call — awaiting redemption, an open buyer debt,
 * a written-off debt (the buyer can still re-sign it) — is left out, so a
 * change in its state cannot move a published figure, and debt state is never
 * readable from the totals.
 *
 * Known residual: a debt voided AFTER it was written off keeps the write-off's
 * `hold_released_at` (`markDebtVoided` only fills it when empty), so it moves
 * into "not charged" at void time with an older timestamp. That needs a late
 * verdict arriving after `BUYER_DEBT_WRITE_OFF_DAYS`, which is not expected.
 * Bound parameters: `:outcomeBefore`, `:...withheldStatuses`.
 */
const FINAL_OUTCOME_SQL =
  `(intent.hold_released_at IS NOT NULL AND intent.hold_released_at < :outcomeBefore ` +
  `AND (${NOT_CHARGED_SQL} OR (intent.status = '${SETTLED_STATUS}' AND ${CREDITED_SQL})))`;

export interface CallExportRow {
  /** The payment intent's own id — the platform's key for the money. */
  readonly id: string;
  /** `X-Assay-Call-Id` as sent upstream — the provider's key for the request. */
  readonly callId: string;
  readonly callClass: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly classification: string | null;
  readonly verificationVerdict: string | null;
  readonly toolId: string;
  readonly asset: string;
  readonly decimals: number;
  readonly priceAmount: string;
  readonly providerAmount: string;
  readonly platformFee: string;
  /** Rail B, hold still open: settled by the verdict, not yet redeemed on chain. */
  readonly awaitingRedemption: boolean;
  /** {@link CREDITED_SQL}: the hold was committed. Only meaningful on a `SETTLED` row. */
  readonly credited: boolean;
  /**
   * `provider_forfeit:<cause>` when the provider forfeited ({@link FORFEITED_SQL}),
   * `uncollected:<cause>` once a debt was written off ({@link WRITTEN_OFF_SQL}),
   * or the lapse cause of an open debt.
   */
  readonly redemptionLastError: string | null;
  /** {@link DEBT_OUTSTANDING_SQL}: an open buyer debt — passed, not collected yet. */
  readonly debtOutstanding: boolean;
  readonly createdAt: Date;
  /**
   * `created_at` at full microsecond precision ({@link exactInstantSql}) — the
   * keyset position. `createdAt` is a `Date`, truncated to the millisecond, and
   * a cursor built from it re-reads the boundary row on every page.
   */
  readonly createdAtExact: string;
}

/** A keyset position for {@link PaymentIntentRepository.findCallsPageForExport}. */
export interface CallExportCursor {
  /** The last emitted row's {@link CallExportRow.createdAtExact} — never a `Date`. */
  readonly createdAt: string;
  readonly id: string;
}

/**
 * An intent the expiry sweep has work to do on.
 *
 * Only the four fields the sweep acts on, and deliberately not the row: the
 * sweep spans tenants, and the less of another tenant's payment record it loads
 * into one process's memory the better.
 */
/**
 * One rail-B intent awaiting its on-chain redemption, projected flat.
 *
 * Every voucher field the program recomputes its 239 bytes from is here — see
 * `findAwaitingRedemption`. `expiresAt` doubles as the voucher's own
 * `expires_at`: `VoucherService.record` writes it as `voucher.expiresAt * 1000`
 * and nothing updates it afterwards.
 */
/**
 * The parties the redemption queue leaves out, from the cached blocklists.
 *
 * - `organizationIds`: blocked organizations, lower-case uuids; the query matches
 *   them against the payer's organization only.
 * - `walletKeys`: the platform blocklist's namespace-wide wallet keys
 *   (`subjectKey`, e.g. `eip155:0xabc…`, Solana as written), matched against
 *   the payer and the delegate.
 * - `chainAccounts`: CAIP-10 accounts the ON-CHAIN blocklist refuses on this
 *   asset's chain, confirmed live (compared lower-case; EVM only).
 */
export interface RedemptionExclusions {
  readonly organizationIds: readonly string[];
  readonly walletKeys: readonly string[];
  readonly chainAccounts: readonly string[];
}

export const NO_REDEMPTION_EXCLUSIONS: RedemptionExclusions = Object.freeze({
  organizationIds: [],
  walletKeys: [],
  chainAccounts: [],
});

export interface RedeemableIntent {
  readonly organizationId: string;
  readonly id: string;
  readonly agentAccount: string;
  readonly providerAccount: string | null;
  readonly assetId: string;
  readonly decimals: number;
  readonly priceAmount: string;
  readonly requestHash: string;
  readonly voucherSeq: string;
  readonly voucherSignature: string;
  readonly voucherResourceHash: string | null;
  readonly voucherIssuedAt: string | null;
  /** The delegate that signed, or null — see `PaymentIntentEntity.voucherDelegate`. */
  readonly voucherDelegate: string | null;
  readonly expiresAt: Date;
  readonly holdId: string;
  readonly providerId: string | null;
  readonly providerAmount: string;
  readonly platformFee: string;
  /** See `PaymentIntentEntity.redemptionLastError`. */
  readonly redemptionLastError: string | null;
  /**
   * How many transaction refs were recorded when the row was read (a ref is
   * written before each broadcast). Optional: absent is 0.
   */
  readonly redemptionTxRefCount?: number;
}

/** One buyer debt that refuses paid calls — see {@link PaymentIntentRepository.findOutstandingDebts}. */
export interface OutstandingDebt {
  readonly id: string;
  readonly organizationId: string;
  /** The agent that made the call: only its own delegate may re-sign it. */
  readonly agentId: string;
  readonly agentAccount: string;
  readonly providerId: string | null;
  readonly providerAccount: string | null;
  readonly toolId: string;
  readonly chainId: string;
  readonly assetId: string;
  readonly decimals: number;
  readonly priceAmount: string;
  readonly requestHash: string;
  readonly voucherResourceHash: string | null;
  readonly voucherSeq: string | null;
  /** The `resource` the voucher signed, or `null` on rows older than the column. */
  readonly voucherResource: string | null;
  /** The FIRST lapse: the write-off clock, never restarted by a replacement. */
  readonly lapsedAt: Date;
  /** The current voucher's `expiresAt`: it stays redeemable on chain until grace after it. */
  readonly expiresAt: Date;
  /**
   * The refusal the voucher lapsed on (`VoucherExpired`, `DelegateIsRevoked`,
   * …), or `uncollected:<cause>` once written off.
   */
  readonly cause: string | null;
  /** When a replacement voucher was accepted and is waiting to be collected, or `null`. */
  readonly replacedAt: Date | null;
  /** Written off (hold released, provider not paid) — still refusing paid calls (H1 interim). */
  readonly writtenOff: boolean;
  readonly createdAt: Date;
}

/** The replacement voucher's fields — see {@link PaymentIntentRepository.replaceLapsedVoucher}. */
export interface LapsedVoucherReplacement {
  readonly seq: string;
  readonly signature: string;
  readonly issuedAt: number;
  readonly delegate: string | null;
  readonly expiresAt: Date;
  /** The replacement's `resource`, and the chain's hash of it (the tool may have been renamed). */
  readonly resource: string;
  readonly resourceHash: string;
}

export interface DuePaymentIntent {
  readonly organizationId: string;
  readonly id: string;
  readonly status: string;
  readonly holdId: string | null;
  /** The payer account — selected by the reads whose writes take the payer's lock. */
  readonly agentAccount?: string;
}

/** The row a debt close (write-off, void) must still be — see `markWrittenOff`. */
/**
 * Read on a `SETTLED` rail-B intent: an open buyer debt an operator may void
 * (`PaymentIntentService.voidDebt`, register row `M-1`) — lapsed, no
 * replacement in flight, and its hold still open or written off (a written-off
 * debt still refuses the payer's paid calls, `DEBT_REFUSING_SQL`). The same
 * predicate `markDebtVoided` closes on.
 */
export const OPERATOR_VOIDABLE_DEBT_SQL =
  `(intent.status = 'SETTLED' AND intent.rail = 'RAIL_B_VOUCHER' AND intent.hold_id IS NOT NULL ` +
  `AND intent.redemption_lapsed_at IS NOT NULL AND intent.redemption_replaced_at IS NULL ` +
  `AND (intent.hold_released_at IS NULL OR intent.redemption_last_error LIKE 'uncollected:%'))`;

/** The filters of the operator's buyer-debt list. Every field optional. */
export interface OperatorDebtFilter {
  readonly chainId?: string;
  readonly assetId?: string;
  readonly payerAccount?: string;
  readonly buyerOrganizationId?: string;
  readonly providerId?: string;
  /** The refusal the voucher lapsed on, exactly (`uncollected:` is looked through). */
  readonly lastError?: string;
  /** Only rows {@link OPERATOR_SUGGESTED_PLATFORM_CAUSE_SQL} labels. */
  readonly suggestedOnly?: boolean;
}

/**
 * The informational label of the operator's debt list: the recorded cause
 * suggests the PLATFORM failed to redeem — `VoucherExpired` with no other
 * recorded refusal, a revert with no name (`UNKNOWN_REVERT:*`), or a fee-spike
 * deferral (`FeeSpikeDeferred`); `uncollected:` is looked through. Never acted
 * on: a person decides (`M-1`). `OperatorBuyerDebtService.suggestsPlatformCause`
 * is the same test in code.
 */
export const OPERATOR_SUGGESTED_PLATFORM_CAUSE_SQL =
  `(regexp_replace(intent.redemption_last_error, '^uncollected:', '') IN ` +
  `('VoucherExpired', 'FeeSpikeDeferred') ` +
  `OR regexp_replace(intent.redemption_last_error, '^uncollected:', '') LIKE 'UNKNOWN\\_REVERT:%')`;

/** One asset's share of the operator's buyer-debt list. */
export interface OperatorDebtTotal {
  readonly assetId: string;
  readonly decimals: number;
  readonly count: number;
  /** Atomic units, as an exact decimal string. */
  readonly amount: string;
}

export interface DebtCloseTarget {
  readonly organizationId: string;
  readonly id: string;
  /** The payer account: the admission lock is keyed on it. */
  readonly payer: string;
  /** The hold the pass read; a row that has since taken another is not closed. */
  readonly holdId: string;
}

/**
 * The statuses in which an intent is **holding money that has not settled**.
 *
 * `FUNDS_SECURED` is where the hold opens, `PROVIDER_EXECUTING` is the call in
 * flight, and `VERIFYING` is served-but-unjudged. Everything else is out for a
 * reason:
 *
 * - `CREATED` has no hold yet, so there is nothing reserved to be exposed.
 * - `SETTLED` has paid, `REFUNDED` / `VOIDED` / `EXPIRED` have released. All
 *   four are terminal and the hold is resolved either way.
 *
 * Keyed as strings rather than as `PaymentIntentStatus` for the reason
 * `WITHHELD_STATUSES` gives: the repository layer does not take an import edge
 * on the payment domain for three constants.
 */
export const OPEN_HOLD_STATUSES: readonly string[] = Object.freeze([
  'FUNDS_SECURED',
  'PROVIDER_EXECUTING',
  'VERIFYING',
]);

/**
 * Statuses that count as "this call cost the agent something", for the
 * spend-policy cap check.
 *
 * Two groups, unioned:
 *
 * - `SETTLED` — the money actually moved.
 * - {@link OPEN_HOLD_STATUSES} — the money has not moved yet but is
 *   **reserved against the agent's balance right now**. A cap that only
 *   counted `SETTLED` would let an agent open ten calls' worth of holds in
 *   parallel, none of them settled yet, and each new call would see a
 *   spend-so-far of zero — the cap would never bind until the first one
 *   resolved, by which point all ten already cleared it.
 *
 * Deliberately **excluded**: `CREATED` (no hold was ever opened — nothing was
 * reserved, matching `domain/withheld.ts`'s `holdId !== null` rule), and the
 * terminal statuses that release a hold without charging —`REFUNDED`,
 * `VOIDED`, `EXPIRED`. A refunded call did not cost the agent anything, and
 * counting it against a spend cap would make the refund guarantee and the
 * spend cap disagree about what "spent" means.
 *
 * Kept as raw strings for the reason `OPEN_HOLD_STATUSES` gives: this
 * repository does not take an import edge on the payment domain's enum for a
 * handful of constants the CHECK constraint already authorises.
 */
export const SPEND_COUNTING_STATUSES: readonly string[] = Object.freeze([
  ...OPEN_HOLD_STATUSES,
  SETTLED_STATUS,
]);

/** One agent's spend-so-far in one asset, split at the UTC hour, day and month boundary. */
export interface AgentSpendTotals {
  /** `Σ price_amount` since the top of the UTC hour — `max_spend_per_hour`. */
  readonly thisHour: bigint;
  /** `Σ price_amount` since {@link utcDayStart} — `spend-policy`'s daily-cap check. */
  readonly today: bigint;
  /** `Σ price_amount` since {@link utcMonthStart} — the monthly-cap check. */
  readonly thisMonth: bigint;
}

/** Which payer's vouchers {@link PaymentIntentRepository.insertAdmittedVoucherIntent} counts. */
export interface VoucherAdmissionScope {
  /** The payer account (`payment_intents.agent_account`). */
  readonly payer: string;
  readonly assetId: string;
  /** The signing delegate, or `null` for the payer's own key. */
  readonly delegate: string | null;
  /** When the escrow's counter was read off the chain (minus a lag margin). */
  readonly escrowSince: Date;
  /** When the delegate's counter was read off the chain (minus a lag margin). */
  readonly delegateSince?: Date | null;
  /**
   * The calling organization: its debts, and the payer account's, are counted
   * under the lock ({@link OpenVoucherTotals.debts}). Omitted, they are not.
   */
  readonly organizationId?: string | null;
}

/** `Σ price_amount` of the vouchers the chain's counters do not hold yet. */
export interface OpenVoucherTotals {
  /** Every rail-B voucher of the payer: what the escrow's window does not know. */
  readonly escrow: bigint;
  /** The signing delegate's vouchers only: what the delegate's window does not know. */
  readonly delegate: bigint;
  /**
   * Set while a change that tightens caps this voucher is redeemed under is
   * being relayed, or landed too recently for this admission's chain read to
   * have seen it (BUG-D1-07): no voucher is admitted then. The seconds until a
   * retry can pass, on the database's clock. See
   * {@link PaymentIntentRepository.holdVoucherAdmission}.
   */
  readonly pausedFor?: number | null;
  /**
   * The payer's `buyer_escrows.next_seq`, read under the admission lock, or
   * `null` with no escrow row. A voucher seq at or above it is not issued (any
   * more): `BuyerEscrowRepository.rewindNextSeq` lowered the counter after the
   * up-front `wasIssued` read, and the seq may be handed out again (S2-2).
   */
  readonly nextSeq?: bigint | null;
  /**
   * The highest `voucher_seq` of the payer's rail-B intents that are still
   * bound for the chain or got there — in flight (`CREATED`, unexpired), open,
   * or `SETTLED` — or `null` with none. A voucher at or below it would be
   * stepped over by that one's redemption and can never be redeemed itself
   * (review 2026-10-15 P-2).
   */
  readonly maxSeq?: bigint | null;
  /**
   * How many rows of the payer account or of the organization refuse paid
   * calls ({@link DEBT_REFUSING_SQL}), read under the lock so a voucher that
   * lapsed during this admission is seen (review-buyer-debt L8). Not read for a
   * replacement (the debt being settled is one of them) or without
   * `scope.organizationId`.
   */
  readonly debts?: number;
  /**
   * The payer's escrow money already promised, read under the lock: every
   * `OPEN` hold on the account and asset (the predicate
   * `LedgerHoldRepository.sumOpenByAccount` subtracts), plus the rail-B
   * vouchers admitted and not yet holding (`CREATED`, no hold, unexpired).
   * Affordability checked outside the lock let K concurrent calls each see
   * the same spendable before any of their holds existed, and all be served
   * against one balance. Not read for a replacement: the debt being re-signed
   * already holds its own amount.
   */
  readonly reserved?: bigint;
}

/** What {@link PaymentIntentRepository.holdVoucherAdmission} pauses, and for how long. */
export interface VoucherAdmissionHold {
  readonly payer: string;
  /**
   * The delegate whose grant is changed: only its vouchers are paused, since a
   * change to its grant cannot strand any other signer's. `null` for a change
   * of the escrow's own limits, which pauses every voucher of the payer.
   */
  readonly delegate: string | null;
  /** The pause lasts at least this long from now (the database's clock). */
  readonly holdSeconds: number;
  /** ...and never ends before this instant (unix seconds), e.g. the signed request's deadline. */
  readonly notBeforeEpochSeconds?: number | null;
}

/** Whose not-yet-redeemed vouchers {@link PaymentIntentRepository.unsettledVouchers} counts. */
export interface UnsettledVoucherScope {
  /** The payer account (`payment_intents.agent_account`). */
  readonly payer: string;
  readonly assetId: string;
  /** Only this delegate's vouchers (CAIP-10, any case); omitted for every voucher of the payer. */
  readonly delegate?: string | null;
  /** When the chain counter this is set beside was read (minus a lag margin). */
  readonly since: Date;
}

/**
 * The payer's vouchers the platform has accepted and the chain has not
 * redeemed yet (BUG-D1-07): what a change to the caps must leave room for.
 */
export interface UnsettledVoucherTotals {
  readonly count: number;
  /** `Σ price_amount`. */
  readonly total: bigint;
  /** The largest single one: what a per-voucher cap must still allow. */
  readonly largest: bigint;
  /**
   * The last instant the chain still redeems one of them (`expires_at` + the
   * row's chain grace: 7,200 s on eip155, 1,800 s on Solana), or null.
   */
  readonly redeemableUntil: Date | null;
  /**
   * `Σ price_amount` redeemed at or after `since`: what a counter read at
   * `since` may not contain yet. Counted twice in the overlap, the safe side.
   */
  readonly redeemedSince: bigint;
}

/**
 * A rail-B intent the chain has not redeemed and still can: in flight
 * (`CREATED`, not expired) or served with its hold open, and not past the
 * chain's redemption grace — past that it is lost already, whatever the caps.
 * The grace is the row's own chain's (`redeemGraceIntervalSql`).
 */
const UNSETTLED_VOUCHER_SQL =
  `(("status" = 'CREATED' AND "hold_id" IS NULL AND "expires_at" > now())` +
  // Redeemed into the escrow's hold already (G3.B1): not unsettled.
  ` OR ("hold_id" IS NOT NULL AND "hold_released_at" IS NULL AND "held_at" IS NULL AND "status" IN (` +
  [...OPEN_HOLD_STATUSES, SETTLED_STATUS].map((status) => `'${status}'`).join(', ') +
  `) AND "expires_at" > now() - ${redeemGraceIntervalSql('"chain_id"')}))`;

/**
 * A rail-B intent the chain's window counter cannot contain yet, given the
 * instant (`$n`) the counter was read. See `insertAdmittedVoucherIntent`.
 */
/** The earlier of two instants. */
const earliest = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

const OPEN_VOUCHER_SQL = (since: string): string =>
  `(("status" = 'CREATED' AND "hold_id" IS NULL AND "expires_at" > now())` +
  ` OR ("hold_id" IS NOT NULL AND "hold_released_at" IS NULL AND "held_at" IS NULL AND "status" IN (` +
  [...OPEN_HOLD_STATUSES, SETTLED_STATUS].map((status) => `'${status}'`).join(', ') +
  `))` +
  // Redeemed at `held_at` when it went into the escrow's hold (G3.B1), not at
  // the later collect: the chain counted it then, and a refund does not
  // give it back (I5).
  ` OR ("status" = '${SETTLED_STATUS}' AND COALESCE("held_at", "hold_released_at") >= ${since}::timestamptz))`;

@Injectable()
export class PaymentIntentRepository extends OrganizationScopedRepository<PaymentIntentEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(PaymentIntentEntity, dataSource);
  }

  /**
   * Moves an intent from one status to another, conditionally.
   *
   * The `status = from` predicate is the load-bearing part. It makes the
   * transition a compare-and-swap, so two workers racing the same edge produce
   * one update and one zero-row result — and the loser finds out it lost rather
   * than writing a second `HOLD_COMMIT` behind the winner's back. Returning the
   * affected count rather than the row makes "did I do it" the caller's answer
   * to read, not something inferred from a re-read that could race.
   */
  async transitionIfInStatus(
    organizationId: string,
    intentId: string,
    from: string,
    to: string,
    patch: QueryDeepPartialEntity<PaymentIntentEntity>,
  ): Promise<number> {
    const result = await this.update(
      { organizationId, id: intentId, status: from },
      { ...patch, status: to },
    );

    return result.affected ?? 0;
  }

  /**
   * Intents whose deadline has passed while they were still expirable.
   *
   * **This query deliberately spans organizations, and it is the only one in
   * the domain that does.** The sweep is a platform-level job with no calling
   * tenant: there is nobody whose `organizationId` it could be scoped to. The
   * guard on `OrganizationScopedRepository` exists to stop a request-serving
   * query that *forgot* its tenant from quietly returning another tenant's
   * rows; it cannot stop a deliberate act, and this is one. What it costs is
   * bounded by the projection — four fields, of which one is the tenant id the
   * caller immediately scopes every follow-up write to.
   */
  async findDueForExpiry(
    now: Date,
    statuses: readonly string[],
    limit: number,
  ): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.status IN (:...statuses)', { statuses })
      .andWhere('intent.expiresAt < :now', { now })
      .orderBy('intent.expiresAt', 'ASC')
      .limit(limit)
      .getRawMany<DuePaymentIntent>();
  }

  /**
   * Intents a worker took and never resolved, whose ledger hold has passed its
   * own deadline (`ledger_holds.expires_at`, 24 hours) while still `OPEN`.
   *
   * The 24-hour backstop's candidates. Cross-tenant like the other sweep
   * reads, oldest deadline first, bounded by `limit`.
   */
  async findDueForHoldBackstop(
    now: Date,
    statuses: readonly string[],
    limit: number,
  ): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .innerJoin('ledger_holds', 'hold', 'hold.id = intent.hold_id')
      .where('intent.status IN (:...statuses)', { statuses })
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere(`hold.status = 'OPEN'`)
      .andWhere('hold.expires_at < :now', { now })
      .orderBy('hold.expires_at', 'ASC')
      .limit(limit)
      .getRawMany<DuePaymentIntent>();
  }

  /**
   * Rail-B intents still `VERIFYING` more than `deadlineSeconds` past their
   * voucher's `expiresAt`, and less than `latestSeconds` past it — the deadline
   * on verdicts (see `PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS`). Only rows with
   * a voucher the redemption job can submit (seq and signature recorded) and
   * an open hold: settling anything else would leave a SETTLED hold nothing
   * ever closes.
   *
   * There is no upper bound any more: a row past the latest its voucher can
   * still be redeemed is settled too, and `PaymentIntentService.resolve` makes
   * it buyer debt at once rather than handing a dead voucher to the redemption
   * job (review 2026-10-15 #2, M3). Before, such rows were left to the 24-hour
   * backstop, which released the hold of a call that was served.
   *
   * A row whose verification already computed a REFUND or VOID outcome that
   * `resolve()` has not applied yet is skipped: the sweep must not overtake a
   * verdict that rejected the call (review 2026-10-15, L6). The verification
   * worker applies it, or the backstop releases the hold.
   *
   * Cross-tenant like the other sweep reads, oldest first, bounded by `limit`.
   */
  async findDueForVerdictDeadline(
    now: Date,
    deadlineSeconds: number,
    limit: number,
  ): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.status = :verifying', { verifying: 'VERIFYING' })
      .andWhere('intent.rail = :rail', { rail: 'RAIL_B_VOUCHER' })
      .andWhere('intent.expiresAt < :cutoff', {
        cutoff: new Date(now.getTime() - deadlineSeconds * 1000),
      })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere('intent.voucherSeq IS NOT NULL')
      .andWhere('intent.voucherSignature IS NOT NULL')
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM verification_records vr
           WHERE vr.intent_id = intent.id
             AND vr.settlement_outcome IS NOT NULL
             AND vr.settlement_outcome <> 'SETTLE')`,
      )
      .orderBy('intent.expiresAt', 'ASC')
      .limit(limit)
      .getRawMany<DuePaymentIntent>();
  }

  /**
   * Terminal intents whose hold was never released.
   *
   * The repair half of the sweep. Every edge into `EXPIRED`, `VOIDED` and
   * `REFUNDED` is a RELEASE edge, and each is written as two steps — the status
   * move, then `releaseHold`. A process that dies between them leaves money
   * reserved for a call that is over, and the intent is no longer in a status
   * any other pass reads: the hold backstop takes in-flight rows only, and
   * `findClosedWithOpenHold` takes settled rail-B rows only. Without this
   * **nothing** returns it — rail A's `available` stays short by the price,
   * and on rail B the open hold keeps reducing spendable forever.
   *
   * Only holds still `OPEN`: a hold another writer already resolved has
   * nothing to release, and selecting it would retry a row that can never
   * succeed at the head of every batch.
   */
  async findTerminalWithUnreleasedHold(
    terminalStatuses: readonly string[],
    limit: number,
  ): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .innerJoin('ledger_holds', 'hold', 'hold.id = intent.hold_id')
      .where('intent.status IN (:...terminalStatuses)', { terminalStatuses })
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere(`hold.status = 'OPEN'`)
      .orderBy('intent.expiresAt', 'ASC')
      .limit(limit)
      .getRawMany<DuePaymentIntent>();
  }

  /**
   * One intent by id, with no tenant.
   *
   * **Deliberately cross-organization**, and it has to be: the public demo's
   * verdict route receives an intent id and nothing else — there is no
   * session, so there is no tenant to scope by. Every other read of this table
   * starts from a caller who owns the rows.
   *
   * That makes the *caller's* obligation sharp, and it is not this method's to
   * discharge: `PublicDemoVerdictService` refuses any intent whose
   * `organizationId` is not the demo organization, and answers 404 rather than
   * 403 so that a foreign id is indistinguishable from one that does not
   * exist. Returning the row here without that check would publish any call's
   * verification stages to anybody who guessed an id — the same shape as the
   * cross-tenant cache leak in `api-surface-g24`.
   *
   * The id is a platform-minted UUID, one per call, so this is a point read
   * rather than a scan and it cannot be walked.
   */
  async findByIdAcrossTenants(id: string): Promise<PaymentIntentEntity | null> {
    return this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.id = :id', { id })
      .getOne();
  }

  /**
   * How many calls one binding has served — the exploration floor's
   * denominator.
   *
   * **This is the source of truth for that number.** `BindingCallCounterService`
   * keeps a Redis counter in front of it so routing does not run a `COUNT(*)`
   * per decision, but the counter is a cache of this query and is rebuilt from
   * it whenever the key is gone. A count that lived only in Redis would let a
   * flush hand a two-year-old binding a new binding's exploration allowance.
   *
   * **Deliberately cross-organization**, and for a sharper reason than the
   * exports above: the tenant on a `payment_intents` row is the **buying**
   * organization, and a binding's calls arrive from every buyer that ever
   * routed to it. Scoping this to any one of them would not narrow the answer,
   * it would produce a different quantity — "how much of this binding did *you*
   * use" — which is not what the floor is defined on. The projection is a
   * single integer and carries no buyer identity at all.
   *
   * `organizationId IS NOT NULL` is what satisfies
   * `OrganizationScopedRepository`'s query-builder guard while reading across
   * tenants on purpose; this file is allowlisted by name in
   * `test/unit/shared/api/surface-consistency.spec.ts`.
   *
   * Rows written before traffic weighting carry `binding_id IS NULL` and are
   * invisible here, deliberately and permanently — see the column's own doc
   * comment. The count is therefore a floor on a long-lived binding's true
   * traffic, which is the safe direction: it makes the binding look newer, and
   * the only thing that costs is a slightly larger share of a capped
   * exploration budget.
   */
  async countCallsByBinding(bindingId: string): Promise<number> {
    return this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.bindingId = :bindingId', { bindingId })
      .getCount();
  }

  /**
   * The projection both sweep queries read.
   *
   * `organizationId` is selected first and is not decoration: it is what makes
   * the built SQL reference the tenant column, and therefore what the query
   * builder guard checks. A projection that dropped it would be rejected before
   * it reached Postgres — correctly, since the caller could then not scope its
   * follow-up writes either.
   */
  /**
   * Rail-B intents that have settled and whose hold is still open — the
   * redemption job's queue.
   *
   * `hold_released_at IS NULL` on a `SETTLED` rail-B intent means exactly one
   * thing: the verdict passed, the provider is owed, and `redeem_voucher` has
   * not landed yet. `PaymentIntentService.resolve` deliberately leaves it that
   * way, and `VerificationSettlementService.repairHoldEffect` deliberately
   * skips it, so nothing else in the system will touch these rows.
   *
   * **Ordered by `(agent_account, voucher_seq)` ascending, and that ordering is
   * load-bearing.** The chain permits out-of-order redemption, but `seq_high`
   * only advancing past holds that have already been decided is what keeps the
   * in-flight gap meaningful: `next_seq − oldest_pending_seq` bounds
   * `next_seq − seq_high` only while the redemptions go up in sequence. (On a
   * chain that requires ascending seq; see `orderedBySeq` below.)
   *
   * **Deliberately cross-organization.** The job runs in the scheduler, per
   * asset, on behalf of no tenant — and the ordering above is per *buyer
   * account*, which is not a tenant either (two agents can share one). Scoping
   * it would produce a different queue rather than a narrower one, and would
   * order each tenant's slice independently. `organizationId IS NOT NULL`
   * satisfies the scope guard while reading across tenants on purpose; the
   * projection carries the organization id so every write back is scoped.
   *
   * Rows missing a signature are excluded rather than returned and skipped: a
   * rail-B row written before voucher v2 has no signature to replay and never
   * will, so returning it would put a permanently unredeemable row at the head
   * of every pass.
   *
   * `orderedBySeq: false` is for a chain that admits each `(payer, seq)` once
   * in any order (`eip155`, D-23): a row is then never held back by a LOWER seq
   * of its payer — still open, or behind a payer-side block — only by its own
   * blocked parties. The default keeps both hold-backs (Solana). Such a queue
   * is not ordered by `(agent_account, voucher_seq)`: a row in its retry
   * back-off is left out, and the batch is filled round-robin by payer and by
   * provider (review 2026-10-23 I-1) — see the query below.
   */
  async findAwaitingRedemption(
    assetId: string,
    settledStatus: string,
    rail: string,
    limit: number,
    exclude: RedemptionExclusions = NO_REDEMPTION_EXCLUSIONS,
    options: { readonly orderedBySeq?: boolean } = {},
  ): Promise<RedeemableIntent[]> {
    const orderedBySeq = options.orderedBySeq ?? true;
    const query = this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.id', 'id')
      .addSelect('intent.agentAccount', 'agentAccount')
      .addSelect('intent.providerAccount', 'providerAccount')
      .addSelect('intent.assetId', 'assetId')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('intent.priceAmount', 'priceAmount')
      .addSelect('intent.requestHash', 'requestHash')
      .addSelect('intent.voucherSeq', 'voucherSeq')
      .addSelect('intent.voucherSignature', 'voucherSignature')
      .addSelect('intent.voucherResourceHash', 'voucherResourceHash')
      .addSelect('intent.voucherIssuedAt', 'voucherIssuedAt')
      .addSelect('intent.voucherDelegate', 'voucherDelegate')
      .addSelect('intent.expiresAt', 'expiresAt')
      .addSelect('intent.holdId', 'holdId')
      .addSelect('intent.providerId', 'providerId')
      .addSelect('intent.providerAmount', 'providerAmount')
      .addSelect('intent.platformFee', 'platformFee')
      .addSelect('intent.redemptionLastError', 'redemptionLastError')
      .addSelect('COALESCE(cardinality(intent.redemption_tx_refs), 0)::int', 'redemptionTxRefCount')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.assetId = :assetId', { assetId })
      .andWhere('intent.rail = :rail', { rail })
      .andWhere('intent.status = :settledStatus', { settledStatus })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere('intent.voucherSeq IS NOT NULL')
      .andWhere('intent.voucherSignature IS NOT NULL')
      // Buyer debt: the voucher is dead and nothing will redeem it until the
      // buyer signs a replacement (`replaceLapsedVoucher` sets
      // `redemption_replaced_at`, keeping the lapse for the write-off clock).
      .andWhere('(intent.redemptionLapsedAt IS NULL OR intent.redemptionReplacedAt IS NOT NULL)')
      // A forfeit, a write-off or a void is closed for good, even if its hold
      // release did not land (a crash between the mark and the release): it
      // must never be redeemed, or the buyer pays for a call reported as not
      // charged (review-buyer-debt L2). The expiry sweep finishes the release.
      .andWhere(`(intent.redemption_last_error IS NULL OR NOT ${CLOSED_OUTCOME_SQL('intent')})`)
      // Redeemed into the escrow's hold already (G3.B1): its hold stays open
      // until `HeldCollectionJob` collects or a dispute refunds it.
      .andWhere('intent.heldAt IS NULL');

    if (orderedBySeq) {
      // A row waits while a LOWER seq of its payer is still in flight or open
      // (review 2026-10-15 P-4). Redeeming it first advances `seq_high` past
      // the lower one, which then dies on `VoucherSeqNotIncreasing` and is paid
      // by the platform. Bounded: the lower one settles (and goes first),
      // or ends REFUNDED/VOIDED/EXPIRED (only a hole), or passes its own
      // redemption window (final review N-1): past `expires_at` + grace the
      // chain refuses it anyway, so it is only a hole, and waiting on it to
      // the 24 h hold backstop would let every later voucher expire too.
      // Per payer account, not per asset: the seq is the escrow's. Not on a
      // chain that admits any order (D-23): nothing there can die of it.
      query.andWhere(
        `NOT EXISTS (
           SELECT 1 FROM payment_intents earlier
            WHERE earlier.organization_id IS NOT NULL
              AND earlier.agent_account = intent.agent_account
              AND earlier.rail = :rail
              AND earlier.voucher_seq IS NOT NULL
              AND earlier.voucher_seq < intent.voucher_seq
              AND earlier.expires_at > now() - ${redeemGraceIntervalSql('earlier.chain_id')}
              AND (earlier.status IN (:...earlierOpenStatuses)
                   OR (earlier.status = 'CREATED' AND earlier.expires_at > now()))
         )`,
        { earlierOpenStatuses: [...OPEN_HOLD_STATUSES] },
      );
    }

    if (
      exclude.organizationIds.length > 0 ||
      exclude.walletKeys.length > 0 ||
      exclude.chainAccounts.length > 0
    ) {
      // A row is left out when it, or an EARLIER seq of the same payer in this
      // queue, has a blocked party. Leaving out only the blocked row would let
      // the payer's later seqs through, and redeeming one of those advances
      // `seq_high` past the held one and kills it. Done in the query, BEFORE
      // the LIMIT, so held rows can never fill the pass (audit E-1). On a
      // chain that admits any order (D-23) only the row's OWN parties count.
      //
      // Payer-side parties only — the payer's organization, the payer and the
      // delegate. A blocked provider or payee is NOT left out: the pass makes
      // that provider forfeit the voucher at once (`VoucherRedemptionService`),
      // which closes the row, so it can neither wait nor fill a pass.
      query.andWhere(
        `NOT EXISTS (
           SELECT 1 FROM payment_intents held
            WHERE held.organization_id IS NOT NULL
              AND held.agent_account = intent.agent_account
              AND held.asset_id = intent.asset_id
              AND held.rail = :rail
              AND held.status = :settledStatus
              AND held.hold_id IS NOT NULL
              AND held.hold_released_at IS NULL
              AND held.held_at IS NULL
              AND held.voucher_seq IS NOT NULL
              AND held.voucher_signature IS NOT NULL
              AND (held.redemption_lapsed_at IS NULL OR held.redemption_replaced_at IS NOT NULL)
              AND ${orderedBySeq ? 'held.voucher_seq <= intent.voucher_seq' : 'held.voucher_seq = intent.voucher_seq'}
              AND (${blockedPartySql('held')})
         )`,
        blockedPartyParams(exclude),
      );
    }

    if (orderedBySeq) {
      return query
        .orderBy('intent.agentAccount', 'ASC')
        .addOrderBy('intent.voucherSeq', 'ASC')
        .limit(limit)
        .getRawMany<RedeemableIntent>();
    }

    // Any order (D-23): nothing holds a payer's rows back any more, so the
    // pass is kept FAIR instead (review 2026-10-23 I-1). A row the chain
    // refused with a retryable error waits out its back-off
    // (`recordRedemptionRetry`), and the batch is filled ROUND-ROBIN by payer
    // and by provider: every payer's and every provider's first row comes
    // before anybody's second, so no payer and no provider can take the batch
    // while somebody else is waiting — and a lone busy one still fills it.
    // Within a round, rows never refused come first, then the nearest deadline.
    query.andWhere('(intent.redemptionRetryAt IS NULL OR intent.redemptionRetryAt <= now())');
    const [inner, parameters] = query.getQueryAndParameters();
    const rows = (await this.manager.query(
      `SELECT ranked.* FROM (
         SELECT queue.*,
                row_number() OVER (PARTITION BY queue."agentAccount"
                                   ORDER BY queue."expiresAt", queue."voucherSeq") AS "payerRound",
                row_number() OVER (PARTITION BY queue."providerAccount"
                                   ORDER BY queue."expiresAt", queue."agentAccount",
                                            queue."voucherSeq") AS "providerRound"
           FROM (${inner}) queue
       ) ranked
       ORDER BY GREATEST(ranked."payerRound", ranked."providerRound") ASC,
                (ranked."redemptionLastError" IS NOT NULL) ASC,
                ranked."expiresAt" ASC,
                ranked."agentAccount" ASC,
                ranked."voucherSeq" ASC
       LIMIT $${parameters.length + 1}`,
      [...parameters, limit],
    )) as (RedeemableIntent & { payerRound?: unknown; providerRound?: unknown })[];
    return rows.map(({ payerRound: _payer, providerRound: _provider, ...row }) => row);
  }

  /**
   * How many vouchers of `assetId` await redemption, when the oldest was issued
   * and the earliest `expires_at` — one aggregate row, for the redemption job's
   * gathering check (`settlement-gathering.constants.ts`), so a pass that will
   * wait loads no rows.
   *
   * The base filters of {@link findAwaitingRedemption}, kept in step with it by
   * hand, without its seq-order hold-back and its blocked-party exclusions: it
   * may count a row the pass then leaves out, which only makes a pass run
   * sooner — never later. On a chain that admits any seq order a row in its
   * retry back-off is left out, as the pass leaves it out.
   */
  async summarizeAwaitingRedemption(
    assetId: string,
    settledStatus: string,
    rail: string,
    options: { readonly orderedBySeq?: boolean } = {},
  ): Promise<{ count: number; oldestIssuedAt: Date | null; earliestExpiresAt: Date | null }> {
    const query = this.createQueryBuilder('intent')
      .select('COUNT(*)::int', 'count')
      .addSelect('MIN(intent.voucherIssuedAt)', 'oldestIssuedAt')
      .addSelect('MIN(intent.expiresAt)', 'earliestExpiresAt')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.assetId = :assetId', { assetId })
      .andWhere('intent.rail = :rail', { rail })
      .andWhere('intent.status = :settledStatus', { settledStatus })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere('intent.voucherSeq IS NOT NULL')
      .andWhere('intent.voucherSignature IS NOT NULL')
      .andWhere('(intent.redemptionLapsedAt IS NULL OR intent.redemptionReplacedAt IS NOT NULL)')
      .andWhere(`(intent.redemption_last_error IS NULL OR NOT ${CLOSED_OUTCOME_SQL('intent')})`)
      .andWhere('intent.heldAt IS NULL');
    if (options.orderedBySeq === false) {
      query.andWhere('(intent.redemptionRetryAt IS NULL OR intent.redemptionRetryAt <= now())');
    }
    const row = await query.getRawOne<{
      count: number | string;
      oldestIssuedAt: string | null;
      earliestExpiresAt: Date | string | null;
    }>();
    return {
      count: Number(row?.count ?? 0),
      // `voucher_issued_at` is the voucher's own unix seconds (bigint).
      oldestIssuedAt:
        row?.oldestIssuedAt === null || row?.oldestIssuedAt === undefined
          ? null
          : new Date(Number(row.oldestIssuedAt) * 1000),
      earliestExpiresAt:
        row?.earliestExpiresAt === null || row?.earliestExpiresAt === undefined
          ? null
          : new Date(row.earliestExpiresAt),
    };
  }

  /**
   * A retryable refusal of this voucher (review 2026-10-23 I-1): it is not
   * attempted again for 1, 2, 4, 8, then 10 minutes — but never past its last
   * pass, `REDEMPTION_DEADLINE_MARGIN_SECONDS` before its on-chain deadline
   * (`expires_at` + the chain's grace), so a provider that tops up its stake
   * or a buyer that re-grants is still met in time. Read only on a chain that
   * admits any seq order.
   */
  async recordRedemptionRetry(organizationId: string, id: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_attempts" = "redemption_attempts" + 1,
              "redemption_retry_at" = LEAST(
                now() + LEAST(interval '${REDEMPTION_RETRY_MAX_SECONDS} seconds',
                              interval '${REDEMPTION_RETRY_BASE_SECONDS} seconds'
                                * power(2, LEAST("redemption_attempts", 4))),
                GREATEST(now(),
                         "expires_at" + ${redeemGraceIntervalSql('"chain_id"')}
                           - interval '${REDEMPTION_DEADLINE_MARGIN_SECONDS} seconds'))
        WHERE "organization_id" = $1 AND "id" = $2`,
      [organizationId, id],
    );
  }

  /**
   * Records a transaction about to carry this intent's voucher, before it is
   * broadcast. Idempotent per reference. See `redemptionTxRefs` on the entity.
   */
  async recordRedemptionTxRef(organizationId: string, id: string, txRef: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_tx_refs" = array_append("redemption_tx_refs", $3::text)
        WHERE "organization_id" = $1 AND "id" = $2
          AND NOT ($3::text = ANY("redemption_tx_refs"))`,
      [organizationId, id, txRef],
    );
  }

  /**
   * Records why the last redemption attempt of this intent was refused, or
   * `provider_forfeit:<cause>` once the provider forfeited it. Overwrites. See
   * `redemptionLastError` on the entity.
   */
  async recordRedemptionError(organizationId: string, id: string, error: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents" SET "redemption_last_error" = $3
        WHERE "organization_id" = $1 AND "id" = $2`,
      [organizationId, id, error],
    );
  }

  /** The transactions {@link recordRedemptionTxRef} recorded for this intent, oldest first. */
  async findRedemptionTxRefs(organizationId: string, id: string): Promise<string[]> {
    const [row] = (await this.manager.query(
      `SELECT "redemption_tx_refs" AS "refs" FROM "payment_intents"
        WHERE "organization_id" = $1 AND "id" = $2`,
      [organizationId, id],
    )) as Array<{ refs: string[] | null }>;
    return row?.refs ?? [];
  }

  /**
   * Records a PROVIDER-side block as the sticky redemption cause of every
   * rail-B voucher of `assetId` still awaiting redemption whose provider
   * organization, payee wallet (`walletKeys`, the blocklist's namespace keys)
   * or on-chain payee (`chainAccounts`, lower-case CAIP-10) is blocked — held
   * or not (review 2026-10-15 #2, M2). A voucher whose PAYER is blocked too is
   * left out of the queue and frozen, so without this the provider's block was
   * never recorded and, lifted before the payer's, cost the provider nothing.
   *
   * Never overwrites a cause already provider-caused (the first one stands) or
   * a closed outcome (`provider_forfeit:`, `uncollected:`). One statement per
   * pass; a no-op when nothing is blocked.
   */
  async recordProviderBlocks(
    assetId: string,
    blocked: RedemptionExclusions,
    providerCaused: readonly string[],
  ): Promise<void> {
    if (
      blocked.organizationIds.length === 0 &&
      blocked.walletKeys.length === 0 &&
      blocked.chainAccounts.length === 0
    ) {
      return;
    }
    const payeeKey =
      `(split_part("provider_account", ':', 1) || ':' || CASE WHEN split_part("provider_account", ':', 1) = 'eip155' ` +
      `THEN lower(split_part("provider_account", ':', 3)) ELSE split_part("provider_account", ':', 3) END)`;
    await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_last_error" = CASE
                WHEN "provider_id"::text = ANY($2::text[]) THEN 'ProviderBlocked'
                WHEN ${payeeKey} = ANY($3::text[]) THEN 'PayeeBlocked'
                ELSE 'PayeeBlockedOnChain' END
        WHERE "organization_id" IS NOT NULL
          AND "asset_id" = $1
          AND "rail" = 'RAIL_B_VOUCHER'
          AND "status" = 'SETTLED'
          AND "hold_id" IS NOT NULL
          AND "hold_released_at" IS NULL
          AND ("redemption_lapsed_at" IS NULL OR "redemption_replaced_at" IS NOT NULL)
          AND ("redemption_last_error" IS NULL OR NOT (
                "redemption_last_error" = ANY($5::text[])
                OR "redemption_last_error" LIKE 'provider_forfeit:%'
                OR "redemption_last_error" LIKE 'uncollected:%'
                OR "redemption_last_error" LIKE 'voided:%'))
          AND ("provider_id"::text = ANY($2::text[])
               OR ${payeeKey} = ANY($3::text[])
               OR lower("provider_account") = ANY($4::text[]))`,
      [
        assetId,
        [...blocked.organizationIds],
        [...blocked.walletKeys],
        blocked.chainAccounts.map((account) => account.toLowerCase()),
        [...providerCaused],
      ],
    );
  }

  /**
   * Turns a served rail-B call into BUYER DEBT: its voucher can no longer be
   * redeemed for a reason that is not the provider's. The hold stays OPEN, so
   * the amount stays out of the buyer's spendable balance, and nobody is
   * credited. `redemption_lapsed_at` keeps the FIRST lapse, so neither a row
   * lapsed twice nor a replacement that lapsed again restarts its write-off
   * clock (review-buyer-debt M4); a replacement that lapses is plain debt again
   * (`redemption_replaced_at` cleared). Only an open hold lapses.
   */
  async lapseRedemption(organizationId: string, id: string, cause: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_lapsed_at" = COALESCE("redemption_lapsed_at", now()),
              "redemption_replaced_at" = NULL,
              "redemption_last_error" = $3
        WHERE "organization_id" = $1 AND "id" = $2 AND "hold_released_at" IS NULL`,
      [organizationId, id, cause],
    );
  }

  /**
   * The payer's debts that refuse its paid calls ({@link DEBT_REFUSING_SQL}):
   * rows of the payer ACCOUNT (any organization — the escrow is the account's)
   * or of the organization (any of its payer accounts), oldest lapse first.
   * Read on every paid call (`PAYMENT_DEBT_OUTSTANDING`) and by
   * `GET /escrow/debts`; `idx_payment_intents_open_debt` holds only these rows.
   *
   * `manager`: the payer's admission transaction, when the caller holds its
   * lock (review-buyer-debt L8).
   */
  async findOutstandingDebts(
    organizationId: string,
    payer: string,
    limit = 50,
    manager: EntityManager = this.manager,
  ): Promise<OutstandingDebt[]> {
    const rows = (await manager.query(
      `SELECT ${OUTSTANDING_DEBT_COLUMNS}
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL
          AND ${DEBT_REFUSING_SQL}
          AND ("agent_account" = $2 OR "organization_id" = $1)
        ORDER BY "redemption_lapsed_at" ASC, "id" ASC
        LIMIT $3`,
      [organizationId, payer, limit],
    )) as RawOutstandingDebt[];
    return rows.map(toOutstandingDebt);
  }

  /**
   * How many buyer debts each asset gained since `since`, still open
   * ({@link DEBT_REFUSING_SQL}): the input of the buyer-debt spike alert
   * (`BuyerDebtSpikeMonitor`). Read from the table rather than counted in
   * memory, so a restart loses nothing. `assetId` narrows it to one asset.
   *
   * Cheap at any table size: the predicate is `idx_payment_intents_open_debt`'s
   * own, so only the open debts (hundreds, thousands) are visited.
   * **Deliberately cross-organization**: a spike is a platform incident,
   * counted over every buyer organization.
   */
  async countDebtsLapsedSince(
    since: Date,
    assetId?: string,
  ): Promise<Array<{ assetId: string; count: number }>> {
    const rows = (await this.manager.query(
      `SELECT "asset_id" AS "assetId", COUNT(*)::int AS "count"
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL
          AND ${DEBT_REFUSING_SQL}
          AND "rail" = 'RAIL_B_VOUCHER'
          AND "redemption_lapsed_at" >= $1
          AND ($2::text IS NULL OR "asset_id" = $2)
        GROUP BY "asset_id"`,
      [since, assetId ?? null],
    )) as Array<{ assetId: string; count: number | string }>;
    return rows.map((row) => ({ assetId: row.assetId, count: Number(row.count) }));
  }

  /**
   * One debt of `payer` by id, whatever its age or how many others there are
   * (review-buyer-debt L5): `null` unless it still refuses paid calls.
   */
  async findOutstandingDebt(payer: string, id: string): Promise<OutstandingDebt | null> {
    const [row] = (await this.manager.query(
      `SELECT ${OUTSTANDING_DEBT_COLUMNS}
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL
          AND "id" = $1 AND "agent_account" = $2
          AND ${DEBT_REFUSING_SQL}`,
      [id, payer],
    )) as RawOutstandingDebt[];
    return row ? toOutstandingDebt(row) : null;
  }

  /**
   * Open buyer debts that lapsed before `before`: the write-off pass's
   * candidates. Cross-tenant like the other sweep reads, oldest first.
   *
   * Left out: a debt whose replacement is being collected (it lapses again,
   * keeping its first lapse, if the replacement fails), and a debt whose
   * payer, payer organization or delegate is BLOCKED — blocking a buyer
   * freezes collection, the write-off clock included (review-buyer-debt L1).
   */
  async findDueForWriteOff(
    before: Date,
    limit: number,
    exclude: RedemptionExclusions = NO_REDEMPTION_EXCLUSIONS,
  ): Promise<DuePaymentIntent[]> {
    const query = this.selectSweepCandidates()
      .addSelect('intent.agentAccount', 'agentAccount')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.redemptionLapsedAt IS NOT NULL')
      .andWhere('intent.redemptionLapsedAt < :before', { before })
      .andWhere('intent.redemptionReplacedAt IS NULL')
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL');
    if (hasExclusions(exclude)) {
      query.andWhere(`NOT (${blockedPartySql('intent')})`, blockedPartyParams(exclude));
    }
    return query.orderBy('intent.redemptionLapsedAt', 'ASC').limit(limit).getRawMany();
  }

  /**
   * Writes off one open debt INSIDE the ledger transaction that releases its
   * hold (review-buyer-debt M1), under the payer's admission lock — the lock
   * `replaceLapsedVoucher` takes — so a replacement cannot slip in between.
   * Records `uncollected:<cause>` and the release in one statement, and only
   * if the row is still exactly the debt the pass read: lapsed before
   * `before`, not being replaced, the same hold, still open. `false` (the
   * caller must not release anything) when it changed: settled, replaced, or
   * written off already.
   */
  async markWrittenOff(
    runner: QueryRunner,
    target: DebtCloseTarget,
    reason: string,
    before: Date,
  ): Promise<boolean> {
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `voucher-admission:${target.payer}`,
    ]);
    const result = (await runner.query(
      `UPDATE "payment_intents"
          SET "redemption_last_error" = $5, "hold_released_at" = now()
        WHERE "organization_id" = $1 AND "id" = $2 AND "agent_account" = $3 AND "hold_id" = $4
          AND "redemption_lapsed_at" IS NOT NULL AND "redemption_lapsed_at" < $6
          AND "redemption_replaced_at" IS NULL
          AND "hold_released_at" IS NULL
        RETURNING "id"`,
      [target.organizationId, target.id, target.payer, target.holdId, reason, before],
    )) as [unknown[], number] | unknown[];
    return affected(result) > 0;
  }

  /**
   * Voids a buyer debt whose call was judged FAIL / REFUND / VOID after it had
   * been settled as served and unverified (review-buyer-debt M2): the buyer is
   * not charged and nobody is credited. Inside the ledger transaction that
   * releases the hold, under the payer's admission lock. Only an open debt
   * (hold open) or a written-off one (hold already released — the release is
   * then a no-op), never a debt whose replacement is being collected: that
   * voucher may already be on its way to the chain. `false` when nothing
   * matched.
   */
  async markDebtVoided(
    runner: QueryRunner,
    target: DebtCloseTarget,
    reason: string,
  ): Promise<boolean> {
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `voucher-admission:${target.payer}`,
    ]);
    const result = (await runner.query(
      `UPDATE "payment_intents"
          SET "redemption_last_error" = $5,
              "hold_released_at" = COALESCE("hold_released_at", now())
        WHERE "organization_id" = $1 AND "id" = $2 AND "agent_account" = $3 AND "hold_id" = $4
          AND "status" = 'SETTLED' AND "rail" = 'RAIL_B_VOUCHER'
          AND "redemption_lapsed_at" IS NOT NULL
          AND "redemption_replaced_at" IS NULL
          AND ("hold_released_at" IS NULL OR "redemption_last_error" LIKE 'uncollected:%')
        RETURNING "id"`,
      [target.organizationId, target.id, target.payer, target.holdId, reason],
    )) as [unknown[], number] | unknown[];
    return affected(result) > 0;
  }

  /**
   * The operator's buyer-debt list ({@link OPERATOR_VOIDABLE_DEBT_SQL}),
   * filtered, unordered and unpaged: the caller pages it.
   *
   * **Deliberately cross-organization**: the operator console has no tenant
   * of its own, and the list exists to find the debts one platform incident
   * left across every buyer organization. `organizationId IS NOT NULL`
   * satisfies the scoped repository's guard, as on `exportQueryBuilder`.
   */
  operatorDebtsQuery(filter: OperatorDebtFilter): SelectQueryBuilder<PaymentIntentEntity> {
    const qb = this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere(OPERATOR_VOIDABLE_DEBT_SQL);
    if (filter.chainId) qb.andWhere('intent.chainId = :chainId', { chainId: filter.chainId });
    if (filter.assetId) qb.andWhere('intent.assetId = :assetId', { assetId: filter.assetId });
    if (filter.payerAccount) {
      qb.andWhere('lower(intent.agentAccount) = lower(:payerAccount)', {
        payerAccount: filter.payerAccount,
      });
    }
    if (filter.buyerOrganizationId) {
      qb.andWhere('intent.organizationId = :buyerOrganizationId', {
        buyerOrganizationId: filter.buyerOrganizationId,
      });
    }
    if (filter.providerId) {
      qb.andWhere('intent.providerId = :providerId', { providerId: filter.providerId });
    }
    if (filter.lastError) {
      qb.andWhere(
        `(intent.redemption_last_error = :lastError ` +
          `OR intent.redemption_last_error = ('uncollected:' || :lastError))`,
        { lastError: filter.lastError },
      );
    }
    if (filter.suggestedOnly) qb.andWhere(OPERATOR_SUGGESTED_PLATFORM_CAUSE_SQL);
    return qb;
  }

  /** Count and amount per asset of {@link operatorDebtsQuery}'s rows (cross-organization, as it). */
  async operatorDebtTotals(
    qb: SelectQueryBuilder<PaymentIntentEntity>,
  ): Promise<OperatorDebtTotal[]> {
    const rows = await qb
      .select('intent.assetId', 'assetId')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('COALESCE(SUM(intent.priceAmount), 0)::text', 'amount')
      .groupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .orderBy('intent.assetId', 'ASC')
      .getRawMany<{
        assetId: string;
        decimals: number | string;
        count: number | string;
        amount: string;
      }>();
    return rows.map((row) => ({
      assetId: row.assetId,
      decimals: Number(row.decimals),
      count: Number(row.count),
      amount: String(row.amount),
    }));
  }

  /**
   * The open buyer debts among `ids` ({@link OPERATOR_VOIDABLE_DEBT_SQL}),
   * read across organizations for the operator's bulk void (`M-1`); an id
   * that is not one now is simply absent.
   */
  async findOperatorDebts(ids: readonly string[]): Promise<PaymentIntentEntity[]> {
    if (ids.length === 0) return [];
    return this.operatorDebtsQuery({})
      .andWhere('intent.id IN (:...ids)', { ids: [...ids] })
      .getMany();
  }

  /**
   * Holds a call for a buyer's dispute filed while the payment is still held
   * (G3.B1), under the payer's admission lock: `dispute_outcome = 'OPEN'` keeps
   * `HeldCollectionJob` from collecting it until the decision. Either held and
   * more than `guardSeconds` before `collectable_at`, or — rail B — served and
   * not redeemed yet (it is redeemed into the hold as usual; a full window
   * starts then). `false` when the window has passed: the dispute is then not
   * guaranteed.
   */
  async holdForDispute(
    runner: Pick<QueryRunner, 'query'>,
    target: { organizationId: string; id: string; payer: string },
    guardSeconds: number,
  ): Promise<boolean> {
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `voucher-admission:${target.payer}`,
    ]);
    const result = (await runner.query(
      `UPDATE "payment_intents" SET "dispute_outcome" = 'OPEN'
        WHERE "organization_id" = $1 AND "id" = $2 AND "agent_account" = $3
          AND "status" = 'SETTLED' AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
          AND "dispute_outcome" IS NULL
          AND (("held_status" = 'HELD' AND "collectable_at" - make_interval(secs => $4) > now())
               OR ("held_status" IS NULL AND "rail" = 'RAIL_B_VOUCHER'
                   AND "redemption_lapsed_at" IS NULL AND "redemption_last_error" IS NULL))
        RETURNING "id"`,
      [target.organizationId, target.id, target.payer, guardSeconds],
    )) as [unknown[], number] | unknown[];
    return affected(result) > 0;
  }

  /**
   * `Σ price_amount` the escrow holds for each of these payers (G3.B1): rail-B
   * calls redeemed into the hold and not collected or refunded yet. Out of the
   * buyer's escrow balance on chain, still in its ledger hold. Cross-tenant:
   * the reconciler's per-escrow walk.
   */
  async sumHeldOnChainByAccounts(
    assetId: string,
    accounts: readonly string[],
  ): Promise<Map<string, bigint>> {
    if (accounts.length === 0) return new Map();
    const rows = (await this.manager.query(
      `SELECT "agent_account" AS "account", COALESCE(SUM("price_amount"), 0)::text AS "held"
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL AND "asset_id" = $1 AND "rail" = 'RAIL_B_VOUCHER'
          AND "held_status" = 'HELD' AND "agent_account" = ANY($2)
        GROUP BY "agent_account"`,
      [assetId, [...accounts]],
    )) as { account: string; held: string }[];
    return new Map(rows.map((row) => [row.account, BigInt(row.held)]));
  }

  /**
   * Voucher seqs in `1..upTo` that no payment intent of this payer carries,
   * highest first, at most `limit` (A2). A redeemed seq with no intent was
   * signed by somebody else (or a copy of this database): the reconciler reads
   * `held(payer, seq)` for these to name a hold the mirror does not have. Each
   * gap is capped at `limit` before it is expanded, so a wide gap (a realigned
   * `next_seq`) costs no more than a narrow one.
   */
  async voucherSeqGaps(
    assetId: string,
    account: string,
    upTo: bigint,
    limit: number,
  ): Promise<string[]> {
    if (upTo < 1n || limit < 1) return [];
    const rows = (await this.manager.query(
      `WITH "seqs" AS (
         SELECT DISTINCT "voucher_seq" AS "s" FROM "payment_intents"
          WHERE "asset_id" = $1 AND "agent_account" = $2
            AND "voucher_seq" IS NOT NULL AND "voucher_seq" <= $3::bigint
         UNION ALL SELECT $3::bigint + 1
       ), "bounds" AS (
         SELECT "s", COALESCE(LAG("s") OVER (ORDER BY "s"), 0) AS "prev" FROM "seqs"
       )
       SELECT "g"::text AS "seq"
         FROM "bounds",
              generate_series(GREATEST("prev" + 1, "s" - $4::bigint), "s" - 1) AS "g"
        ORDER BY "g" DESC
        LIMIT $4`,
      [assetId, account, upTo.toString(), limit],
    )) as { seq: string }[];
    return rows.map((row) => row.seq);
  }

  /** `Σ price_amount` the escrow holds, every payer: the mirror of `totalHeld()`. */
  async sumHeldOnChain(assetId: string): Promise<bigint> {
    const [row] = (await this.manager.query(
      `SELECT COALESCE(SUM("price_amount"), 0)::text AS "held"
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL AND "asset_id" = $1 AND "rail" = 'RAIL_B_VOUCHER'
          AND "held_status" = 'HELD'`,
      [assetId],
    )) as { held: string }[];
    return BigInt(row?.held ?? '0');
  }

  /**
   * Marks a call's payment held (G3.B1): rail B once `redeemVoucher` put it in
   * the escrow's hold (`PaymentHeld`), rail A at settlement. Only once, and
   * only while the call's hold is open. `false` when nothing matched.
   */
  async markHeld(
    organizationId: string,
    id: string,
    heldAt: Date,
    collectableAt: Date,
  ): Promise<boolean> {
    const result = (await this.manager.query(
      `UPDATE "payment_intents"
          SET "held_status" = 'HELD', "held_at" = $3, "collectable_at" = $4
        WHERE "organization_id" = $1 AND "id" = $2 AND "status" = 'SETTLED'
          AND "held_status" IS NULL AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
        RETURNING "id"`,
      [organizationId, id, heldAt, collectableAt],
    )) as [unknown[], number] | unknown[];
    return affected(result) > 0;
  }

  /**
   * Held payments the collection job may collect now (G3.B1): past
   * `collectable_at`, not held by an open or upheld dispute, hold still open,
   * not backing off after a failure, no blocked party (review P1-3 — the
   * contract refuses them, and they would block the pass every minute) — in
   * seq order per payer. Deliberately cross-organization: a platform job.
   *
   * `beforeSeconds` (rail B): only rows whose `collectable_at + beforeSeconds`
   * is still in the future — the rest are past (or about to pass) the chain's
   * timeout and are {@link findTimedOutCollectable}'s, collected singly.
   */
  async findCollectable(
    rail: string,
    limit: number,
    exclude: RedemptionExclusions = NO_REDEMPTION_EXCLUSIONS,
    beforeSeconds: number | null = null,
  ): Promise<PaymentIntentEntity[]> {
    const query = this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.rail = :rail', { rail })
      .andWhere(`intent.heldStatus = 'HELD'`)
      .andWhere('intent.collectableAt <= now()')
      .andWhere(`(intent.disputeOutcome IS NULL OR intent.disputeOutcome = 'REJECTED')`)
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere('(intent.heldRetryAt IS NULL OR intent.heldRetryAt <= now())');
    if (beforeSeconds !== null) {
      query.andWhere(`intent.collectableAt > now() - make_interval(secs => :before)`, {
        before: beforeSeconds,
      });
    }
    if (hasExclusions(exclude)) {
      query.andWhere(`NOT (${blockedCollectSql('intent')})`, blockedPartyParams(exclude));
    }
    return query
      .orderBy('intent.agentAccount', 'ASC')
      .addOrderBy('intent.voucherSeq', 'ASC', 'NULLS LAST')
      .addOrderBy('intent.collectableAt', 'ASC')
      .limit(limit)
      .getMany();
  }

  /**
   * Held payments the collection job collects SINGLY (G3.B1): past, or about
   * to pass, the chain's timeout (`collect_at + timeoutSeconds <= now()`, the
   * caller's margin already taken off), when anyone may collect them and one
   * collected by a stranger would revert a whole batch. Otherwise exactly
   * {@link findCollectable}'s filters: undisputed (or rejected), hold open, not
   * backing off, no blocked party — so a row that will never be sent cannot sit
   * at the head of the queue. Cross-organization: a job.
   */
  async findTimedOutCollectable(
    rail: string,
    exclude: RedemptionExclusions,
    timeoutSeconds: number,
    limit: number,
  ): Promise<PaymentIntentEntity[]> {
    const query = this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.rail = :rail', { rail })
      .andWhere(`intent.heldStatus = 'HELD'`)
      .andWhere(`(intent.disputeOutcome IS NULL OR intent.disputeOutcome = 'REJECTED')`)
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere(`intent.collectableAt <= now() - make_interval(secs => :timeout)`, {
        timeout: timeoutSeconds,
      })
      .andWhere('(intent.heldRetryAt IS NULL OR intent.heldRetryAt <= now())');
    if (hasExclusions(exclude)) {
      query.andWhere(`NOT (${blockedCollectSql('intent')})`, blockedPartyParams(exclude));
    }
    return query
      .orderBy('intent.collectableAt', 'ASC')
      .addOrderBy('intent.id', 'ASC')
      .limit(limit)
      .getMany();
  }

  /**
   * Held payments past the chain's timeout (`collectable_at + timeoutSeconds`)
   * that the platform never collects and only SYNCS — an open or upheld
   * dispute's, or a blocked provider's ({@link blockedProviderSql}): booked once
   * someone collects them. Not backing off: the caller backs a row off after
   * each read that finds it still held, so these never crowd out newer ones.
   * Cross-organization: a job.
   */
  async findHeldPastTimeout(
    rail: string,
    exclude: RedemptionExclusions,
    timeoutSeconds: number,
    limit: number,
  ): Promise<PaymentIntentEntity[]> {
    const blockedProvider = hasExclusions(exclude) ? ` OR (${blockedProviderSql('intent')})` : '';
    return this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.rail = :rail', { rail })
      .andWhere(`intent.heldStatus = 'HELD'`)
      .andWhere(`intent.collectableAt <= now() - make_interval(secs => :timeout)`, {
        timeout: timeoutSeconds,
      })
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere('(intent.heldRetryAt IS NULL OR intent.heldRetryAt <= now())')
      .andWhere(
        `(intent.disputeOutcome IN ('OPEN', 'UPHELD')${blockedProvider})`,
        blockedPartyParams(exclude),
      )
      .orderBy('intent.collectableAt', 'ASC')
      .addOrderBy('intent.id', 'ASC')
      .limit(limit)
      .getMany();
  }

  /**
   * Held payments of a BLOCKED provider the escrow can still refund (owner
   * decision 2026-10-18): held, hold open, not backing off, the provider's
   * organization or payout account blocked ({@link blockedProviderSql} — only
   * the provider side of `exclude` is read), and `refundHeld` still open
   * (`collectable_at + timeoutSeconds` in the future; `null` for rail A,
   * whose hold is the ledger's and has no timeout). Any dispute state: the
   * buyer is refunded whatever a dispute would have decided. Closest to the
   * timeout first. Cross-organization: a job.
   *
   * Also a held row whose provider-block cause is RECORDED
   * ({@link RECORDED_BLOCK_CAUSE_SQL}), blocked or not now: its refund may have
   * landed without being booked before the block was lifted, and no other
   * queue would pick it up while a dispute holds it. The caller books it, or
   * clears the cause when the chain still holds it.
   */
  async findHeldOfBlockedProviders(
    rail: string,
    exclude: RedemptionExclusions,
    timeoutSeconds: number | null,
    limit: number,
  ): Promise<PaymentIntentEntity[]> {
    const blocked = hasExclusions(exclude) ? ` OR (${blockedProviderSql('intent')})` : '';
    const query = this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.rail = :rail', { rail })
      .andWhere(`intent.heldStatus = 'HELD'`)
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL');
    if (timeoutSeconds !== null) {
      query.andWhere(`intent.collectableAt > now() - make_interval(secs => :timeout)`, {
        timeout: timeoutSeconds,
      });
    }
    return query
      .andWhere('(intent.heldRetryAt IS NULL OR intent.heldRetryAt <= now())')
      .andWhere(`(${RECORDED_BLOCK_CAUSE_SQL('intent')}${blocked})`, blockedPartyParams(exclude))
      .orderBy('intent.collectableAt', 'ASC')
      .addOrderBy('intent.id', 'ASC')
      .limit(limit)
      .getMany();
  }

  /**
   * Clears a provider-block cause recorded on a held row whose provider is no
   * longer blocked and whose payment the chain still holds: the row goes back
   * to plain collection.
   */
  async clearHeldRefundCause(organizationId: string, id: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents" SET "redemption_last_error" = NULL
        WHERE "organization_id" = $1 AND "id" = $2 AND "held_status" = 'HELD'
          AND ${RECORDED_BLOCK_CAUSE_SQL('payment_intents')}`,
      [organizationId, id],
    );
  }

  /**
   * Held payments of a BLOCKED provider from `warnSeconds` before the chain's
   * timeout (`collectable_at + timeoutSeconds`) to `pastSeconds` after it: a
   * refund that has not landed by then is lost to the provider, so these are
   * paged. Bounded on both sides, so rows long past the timeout that nobody
   * collects cannot crowd out the ones still inside the window. Backing off or
   * not. Cross-organization: a job.
   */
  async findBlockedHeldNearTimeout(
    rail: string,
    exclude: RedemptionExclusions,
    timeoutSeconds: number,
    warnSeconds: number,
    pastSeconds: number,
    limit: number,
  ): Promise<PaymentIntentEntity[]> {
    if (!hasExclusions(exclude)) return [];
    return this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.rail = :rail', { rail })
      .andWhere(`intent.heldStatus = 'HELD'`)
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere(`intent.collectableAt <= now() - make_interval(secs => :lead)`, {
        lead: timeoutSeconds - warnSeconds,
      })
      .andWhere(`intent.collectableAt > now() - make_interval(secs => :lag)`, {
        lag: timeoutSeconds + pastSeconds,
      })
      .andWhere(`(${blockedProviderSql('intent')})`, blockedPartyParams(exclude))
      .orderBy('intent.collectableAt', 'ASC')
      .addOrderBy('intent.id', 'ASC')
      .limit(limit)
      .getMany();
  }

  /**
   * Records why a held payment is about to be refunded for its provider
   * (`ProviderBlocked` | `PayeeBlocked` | `PayeeBlockedOnChain`), BEFORE the
   * refund is sent: if the block is lifted before the refund is booked, the
   * booking still knows its cause. Never over a closed outcome.
   */
  async recordHeldRefundCause(organizationId: string, id: string, cause: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents" SET "redemption_last_error" = $3
        WHERE "organization_id" = $1 AND "id" = $2 AND "held_status" = 'HELD'
          AND ("redemption_last_error" IS NULL OR NOT ${CLOSED_OUTCOME_SQL('payment_intents')})`,
      [organizationId, id, cause],
    );
  }

  /**
   * A blocked provider's refund landed while a buyer's dispute on the call is
   * still undecided (or decided, its refund pending): the dispute's money side
   * is written as refunded — the full amount restored, as an upheld refund
   * would — inside the caller's transaction. The decision itself stays the
   * operator's (the dispute stays `OPEN` in the queue); deciding later keeps
   * `REFUNDED` (`planRefund`). `sla_due_at` is cleared: the SLA neither pages
   * about nor auto-upholds a call already refunded. Returns the disputes
   * written.
   */
  async markDisputeRefunded(
    runner: Pick<QueryRunner, 'query'>,
    organizationId: string,
    intentId: string,
  ): Promise<string[]> {
    const result = (await runner.query(
      `UPDATE "disputes" d
          SET "refund_source" = 'UNCOLLECTED_EARNINGS', "refund_state" = 'REFUNDED',
              "refund_amount" = CASE WHEN d."asset_id" IS NULL THEN NULL
                                     ELSE COALESCE(i."settled_amount", i."price_amount") END,
              "restored_amount" = CASE WHEN d."asset_id" IS NULL THEN NULL
                                       ELSE COALESCE(i."settled_amount", i."price_amount") END,
              "sla_due_at" = NULL, "updated_at" = now()
         FROM "payment_intents" i
        WHERE i."organization_id" = $1 AND i."id" = $2
          AND d."organization_id" = $1 AND d."intent_id" = $2
          AND (d."state" IN ('OPEN', 'UNDER_REVIEW')
               OR (d."state" = 'UPHELD' AND d."refund_state" = 'PENDING'))
        RETURNING d."id"`,
      [organizationId, intentId],
    )) as unknown;
    const rows =
      Array.isArray(result) && result.length === 2 && Array.isArray(result[0])
        ? (result[0] as { id: string }[])
        : (result as { id: string }[]);
    return rows.map((row) => row.id);
  }

  /** The assets with a payment still held on chain: whose chains' blocklists matter. */
  async findHeldAssetIds(rail: string): Promise<string[]> {
    const rows = (await this.manager.query(
      `SELECT DISTINCT "asset_id" AS "assetId" FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL AND "rail" = $1 AND "held_status" = 'HELD'`,
      [rail],
    )) as { assetId: string }[];
    return rows.map((row) => row.assetId);
  }

  /**
   * Per asset: how many held payments of `rail` the batched collect would take
   * ({@link findCollectable}'s filters with `beforeSeconds`), and since when the
   * oldest has been collectable — one aggregate row per asset, for the
   * collection job's gathering check (`settlement-gathering.constants.ts`).
   * Without the blocked-party exclusions: it may count a row the pass then
   * leaves out, which only makes a pass run sooner — never later.
   */
  async summarizeCollectable(
    rail: string,
    beforeSeconds: number,
  ): Promise<Map<string, { count: number; oldestCollectableAt: Date | null }>> {
    const rows = (await this.manager.query(
      `SELECT "asset_id" AS "assetId", COUNT(*)::int AS "count",
              MIN("collectable_at") AS "oldestCollectableAt"
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL
          AND "rail" = $1
          AND "held_status" = 'HELD'
          AND "collectable_at" <= now()
          AND "collectable_at" > now() - make_interval(secs => $2)
          AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'REJECTED')
          AND "hold_id" IS NOT NULL
          AND "hold_released_at" IS NULL
          AND ("held_retry_at" IS NULL OR "held_retry_at" <= now())
        GROUP BY "asset_id"`,
      [rail, beforeSeconds],
    )) as { assetId: string; count: number | string; oldestCollectableAt: Date | string | null }[];
    return new Map(
      rows.map((row) => [
        row.assetId,
        {
          count: Number(row.count),
          oldestCollectableAt:
            row.oldestCollectableAt === null ? null : new Date(row.oldestCollectableAt),
        },
      ]),
    );
  }

  /**
   * A collect or refund of this held payment failed: back off — 1, 2, 4 …
   * minutes, at most an hour — so a stuck row neither blocks the pass nor
   * burns gas every minute (review P1-3).
   */
  async recordHeldFailure(organizationId: string, id: string, error: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents"
          SET "held_attempts" = "held_attempts" + 1,
              "held_retry_at" = now() + LEAST(interval '60 minutes',
                                              interval '1 minute' * power(2, LEAST("held_attempts", 6))),
              "held_last_error" = $3
        WHERE "organization_id" = $1 AND "id" = $2`,
      [organizationId, id, error.slice(0, 500)],
    );
  }

  /**
   * Books a collected hold's outcome on the row, INSIDE the caller's
   * transaction and under the payer's lock: `held_status = 'COLLECTED'` and the
   * transaction. The ledger commit beside it is the caller's.
   */
  async markHeldCollected(
    runner: Pick<QueryRunner, 'query'>,
    target: { organizationId: string; id: string; payer: string },
    txRef: string | null,
  ): Promise<boolean> {
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `voucher-admission:${target.payer}`,
    ]);
    const result = (await runner.query(
      `UPDATE "payment_intents"
          SET "held_status" = 'COLLECTED', "held_tx_ref" = COALESCE($3, "held_tx_ref"),
              "hold_released_at" = COALESCE("hold_released_at", now())
        WHERE "organization_id" = $1 AND "id" = $2 AND "held_status" = 'HELD'
        RETURNING "id"`,
      [target.organizationId, target.id, txRef],
    )) as [unknown[], number] | unknown[];
    return affected(result) > 0;
  }

  /**
   * Sets the call's dispute mark, inside the caller's transaction: the decision
   * (`UPHELD` | `REJECTED`), or `null` when a held dispute is withdrawn. A
   * `REJECTED` or cleared row is back in the redemption queue.
   */
  async setDisputeOutcome(
    runner: Pick<QueryRunner, 'query'>,
    organizationId: string,
    id: string,
    outcome: 'UPHELD' | 'REJECTED' | null,
    onlyIfOpen = false,
  ): Promise<void> {
    await runner.query(
      `UPDATE "payment_intents" SET "dispute_outcome" = $3
        WHERE "organization_id" = $1 AND "id" = $2
          ${onlyIfOpen ? `AND "dispute_outcome" = 'OPEN'` : ''}`,
      [organizationId, id, outcome],
    );
  }

  /**
   * Books a refunded hold (G3.B1), INSIDE the ledger transaction that releases
   * the buyer's hold, under the payer's admission lock: `<reason>` closes the
   * row for good, `held_status = 'REFUNDED'`, `hold_released_at` stamped with
   * the release. Only a row an upheld dispute holds — unless `requireUpheld`
   * is `false` (a blocked provider's refund, whatever the dispute state).
   * `false` when nothing matched — already booked, or collected.
   */
  async markHeldRefunded(
    runner: QueryRunner,
    target: DebtCloseTarget,
    reason: string,
    txRef: string | null,
    requireUpheld = true,
  ): Promise<boolean> {
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `voucher-admission:${target.payer}`,
    ]);
    const result = (await runner.query(
      `UPDATE "payment_intents"
          SET "redemption_last_error" = $5, "hold_released_at" = now(),
              "held_status" = 'REFUNDED', "held_tx_ref" = COALESCE($6, "held_tx_ref")
        WHERE "organization_id" = $1 AND "id" = $2 AND "agent_account" = $3 AND "hold_id" = $4
          AND "status" = 'SETTLED' AND "held_status" = 'HELD'
          AND ("dispute_outcome" = 'UPHELD' OR NOT $7) AND "hold_released_at" IS NULL
        RETURNING "id"`,
      [target.organizationId, target.id, target.payer, target.holdId, reason, txRef, requireUpheld],
    )) as [unknown[], number] | unknown[];
    return affected(result) > 0;
  }

  /**
   * Rail-B rows closed for good — forfeited, written off or voided — whose
   * hold release never landed (a crash between the mark and the release):
   * the expiry sweep releases them. The redemption queue already leaves them
   * out (review-buyer-debt L2).
   */
  async findClosedWithOpenHold(limit: number): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.rail = :rail', { rail: 'RAIL_B_VOUCHER' })
      .andWhere('intent.status = :settled', { settled: SETTLED_STATUS })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere(CLOSED_OUTCOME_SQL('intent'))
      .limit(limit)
      .getRawMany<DuePaymentIntent>();
  }

  /**
   * Swaps a debt's lapsed voucher for the buyer's REPLACEMENT and puts the row
   * back in the redemption queue — under the payer's admission lock, with the
   * SAME admission checks as a new voucher (review-buyer-debt M4): `admit`
   * sees the payer's windows (escrow and delegate, this debt's own row left
   * out), any admission pause, `next_seq` and the highest live seq, exactly as
   * {@link insertAdmittedVoucherIntent} reads them.
   *
   * The row stays DEBT until the replacement is collected:
   * `redemption_lapsed_at` is kept (the write-off clock never restarts) and
   * `redemption_replaced_at` is set, so the payer's paid calls stay refused
   * ({@link DEBT_REFUSING_SQL}) until `commitRedeemedHold` commits the hold.
   *
   * A WRITTEN-OFF debt is re-signed too (H1 interim): its hold was released,
   * so the caller opens a new one first and passes it as `reopenHoldId`; the
   * row takes it and loses its `uncollected:` mark, and the provider is paid
   * normally once the replacement lands.
   *
   * `false` when the row is no longer a debt of this payer that can be
   * replaced (settled, being replaced already, voided). Writing the new seq
   * passes `trg_payment_intents_voucher_seq_immutable` only while the old
   * voucher is past its on-chain deadline (migration 1760900000000): the
   * caller checks that first, and the trigger's `check_violation` is the
   * backstop. The old voucher's
   * transaction references are cleared: none of them carries the new voucher,
   * and a debt lapses only once its own transactions are known not to have
   * landed.
   */
  async replaceLapsedVoucher(
    organizationId: string,
    id: string,
    payer: string,
    replacement: LapsedVoucherReplacement,
    admission: { scope: VoucherAdmissionScope; admit: (open: OpenVoucherTotals) => void },
    reopenHoldId: string | null = null,
  ): Promise<boolean> {
    return this.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `voucher-admission:${payer}`,
      ]);
      admission.admit(await readVoucherAdmission(manager, admission.scope, id));
      const result = (await manager.query(
        `UPDATE "payment_intents"
            SET "voucher_seq" = $4, "voucher_signature" = $5, "voucher_issued_at" = $6,
                "voucher_delegate" = $7, "expires_at" = $8, "voucher_resource_hash" = $9,
                "voucher_resource" = $10,
                "redemption_tx_refs" = '{}', "redemption_last_error" = NULL,
                "redemption_replaced_at" = now(),
                "hold_id" = COALESCE($11::uuid, "hold_id"),
                "hold_released_at" = CASE WHEN $11::uuid IS NULL THEN "hold_released_at" ELSE NULL END
          WHERE "organization_id" = $1 AND "id" = $2 AND "agent_account" = $3
            AND "status" = 'SETTLED' AND "rail" = 'RAIL_B_VOUCHER'
            AND "redemption_lapsed_at" IS NOT NULL AND "redemption_replaced_at" IS NULL
            AND (($11::uuid IS NULL AND "hold_released_at" IS NULL
                  AND ("redemption_last_error" IS NULL
                       OR NOT ${CLOSED_OUTCOME_SQL('"payment_intents"')}))
              OR ($11::uuid IS NOT NULL AND "hold_released_at" IS NOT NULL
                  AND "redemption_last_error" LIKE 'uncollected:%'))
          RETURNING "id"`,
        [
          organizationId,
          id,
          payer,
          replacement.seq,
          replacement.signature,
          replacement.issuedAt,
          replacement.delegate,
          replacement.expiresAt,
          replacement.resourceHash,
          replacement.resource,
          reopenHoldId,
        ],
      )) as [unknown[], number] | unknown[];
      return affected(result) > 0;
    });
  }

  /**
   * Inserts a rail-B voucher's intent **only if it is admitted**, atomically
   * with the read that admits it (BUG-D1-02).
   *
   * The escrow's window and a delegate's window are counters the CHAIN keeps,
   * and they only learn about a voucher when it is redeemed — minutes after the
   * call was served. So admitting a voucher means adding, to the chain's
   * decayed counter, every voucher this platform has accepted and the chain has
   * not counted yet. Read and insert as two statements, five concurrent calls
   * all read the same total and all fit; four of them were then refused at
   * redemption.
   *
   * Here the two happen under `pg_advisory_xact_lock` keyed on the PAYER, in
   * one transaction: the next admission for the same payer waits until this
   * intent is committed, and its read then counts it. The lock is per payer,
   * not per (payer, delegate), because the escrow's own window is the payer's
   * and every delegate spends from it too. It is transaction scoped, so a
   * refusal (`admit` throwing) or a constraint violation rolls back and
   * releases it with nothing written. Nothing but these two statements runs
   * under it — no RPC, no other connection — so it is held for milliseconds
   * and cannot wait on the pool it is holding a connection from.
   *
   * What {@link OpenVoucherTotals} counts, per rail-B intent of the payer in
   * the asset (across organizations: the window is the payer account's, and
   * two tenants' agents can spend from one account):
   *
   * - **in flight**: `CREATED` and not yet expired — inserted by an admission
   *   that is still securing its funds. This row IS the reservation; without
   *   it, the gap between this insert and the hold is the same race again.
   *   `VoucherService` expires a `CREATED` row whose funds could not be
   *   secured, so a refused call does not keep its place.
   * - **served, not on chain**: an open hold, or `SETTLED` with the hold the
   *   redemption job has not closed.
   * - **on chain after the chain was read**: `SETTLED` with the hold closed at
   *   or after `since`. The counter the caller read cannot contain a
   *   redemption that landed after the read, and the hold is closed only after
   *   the redemption confirms — so a voucher redeemed in between is counted
   *   here, not lost between the two numbers. (Before `since` it is in the
   *   chain's counter; counting it twice in that overlap is the safe side.)
   *
   * `idx_payment_intents_voucher_admission` covers the read.
   */
  async insertAdmittedVoucherIntent(
    row: QueryDeepPartialEntity<PaymentIntentEntity>,
    scope: VoucherAdmissionScope,
    admit: (open: OpenVoucherTotals) => void,
  ): Promise<void> {
    if (!row.organizationId) {
      throw new Error(
        'PaymentIntentRepository.insertAdmittedVoucherIntent: organizationId is required',
      );
    }
    await this.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `voucher-admission:${scope.payer}`,
      ]);
      admit(await readVoucherAdmission(manager, scope, null));
      await manager.insert(PaymentIntentEntity, row);
    });
  }

  /**
   * The payer's vouchers the chain has not redeemed yet, and those it redeemed
   * at or after `scope.since` (BUG-D1-07). Read without the admission lock: a
   * figure to show and to warn on. The check that must not race an admission
   * is {@link holdVoucherAdmission}.
   */
  async unsettledVouchers(scope: UnsettledVoucherScope): Promise<UnsettledVoucherTotals> {
    return readUnsettledVouchers(this.manager, scope);
  }

  /**
   * Takes ONE pause on the payer's rail-B admission (or one delegate's) and
   * reads what is still unsettled, in one transaction under the payer's
   * admission lock (BUG-D1-07). Returns the pause's id, which only its own
   * relay ends ({@link landVoucherAdmissionPause},
   * {@link releaseVoucherAdmissionPause}).
   *
   * A voucher admission either committed before this (and is in the totals
   * returned) or runs after it (and sees the pause and is refused): there is no
   * third case, because both take `voucher-admission:<payer>`. So a caller that
   * checks the totals, then relays a change that tightens the caps, cannot
   * strand a voucher admitted in between under the old caps. Two tightenings of
   * one payer hold two rows: neither can end the other's.
   *
   * Every instant is the database's clock, the same one the admission compares
   * it with.
   */
  async holdVoucherAdmission(
    hold: VoucherAdmissionHold,
    scopes: readonly UnsettledVoucherScope[],
  ): Promise<{ pauseId: string; totals: UnsettledVoucherTotals[] }> {
    return this.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `voucher-admission:${hold.payer}`,
      ]);
      // Old rows are inert; tidy them up while the lock is held anyway.
      await manager.query(
        `DELETE FROM "voucher_admission_pauses"
          WHERE "payer_account" = $1 AND "paused_until" < now() - interval '1 hour'`,
        [hold.payer],
      );
      const [row] = (await manager.query(
        `INSERT INTO "voucher_admission_pauses" ("payer_account", "delegate", "paused_until")
         VALUES ($1, $2, GREATEST(now() + make_interval(secs => $3::double precision),
                                  COALESCE(to_timestamp($4::double precision), '-infinity'::timestamptz)))
         RETURNING "id"`,
        [hold.payer, hold.delegate, hold.holdSeconds, hold.notBeforeEpochSeconds ?? null],
      )) as Array<{ id: string }>;
      const totals: UnsettledVoucherTotals[] = [];
      for (const scope of scopes) totals.push(await readUnsettledVouchers(manager, scope));
      return { pauseId: row.id, totals };
    });
  }

  /**
   * The pause's relay landed: it ends `settleSeconds` from now, and any
   * admission whose chain read predates the landing (by the admission's own
   * lag margin) stays refused — see {@link insertAdmittedVoucherIntent}.
   */
  async landVoucherAdmissionPause(pauseId: string, settleSeconds: number): Promise<void> {
    await this.manager.query(
      `UPDATE "voucher_admission_pauses"
          SET "landed_at" = now(), "paused_until" = now() + make_interval(secs => $2::double precision)
        WHERE "id" = $1`,
      [pauseId, settleSeconds],
    );
  }

  /** The pause's relay was refused by name: nothing landed, so its pause goes now. */
  async releaseVoucherAdmissionPause(pauseId: string): Promise<void> {
    await this.manager.query(`DELETE FROM "voucher_admission_pauses" WHERE "id" = $1`, [pauseId]);
  }

  /**
   * Throws unless the buyer-debt columns exist (migrations `1760600000000`,
   * `1760700000000` and `1760800000000`). Every paid call reads them
   * (`findOutstandingDebts`) and the redemption job writes them, so a process
   * started before the migrations would answer every paid call with a 500 —
   * this refuses the boot instead (review-buyer-debt H2). A database with no
   * `payment_intents` at all is left alone, as for the pause table below.
   */
  async assertBuyerDebtSchema(): Promise<void> {
    const required = [
      'redemption_last_error',
      'redemption_lapsed_at',
      'redemption_replaced_at',
      'voucher_resource',
    ];
    const [row] = (await this.manager.query(
      `SELECT to_regclass('payment_intents') IS NOT NULL AS "intents",
              (SELECT COUNT(*)::int FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'payment_intents'
                  AND column_name = ANY($1::text[])) AS "columns"`,
      [required],
    )) as Array<{ intents: boolean; columns: number }>;
    if (row?.intents && Number(row.columns) !== required.length) {
      throw new Error(
        'payment_intents is missing the buyer-debt columns: run the migrations ' +
          '(PaymentIntentRedemptionLastError1760600000000, PaymentIntentRedemptionLapsed1760700000000, ' +
          'PaymentIntentDebtReplacing1760800000000) before starting any process ' +
          '(docs/runbooks/buyer-debt-deploy.md)',
      );
    }
  }

  /**
   * Throws unless `voucher_admission_pauses` has its per-request shape
   * (migration `VoucherAdmissionPausePerRequest1759600000006`). Every locked
   * voucher admission reads it, so an API started before the migration would
   * refuse every rail-B payment with a SQL error; this says so at boot instead.
   * A database with no `payment_intents` at all (nothing migrated, nothing to
   * admit against) is not this case and is left alone.
   */
  async assertAdmissionPauseSchema(): Promise<void> {
    const [row] = (await this.manager.query(
      `SELECT to_regclass('payment_intents') IS NOT NULL AS "intents",
              (SELECT COUNT(*)::int FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'voucher_admission_pauses'
                  AND column_name IN ('id', 'delegate', 'landed_at')) AS "columns"`,
    )) as Array<{ intents: boolean; columns: number }>;
    if (row?.intents && Number(row.columns) !== 3) {
      throw new Error(
        'voucher_admission_pauses is missing or has its old shape: run the migrations ' +
          '(VoucherAdmissionPausePerRequest1759600000006) before starting the API',
      );
    }
  }

  /**
   * Takes a `CREATED` rail-B intent out of {@link insertAdmittedVoucherIntent}'s
   * in-flight count when its funds could not be secured: its deadline moves to
   * now, so the expiry sweep closes it on its next pass exactly as it would
   * have at the voucher's own deadline. A row that has moved on, or has a hold,
   * is left alone.
   */
  async abandonUnsecuredVoucherIntent(organizationId: string, id: string): Promise<void> {
    await this.update(
      { organizationId, id, status: 'CREATED', holdId: IsNull() },
      { expiresAt: () => 'now()' },
    );
  }

  private selectSweepCandidates(): SelectQueryBuilder<PaymentIntentEntity> {
    return this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.id', 'id')
      .addSelect('intent.status', 'status')
      .addSelect('intent.holdId', 'holdId');
  }

  /**
   * The intent side of `withheld`: `Σ` held amount over
   * {@link WITHHELD_STATUSES} plus the `SETTLED` rows never collected and not
   * owed ({@link NOT_CHARGED_SETTLED_SQL}, the `NOT_COLLECTED` bucket), so the
   * total is the receipts summary's `notCharged`. Restricted to intents that
   * actually reserved something (`hold_id IS NOT NULL` — see `domain/withheld.ts` for why an
   * intent that expired in `CREATED` must not appear here), grouped by asset
   * and by status so a caller can fold the rows into `WithheldBucket`s without
   * loading one row per intent.
   *
   * The hold's amount, not `price_amount`: a rail-A intent is held at the quote
   * and re-priced to the binding that served, and what a refund or a void
   * gives back is the whole hold. For a tool with one price the two are equal.
   */
  async sumWithheldByAssetAndStatus(
    organizationId: string,
    period: PaymentIntentPeriod = {},
  ): Promise<WithheldStatusAssetTotal[]> {
    const qb = this.createQueryBuilder('intent')
      .select('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('intent.status', 'status')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(COALESCE(hold.amount, intent.price_amount)), 0)', 'amount')
      .leftJoin(
        'ledger_holds',
        'hold',
        'hold.id = intent.hold_id AND hold.organization_id = intent.organization_id',
      )
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere(`(intent.status IN (:...statuses) OR ${NOT_CHARGED_SETTLED_SQL})`, {
        statuses: WITHHELD_STATUSES,
      })
      .andWhere('intent.holdId IS NOT NULL');

    this.applyPeriod(qb, period);

    const rows = await qb
      .groupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .addGroupBy('intent.status')
      .getRawMany<{
        asset: string;
        decimals: string;
        status: string;
        calls: string;
        amount: string;
      }>();

    return rows.map((row) => ({
      asset: row.asset,
      decimals: Number(row.decimals),
      status: row.status,
      notCollected: row.status === SETTLED_STATUS,
      calls: Number(row.calls),
      amount: BigInt(row.amount),
    }));
  }

  /**
   * `Σ price_amount` for one agent, in one asset, split at the UTC hour, day
   * and month boundary in a single pass (the spend-policy `max_spend_per_hour`
   * and daily/monthly cap checks).
   *
   * One query rather than three: `monthStart <= dayStart <= hourStart`, so
   * filtering the `WHERE` to `created_at >= :monthStart` already selects
   * every row any total needs, and the `SUM(CASE …)` projections split that
   * one scan into "this hour", "today" and "this month" without reading the
   * table twice. See {@link SPEND_COUNTING_STATUSES} for which statuses count as
   * spend and why.
   *
   * Scoped to one `assetId` on purpose: a `spend_policies` row denominates
   * every limit in exactly one asset (`spend_policies.asset_id`), so an
   * intent priced in a different asset is not part of what this cap governs —
   * see `SpendPolicyEnforcementService`'s own doc comment for what happens
   * when a call's price is not in the policy's asset.
   */
  async sumSpendByAgent(
    organizationId: string,
    agentId: string,
    assetId: string,
    hourStart: Date,
    dayStart: Date,
    monthStart: Date,
  ): Promise<AgentSpendTotals> {
    const row = await this.createQueryBuilder('intent')
      .select(
        'COALESCE(SUM(CASE WHEN intent.createdAt >= :hourStart THEN intent.priceAmount ELSE 0 END), 0)',
        'thisHour',
      )
      .addSelect(
        'COALESCE(SUM(CASE WHEN intent.createdAt >= :dayStart THEN intent.priceAmount ELSE 0 END), 0)',
        'today',
      )
      .addSelect(
        'COALESCE(SUM(intent.priceAmount), 0)',
        // Every row this query reads already satisfies `created_at >=
        // :monthStart` (the WHERE below), so a plain SUM over all of them is
        // "this month" — no second CASE needed.
        'thisMonth',
      )
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere('intent.agentId = :agentId', { agentId })
      .andWhere('intent.assetId = :assetId', { assetId })
      .andWhere('intent.status IN (:...statuses)', { statuses: SPEND_COUNTING_STATUSES })
      // A settled call the buyer was never charged for — the provider
      // forfeited it, or its debt was written off or voided — spent nothing, so it does
      // not count against the caps (review #2, M4). An OUTSTANDING debt does:
      // the buyer still owes it. Legacy absorbs are left to their few rows.
      .andWhere(
        `NOT (intent.status = '${SETTLED_STATUS}' AND (COALESCE(${FORFEITED_SQL}, false) ` +
          `OR COALESCE(${WRITTEN_OFF_SQL}, false) OR (COALESCE(${VOIDED_SQL}, false) ` +
          // A dispute refund does not give the caps back (G3.B1, I5).
          `AND intent.redemption_last_error <> '${DISPUTE_REFUND_MARK}')))`,
      )
      .andWhere('intent.createdAt >= :monthStart', { monthStart })
      .setParameters({ hourStart, dayStart })
      .getRawOne<{ thisHour: string; today: string; thisMonth: string }>();

    return {
      thisHour: BigInt(row?.thisHour ?? '0'),
      today: BigInt(row?.today ?? '0'),
      thisMonth: BigInt(row?.thisMonth ?? '0'),
    };
  }

  /**
   * Rows for `GET /receipts/summary`: `calls`, `listedTotal`, `chargedTotal`,
   * `withheldTotal` and `refundedCalls`, grouped by `groupBy` and by asset —
   * never mixed across assets, since a `Money` sum across two assets is not a
   * number, it is an error (`MoneyUtil.sum`).
   *
   * Server-side on purpose: a browser cannot fetch 15,000 rows to sum them, and
   * neither should this process — the aggregation is the whole point of the
   * query.
   *
   * `byUtcDay` also splits every group by the UTC day of `created_at` (the
   * `day` bucket's own expression), so a window of N days answers N per-day
   * summaries in one query. Rows keep the ORDER BY of a single-day call, so the
   * rows of one day, filtered out in order, are exactly that day's answer.
   */
  async summarizeReceipts(
    organizationId: string,
    groupBy: ReceiptsSummaryGroupBy,
    window: Required<PaymentIntentPeriod>,
    assetId?: string,
    options: { readonly byUtcDay?: boolean } = {},
  ): Promise<ReceiptsSummaryRow[]> {
    const groupExpression = this.summaryGroupExpression(groupBy);

    const qb = this.createQueryBuilder('intent')
      .select(groupExpression, 'key')
      .addSelect('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(intent.priceAmount), 0)', 'listedTotal')
      .addSelect(
        // A forfeited voucher, a written-off or voided debt and a legacy absorb
        // were never collected: the buyer was not charged (review #2, M4). An
        // open or written-off debt is owed, not charged (R17b-B-01, final M2).
        `COALESCE(SUM(CASE WHEN ${SUMMARY_CHARGED_SQL} THEN intent.priceAmount ELSE 0 END), 0)`,
        'chargedTotal',
      )
      .addSelect(`COUNT(*) FILTER (WHERE ${SUMMARY_CHARGED_SQL})`, 'chargedCalls')
      .addSelect(
        `COALESCE(SUM(CASE WHEN ${SUMMARY_OWED_SQL} THEN intent.priceAmount ELSE 0 END), 0)`,
        'owedTotal',
      )
      .addSelect(`COUNT(*) FILTER (WHERE ${SUMMARY_OWED_SQL})`, 'owedCalls')
      .addSelect(
        `COALESCE(SUM(CASE WHEN ${SUMMARY_IN_PROGRESS_SQL} THEN intent.priceAmount ELSE 0 END), 0)`,
        'inProgressTotal',
      )
      .addSelect(`COUNT(*) FILTER (WHERE ${SUMMARY_IN_PROGRESS_SQL})`, 'inProgressCalls')
      .addSelect(
        'COALESCE(SUM(CASE WHEN intent.status IN (:...withheldStatuses) AND intent.holdId IS NOT NULL ' +
          'THEN intent.priceAmount ELSE 0 END), 0)',
        'withheldTotal',
      )
      .addSelect('COUNT(*) FILTER (WHERE intent.status = :refundedStatus)', 'refundedCalls')
      .addSelect('COUNT(*) FILTER (WHERE intent.price_amount = 0)', 'freeCalls')
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere(`NOT ${SUMMARY_NEVER_RESERVED_SQL}`)
      .andWhere(`${CREATED_AT} >= :from`, { from: window.from })
      .andWhere(`${CREATED_AT} < :to`, { to: window.to })
      .setParameters({
        refundedStatus: REFUNDED_STATUS,
        withheldStatuses: WITHHELD_STATUSES,
      });

    if (assetId) {
      qb.andWhere('intent.assetId = :assetId', { assetId });
    }

    qb.groupBy(groupExpression).addGroupBy('intent.assetId').addGroupBy('intent.decimals');

    if (options.byUtcDay) {
      const dayExpression = this.summaryGroupExpression(ReceiptsSummaryGroupBy.DAY);
      qb.addSelect(dayExpression, 'day').addGroupBy(dayExpression);
    }

    const rows = await qb
      // Without an ORDER BY, Postgres returns groups in hash order, so a daily
      // series came back shuffled. Every key is a string (an ISO date for
      // `day`), so ascending is chronological for `day` and stable for the rest.
      .orderBy(groupExpression, 'ASC')
      .addOrderBy('intent.assetId', 'ASC')
      .getRawMany<{
        key: string;
        asset: string;
        decimals: string;
        calls: string;
        listedTotal: string;
        chargedTotal: string;
        withheldTotal: string;
        refundedCalls: string;
        chargedCalls: string;
        owedTotal: string;
        owedCalls: string;
        inProgressTotal: string;
        inProgressCalls: string;
        freeCalls: string;
        day?: string;
      }>();

    return rows.map((row) => {
      const listedTotal = BigInt(row.listedTotal);
      const chargedTotal = BigInt(row.chargedTotal);
      const owedTotal = BigInt(row.owedTotal);
      const inProgressTotal = BigInt(row.inProgressTotal);
      const calls = Number(row.calls);
      const owedCalls = Number(row.owedCalls);
      const inProgressCalls = Number(row.inProgressCalls);
      return {
        key: row.key,
        asset: row.asset,
        decimals: Number(row.decimals),
        calls,
        listedTotal,
        chargedTotal,
        withheldTotal: BigInt(row.withheldTotal),
        refundedCalls: Number(row.refundedCalls),
        notChargedTotal: listedTotal - chargedTotal - owedTotal - inProgressTotal,
        notChargedCalls: calls - Number(row.chargedCalls) - owedCalls - inProgressCalls,
        owedTotal,
        owedCalls,
        inProgressTotal,
        inProgressCalls,
        freeCalls: Number(row.freeCalls ?? 0),
        ...(options.byUtcDay ? { day: row.day } : {}),
      };
    });
  }

  private applyPeriod(
    qb: SelectQueryBuilder<PaymentIntentEntity>,
    period: PaymentIntentPeriod,
  ): void {
    if (period.from) {
      qb.andWhere(`${CREATED_AT} >= :from`, { from: period.from });
    }
    if (period.to) {
      qb.andWhere(`${CREATED_AT} < :to`, { to: period.to });
    }
  }

  /**
   * The `SELECT`/`GROUP BY` expression for each grouping dimension.
   *
   * `provider` and `verdict` are nullable columns — `COALESCE`d to a stable
   * label rather than left `NULL`, since a `NULL` group key reads as "unknown
   * dimension" in a response body where every other key is a string.
   */
  private summaryGroupExpression(groupBy: ReceiptsSummaryGroupBy): string {
    switch (groupBy) {
      case ReceiptsSummaryGroupBy.TOOL:
        return 'intent.toolId';
      case ReceiptsSummaryGroupBy.PROVIDER:
        // The column, not the property: TypeORM only rewrites `alias.property` when
        // a delimiter follows, and `::text` is not one, so `intent.providerId`
        // reached Postgres verbatim ("column intent.providerid does not exist").
        return "COALESCE(intent.provider_id::text, 'unassigned')";
      case ReceiptsSummaryGroupBy.DAY:
        return `to_char(${CREATED_AT_UTC_DAY}, 'YYYY-MM-DD')`;
      case ReceiptsSummaryGroupBy.STATUS:
        return 'intent.status';
      case ReceiptsSummaryGroupBy.VERDICT:
        return "COALESCE(intent.verificationVerdict, 'UNVERIFIED')";
      case ReceiptsSummaryGroupBy.AGENT:
        return 'intent.agentId';
      case ReceiptsSummaryGroupBy.CREDENTIAL:
        // Columns, not properties, for the reason `PROVIDER` gives.
        return "COALESCE(intent.credential_id::text, 'agent:' || intent.agent_id::text)";
    }
  }

  // ── Per-call export ─────────────────────────────────────────────────────

  /**
   * How many calls the export's window matches, for `ProviderCallsExportService`
   * to decide up front whether the row cap will bind — see that service for why
   * the decision has to be made *before* the first byte of the CSV is written
   * (`docs/api-list-contract.md`'s no-silent-caps principle: a truncation the
   * client cannot see is not a cap, it is data loss).
   *
   * Scoped exactly like `ProviderEarningsService` — by `provider_id`, not
   * `organization_id` — for the same reason: a provider's calls are served to
   * every buying organization, not its own.
   */
  async countCallsForExport(
    providerId: string,
    period: Required<PaymentIntentPeriod>,
    assetId?: string,
  ): Promise<number> {
    const qb = this.exportQueryBuilder(providerId, period, assetId);
    return qb.getCount();
  }

  /**
   * One page of the export, ordered `(created_at, id)` ascending — the same
   * tiebreak `docs/api-list-contract.md` rule 2 requires of any keyset scan,
   * applied by hand here because a CSV stream is not a `CursorPageDto` and
   * does not go through `paginate()` (see `ProviderCallsExportService`'s own
   * doc comment for why the two are deliberately different shapes).
   *
   * `after` is `null` for the first page. Passing the *last row already
   * emitted* rather than an opaque token is deliberate: the caller is a
   * server-side stream with no client round-trip between pages, so there is
   * nothing to encode a token for and against.
   */
  async findCallsPageForExport(
    providerId: string,
    period: Required<PaymentIntentPeriod>,
    assetId: string | undefined,
    after: CallExportCursor | null,
    limit: number,
  ): Promise<CallExportRow[]> {
    const qb = this.exportQueryBuilder(providerId, period, assetId)
      .select('intent.id', 'id')
      .addSelect('intent.callId', 'callId')
      .addSelect('intent.callClass', 'callClass')
      .addSelect('intent.status', 'status')
      .addSelect('intent.statusReason', 'statusReason')
      .addSelect('intent.classification', 'classification')
      .addSelect('intent.verificationVerdict', 'verificationVerdict')
      .addSelect('intent.toolId', 'toolId')
      .addSelect('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('intent.priceAmount', 'priceAmount')
      .addSelect('intent.providerAmount', 'providerAmount')
      .addSelect('intent.platformFee', 'platformFee')
      .addSelect(AWAITING_REDEMPTION_SQL, 'awaitingRedemption')
      .addSelect(CREDITED_SQL, 'credited')
      .addSelect('intent.redemptionLastError', 'redemptionLastError')
      .addSelect(DEBT_OUTSTANDING_SQL, 'debtOutstanding')
      .addSelect('intent.createdAt', 'createdAt')
      .addSelect(exactInstantSql('intent.created_at'), 'createdAtExact');

    // Row-value form, as `paginate()` builds it. The position must be the
    // exact microsecond value: a millisecond `Date` here sorts *before* the
    // row it came from, so every page re-read its predecessor's last row and
    // the `rowCount` budget ran out with the window's tail never emitted
    // (BUG-R17b-P-01: 48 pages, 48 duplicates, the last 48 calls missing).
    if (after) {
      qb.andWhere(
        '(intent.created_at, intent.id) > (:afterCreatedAt::timestamptz, :afterId::uuid)',
        { afterCreatedAt: after.createdAt, afterId: after.id },
      );
    }

    const rows = await qb
      .orderBy('intent.createdAt', 'ASC')
      .addOrderBy('intent.id', 'ASC')
      .limit(limit)
      .getRawMany<{
        id: string;
        callId: string;
        callClass: string;
        status: string;
        statusReason: string | null;
        classification: string | null;
        verificationVerdict: string | null;
        toolId: string;
        asset: string;
        decimals: string;
        priceAmount: string;
        providerAmount: string;
        platformFee: string;
        awaitingRedemption: boolean | string;
        credited: boolean | string;
        redemptionLastError: string | null;
        debtOutstanding: boolean | string;
        createdAt: Date;
        createdAtExact: string;
      }>();

    return rows.map((row) => ({
      ...row,
      decimals: Number(row.decimals),
      awaitingRedemption: row.awaitingRedemption === true || row.awaitingRedemption === 'true',
      credited: row.credited === true || row.credited === 'true',
      debtOutstanding: row.debtOutstanding === true || row.debtOutstanding === 'true',
    }));
  }

  /**
   * Candidate rows for the public Explorer's "not charged" feed: paid calls
   * created in `[from, to)` that ended without a charge, whose outcome (the
   * hold release) was recorded before `outcomeBefore`, made by an eligible
   * buyer ({@link ELIGIBLE_BUYER_SQL}), newest first, at most `limit`.
   *
   * **Deliberately cross-organization**, and there is no tenant to scope it to:
   * the route is served with no session, and the claim it backs — *you do not
   * pay for results you cannot use* — is a statement about the platform. What
   * keeps that safe is the projection and the service's k-anonymity rule: no
   * intent, call, organization, agent, account, hold, body or transaction
   * reference is selected; the buyer appears only as an md5 digest, used in
   * process to count distinct buyers and never published.
   *
   * "Not charged" is {@link WITHHELD_STATUSES} with a hold — the definition
   * `GET /withheld` uses — plus the `SETTLED` rows the buyer was not charged
   * for and does not owe ({@link NOT_CHARGED_SETTLED_SQL}), restricted to
   * `PAID` calls: together the receipts summary's `notCharged` bucket. An open
   * or written-off buyer debt is owed, never listed here.
   */
  async findNotChargedCandidates(
    window: NotChargedWindow,
    limit: number,
  ): Promise<NotChargedCallRow[]> {
    const rows = await this.createQueryBuilder('intent')
      .select('intent.toolId', 'toolId')
      .addSelect('intent.providerId', 'providerId')
      .addSelect('intent.status', 'status')
      .addSelect('intent.classification', 'classification')
      .addSelect('intent.verificationVerdict', 'verificationVerdict')
      .addSelect('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('intent.priceAmount', 'priceAmount')
      .addSelect('intent.createdAt', 'createdAt')
      .addSelect(NOT_CHARGED_SETTLED_CAUSE_SQL, 'settledCause')
      .addSelect('md5(intent.organization_id::text)', 'buyer')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.callClass = :paid', { paid: PAID_CALL_CLASS })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere(NOT_CHARGED_SQL, { withheldStatuses: WITHHELD_STATUSES })
      .andWhere(`${CREATED_AT} >= :from`, { from: window.from })
      .andWhere(`${CREATED_AT} < :to`, { to: window.to })
      .andWhere('intent.hold_released_at IS NOT NULL')
      .andWhere('intent.hold_released_at < :outcomeBefore', {
        outcomeBefore: window.outcomeBefore,
      })
      .andWhere(ELIGIBLE_BUYER_SQL, {
        buyerCreatedBefore: window.buyerCreatedBefore,
        buyerCollectedBefore: window.buyerCollectedBefore,
        settledStatus: SETTLED_STATUS,
      })
      .orderBy('intent.createdAt', 'DESC')
      .limit(limit)
      .getRawMany<{
        toolId: string;
        providerId: string | null;
        status: string;
        classification: string | null;
        verificationVerdict: string | null;
        asset: string;
        decimals: string | number;
        priceAmount: string;
        createdAt: Date;
        settledCause: NotChargedSettledCause | null;
        buyer: string;
      }>();

    return rows.map((row) => ({
      toolId: row.toolId,
      providerId: row.providerId,
      status: row.status,
      classification: row.classification,
      verificationVerdict: row.verificationVerdict,
      asset: row.asset,
      decimals: Number(row.decimals),
      priceAmount: BigInt(row.priceAmount),
      createdAt: new Date(row.createdAt),
      settledCause: row.settledCause ?? null,
      buyer: row.buyer,
    }));
  }

  /**
   * Per-asset totals behind the same feed over `[from, to)`, for ELIGIBLE
   * buyers only: paid calls whose outcome was final before `outcomeBefore`
   * ({@link FINAL_OUTCOME_SQL}), how many were not charged, how many of those
   * failed verification, the listed value not charged, and how many buyers
   * stand behind the asset (the input to the per-asset k rule).
   *
   * **Deliberately cross-organization**, for the reason given on
   * {@link findNotChargedCandidates}; the projection is counts and sums per
   * asset, naming nobody.
   */
  async summarizeNotCharged(window: NotChargedWindow): Promise<NotChargedTotalsRow[]> {
    const rows = await this.createQueryBuilder('intent')
      .select('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COUNT(DISTINCT intent.organization_id)', 'buyers')
      .addSelect(`COUNT(*) FILTER (WHERE ${NOT_CHARGED_SQL})`, 'notChargedCalls')
      // COALESCE: a legacy absorb has a NULL `redemption_last_error`, which makes
      // FAILED_CHECK_SQL NULL; it is not a failed check, here and in the split.
      .addSelect(`COUNT(*) FILTER (WHERE COALESCE(${FAILED_CHECK_SQL}, false))`, 'failedCheckCalls')
      .addSelect(
        `COALESCE(SUM(CASE WHEN ${NOT_CHARGED_SQL} THEN intent.priceAmount ELSE 0 END), 0)`,
        'notChargedAmount',
      )
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.callClass = :paid', { paid: PAID_CALL_CLASS })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere(FINAL_OUTCOME_SQL)
      .andWhere(`${CREATED_AT} >= :from`, { from: window.from })
      .andWhere(`${CREATED_AT} < :to`, { to: window.to })
      // Every figure is over eligible buyers only, the same population the k
      // rule counts (audit 2026-10-17 P3-1).
      .andWhere(ELIGIBLE_BUYER_SQL)
      .setParameters({
        withheldStatuses: WITHHELD_STATUSES,
        refundedStatus: REFUNDED_STATUS,
        settledStatus: SETTLED_STATUS,
        outcomeBefore: window.outcomeBefore,
        buyerCreatedBefore: window.buyerCreatedBefore,
        buyerCollectedBefore: window.buyerCollectedBefore,
      })
      .groupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .orderBy('intent.assetId', 'ASC')
      .getRawMany<{
        asset: string;
        decimals: string | number;
        calls: string;
        buyers: string;
        notChargedCalls: string;
        failedCheckCalls: string;
        notChargedAmount: string;
      }>();

    return rows.map((row) => ({
      asset: row.asset,
      decimals: Number(row.decimals),
      calls: Number(row.calls),
      buyers: Number(row.buyers),
      notChargedCalls: Number(row.notChargedCalls),
      failedCheckCalls: Number(row.failedCheckCalls),
      notChargedAmount: BigInt(row.notChargedAmount),
    }));
  }

  /**
   * The not-charged calls of {@link summarizeNotCharged} that did not fail the
   * check, per asset and reason ({@link NOT_CHARGED_OTHER_REASON_SQL}), each
   * with its distinct eligible buyers so the service can hold every published
   * reason to the k rule on its own. Same window, same eligible buyers, same
   * final-outcome cut as the totals, so the cells add up to
   * `notChargedCalls - failedCheckCalls` per asset.
   *
   * **Deliberately cross-organization**, for the reason given on
   * {@link findNotChargedCandidates}; the projection is counts per asset and
   * reason, naming nobody.
   */
  async summarizeNotChargedReasons(window: NotChargedWindow): Promise<NotChargedReasonTotalsRow[]> {
    const rows = await this.createQueryBuilder('intent')
      .select('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect(NOT_CHARGED_OTHER_REASON_SQL, 'reason')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COUNT(DISTINCT intent.organization_id)', 'buyers')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.callClass = :paid', { paid: PAID_CALL_CLASS })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere(FINAL_OUTCOME_SQL)
      .andWhere(NOT_CHARGED_SQL)
      .andWhere(`NOT COALESCE(${FAILED_CHECK_SQL}, false)`)
      .andWhere(`${CREATED_AT} >= :from`, { from: window.from })
      .andWhere(`${CREATED_AT} < :to`, { to: window.to })
      .andWhere(ELIGIBLE_BUYER_SQL)
      .setParameters({
        withheldStatuses: WITHHELD_STATUSES,
        refundedStatus: REFUNDED_STATUS,
        settledStatus: SETTLED_STATUS,
        outcomeBefore: window.outcomeBefore,
        buyerCreatedBefore: window.buyerCreatedBefore,
        buyerCollectedBefore: window.buyerCollectedBefore,
      })
      .groupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .addGroupBy('3')
      .orderBy('intent.assetId', 'ASC')
      .getRawMany<{
        asset: string;
        decimals: string | number;
        reason: NotChargedOtherReason;
        calls: string;
        buyers: string;
      }>();

    return rows.map((row) => ({
      asset: row.asset,
      decimals: Number(row.decimals),
      reason: row.reason,
      calls: Number(row.calls),
      buyers: Number(row.buyers),
    }));
  }

  /**
   * The shared predicate for both export methods above.
   *
   * **Deliberately cross-organization**, exactly like `ProviderEarningsService`
   * (see that class's doc comment for the full justification): a provider's
   * calls belong to the buyer organizations that made them, so scoping to the
   * caller's own `organizationId` would return nothing. `organizationId IS NOT
   * NULL` satisfies `OrganizationScopedRepository`'s query-builder guard
   * (which checks that a query *mentions* the column, not that it is bound to
   * the caller) while reading across every tenant on purpose — allowlisted by
   * name in `test/unit/shared/api/surface-consistency.spec.ts`.
   */
  private exportQueryBuilder(
    providerId: string,
    period: Required<PaymentIntentPeriod>,
    assetId?: string,
  ): SelectQueryBuilder<PaymentIntentEntity> {
    const qb = this.createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.providerId = :providerId', { providerId })
      .andWhere(`${CREATED_AT} >= :from`, { from: period.from })
      .andWhere(`${CREATED_AT} < :to`, { to: period.to });

    if (assetId) {
      qb.andWhere('intent.assetId = :assetId', { assetId });
    }

    return qb;
  }

  /**
   * What this organization's escrow account paid for calls in `[from, to)`,
   * by call time: rail-B calls charged as `GET /receipts/summary` counts
   * them (not owed, not collected-never). Atomic units. A statement line
   * (B7), read-only.
   */
  async sumEscrowPaid(
    organizationId: string,
    accountId: string,
    assetId: string,
    from: Date | null,
    to: Date,
  ): Promise<bigint> {
    const qb = this.createQueryBuilder('intent')
      .select(`COALESCE(SUM(intent.priceAmount), 0)`, 'total')
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere('lower(intent.agentAccount) = lower(:accountId)', { accountId })
      .andWhere('intent.assetId = :assetId', { assetId })
      .andWhere('intent.rail = :rail', { rail: 'RAIL_B_VOUCHER' })
      .andWhere(SUMMARY_CHARGED_SQL)
      .andWhere('intent.createdAt < :to', { to });
    if (from) qb.andWhere('intent.createdAt >= :from', { from });
    const row = await qb.getRawOne<{ total: string }>();
    return BigInt(row?.total ?? '0');
  }

  /**
   * Of {@link sumEscrowPaid}, what the chain has not taken from the escrow yet:
   * charged rail-B calls whose hold is still open ({@link AWAITING_REDEMPTION_SQL}:
   * the redemption has not landed) and that were not redeemed into the dispute
   * hold either. Atomic units. Read by the statement's check against the escrow
   * balance (B7).
   *
   * Not `redemption_tx_refs`: a ref is written before its broadcast (so it does
   * not prove the chain took anything), and calls redeemed before refs were
   * recorded have none. Counting those as unsettled made the statement say
   * money was "still being collected" that Funding's chain counters showed
   * collected (V1-5).
   */
  async sumEscrowChargedNotRedeemed(
    organizationId: string,
    accountId: string,
    assetId: string,
  ): Promise<bigint> {
    const row = await this.createQueryBuilder('intent')
      .select(`COALESCE(SUM(intent.priceAmount), 0)`, 'total')
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere('lower(intent.agentAccount) = lower(:accountId)', { accountId })
      .andWhere('intent.assetId = :assetId', { assetId })
      .andWhere('intent.rail = :rail', { rail: 'RAIL_B_VOUCHER' })
      .andWhere(SUMMARY_CHARGED_SQL)
      .andWhere(AWAITING_REDEMPTION_SQL)
      .andWhere('intent.heldStatus IS NULL')
      .getRawOne<{ total: string }>();
    return BigInt(row?.total ?? '0');
  }

  /**
   * Whether this payment key (`voucher_delegate`) signed a voucher that held
   * money before `intent` did: an earlier row, by `(created_at, id)`, with a
   * hold. `PaymentKeyFirstSpendService` asks it so that "first" is a fact of
   * the table and not only of the notification suppression cache, which fails
   * open. A row that never held money (refused for funds) is not a spend.
   *
   * Two concurrent first vouchers may both answer `false`; the notification's
   * own `ONCE` suppression then keeps it to one. Served by
   * `idx_payment_intents_delegate_created`.
   */
  async hasEarlierDelegateSpend(
    organizationId: string,
    delegate: string,
    intent: { readonly id: string; readonly createdAt: Date },
  ): Promise<boolean> {
    const row = await this.createQueryBuilder('intent')
      .select('1', 'one')
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere('intent.voucherDelegate = :delegate', { delegate })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.id <> :id', { id: intent.id })
      .andWhere(
        `(${CREATED_AT} < :createdAt OR (${CREATED_AT} = :createdAt AND intent.id < :id))`,
        { createdAt: intent.createdAt },
      )
      .limit(1)
      .getRawOne<{ one: number }>();
    return row !== undefined && row !== null;
  }

  /**
   * What each payment key spent in `[from, to)`, across every organization,
   * for `PaymentKeyDailySummaryService`: rail-B vouchers signed by a delegate
   * whose funds were secured and that are not refunded, voided or expired,
   * grouped by organization, credential, key and asset. A key that spent
   * nothing has no row.
   *
   * Deliberately cross-organization: the summary is the platform's own daily
   * pass over every tenant, like the redemption queue above; each row is then
   * sent to its own organization only. Amounts are sums of `numeric(78,0)`
   * returned as decimal strings and read as `bigint`. Served by
   * `idx_payment_intents_delegate_recent`.
   */
  async sumDelegateSpendByKey(from: Date, to: Date): Promise<DelegateSpendRow[]> {
    const rows = await this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.credentialId', 'credentialId')
      .addSelect('MIN(intent.agent_id::text)', 'agentId')
      .addSelect('intent.voucherDelegate', 'delegate')
      .addSelect('intent.chainId', 'chainId')
      .addSelect('intent.assetId', 'assetId')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(intent.priceAmount), 0)', 'amount')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.voucherDelegate IS NOT NULL')
      .andWhere('intent.rail = :rail', { rail: 'RAIL_B_VOUCHER' })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.status IN (:...spent)', {
        spent: ['FUNDS_SECURED', 'PROVIDER_EXECUTING', 'VERIFYING', SETTLED_STATUS],
      })
      .andWhere(`${CREATED_AT} >= :from`, { from })
      .andWhere(`${CREATED_AT} < :to`, { to })
      .groupBy('intent.organizationId')
      .addGroupBy('intent.credentialId')
      .addGroupBy('intent.voucherDelegate')
      .addGroupBy('intent.chainId')
      .addGroupBy('intent.assetId')
      .addGroupBy('intent.decimals')
      .orderBy('intent.organizationId', 'ASC')
      .addOrderBy('intent.voucherDelegate', 'ASC')
      .addOrderBy('intent.assetId', 'ASC')
      .getRawMany<{
        organizationId: string;
        credentialId: string | null;
        agentId: string;
        delegate: string;
        chainId: string;
        assetId: string;
        decimals: number | string;
        calls: number | string;
        amount: string;
      }>();
    return rows.map((row) => ({
      organizationId: row.organizationId,
      credentialId: row.credentialId ?? null,
      agentId: row.agentId,
      delegate: row.delegate,
      chainId: row.chainId,
      assetId: row.assetId,
      decimals: Number(row.decimals),
      calls: Number(row.calls),
      amount: BigInt(row.amount),
    }));
  }
}

/** One payment key's spend in one asset over a window (`sumDelegateSpendByKey`). */
export interface DelegateSpendRow {
  readonly organizationId: string;
  /** The credential that made the calls; null on a row written without one. */
  readonly credentialId: string | null;
  readonly agentId: string;
  /** The payment key (CAIP-10). */
  readonly delegate: string;
  readonly chainId: string;
  readonly assetId: string;
  readonly decimals: number;
  readonly calls: number;
  /** Atomic units, exact. */
  readonly amount: bigint;
}

/**
 * What a rail-B admission under the payer's lock must see
 * ({@link OpenVoucherTotals}): the vouchers the chain's window counters do not
 * hold yet (escrow and delegate), any live admission pause, the payer's
 * `next_seq`, and the highest seq still bound for the chain.
 *
 * `replacing`: the id of a debt whose voucher is being REPLACED
 * (`replaceLapsedVoucher`). Its own row is left out of every figure — its old
 * voucher is dead and the replacement is the one being admitted — and so are
 * other lapsed vouchers that are not being replaced: they will never reach the
 * chain, so they cannot be stepped over.
 */
async function readVoucherAdmission(
  manager: EntityManager,
  scope: VoucherAdmissionScope,
  replacing: string | null,
): Promise<OpenVoucherTotals> {
  const [totals] = (await manager.query(
    `SELECT
       COALESCE(SUM("price_amount") FILTER (WHERE ${OPEN_VOUCHER_SQL('$4')}), 0)::text AS "escrow",
       COALESCE(SUM("price_amount") FILTER (
         WHERE "voucher_delegate" = $3 AND ${OPEN_VOUCHER_SQL('$5')}
       ), 0)::text AS "delegate"
     FROM "payment_intents"
     WHERE "organization_id" IS NOT NULL
       AND "agent_account" = $1
       AND "asset_id" = $2
       AND "rail" = 'RAIL_B_VOUCHER'
       AND ($6::uuid IS NULL OR "id" <> $6::uuid)
       AND ("hold_released_at" IS NULL OR "hold_released_at" >= LEAST($4::timestamptz, $5::timestamptz)
            OR "held_at" >= LEAST($4::timestamptz, $5::timestamptz))`,
    [
      scope.payer,
      scope.assetId,
      scope.delegate,
      scope.escrowSince,
      scope.delegateSince ?? scope.escrowSince,
      replacing,
    ],
  )) as Array<{ escrow: string; delegate: string }>;
  // Any live pause over this voucher (BUG-D1-07): one per tightening, the
  // payer's own (`delegate IS NULL`) or this delegate's. Live while its
  // relay is pending, and after it landed for as long as this admission's
  // chain read (`$3`, already lagged) predates the landing — the read saw
  // the OLD caps, however late this insert comes.
  const [pause] = (await manager.query(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (MAX("paused_until") - now()))))::int AS "paused_for"
       FROM "voucher_admission_pauses"
      WHERE "payer_account" = $1
        AND ("delegate" IS NULL OR ($2::text IS NOT NULL AND lower("delegate") = lower($2::text)))
        AND ("paused_until" > now() OR ("landed_at" IS NOT NULL AND "landed_at" > $3::timestamptz))
     HAVING COUNT(*) > 0`,
    [
      scope.payer,
      scope.delegate,
      earliest(scope.escrowSince, scope.delegateSince ?? scope.escrowSince),
    ],
  )) as Array<{ paused_for: number }>;
  const [escrowRow] = (await manager.query(
    `SELECT "next_seq"::text AS "next_seq" FROM "buyer_escrows" WHERE "account_id" = $1`,
    [scope.payer],
  )) as Array<{ next_seq: string }>;
  // Every asset: a seq is the payer account's, not the asset's.
  const [highest] = (await manager.query(
    `SELECT MAX("voucher_seq")::text AS "max_seq"
       FROM "payment_intents"
      WHERE "organization_id" IS NOT NULL
        AND "agent_account" = $1
        AND "rail" = 'RAIL_B_VOUCHER'
        AND "voucher_seq" IS NOT NULL
        AND ($2::uuid IS NULL OR ("id" <> $2::uuid
             AND ("redemption_lapsed_at" IS NULL OR "redemption_replaced_at" IS NOT NULL)))
        AND ("status" IN (${[...OPEN_HOLD_STATUSES, SETTLED_STATUS]
          .map((status) => `'${status}'`)
          .join(', ')})
             OR ("status" = 'CREATED' AND "expires_at" > now()))`,
    [scope.payer, replacing],
  )) as Array<{ max_seq: string | null }>;
  let debts: number | undefined;
  if (replacing === null && scope.organizationId) {
    const [owed] = (await manager.query(
      `SELECT COUNT(*)::int AS "debts" FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL AND ${DEBT_REFUSING_SQL}
          AND ("agent_account" = $1 OR "organization_id" = $2)`,
      [scope.payer, scope.organizationId],
    )) as Array<{ debts: number }>;
    debts = Number(owed?.debts ?? 0);
  }
  let reserved: bigint | undefined;
  if (replacing === null) {
    const [promised] = (await manager.query(
      `SELECT (
         (SELECT COALESCE(SUM(h."amount"), 0) FROM "ledger_holds" h
           WHERE h."account_id" = $1 AND h."asset_id" = $2 AND h."status" = 'OPEN'
             AND NOT EXISTS (
               SELECT 1 FROM "payment_intents" i
                WHERE i."id" = h."intent_id" AND i."organization_id" IS NOT NULL
                  AND i."rail" = 'RAIL_B_VOUCHER' AND i."held_status" = 'HELD'
                  AND i."hold_id" = h."id"))
         +
         (SELECT COALESCE(SUM("price_amount"), 0) FROM "payment_intents"
           WHERE "organization_id" IS NOT NULL AND "agent_account" = $1 AND "asset_id" = $2
             AND "rail" = 'RAIL_B_VOUCHER' AND "status" = 'CREATED' AND "hold_id" IS NULL
             AND "expires_at" > now())
       )::text AS "reserved"`,
      [scope.payer, scope.assetId],
    )) as Array<{ reserved: string }>;
    reserved = BigInt(promised?.reserved ?? '0');
  }
  return {
    debts,
    reserved,
    escrow: BigInt(totals?.escrow ?? '0'),
    delegate: scope.delegate === null ? 0n : BigInt(totals?.delegate ?? '0'),
    pausedFor: pause ? Number(pause.paused_for) : null,
    nextSeq: escrowRow ? BigInt(escrowRow.next_seq) : null,
    maxSeq: highest?.max_seq ? BigInt(highest.max_seq) : null,
  };
}

const OUTSTANDING_DEBT_COLUMNS =
  `"id", "organization_id" AS "organizationId", "agent_id" AS "agentId", ` +
  `"agent_account" AS "agentAccount", "provider_id" AS "providerId", ` +
  `"provider_account" AS "providerAccount", "tool_id" AS "toolId", "chain_id" AS "chainId", ` +
  `"asset_id" AS "assetId", "decimals", "price_amount"::text AS "priceAmount", ` +
  `"request_hash" AS "requestHash", "voucher_resource_hash" AS "voucherResourceHash", ` +
  `"voucher_seq"::text AS "voucherSeq", "voucher_resource" AS "voucherResource", ` +
  `"redemption_lapsed_at" AS "lapsedAt", "expires_at" AS "expiresAt", ` +
  `"redemption_last_error" AS "cause", ` +
  `"redemption_replaced_at" AS "replacedAt", ` +
  `COALESCE("redemption_last_error" LIKE 'uncollected:%', false) AS "writtenOff", ` +
  `"created_at" AS "createdAt"`;

type RawOutstandingDebt = Omit<OutstandingDebt, 'writtenOff' | 'decimals'> & {
  readonly writtenOff: boolean | string;
  readonly decimals: number | string;
};

function toOutstandingDebt(row: RawOutstandingDebt): OutstandingDebt {
  return {
    ...row,
    decimals: Number(row.decimals),
    replacedAt: row.replacedAt ?? null,
    voucherResource: row.voucherResource ?? null,
    writtenOff: row.writtenOff === true || row.writtenOff === 'true',
  };
}

async function readUnsettledVouchers(
  manager: EntityManager,
  scope: UnsettledVoucherScope,
): Promise<UnsettledVoucherTotals> {
  const byDelegate = scope.delegate ? ` AND lower("voucher_delegate") = lower($4)` : '';
  const [row] = (await manager.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${UNSETTLED_VOUCHER_SQL})::int AS "count",
       COALESCE(SUM("price_amount") FILTER (WHERE ${UNSETTLED_VOUCHER_SQL}), 0)::text AS "total",
       COALESCE(MAX("price_amount") FILTER (WHERE ${UNSETTLED_VOUCHER_SQL}), 0)::text AS "largest",
       MAX("expires_at" + ${redeemGraceIntervalSql('"chain_id"')})
         FILTER (WHERE ${UNSETTLED_VOUCHER_SQL}) AS "redeemableUntil",
       COALESCE(SUM("price_amount") FILTER (
         WHERE "status" = '${SETTLED_STATUS}'
           AND COALESCE("held_at", "hold_released_at") >= $3::timestamptz
       ), 0)::text AS "redeemedSince"
     FROM "payment_intents"
     WHERE "organization_id" IS NOT NULL
       AND "agent_account" = $1
       AND "asset_id" = $2
       AND "rail" = 'RAIL_B_VOUCHER'
       AND ("hold_released_at" IS NULL OR "hold_released_at" >= $3::timestamptz
            OR "held_at" >= $3::timestamptz)${byDelegate}`,
    scope.delegate
      ? [scope.payer, scope.assetId, scope.since, scope.delegate]
      : [scope.payer, scope.assetId, scope.since],
  )) as Array<{
    count: number;
    total: string;
    largest: string;
    redeemableUntil: Date | null;
    redeemedSince: string;
  }>;
  return {
    count: Number(row?.count ?? 0),
    total: BigInt(row?.total ?? '0'),
    largest: BigInt(row?.largest ?? '0'),
    redeemableUntil: row?.redeemableUntil ? new Date(row.redeemableUntil) : null,
    redeemedSince: BigInt(row?.redeemedSince ?? '0'),
  };
}

/**
 * Whether a payer-side party of the row aliased `alias` is blocked: the
 * payer's organization, the payer or the delegate (by blocklist key or by
 * on-chain account). Named parameters: {@link blockedPartyParams}.
 *
 * Never NULL: each term is `COALESCE(…, false)`. A NULL column (no delegate,
 * no provider) compared with a non-empty array is NULL, and `NOT (… OR NULL)`
 * is NULL too — which would drop every honest row without a delegate from
 * every `NOT (blocked)` query the moment one wallet is blocked.
 */
function blockedPartySql(alias: string): string {
  const key = (column: string) =>
    `(split_part(${alias}.${column}, ':', 1) || ':' || CASE WHEN split_part(${alias}.${column}, ':', 1) = 'eip155' ` +
    `THEN lower(split_part(${alias}.${column}, ':', 3)) ELSE split_part(${alias}.${column}, ':', 3) END)`;
  return [
    `${alias}.organization_id::text = ANY(:blockedOrgs)`,
    ...['agent_account', 'voucher_delegate'].flatMap((column) => [
      `${key(column)} = ANY(:blockedWalletKeys)`,
      `lower(${alias}.${column}) = ANY(:blockedChainAccounts)`,
    ]),
  ]
    .map(notNull)
    .join(' OR ');
}

/**
 * {@link blockedPartySql} for a COLLECT: the contract's `assertActive(payer,
 * provider)` refuses the provider side too, so the provider's organization and
 * payout account count as well.
 */
function blockedCollectSql(alias: string): string {
  return [blockedPartySql(alias), blockedProviderSql(alias)].join(' OR ');
}

/**
 * Whether the PROVIDER side of the row aliased `alias` is blocked: the
 * provider's organization, or its payout account by blocklist key or by
 * on-chain account. Named parameters: {@link blockedPartyParams}.
 */
function blockedProviderSql(alias: string): string {
  const key = (column: string) =>
    `(split_part(${alias}.${column}, ':', 1) || ':' || CASE WHEN split_part(${alias}.${column}, ':', 1) = 'eip155' ` +
    `THEN lower(split_part(${alias}.${column}, ':', 3)) ELSE split_part(${alias}.${column}, ':', 3) END)`;
  return [
    `${alias}.provider_id::text = ANY(:blockedOrgs)`,
    `${key('provider_account')} = ANY(:blockedWalletKeys)`,
    `lower(${alias}.provider_account) = ANY(:blockedChainAccounts)`,
  ]
    .map(notNull)
    .join(' OR ');
}

/** A boolean SQL term that is `false`, never NULL, when its column is NULL. */
function notNull(term: string): string {
  return `COALESCE(${term}, false)`;
}

function blockedPartyParams(exclude: RedemptionExclusions): Record<string, string[]> {
  return {
    blockedOrgs: [...exclude.organizationIds],
    blockedWalletKeys: [...exclude.walletKeys],
    blockedChainAccounts: exclude.chainAccounts.map((account) => account.toLowerCase()),
  };
}

function hasExclusions(exclude: RedemptionExclusions): boolean {
  return (
    exclude.organizationIds.length > 0 ||
    exclude.walletKeys.length > 0 ||
    exclude.chainAccounts.length > 0
  );
}

/** Rows a raw `UPDATE … RETURNING` touched, across the driver's two result shapes. */
function affected(result: [unknown[], number] | unknown[]): number {
  if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}
