import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { DepositIntentEntity } from '../entities/deposit-intent.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** A deposit intent the expiry sweep has work to do on. Mirrors `DuePaymentIntent`. */
export interface DueDepositIntent {
  readonly organizationId: string;
  readonly id: string;
  readonly status: string;
}

@Injectable()
export class DepositIntentRepository extends OrganizationScopedRepository<DepositIntentEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(DepositIntentEntity, dataSource);
  }

  /**
   * Moves a deposit intent from one status to another, conditionally.
   *
   * Same compare-and-swap reasoning as `PaymentIntentRepository`'s — the
   * `status = from` predicate is what makes a concurrent `settleDeposit` call
   * lose cleanly instead of crediting the ledger twice.
   */
  async transitionIfInStatus(
    organizationId: string,
    intentId: string,
    from: string,
    to: string,
    patch: QueryDeepPartialEntity<DepositIntentEntity>,
  ): Promise<number> {
    const result = await this.update(
      { organizationId, id: intentId, status: from },
      { ...patch, status: to },
    );

    return result.affected ?? 0;
  }

  /**
   * Deposit intents whose deadline has passed while still `CREATED`.
   *
   * Deliberately cross-tenant, same reasoning as
   * `PaymentIntentRepository.findDueForExpiry` — the sweep is a platform job
   * with no calling tenant.
   */
  async findDueForExpiry(now: Date, limit: number): Promise<DueDepositIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.status = :status', { status: 'CREATED' })
      .andWhere('intent.expiresAt < :now', { now })
      .orderBy('intent.expiresAt', 'ASC')
      .limit(limit)
      .getRawMany<DueDepositIntent>();
  }

  /**
   * `SETTLED` deposits with a transaction to re-check for finality.
   *
   * The ledger journal remains the source of truth for whether a promotion
   * already happened — `DepositFinalityService` reads it per candidate and
   * that check is what makes a second `DEPOSIT_CONFIRM` impossible.
   * `finality_resolved_at IS NULL` is only the **queue predicate**: it decides
   * what is worth looking at, never what happened.
   *
   * That predicate is not optional. Without it nothing ever left this set —
   * the sweep writes ledger entries and never touches the row, and
   * `updated_at` moves only on a real `UPDATE` — so the 200 oldest settled
   * deposits became a permanent prefix and every deposit settled after the
   * two-hundredth was never promoted. `DepositFinalityResolution1758100000001`
   * carries the full account, including why a stale marker can only cost a
   * redundant journal read.
   *
   * Deliberately cross-tenant, same reasoning as `findDueForExpiry`.
   */
  async findSettledAwaitingFinality(limit: number): Promise<SettledDepositIntent[]> {
    return this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.id', 'id')
      .addSelect('intent.chainId', 'chainId')
      .addSelect('intent.chainTxRef', 'chainTxRef')
      .where('intent.status = :status', { status: 'SETTLED' })
      .andWhere('intent.chainTxRef IS NOT NULL')
      .andWhere('intent.finalityResolvedAt IS NULL')
      .orderBy('intent.updatedAt', 'ASC')
      .limit(limit)
      .getRawMany<SettledDepositIntent>();
  }

  /**
   * Takes a deposit out of the finality queue.
   *
   * Called *after* the resolving ledger entry is durable, never before: a
   * crash between the two costs one extra journal read on the next pass,
   * whereas the reverse order would strand the deposit exactly as the missing
   * predicate used to.
   *
   * Idempotent — the timestamp is only ever read as "is this null", so
   * re-stamping an already-stamped row changes nothing the sweep can observe.
   */
  async markFinalityResolved(
    organizationId: string,
    intentId: string,
    resolvedAt: Date,
  ): Promise<number> {
    const result = await this.update(
      { organizationId, id: intentId },
      { finalityResolvedAt: resolvedAt },
    );

    return result.affected ?? 0;
  }

  private selectSweepCandidates(): SelectQueryBuilder<DepositIntentEntity> {
    return this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.id', 'id')
      .addSelect('intent.status', 'status');
  }
}

export interface SettledDepositIntent {
  readonly organizationId: string;
  readonly id: string;
  readonly chainId: string;
  readonly chainTxRef: string;
}
