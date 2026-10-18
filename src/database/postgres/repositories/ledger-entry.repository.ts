import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { LEGACY_POOLED_VAULT_TX_REF } from '@modules/ledger/ports/ledger.types';
import { LedgerEntryEntity } from '../entities/ledger-entry.entity';
import { assertOrganizationScopedValues } from '../organization-scope';
import { OrganizationScopedRepository } from './organization-scoped.repository';

export const LEDGER_INSERT_CHUNK_SIZE = 500;

/**
 * Mirrors `LedgerEntryType.HOLD_RELEASE`. Kept as a local literal rather than
 * an import of `@modules/ledger/ports/ledger.types` — the same reason
 * `LedgerHoldRepository.HOLD_STATUS_OPEN` is: this layer sits below the domain
 * and does not take an import edge back up into it for one string.
 */
const HOLD_RELEASE_ENTRY_TYPE = 'HOLD_RELEASE';

export interface JournalFilter {
  readonly accountId?: string;
  readonly assetId?: string;
  readonly intentId?: string;
  readonly holdId?: string;
  readonly batchId?: string;
}

/**
 * Reads and appends on the journal. There is no update path and no delete path,
 * here or anywhere.
 */
@Injectable()
export class LedgerEntryRepository extends OrganizationScopedRepository<LedgerEntryEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(LedgerEntryEntity, dataSource);
  }

  /**
   * Inserts a batch inside the caller's transaction. **Strict** — no
   * `orIgnore`, no upsert, no chunk-splitting retry.
   *
   * `AbstractRepository.batchInsertWithSplit` is the house batch helper and is
   * deliberately not used: it inserts `ON CONFLICT DO NOTHING`, so a duplicate
   * row would be dropped silently while the caller still applied its delta to
   * the snapshot — the journal and the balance would part company and nothing
   * would report it. On this table a conflict is a bug, and a bug must fail the
   * batch.
   *
   * Chunking is only to stay under the parameter limit; every chunk runs on the
   * caller's `queryRunner`, so all of them commit together or none do.
   */
  async appendMany(
    values: Partial<LedgerEntryEntity>[],
    queryRunner: QueryRunner,
  ): Promise<number> {
    if (values.length === 0) {
      return 0;
    }
    assertOrganizationScopedValues(values, 'LedgerEntryEntity.appendMany');

    let inserted = 0;
    for (let i = 0; i < values.length; i += LEDGER_INSERT_CHUNK_SIZE) {
      const chunk = values.slice(i, i + LEDGER_INSERT_CHUNK_SIZE);
      const result = await queryRunner.manager
        .createQueryBuilder()
        .insert()
        .into(LedgerEntryEntity)
        .values(chunk)
        .execute();
      inserted += result.identifiers.length;
    }
    return inserted;
  }

  /**
   * Every entry for an organization, in journal order.
   *
   * Ordered by `seq` because that is the only total order the table has, and a
   * rebuild that reads rows in an arbitrary order cannot be compared against a
   * partial replay.
   */
  async readJournal(
    organizationId: string,
    filter: JournalFilter = {},
    queryRunner?: QueryRunner,
  ): Promise<LedgerEntryEntity[]> {
    const builder = this.createQueryBuilder('entry', queryRunner).where(
      'entry.organizationId = :organizationId',
      { organizationId },
    );

    if (filter.accountId !== undefined) {
      builder.andWhere('entry.accountId = :accountId', { accountId: filter.accountId });
    }
    if (filter.assetId !== undefined) {
      builder.andWhere('entry.assetId = :assetId', { assetId: filter.assetId });
    }
    if (filter.intentId !== undefined) {
      builder.andWhere('entry.intentId = :intentId', { intentId: filter.intentId });
    }
    if (filter.holdId !== undefined) {
      builder.andWhere('entry.holdId = :holdId', { holdId: filter.holdId });
    }
    if (filter.batchId !== undefined) {
      builder.andWhere('entry.batchId = :batchId', { batchId: filter.batchId });
    }

    return builder.orderBy('entry.seq', 'ASC').getMany();
  }

  /**
   * What one executed slash actually paid the harmed agents.
   *
   * **The agent's share is on no column.** `slash_proposals` records
   * `applied_amount` and `platform_amount` and nothing else, and the third
   * number cannot be derived by subtracting them: measured on the real executed
   * proposal, `applied 520000`, `platform 156000`, agent `312000`, and the
   * provider retains the remaining `52000`. `applied − platform` is `364000`,
   * which is simply wrong. The page must not add two numbers together and call
   * that the penalty.
   *
   * So the figure is read where it was actually written.
   * `SlashCompensationService` credits each agent with
   * `chainTxRef = <execution signature>`, which makes the sum below the exact
   * total that reached agents for that one on-chain slash.
   *
   * **Deliberately cross-organization**, and it has to be: the credits belong
   * to whichever buyers were harmed, and there is no single tenant to scope to.
   * The projection is one integer and names nobody. This file is allowlisted by
   * name in `test/unit/shared/api/surface-consistency.spec.ts`.
   */
  async sumSlashDistributionBySignature(signature: string): Promise<string> {
    const row = await this.createQueryBuilder('entry')
      .select('COALESCE(SUM(entry.amount), 0)', 'total')
      .where('entry.organizationId IS NOT NULL')
      .andWhere('entry.entryType = :type', { type: 'SLASH_DISTRIBUTION' })
      .andWhere('entry.chainTxRef = :signature', { signature })
      .getRawOne<{ total: string }>();

    return row?.total ?? '0';
  }

  /**
   * `Σ amount` per entry type, for one asset, across **every** organization.
   *
   * **Deliberately cross-tenant**, exactly like
   * `AccountBalanceRepository.sumLiabilities` and for the same reason: the
   * vault is one shared account and the liability it must cover is a
   * platform-wide sum. `COUNT(DISTINCT organization_id)` is a real figure and
   * also what makes the scope guard's "this SQL references organization_id"
   * check true rather than circumvented.
   *
   * It sums the **journal**, not the snapshot table. That is the whole point:
   * `account_balances` is a cache, and a reconciler that reads the cache can
   * only ever discover that the chain disagrees with the cache — never that
   * the cache disagrees with the journal that defines it. The two totals are
   * compared against each other in `ReconciliationService`.
   *
   * The amounts are unsigned; the caller applies direction from
   * `LEDGER_ENTRY_EFFECTS`. Grouping by type rather than summing signed values
   * in SQL keeps the effect table the single place direction is decided.
   */
  async sumByEntryType(assetId: string): Promise<EntryTypeTotals> {
    const rows = await this.createQueryBuilder('entry')
      .select('entry.entryType', 'entryType')
      .addSelect('COALESCE(SUM(entry.amount), 0)', 'total')
      .addSelect('COUNT(DISTINCT entry.organizationId)', 'organizations')
      .addSelect('COUNT(*)', 'entries')
      .where('entry.assetId = :assetId', { assetId })
      .groupBy('entry.entryType')
      .getRawMany<{
        entryType: string;
        total: string;
        organizations: string;
        entries: string;
      }>();

    const totals = new Map<string, bigint>();
    const organizations = new Set<string>();
    let entries = 0;

    for (const row of rows) {
      totals.set(row.entryType, BigInt(row.total));
      entries += Number(row.entries);
      // Per-group distinct counts cannot be summed into a platform-wide
      // distinct count, so the figure reported is the largest group's — a
      // lower bound, labelled as such rather than a wrong exact number.
      organizations.add(row.organizations);
    }

    return {
      totals,
      entries,
      organizationsAtLeast: Math.max(0, ...[...organizations].map(Number)),
    };
  }

  /**
   * `Σ amount` of the provider credits and platform fees whose value a
   * **rail-B redemption** paid straight out of the buyer's escrow — the
   * escrow program transfers `amount − fee` to the provider and `fee` to the
   * treasury in the instruction that redeems the voucher. That value never
   * sits in the vault after the entry is written, so the reconciler must not
   * count it as a liability the vault covers. Every rail-A credit is excluded. Cross-tenant for the reason
   * {@link sumByEntryType} gives; the `organization_id` count is what the
   * scope guard checks for.
   */
  async sumPaidAtRedemption(assetId: string): Promise<PaidAtRedemption> {
    const rows = await this.createQueryBuilder('entry')
      .select('entry.entryType', 'entryType')
      .addSelect('COALESCE(SUM(entry.amount), 0)', 'total')
      .addSelect('COUNT(DISTINCT entry.organizationId)', 'organizations')
      .where('entry.assetId = :assetId', { assetId })
      .andWhere('entry.entryType IN (:...types)', { types: ['PROVIDER_CREDIT', 'PLATFORM_FEE'] })
      // Identified by the ref, which is required on every credit: a rail-A
      // commit names `LEGACY_POOLED_VAULT_TX_REF` (its money stays in the
      // pooled vault until a `PAYOUT`), and every other ref is a redemption —
      // its signature, or `unobserved:seq=…` for one that landed unobserved. A
      // NULL ref predates the rule and stays counted, which can only
      // over-state what is owed.
      .andWhere('entry.chainTxRef IS NOT NULL')
      .andWhere('entry.chainTxRef <> :legacy', { legacy: LEGACY_POOLED_VAULT_TX_REF })
      .groupBy('entry.entryType')
      .getRawMany<{ entryType: string; total: string; organizations: string }>();

    const total = (type: string) => BigInt(rows.find((r) => r.entryType === type)?.total ?? '0');
    return { providerCredits: total('PROVIDER_CREDIT'), platformFees: total('PLATFORM_FEE') };
  }

  /**
   * `Σ amount` for one entry type, grouped by asset, within one organization
   * and (optionally) one time window.
   *
   * The ledger side of `withheld`'s reconciliation: `LedgerWithheldService`
   * calls this with `HOLD_RELEASE` to get the figure `withheld` must equal, by
   * construction, independently of anything on `payment_intents`.
   */
  async sumEntryTypeByAsset(
    organizationId: string,
    entryType: string,
    period: JournalPeriod = {},
  ): Promise<EntryTypeAssetTotal[]> {
    const qb = this.createQueryBuilder('entry')
      .select('entry.assetId', 'asset')
      .addSelect('entry.decimals', 'decimals')
      .addSelect('COALESCE(SUM(entry.amount), 0)', 'amount')
      .addSelect('COUNT(*)', 'entries')
      .where('entry.organizationId = :organizationId', { organizationId })
      .andWhere('entry.entryType = :entryType', { entryType });

    if (period.from) {
      qb.andWhere('entry.createdAt >= :from', { from: period.from });
    }
    if (period.to) {
      qb.andWhere('entry.createdAt < :to', { to: period.to });
    }

    const rows = await qb
      .groupBy('entry.assetId')
      .addGroupBy('entry.decimals')
      .getRawMany<{ asset: string; decimals: string; amount: string; entries: string }>();

    return rows.map((row) => ({
      asset: row.asset,
      decimals: Number(row.decimals),
      amount: BigInt(row.amount),
      entries: Number(row.entries),
    }));
  }

  /**
   * Per asset, the `HOLD_RELEASE` entries whose hold's intent does not point
   * back at that hold — see `domain/withheld.ts` for exactly why this shape of
   * row exists and why it must be named rather than folded silently into
   * `withheld` — and the remainder released when a hold is committed below its
   * amount.
   *
   * The join is honest rather than inferred: it walks `ledger_entries` →
   * `ledger_holds` (the hold the release resolved) → `payment_intents` (the
   * call that hold was opened for), and reports every release whose intent's
   * own `hold_id` disagrees with the hold the release actually closed —
   * including an intent that never recorded a hold at all
   * (`intent.hold_id IS NULL`), which is exactly the `secureFunds` race the
   * domain comment names.
   *
   * Aggregated in SQL: one row per asset, and at most `maxListedIds` orphan
   * hold ids. A remainder exists for every call served below its hold, so a
   * row per entry made every `GET /balances` load the account's whole release
   * history (round-two review N-8). The sums are the same terms as before.
   *
   * `payment_intents` belongs to a different domain, and this is the one place
   * the ledger reads it directly rather than through a port: the alternative —
   * asking the payment domain for "every intent whose hold does not match its
   * own hold" — is the same query run on the other side of a boundary that buys
   * nothing, since the fact being checked is intrinsically about how the two
   * tables agree.
   */
  async summarizeOrphanedHoldReleases(
    organizationId: string,
    period: JournalPeriod = {},
    maxListedIds = 100,
  ): Promise<OrphanedHoldReleaseSummary[]> {
    // A release on its intent's own COMMITTED hold is the remainder of a
    // charge below the hold — the quote less the serving binding's price —
    // returned at settlement. Not withheld value either: the call was
    // charged. Reported as its own term and not as an orphan (final review N-8).
    const remainder = `(hold.status = 'COMMITTED' AND intent.hold_id IS NOT NULL AND intent.hold_id = hold.id)`;
    const listed = Math.max(0, Math.trunc(maxListedIds));

    const qb = this.createQueryBuilder('entry')
      .innerJoin(
        'ledger_holds',
        'hold',
        'hold.id = entry.hold_id AND hold.organization_id = entry.organization_id',
      )
      .innerJoin(
        'payment_intents',
        'intent',
        'intent.id = hold.intent_id AND intent.organization_id = entry.organization_id',
      )
      .select('entry.assetId', 'asset')
      .addSelect('entry.decimals', 'decimals')
      .addSelect(
        `COALESCE(SUM(entry.amount) FILTER (WHERE ${remainder}), 0)`,
        'settlementRemainders',
      )
      .addSelect(
        `COALESCE(SUM(entry.amount) FILTER (WHERE NOT ${remainder}), 0)`,
        'orphanedReleases',
      )
      .addSelect(`COUNT(*) FILTER (WHERE NOT ${remainder})`, 'orphanedHoldCount')
      .addSelect(
        `(array_agg(entry.hold_id ORDER BY entry.seq) FILTER (WHERE NOT ${remainder}))[1:${listed}]`,
        'orphanedHoldIds',
      )
      .where('entry.organizationId = :organizationId', { organizationId })
      .andWhere('entry.entryType = :entryType', { entryType: HOLD_RELEASE_ENTRY_TYPE })
      .andWhere(
        `(intent.hold_id IS NULL OR intent.hold_id <> hold.id OR hold.status = 'COMMITTED')`,
      );

    if (period.from) {
      qb.andWhere('entry.createdAt >= :from', { from: period.from });
    }
    if (period.to) {
      qb.andWhere('entry.createdAt < :to', { to: period.to });
    }

    const rows = await qb.groupBy('entry.assetId').addGroupBy('entry.decimals').getRawMany<{
      asset: string;
      decimals: string;
      settlementRemainders: string;
      orphanedReleases: string;
      orphanedHoldCount: string;
      orphanedHoldIds: string[] | null;
    }>();

    return rows.map((row) => ({
      asset: row.asset,
      decimals: Number(row.decimals),
      settlementRemainders: BigInt(row.settlementRemainders),
      orphanedReleases: BigInt(row.orphanedReleases),
      orphanedHoldCount: Number(row.orphanedHoldCount),
      orphanedHoldIds: row.orphanedHoldIds ?? [],
    }));
  }

  /**
   * What was deposited into this account's escrow in `[from, to)`, by entry
   * time: credited deposits (`DEPOSIT_PENDING`, legacy `DEPOSIT`) less those a
   * reorg dropped (`DEPOSIT_REJECT`). Atomic units. A statement line (B7),
   * read-only.
   */
  async sumDeposits(
    organizationId: string,
    accountId: string,
    assetId: string,
    from: Date | null,
    to: Date,
  ): Promise<bigint> {
    const qb = this.createQueryBuilder('entry')
      .select(
        `COALESCE(SUM(CASE WHEN entry.entryType = 'DEPOSIT_REJECT' ` +
          `THEN -entry.amount ELSE entry.amount END), 0)`,
        'total',
      )
      .where('entry.organizationId = :organizationId', { organizationId })
      .andWhere('lower(entry.accountId) = lower(:accountId)', { accountId })
      .andWhere('entry.assetId = :assetId', { assetId })
      .andWhere('entry.entryType IN (:...types)', {
        types: ['DEPOSIT_PENDING', 'DEPOSIT', 'DEPOSIT_REJECT'],
      })
      .andWhere('entry.createdAt < :to', { to });
    if (from) qb.andWhere('entry.createdAt >= :from', { from });
    const row = await qb.getRawOne<{ total: string }>();
    return BigInt(row?.total ?? '0');
  }
}

/** See {@link LedgerEntryRepository.sumPaidAtRedemption}. Unsigned, atomic units. */
export interface PaidAtRedemption {
  readonly providerCredits: bigint;
  readonly platformFees: bigint;
}

export interface EntryTypeTotals {
  /** Unsigned `Σ amount` keyed by `entry_type`. Absent key means no entries of that type. */
  readonly totals: ReadonlyMap<string, bigint>;
  /** How many journal rows were folded — an audit figure for the run record. */
  readonly entries: number;
  /** Lower bound on how many organizations contributed. See `sumByEntryType`. */
  readonly organizationsAtLeast: number;
}

/** A window of time a query is scoped to. Either edge may be omitted for an open bound. */
export interface JournalPeriod {
  readonly from?: Date;
  readonly to?: Date;
}

/** `Σ amount` for one entry type, per asset, within an organization. */
export interface EntryTypeAssetTotal {
  readonly asset: string;
  readonly decimals: number;
  readonly amount: bigint;
  readonly entries: number;
}

/**
 * One `HOLD_RELEASE` that belongs to no withheld intent — see
 * `domain/withheld.ts` for why this term exists rather than being tolerated as
 * an unexplained delta.
 */
export interface OrphanedHoldReleaseSummary {
  readonly asset: string;
  readonly decimals: number;
  /**
   * `Σ` the remainders released on intents' own COMMITTED holds when a call
   * was charged below its hold. Expected on every cheaper serve, so it is
   * reported apart from the real orphans.
   */
  readonly settlementRemainders: bigint;
  /** `Σ` the releases whose hold's intent does not point back at that hold. */
  readonly orphanedReleases: bigint;
  /** How many such releases. */
  readonly orphanedHoldCount: number;
  /** The holds of the first of them, oldest first, at most the caller's cap. */
  readonly orphanedHoldIds: readonly string[];
}
