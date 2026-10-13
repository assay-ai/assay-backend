import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner, SelectQueryBuilder } from 'typeorm';

import { AccountBlockEntity } from '../entities/account-block.entity';
import { AbstractRepository } from './abstract.repository';

export interface AccountBlockFilter {
  readonly subjectKind?: string;
  /** Exact match on the subject key. */
  readonly subjectKey?: string;
  /** `true` standing blocks only, `false` lifted ones only, absent both. */
  readonly active?: boolean;
  readonly reasonCode?: string;
}

/** The columns the in-memory blocklist holds. */
export interface ActiveBlockRow {
  readonly id: string;
  readonly subjectKind: string;
  readonly subject: string;
  readonly subjectKey: string;
  readonly reasonCode: string;
  readonly blockedAt: Date;
}

/**
 * Platform data, not tenant data — see `AccountBlockEntity` — so this extends
 * `AbstractRepository` and every read here spans the deployment on purpose.
 */
@Injectable()
export class AccountBlockRepository extends AbstractRepository<AccountBlockEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(AccountBlockEntity, dataSource);
  }

  /**
   * Every block standing now. The whole blocklist, read by every process on
   * every refresh; `idx_account_blocks_active` covers it.
   */
  async findActive(): Promise<ActiveBlockRow[]> {
    return this.createQueryBuilder('block')
      .select([
        'block.id',
        'block.subjectKind',
        'block.subject',
        'block.subjectKey',
        'block.reasonCode',
        'block.blockedAt',
      ])
      .where('block.unblocked_at IS NULL')
      .getMany();
  }

  async insertBlock(
    queryRunner: QueryRunner,
    row: Partial<AccountBlockEntity>,
  ): Promise<AccountBlockEntity> {
    const entity = queryRunner.manager.create(AccountBlockEntity, row);
    return queryRunner.manager.save(AccountBlockEntity, entity);
  }

  /**
   * Lift a standing block. Returns the number of rows moved — zero when the
   * block was already lifted, which the caller turns into a refusal.
   */
  async markUnblocked(
    queryRunner: QueryRunner,
    id: string,
    patch: {
      readonly unblockedBy: string;
      readonly unblockApprovedBy: string;
      readonly unblockedAt: Date;
      readonly unblockNote: string;
    },
  ): Promise<number> {
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(AccountBlockEntity)
      .set(patch)
      .where('id = :id', { id })
      .andWhere('unblocked_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  feedQueryBuilder(filter: AccountBlockFilter): SelectQueryBuilder<AccountBlockEntity> {
    const qb = this.createQueryBuilder('block');
    if (filter.subjectKind) {
      qb.andWhere('block.subject_kind = :kind', { kind: filter.subjectKind });
    }
    if (filter.subjectKey) {
      qb.andWhere('block.subject_key = :key', { key: filter.subjectKey });
    }
    if (filter.reasonCode) {
      qb.andWhere('block.reason_code = :reason', { reason: filter.reasonCode });
    }
    if (filter.active === true) qb.andWhere('block.unblocked_at IS NULL');
    if (filter.active === false) qb.andWhere('block.unblocked_at IS NOT NULL');
    return qb;
  }
}
