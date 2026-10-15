import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WITHHELD_STATUSES } from '@modules/ledger/domain/withheld';
import { REDEEM_GRACE_SECONDS } from '@modules/payment/constants/voucher-redemption.constants';
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
 * `Σ` listed price over the withheld statuses that had a hold, grouped by asset
 * and by status so `LedgerWithheldService` can fold rows into `WithheldBucket`s
 * without loading one row per intent.
 */
export interface WithheldStatusAssetTotal {
  readonly asset: string;
  readonly decimals: number;
  readonly status: string;
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
}

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
 * retires it and writes `PROVIDER_CREDIT`.
 */
export const AWAITING_REDEMPTION_SQL =
  `(intent.rail = 'RAIL_B_VOUCHER' AND intent.hold_id IS NOT NULL ` +
  `AND intent.hold_released_at IS NULL AND intent.redemption_lapsed_at IS NULL)`;

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
 * Read on a credited intent: a LEGACY credit out of platform funds
 * (`platform_absorbed:<error>`), written before buyer debt replaced it. Nothing
 * writes one any more: the platform never pays or owes a provider. Kept only to
 * label the historical rows, which are reported as uncollected (the buyer's
 * hold was released and no buyer money backs the credit). The credit's
 * `organization_id` is the provider's, which puts the probe on
 * `idx_ledger_entries_intent_id`.
 */
export const PLATFORM_ABSORBED_SQL =
  `EXISTS (SELECT 1 FROM ledger_entries absorbed ` +
  `WHERE absorbed.organization_id = intent.provider_id AND absorbed.intent_id = intent.id ` +
  `AND absorbed.entry_type = 'PROVIDER_CREDIT' ` +
  `AND absorbed.chain_tx_ref LIKE 'platform_absorbed:%')`;

/**
 * The same legacy credit as {@link PLATFORM_ABSORBED_SQL}, read for its reason
 * (the program error after the prefix, e.g. `DelegateIsRevoked`); `NULL` when
 * the call was not absorbed. One credit per intent (partial unique index).
 */
export const PLATFORM_ABSORBED_REASON_SQL =
  `(SELECT substring(absorbed.chain_tx_ref FROM 19) ` + // after the 18-char prefix
  `FROM ledger_entries absorbed ` +
  `WHERE absorbed.organization_id = intent.provider_id AND absorbed.intent_id = intent.id ` +
  `AND absorbed.entry_type = 'PROVIDER_CREDIT' ` +
  `AND absorbed.chain_tx_ref LIKE 'platform_absorbed:%' LIMIT 1)`;

/**
 * Read on a `SETTLED` intent: the buyer was NOT charged although the verdict
 * passed — the provider forfeited, the debt was written off, or (legacy) the
 * platform absorbed it. The one predicate every buyer-facing "charged" figure
 * and the spend caps leave out (review 2026-10-15 #2, M4).
 */
export const NOT_COLLECTED_SQL =
  `(COALESCE(${FORFEITED_SQL}, false) OR COALESCE(${WRITTEN_OFF_SQL}, false) ` +
  `OR ${PLATFORM_ABSORBED_SQL})`;

/**
 * Read on a `SETTLED` intent: the provider has been credited OUT OF THE
 * BUYER'S ESCROW — its hold was committed, which is exactly when
 * `PROVIDER_CREDIT` is written (rail A inline in `PaymentIntentService.resolve`,
 * rail B in `commitRedeemedHold` once `redeem_voucher` lands). Every "earned"
 * figure filters on this, so it matches the earnings ledger by construction.
 *
 * A released hold is not a committed one: a forfeit, a write-off and a legacy
 * absorb all released the buyer's hold and are left out (review 2026-10-15, M2;
 * review #2, M4).
 */
export const CREDITED_SQL =
  `(intent.hold_id IS NOT NULL AND intent.hold_released_at IS NOT NULL ` +
  `AND NOT ${NOT_COLLECTED_SQL})`;

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
  /** Why the credit came out of platform funds, or `null` — see {@link PLATFORM_ABSORBED_REASON_SQL}. */
  readonly absorbedReason: string | null;
  /** `provider_forfeit:<cause>` when the provider forfeited — see {@link FORFEITED_SQL}. */
  readonly redemptionLastError: string | null;
  readonly createdAt: Date;
}

/** A keyset position for {@link PaymentIntentRepository.findCallsPageForExport}. */
export interface CallExportCursor {
  readonly createdAt: Date;
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
}

/** One open buyer debt — see {@link PaymentIntentRepository.findOutstandingDebts}. */
export interface OutstandingDebt {
  readonly id: string;
  readonly organizationId: string;
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
  readonly lapsedAt: Date;
  /** The refusal the voucher lapsed on (`VoucherExpired`, `DelegateIsRevoked`, …). */
  readonly cause: string | null;
  readonly createdAt: Date;
}

/** The replacement voucher's fields — see {@link PaymentIntentRepository.replaceLapsedVoucher}. */
export interface LapsedVoucherReplacement {
  readonly seq: string;
  readonly signature: string;
  readonly issuedAt: number;
  readonly delegate: string | null;
  readonly expiresAt: Date;
}

export interface DuePaymentIntent {
  readonly organizationId: string;
  readonly id: string;
  readonly status: string;
  readonly holdId: string | null;
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
  /** The last instant the chain still redeems one of them (`expires_at` + grace), or null. */
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
 */
const UNSETTLED_VOUCHER_SQL =
  `(("status" = 'CREATED' AND "hold_id" IS NULL AND "expires_at" > now())` +
  ` OR ("hold_id" IS NOT NULL AND "hold_released_at" IS NULL AND "status" IN (` +
  [...OPEN_HOLD_STATUSES, SETTLED_STATUS].map((status) => `'${status}'`).join(', ') +
  `) AND "expires_at" > now() - interval '${REDEEM_GRACE_SECONDS} seconds'))`;

/**
 * A rail-B intent the chain's window counter cannot contain yet, given the
 * instant (`$n`) the counter was read. See `insertAdmittedVoucherIntent`.
 */
/** The earlier of two instants. */
const earliest = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

const OPEN_VOUCHER_SQL = (since: string): string =>
  `(("status" = 'CREATED' AND "hold_id" IS NULL AND "expires_at" > now())` +
  ` OR ("hold_id" IS NOT NULL AND "hold_released_at" IS NULL AND "status" IN (` +
  [...OPEN_HOLD_STATUSES, SETTLED_STATUS].map((status) => `'${status}'`).join(', ') +
  `))` +
  ` OR ("status" = '${SETTLED_STATUS}' AND "hold_released_at" >= ${since}::timestamptz))`;

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
   * The upper bound (`latestSeconds`) keeps the sweep off vouchers the chain
   * would already refuse: those are left to the hold backstop, which releases
   * the buyer's hold and pays nobody (review 2026-10-15, H1).
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
    latestSeconds: number,
    limit: number,
  ): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.status = :verifying', { verifying: 'VERIFYING' })
      .andWhere('intent.rail = :rail', { rail: 'RAIL_B_VOUCHER' })
      .andWhere('intent.expiresAt < :cutoff', {
        cutoff: new Date(now.getTime() - deadlineSeconds * 1000),
      })
      .andWhere('intent.expiresAt > :latest', {
        latest: new Date(now.getTime() - latestSeconds * 1000),
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
   * Intents already expired whose hold was never released.
   *
   * The repair half of the sweep. A pass that expires an intent and then dies
   * before the ledger call lands leaves money reserved for a call that will
   * never happen, and the intent is no longer in an expirable status, so
   * `findDueForExpiry` will never look at it again. Without this **nothing**
   * returns it: the 24-hour hold backstop this comment used to name is
   * unimplemented, `ledger_holds.expires_at` having no reader anywhere.
   *
   * `expiredStatus` is the gate, and it is also the limit: a hold left open by
   * a *terminal* intent is not `EXPIRED` and is not found here.
   */
  async findExpiredWithUnreleasedHold(
    expiredStatus: string,
    limit: number,
  ): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.status = :expiredStatus', { expiredStatus })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
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
   * `next_seq − seq_high` only while the redemptions go up in sequence.
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
   */
  async findAwaitingRedemption(
    assetId: string,
    settledStatus: string,
    rail: string,
    limit: number,
    exclude: RedemptionExclusions = NO_REDEMPTION_EXCLUSIONS,
  ): Promise<RedeemableIntent[]> {
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
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.assetId = :assetId', { assetId })
      .andWhere('intent.rail = :rail', { rail })
      .andWhere('intent.status = :settledStatus', { settledStatus })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere('intent.voucherSeq IS NOT NULL')
      .andWhere('intent.voucherSignature IS NOT NULL')
      // Buyer debt: the voucher is dead and nothing will redeem it until the
      // buyer signs a replacement (`replaceLapsedVoucher` clears the column).
      .andWhere('intent.redemptionLapsedAt IS NULL')
      // A row waits while a LOWER seq of its payer is still in flight or open
      // (review 2026-10-15 P-4). Redeeming it first advances `seq_high` past
      // the lower one, which then dies on `VoucherSeqNotIncreasing` and is paid
      // by the platform. Bounded: the lower one settles (and goes first),
      // or ends REFUNDED/VOIDED/EXPIRED (only a hole), or passes its own
      // redemption window (final review N-1): past `expires_at` + grace the
      // chain refuses it anyway, so it is only a hole, and waiting on it to
      // the 24 h hold backstop would let every later voucher expire too.
      // Per payer account, not per asset: the seq is the escrow's.
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM payment_intents earlier
            WHERE earlier.organization_id IS NOT NULL
              AND earlier.agent_account = intent.agent_account
              AND earlier.rail = :rail
              AND earlier.voucher_seq IS NOT NULL
              AND earlier.voucher_seq < intent.voucher_seq
              AND earlier.expires_at > now() - interval '${REDEEM_GRACE_SECONDS} seconds'
              AND (earlier.status IN (:...earlierOpenStatuses)
                   OR (earlier.status = 'CREATED' AND earlier.expires_at > now()))
         )`,
        { earlierOpenStatuses: [...OPEN_HOLD_STATUSES] },
      );

    if (
      exclude.organizationIds.length > 0 ||
      exclude.walletKeys.length > 0 ||
      exclude.chainAccounts.length > 0
    ) {
      // A row is left out when it, or an EARLIER seq of the same payer in this
      // queue, has a blocked party. Leaving out only the blocked row would let
      // the payer's later seqs through, and redeeming one of those advances
      // `seq_high` past the held one and kills it. Done in the query, BEFORE
      // the LIMIT, so held rows can never fill the pass (audit E-1).
      //
      // Payer-side parties only — the payer's organization, the payer and the
      // delegate. A blocked provider or payee is NOT left out: the pass makes
      // that provider forfeit the voucher at once (`VoucherRedemptionService`),
      // which closes the row, so it can neither wait nor fill a pass.
      const blockedParty = (alias: string) => {
        const key = (column: string) =>
          `(split_part(${alias}.${column}, ':', 1) || ':' || CASE WHEN split_part(${alias}.${column}, ':', 1) = 'eip155' ` +
          `THEN lower(split_part(${alias}.${column}, ':', 3)) ELSE split_part(${alias}.${column}, ':', 3) END)`;
        return [
          `${alias}.organization_id::text = ANY(:blockedOrgs)`,
          ...['agent_account', 'voucher_delegate'].flatMap((column) => [
            `${key(column)} = ANY(:blockedWalletKeys)`,
            `lower(${alias}.${column}) = ANY(:blockedChainAccounts)`,
          ]),
        ].join(' OR ');
      };
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
              AND held.voucher_seq IS NOT NULL
              AND held.voucher_signature IS NOT NULL
              AND held.redemption_lapsed_at IS NULL
              AND held.voucher_seq <= intent.voucher_seq
              AND (${blockedParty('held')})
         )`,
        {
          blockedOrgs: [...exclude.organizationIds],
          blockedWalletKeys: [...exclude.walletKeys],
          blockedChainAccounts: exclude.chainAccounts.map((account) => account.toLowerCase()),
        },
      );
    }

    return query
      .orderBy('intent.agentAccount', 'ASC')
      .addOrderBy('intent.voucherSeq', 'ASC')
      .limit(limit)
      .getRawMany<RedeemableIntent>();
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
          AND "redemption_lapsed_at" IS NULL
          AND ("redemption_last_error" IS NULL OR NOT (
                "redemption_last_error" = ANY($5::text[])
                OR "redemption_last_error" LIKE 'provider_forfeit:%'
                OR "redemption_last_error" LIKE 'uncollected:%'))
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
   * credited. `redemption_lapsed_at` keeps the FIRST lapse, so a row lapsed
   * twice does not restart its write-off clock. Only an open hold lapses.
   */
  async lapseRedemption(organizationId: string, id: string, cause: string): Promise<void> {
    await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_lapsed_at" = COALESCE("redemption_lapsed_at", now()),
              "redemption_last_error" = $3
        WHERE "organization_id" = $1 AND "id" = $2 AND "hold_released_at" IS NULL`,
      [organizationId, id, cause],
    );
  }

  /**
   * The open buyer debts of a payer: rows of the payer ACCOUNT (any
   * organization — the escrow is the account's) or of the organization (any
   * of its payer accounts), oldest first. Read on every paid call
   * (`PAYMENT_DEBT_OUTSTANDING`) and by `GET /escrow/debts`;
   * `idx_payment_intents_open_debt` holds only open debts.
   */
  async findOutstandingDebts(
    organizationId: string,
    payer: string,
    limit = 50,
  ): Promise<OutstandingDebt[]> {
    return (await this.manager.query(
      `SELECT "id", "organization_id" AS "organizationId", "agent_account" AS "agentAccount",
              "provider_id" AS "providerId", "provider_account" AS "providerAccount",
              "tool_id" AS "toolId", "chain_id" AS "chainId", "asset_id" AS "assetId",
              "decimals", "price_amount"::text AS "priceAmount", "request_hash" AS "requestHash",
              "voucher_resource_hash" AS "voucherResourceHash", "voucher_seq"::text AS "voucherSeq",
              "redemption_lapsed_at" AS "lapsedAt", "redemption_last_error" AS "cause",
              "created_at" AS "createdAt"
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL
          AND "redemption_lapsed_at" IS NOT NULL
          AND "hold_released_at" IS NULL
          AND ("agent_account" = $2 OR "organization_id" = $1)
        ORDER BY "redemption_lapsed_at" ASC, "id" ASC
        LIMIT $3`,
      [organizationId, payer, limit],
    )) as OutstandingDebt[];
  }

  /**
   * Open buyer debts that lapsed before `before`: the write-off pass's
   * candidates. Cross-tenant like the other sweep reads, oldest first.
   */
  async findDueForWriteOff(before: Date, limit: number): Promise<DuePaymentIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.redemptionLapsedAt IS NOT NULL')
      .andWhere('intent.redemptionLapsedAt < :before', { before })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .orderBy('intent.redemptionLapsedAt', 'ASC')
      .limit(limit)
      .getRawMany<DuePaymentIntent>();
  }

  /**
   * Records why an open debt is written off (`uncollected:<cause>`), BEFORE
   * its hold is released: a crash between the two leaves the row where the
   * next pass finds it (the hold is still open) and writes it off again.
   */
  async markWrittenOff(organizationId: string, id: string, reason: string): Promise<boolean> {
    const result = (await this.manager.query(
      `UPDATE "payment_intents" SET "redemption_last_error" = $3
        WHERE "organization_id" = $1 AND "id" = $2
          AND "redemption_lapsed_at" IS NOT NULL AND "hold_released_at" IS NULL
        RETURNING "id"`,
      [organizationId, id, reason],
    )) as [unknown[], number] | unknown[];
    return affected(result) > 0;
  }

  /**
   * Swaps a lapsed voucher for the buyer's REPLACEMENT and reopens the row to
   * the redemption queue — under the payer's admission lock, so it cannot race
   * an admission or a second replacement (BUG-D1-02's lock).
   *
   * `admit` sees the payer's `next_seq` and highest live seq, as a voucher
   * admission does: the replacement's seq must be issued (`< next_seq`) and
   * above every seq still bound for the chain, or redeeming it would step over
   * one of them. The row must still be an open debt; `false` when it is not
   * (settled by a concurrent replacement, or written off). The old voucher's
   * transaction references are cleared: none of them carries the new voucher,
   * and a debt lapses only once its own transactions are known not to have
   * landed.
   */
  async replaceLapsedVoucher(
    organizationId: string,
    id: string,
    payer: string,
    replacement: LapsedVoucherReplacement,
    admit: (open: { nextSeq: bigint | null; maxSeq: bigint | null }) => void,
  ): Promise<boolean> {
    return this.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `voucher-admission:${payer}`,
      ]);
      const [escrowRow] = (await manager.query(
        `SELECT "next_seq"::text AS "next_seq" FROM "buyer_escrows" WHERE "account_id" = $1`,
        [payer],
      )) as Array<{ next_seq: string }>;
      const [highest] = (await manager.query(
        `SELECT MAX("voucher_seq")::text AS "max_seq"
           FROM "payment_intents"
          WHERE "organization_id" IS NOT NULL
            AND "agent_account" = $1
            AND "rail" = 'RAIL_B_VOUCHER'
            AND "voucher_seq" IS NOT NULL
            AND "redemption_lapsed_at" IS NULL
            AND ("status" IN (${[...OPEN_HOLD_STATUSES, SETTLED_STATUS]
              .map((status) => `'${status}'`)
              .join(', ')})
                 OR ("status" = 'CREATED' AND "expires_at" > now()))`,
        [payer],
      )) as Array<{ max_seq: string | null }>;
      admit({
        nextSeq: escrowRow ? BigInt(escrowRow.next_seq) : null,
        maxSeq: highest?.max_seq ? BigInt(highest.max_seq) : null,
      });
      const result = (await manager.query(
        `UPDATE "payment_intents"
            SET "voucher_seq" = $4, "voucher_signature" = $5, "voucher_issued_at" = $6,
                "voucher_delegate" = $7, "expires_at" = $8,
                "redemption_tx_refs" = '{}', "redemption_last_error" = NULL,
                "redemption_lapsed_at" = NULL
          WHERE "organization_id" = $1 AND "id" = $2 AND "agent_account" = $3
            AND "status" = 'SETTLED' AND "rail" = 'RAIL_B_VOUCHER'
            AND "redemption_lapsed_at" IS NOT NULL AND "hold_released_at" IS NULL
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
   * redemption and the platform paid the providers.
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
           AND ("hold_released_at" IS NULL OR "hold_released_at" >= LEAST($4::timestamptz, $5::timestamptz))`,
        [
          scope.payer,
          scope.assetId,
          scope.delegate,
          scope.escrowSince,
          scope.delegateSince ?? scope.escrowSince,
        ],
      )) as Array<{ escrow: string; delegate: string }>;
      // Any live pause over this voucher (BUG-D1-07): one per tightening, the
      // payer's own (`delegate IS NULL`) or this delegate's. Live while its
      // relay is pending, and after it landed for as long as this admission's
      // chain read (`$4`, already lagged) predates the landing — the read saw
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
            AND ("status" IN (${[...OPEN_HOLD_STATUSES, SETTLED_STATUS]
              .map((status) => `'${status}'`)
              .join(', ')})
                 OR ("status" = 'CREATED' AND "expires_at" > now()))`,
        [scope.payer],
      )) as Array<{ max_seq: string | null }>;
      admit({
        escrow: BigInt(totals?.escrow ?? '0'),
        delegate: scope.delegate === null ? 0n : BigInt(totals?.delegate ?? '0'),
        pausedFor: pause ? Number(pause.paused_for) : null,
        nextSeq: escrowRow ? BigInt(escrowRow.next_seq) : null,
        maxSeq: highest?.max_seq ? BigInt(highest.max_seq) : null,
      });
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
   * {@link WITHHELD_STATUSES}, restricted to intents that actually reserved
   * something (`hold_id IS NOT NULL` — see `domain/withheld.ts` for why an
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
      .andWhere('intent.status IN (:...statuses)', { statuses: WITHHELD_STATUSES })
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
   */
  async summarizeReceipts(
    organizationId: string,
    groupBy: ReceiptsSummaryGroupBy,
    window: Required<PaymentIntentPeriod>,
    assetId?: string,
  ): Promise<ReceiptsSummaryRow[]> {
    const groupExpression = this.summaryGroupExpression(groupBy);

    const qb = this.createQueryBuilder('intent')
      .select(groupExpression, 'key')
      .addSelect('intent.assetId', 'asset')
      .addSelect('intent.decimals', 'decimals')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(intent.priceAmount), 0)', 'listedTotal')
      .addSelect(
        // A forfeited voucher was never collected: the buyer was not charged.
        `COALESCE(SUM(CASE WHEN intent.status = :settledStatus ` +
          `AND NOT COALESCE(${FORFEITED_SQL}, false) THEN intent.priceAmount ELSE 0 END), 0)`,
        'chargedTotal',
      )
      .addSelect(
        'COALESCE(SUM(CASE WHEN intent.status IN (:...withheldStatuses) AND intent.holdId IS NOT NULL ' +
          'THEN intent.priceAmount ELSE 0 END), 0)',
        'withheldTotal',
      )
      .addSelect('COUNT(*) FILTER (WHERE intent.status = :refundedStatus)', 'refundedCalls')
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere(`${CREATED_AT} >= :from`, { from: window.from })
      .andWhere(`${CREATED_AT} < :to`, { to: window.to })
      .setParameters({
        settledStatus: SETTLED_STATUS,
        refundedStatus: REFUNDED_STATUS,
        withheldStatuses: WITHHELD_STATUSES,
      });

    if (assetId) {
      qb.andWhere('intent.assetId = :assetId', { assetId });
    }

    const rows = await qb
      .groupBy(groupExpression)
      .addGroupBy('intent.assetId')
      .addGroupBy('intent.decimals')
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
      }>();

    return rows.map((row) => ({
      key: row.key,
      asset: row.asset,
      decimals: Number(row.decimals),
      calls: Number(row.calls),
      listedTotal: BigInt(row.listedTotal),
      chargedTotal: BigInt(row.chargedTotal),
      withheldTotal: BigInt(row.withheldTotal),
      refundedCalls: Number(row.refundedCalls),
    }));
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
      .addSelect(PLATFORM_ABSORBED_REASON_SQL, 'absorbedReason')
      .addSelect('intent.redemptionLastError', 'redemptionLastError')
      .addSelect('intent.createdAt', 'createdAt');

    if (after) {
      qb.andWhere(
        `(intent.created_at > :afterCreatedAt OR ` +
          `(intent.created_at = :afterCreatedAt AND intent.id > :afterId))`,
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
        absorbedReason: string | null;
        redemptionLastError: string | null;
        createdAt: Date;
      }>();

    return rows.map((row) => ({
      ...row,
      decimals: Number(row.decimals),
      awaitingRedemption: row.awaitingRedemption === true || row.awaitingRedemption === 'true',
      credited: row.credited === true || row.credited === 'true',
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
       MAX("expires_at") FILTER (WHERE ${UNSETTLED_VOUCHER_SQL}) AS "latestExpiry",
       COALESCE(SUM("price_amount") FILTER (
         WHERE "status" = '${SETTLED_STATUS}' AND "hold_released_at" >= $3::timestamptz
       ), 0)::text AS "redeemedSince"
     FROM "payment_intents"
     WHERE "organization_id" IS NOT NULL
       AND "agent_account" = $1
       AND "asset_id" = $2
       AND "rail" = 'RAIL_B_VOUCHER'
       AND ("hold_released_at" IS NULL OR "hold_released_at" >= $3::timestamptz)${byDelegate}`,
    scope.delegate
      ? [scope.payer, scope.assetId, scope.since, scope.delegate]
      : [scope.payer, scope.assetId, scope.since],
  )) as Array<{
    count: number;
    total: string;
    largest: string;
    latestExpiry: Date | null;
    redeemedSince: string;
  }>;
  const latest = row?.latestExpiry ? new Date(row.latestExpiry) : null;
  return {
    count: Number(row?.count ?? 0),
    total: BigInt(row?.total ?? '0'),
    largest: BigInt(row?.largest ?? '0'),
    redeemableUntil:
      latest === null ? null : new Date(latest.getTime() + REDEEM_GRACE_SECONDS * 1000),
    redeemedSince: BigInt(row?.redeemedSince ?? '0'),
  };
}

/** Rows a raw `UPDATE … RETURNING` touched, across the driver's two result shapes. */
function affected(result: [unknown[], number] | unknown[]): number {
  if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}
