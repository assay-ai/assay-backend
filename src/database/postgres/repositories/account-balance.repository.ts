import { INTERNAL_ACCOUNTS } from '@modules/ledger/ports/ledger.types';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryResult, QueryRunner } from 'typeorm';
import { AccountBalanceEntity } from '../entities/account-balance.entity';
import { assertOrganizationScopedSql, assertOrganizationScopedValues } from '../organization-scope';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Postgres `check_violation` — raised by `chk_account_balances_non_negative`. */
export const CHECK_VIOLATION_CODE = '23514';

export interface BalanceRowKey {
  readonly accountId: string;
  readonly assetId: string;
}

export interface BalanceRowDelta extends BalanceRowKey {
  readonly decimals: number;
  readonly available: bigint;
  readonly held: bigint;
  readonly pending: bigint;
}

/**
 * The snapshot table, and the lock that serialises spending.
 *
 * Every method that mutates takes a `QueryRunner`: a balance change is never
 * correct on its own, only as part of a transaction that also writes the
 * journal entry explaining it.
 */
@Injectable()
export class AccountBalanceRepository extends OrganizationScopedRepository<AccountBalanceEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(AccountBalanceEntity, dataSource);
  }

  /**
   * Materialises any missing snapshot rows at zero, so there is always a row to
   * lock.
   *
   * `ON CONFLICT DO NOTHING` rather than a read-then-insert: two transactions
   * touching a brand-new account would both see it missing and both insert. The
   * loser blocks on the winner's speculative insertion, then does nothing —
   * which is exactly the desired outcome and costs one statement.
   */
  async ensureRows(
    organizationId: string,
    keys: readonly { accountId: string; assetId: string; decimals: number }[],
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    const values = keys.map((key) => ({
      organizationId,
      accountId: key.accountId,
      assetId: key.assetId,
      decimals: key.decimals,
      available: '0',
      held: '0',
      pending: '0',
    }));
    assertOrganizationScopedValues(values, 'AccountBalanceEntity.ensureRows');

    await queryRunner.manager
      .createQueryBuilder()
      .insert()
      .into(AccountBalanceEntity)
      .values(values)
      .orIgnore()
      .execute();
  }

  /**
   * Takes a row-level write lock on each key, in a fixed order.
   *
   * The order is the deadlock guard: two flushes touching `{A, B}` and `{B, A}`
   * without it will eventually take the two locks in opposite orders and one
   * will be killed. Postgres places the `LockRows` step above the `Sort`, so a
   * single ordered statement acquires the locks in the sorted order — the same
   * reason this is one query rather than a loop.
   */
  async lockRows(
    organizationId: string,
    keys: readonly BalanceRowKey[],
    queryRunner: QueryRunner,
  ): Promise<Map<string, AccountBalanceEntity>> {
    if (keys.length === 0) {
      return new Map();
    }

    // A composite `IN ((a, b), …)` cannot be expressed through TypeORM's
    // `:...spread`, which flattens one level and would bind each pair as an
    // array literal. An explicit OR of equalities is longer and unambiguous.
    const parameters: Record<string, string> = {};
    const conditions = keys.map((key, index) => {
      parameters[`account${index}`] = key.accountId;
      parameters[`asset${index}`] = key.assetId;
      return `(balance.accountId = :account${index} AND balance.assetId = :asset${index})`;
    });

    const rows = await this.createQueryBuilder('balance', queryRunner)
      .setLock('pessimistic_write')
      .where('balance.organizationId = :organizationId', { organizationId })
      .andWhere(`(${conditions.join(' OR ')})`, parameters)
      .orderBy('balance.accountId', 'ASC')
      .addOrderBy('balance.assetId', 'ASC')
      .getMany();

    return new Map(rows.map((row) => [rowKeyOf(row.accountId, row.assetId), row]));
  }

  /**
   * Adds the deltas to the locked rows in one statement.
   *
   * A bucket driven below zero trips `chk_account_balances_non_negative` and
   * aborts the transaction. That constraint should never fire — the caller
   * checked under the lock — and if it does the write fails rather than the
   * ledger going negative, which is the whole reason it is declared.
   */
  async applyDeltas(
    organizationId: string,
    deltas: readonly BalanceRowDelta[],
    queryRunner: QueryRunner,
  ): Promise<number> {
    if (deltas.length === 0) {
      return 0;
    }

    const parameters: unknown[] = [organizationId];
    const tuples = deltas.map((delta) => {
      const base = parameters.length;
      parameters.push(
        delta.accountId,
        delta.assetId,
        delta.available.toString(),
        delta.held.toString(),
        delta.pending.toString(),
      );
      return (
        `($${base + 1}, $${base + 2}, ` +
        `$${base + 3}::numeric, $${base + 4}::numeric, $${base + 5}::numeric)`
      );
    });

    const sql = `
      UPDATE account_balances AS b
         SET available  = b.available + d.available,
             held       = b.held      + d.held,
             pending    = b.pending   + d.pending,
             updated_at = now()
        FROM (VALUES ${tuples.join(', ')})
             AS d(account_id, asset_id, available, held, pending)
       WHERE b.organization_id = $1
         AND b.account_id      = d.account_id
         AND b.asset_id        = d.asset_id
      RETURNING b.account_id
    `;

    // Raw SQL bypasses the query-builder guard, so the statement is checked
    // explicitly. `updateAll`-style accidents are the failure this catches.
    assertOrganizationScopedSql(sql, 'AccountBalanceEntity.applyDeltas');

    // `useStructuredResult` — without it TypeORM returns `[rows, rowCount]` for
    // an UPDATE, so `.length` is 2 no matter how many rows moved. Reading the
    // count off the wrong shape is exactly the kind of quiet wrongness this
    // method exists to detect, so it asks for the shape that says what it means.
    const result: QueryResult = await queryRunner.query(sql, parameters, true);
    return result.affected ?? result.records?.length ?? 0;
  }

  async findOneRow(
    organizationId: string,
    accountId: string,
    assetId: string,
  ): Promise<AccountBalanceEntity | null> {
    return this.findOneBy({ organizationId, accountId, assetId });
  }

  async findAllRows(organizationId: string): Promise<AccountBalanceEntity[]> {
    return this.findBy({ organizationId });
  }

  /**
   * The right-hand side of proof of reserves:
   * `Σ (available + held + pending)` across **every** organization's balance
   * in `asset`.
   *
   * **Deliberately cross-tenant**, in the same spirit as
   * `PaymentIntentRepository`'s sweep queries — the vault is one shared
   * account custodying every organization's funds, so the liability it must
   * cover is a platform-wide sum, not any one tenant's. There is no
   * `organizationId` to scope this to.
   *
   * A bare `SUM` with no `GROUP BY` cannot also select a bare
   * `organizationId` column — Postgres refuses to mix an aggregate and a
   * non-aggregate column without one. `COUNT(DISTINCT …)` is not a workaround
   * for the scope guard: it is itself a real, useful number (how many
   * organizations contributed to the total), and it happens to also be what
   * makes "the built SQL references `organization_id`" a true statement about
   * this query rather than a formality defeated by wrapping the column.
   */
  async sumLiabilities(assetId: string): Promise<LiabilityTotals> {
    const raw = await this.createQueryBuilder('balance')
      .select('COALESCE(SUM(balance.available), 0)', 'available')
      .addSelect('COALESCE(SUM(balance.held), 0)', 'held')
      .addSelect('COALESCE(SUM(balance.pending), 0)', 'pending')
      .addSelect('COUNT(DISTINCT balance.organizationId)', 'organizations')
      .where('balance.assetId = :assetId', { assetId })
      .getRawOne<{ available: string; held: string; pending: string; organizations: string }>();

    return {
      available: BigInt(raw?.available ?? '0'),
      held: BigInt(raw?.held ?? '0'),
      pending: BigInt(raw?.pending ?? '0'),
      organizations: Number(raw?.organizations ?? '0'),
    };
  }

  /**
   * `available` and `held` per ledger account, for the named accounts only
   * (the reconciler's per-buyer escrow check).
   *
   * **Deliberately cross-tenant, and summed rather than selected.** An escrow
   * is keyed on the account pubkey alone (`uq_buyer_escrows_account`), and the
   * consequence is: two agents sharing a `primary_account_id` share one escrow,
   * one sequence window and one balance. Their `account_balances` rows are per
   * organization, so the figure that has to be compared against one on-chain
   * escrow is the sum across every organization holding that account. Selecting
   * one tenant's row would under-report the holds and turn a real shortfall
   * into a clean pass.
   *
   * `held` is carried separately from `available` because the two answer
   * different questions of the same escrow: `held` alone is what the platform
   * has *reserved* and must be covered (check 4, CRITICAL), while
   * `available + held + pending` is what the mirror believes the escrow holds
   * (check 5, WARN) — `pending` because a settled deposit awaiting finality is
   * already on chain in the escrow.
   *
   * `GROUP BY account_id` makes `organization_id` unreferenced by the built SQL,
   * so the scope guard would refuse this query — hence the raw `DataSource`
   * path, exactly as `oldestPendingSeq` takes for the same reason one table
   * over. An empty `accountIds` returns an empty map without a round trip.
   */
  async sumByAccounts(
    assetId: string,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, AccountBucketTotals>> {
    const totals = new Map<string, AccountBucketTotals>();
    if (accountIds.length === 0) {
      return totals;
    }

    const rows: Array<{ account_id: string; available: string; held: string; pending: string }> =
      await this.dataSource.query(
        `SELECT "account_id",
                COALESCE(SUM("available"), 0)::text AS available,
                COALESCE(SUM("held"), 0)::text      AS held,
                COALESCE(SUM("pending"), 0)::text   AS pending
           FROM "account_balances"
          WHERE "asset_id" = $1
            AND "account_id" = ANY($2::varchar[])
          GROUP BY "account_id"`,
        [assetId, accountIds],
      );

    for (const row of rows) {
      totals.set(row.account_id, {
        available: BigInt(row.available),
        held: BigInt(row.held),
        pending: BigInt(row.pending),
      });
    }
    return totals;
  }
  /**
   * How many accounts this platform holds a non-zero balance for, in one asset
   * — the `Accounts` tile of the public proof-of-reserves page.
   *
   * **Excludes `INTERNAL_ACCOUNTS`.** That is the same exclusion
   * `BalancesService` makes with `isAccountId` on this table and for the same
   * reason: `platform:fees` is the platform's own book, and
   * `LedgerHoldService.commitHoldAndCredit` keys it by the **paying**
   * organization — so every org that ever paid for a call has one, and
   * counting them would publish more "accounts" than there are customers.
   * The same defect has appeared before on this table.
   *
   * **It counts rows, and `account_balances` is keyed
   * `(organizationId, accountId, assetId)`** — so one `accountId` held by two
   * organizations counts twice. That is what the tile's label "Accounts" is
   * taken to mean here. `COUNT(DISTINCT account_id)` is one word away and
   * publishes a different number; this docstring is the only thing recording
   * which of the two was chosen.
   *
   * **Deliberately cross-organization**, exactly as `sumLiabilities` above: the
   * tile sits beside a platform-wide vault balance and must be the
   * platform-wide count, so there is no `organizationId` to scope it to — and
   * the page that reads it is served with no guard and no session, so there is
   * no caller identity to scope it *by*. The projection is a single integer:
   * no account id, no balance, no tenant.
   *
   * `organizationId IS NOT NULL` is the idiom the rest of this codebase uses to
   * say that out loud, and this file is allowlisted for it by name in
   * `test/unit/shared/api/surface-consistency.spec.ts`.
   */
  async countFundedCustomerAccounts(assetId: string): Promise<number> {
    return this.createQueryBuilder('balance')
      .where('balance.organizationId IS NOT NULL')
      .andWhere('balance.assetId = :assetId', { assetId })
      .andWhere('balance.accountId NOT IN (:...internal)', {
        internal: Object.values(INTERNAL_ACCOUNTS),
      })
      .andWhere('(balance.available + balance.held + balance.pending) > 0')
      .getCount();
  }
}

/** One ledger account's two spendable buckets, summed across organizations. */
export interface AccountBucketTotals {
  readonly available: bigint;
  readonly held: bigint;
  /** Observed on chain, not yet final — already IN the escrow. */
  readonly pending: bigint;
}

export interface LiabilityTotals {
  readonly available: bigint;
  readonly held: bigint;
  readonly pending: bigint;
  readonly organizations: number;
}

export function rowKeyOf(accountId: string, assetId: string): string {
  return `${accountId}|${assetId}`;
}
