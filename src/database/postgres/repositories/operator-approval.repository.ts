import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { OperatorApprovalEntity } from '../entities/operator-approval.entity';
import { AbstractRepository } from './abstract.repository';

/** The two-person approvals queue. Platform-owned, so not tenant-scoped. */
@Injectable()
export class OperatorApprovalRepository extends AbstractRepository<OperatorApprovalEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OperatorApprovalEntity, dataSource);
  }

  /** Every `PENDING` row past its `expires_at` becomes `EXPIRED`. Returns how many. */
  async expireStale(now: Date = new Date()): Promise<number> {
    const result = await this.createQueryBuilder()
      .update(OperatorApprovalEntity)
      .set({ status: 'EXPIRED', decidedAt: now })
      .where('status = :pending', { pending: 'PENDING' })
      .andWhere('expires_at <= :now', { now })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * `PENDING` → `APPROVED`, only if the row is still pending, unexpired and
   * requested by `requestedBy`. Run on the action's own transaction, so the
   * row lock it takes makes a second, concurrent approval wait and then match
   * nothing. Returns whether this call moved it.
   */
  async markApproved(
    manager: EntityManager,
    id: string,
    requestedBy: string,
    approvedBy: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(OperatorApprovalEntity)
      .set({ status: 'APPROVED', approvedBy, decidedAt: now })
      .where('id = :id', { id })
      .andWhere('status = :pending', { pending: 'PENDING' })
      .andWhere('requested_by = :requestedBy', { requestedBy })
      .andWhere('expires_at > :now', { now })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  /** `PENDING` → `REJECTED`. Returns whether this call moved it. */
  async markRejected(id: string, rejectedBy: string, now: Date = new Date()): Promise<boolean> {
    const result = await this.createQueryBuilder()
      .update(OperatorApprovalEntity)
      .set({ status: 'REJECTED', rejectedBy, decidedAt: now })
      .where('id = :id', { id })
      .andWhere('status = :pending', { pending: 'PENDING' })
      .execute();
    return (result.affected ?? 0) === 1;
  }
}
