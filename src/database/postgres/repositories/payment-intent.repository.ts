import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WITHHELD_STATUSES } from '@modules/ledger/domain/withheld';
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
}

/** One row of a summary grouping, still in atomic units. */
export interface ReceiptsSummaryRow {
  /** The group's label — a tool id, a provider id, a day, a status, a verdict. */
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
  `AND intent.hold_released_at IS NULL)`;

export interface CallExportRow {
  /** The payment intent's own id — the platform's key for the money. */
  readonly id: string;
  /** `X-X402-Call-Id` as sent upstream — the provider's key for the request. */
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
  readonly expiresAt: Date;
  readonly holdId: string;
  readonly providerId: string | null;
  readonly providerAmount: string;
  readonly platformFee: string;
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

/** One agent's spend-so-far in one asset, split at the UTC day and UTC month boundary. */
export interface AgentSpendTotals {
  /** `Σ price_amount` since {@link utcDayStart} — `spend-policy`'s daily-cap check. */
  readonly today: bigint;
  /** `Σ price_amount` since {@link utcMonthStart} — the monthly-cap check. */
  readonly thisMonth: bigint;
}

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
  ): Promise<RedeemableIntent[]> {
    return this.createQueryBuilder('intent')
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
      .addSelect('intent.expiresAt', 'expiresAt')
      .addSelect('intent.holdId', 'holdId')
      .addSelect('intent.providerId', 'providerId')
      .addSelect('intent.providerAmount', 'providerAmount')
      .addSelect('intent.platformFee', 'platformFee')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.assetId = :assetId', { assetId })
      .andWhere('intent.rail = :rail', { rail })
      .andWhere('intent.status = :settledStatus', { settledStatus })
      .andWhere('intent.holdId IS NOT NULL')
      .andWhere('intent.holdReleasedAt IS NULL')
      .andWhere('intent.voucherSeq IS NOT NULL')
      .andWhere('intent.voucherSignature IS NOT NULL')
      .orderBy('intent.agentAccount', 'ASC')
      .addOrderBy('intent.voucherSeq', 'ASC')
      .limit(limit)
      .getRawMany<RedeemableIntent>();
  }

  private selectSweepCandidates(): SelectQueryBuilder<PaymentIntentEntity> {
    return this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.id', 'id')
      .addSelect('intent.status', 'status')
      .addSelect('intent.holdId', 'holdId');
  }

  /**
   * The intent side of `withheld`: `Σ` listed price over
   * {@link WITHHELD_STATUSES}, restricted to intents that actually reserved
   * something (`hold_id IS NOT NULL` — see `domain/withheld.ts` for why an
   * intent that expired in `CREATED` must not appear here), grouped by asset
   * and by status so a caller can fold the rows into `WithheldBucket`s without
   * loading one row per intent.
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
      .addSelect('COALESCE(SUM(intent.priceAmount), 0)', 'amount')
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
   * `Σ price_amount` for one agent, in one asset, split at the UTC day and UTC
   * month boundary in a single pass (the spend-policy cap check).
   *
   * One query rather than two: `monthStart` is always `<= dayStart`, so
   * filtering the `WHERE` to `created_at >= :monthStart` already selects
   * every row either total needs, and the two `SUM(CASE …)` projections split
   * that one scan into "today" and "this month" without reading the table
   * twice. See {@link SPEND_COUNTING_STATUSES} for which statuses count as
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
    dayStart: Date,
    monthStart: Date,
  ): Promise<AgentSpendTotals> {
    const row = await this.createQueryBuilder('intent')
      .select(
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
      .setParameters({ dayStart })
      .getRawOne<{ today: string; thisMonth: string }>();

    return {
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
        'COALESCE(SUM(CASE WHEN intent.status = :settledStatus THEN intent.priceAmount ELSE 0 END), 0)',
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
        createdAt: Date;
      }>();

    return rows.map((row) => ({
      ...row,
      decimals: Number(row.decimals),
      awaitingRedemption: row.awaitingRedemption === true || row.awaitingRedemption === 'true',
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
