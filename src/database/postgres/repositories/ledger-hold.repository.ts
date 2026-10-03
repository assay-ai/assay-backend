import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { LedgerHoldEntity } from '../entities/ledger-hold.entity';
import { assertOrganizationScopedValues } from '../organization-scope';
import { OrganizationScopedRepository } from './organization-scoped.repository';

export const HOLD_STATUS_OPEN = 'OPEN';

@Injectable()
export class LedgerHoldRepository extends OrganizationScopedRepository<LedgerHoldEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(LedgerHoldEntity, dataSource);
  }

  async insertOne(value: Partial<LedgerHoldEntity>, queryRunner: QueryRunner): Promise<void> {
    assertOrganizationScopedValues(value, 'LedgerHoldEntity.insertOne');
    await queryRunner.manager
      .createQueryBuilder()
      .insert()
      .into(LedgerHoldEntity)
      .values(value)
      .execute();
  }

  /**
   * Reads a hold and holds a write lock on it for the rest of the transaction.
   *
   * The lock is what makes a concurrent release and commit of the same hold
   * resolve one after the other rather than both reading `OPEN`.
   */
  async lockById(
    organizationId: string,
    holdId: string,
    queryRunner: QueryRunner,
  ): Promise<LedgerHoldEntity | null> {
    const rows = await this.createQueryBuilder('hold', queryRunner)
      .setLock('pessimistic_write')
      .where('hold.organizationId = :organizationId', { organizationId })
      .andWhere('hold.id = :holdId', { holdId })
      .getMany();

    return rows[0] ?? null;
  }

  /**
   * Moves an `OPEN` hold to a terminal state, conditionally.
   *
   * The `status = 'OPEN'` predicate is the load-bearing part: it makes the
   * transition compare-and-set, so a second releaser updates zero rows and
   * learns it lost without ever writing a second `HOLD_RELEASE`. Returning the
   * affected count rather than the row makes "did I do it" the caller's answer
   * to read, not something inferred from a re-read that could race.
   */
  async resolveIfOpen(
    organizationId: string,
    holdId: string,
    status: string,
    resolveEntryId: string,
    queryRunner: QueryRunner,
  ): Promise<number> {
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(LedgerHoldEntity)
      .set({ status, resolveEntryId, updatedAt: new Date() })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :holdId', { holdId })
      .andWhere('status = :open', { open: HOLD_STATUS_OPEN })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * `Σ amount` over every `OPEN` hold against `(accountId, assetId)`.
   *
   * Deliberately **not** organization-scoped, for the same reason
   * `BuyerEscrowRepository.oldestPendingSeq` is not: the escrow this backs is
   * one account's, on one chain, and a second organization's open hold against
   * that same account reserves the same on-chain money. Scoping this by tenant
   * would under-report the reservation and let `EscrowSpendGate` authorise a
   * spend the account cannot actually cover.
   */
  async sumOpenByAccount(accountId: string, assetId: string): Promise<bigint> {
    const rows: Array<{ sum: string | null }> = await this.dataSource.query(
      `SELECT COALESCE(SUM("amount"), 0)::text AS sum
         FROM "ledger_holds"
        WHERE "account_id" = $1 AND "asset_id" = $2 AND "status" = $3`,
      [accountId, assetId, HOLD_STATUS_OPEN],
    );

    return BigInt(rows[0]?.sum ?? '0');
  }
}
