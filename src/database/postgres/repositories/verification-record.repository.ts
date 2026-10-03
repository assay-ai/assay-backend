import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { VerificationRecordEntity } from '../entities/verification-record.entity';
import { assertOrganizationScopedCriteria } from '../organization-scope';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * A record a restarted worker still owes work on.
 *
 * Deliberately a projection and not the row: the sweep spans tenants and the
 * evidence columns are the large ones — a response body and four stage results
 * per record, loaded for every candidate, to decide something four small fields
 * already decide.
 */
export interface UnsettledVerificationRecord {
  readonly organizationId: string;
  readonly id: string;
  readonly intentId: string;
  readonly state: string;
  readonly settlementOutcome: string | null;
}

/**
 * The verdict store.
 *
 * Two of these methods are compare-and-swaps rather than updates, and that is
 * the whole reason this class exists rather than the service calling `update`
 * directly. A worker resuming after a crash re-runs work it may already have
 * done; the guard against doing it twice has to live in the `WHERE` clause,
 * where two processes racing produce one winner, and not in a read followed by
 * a write, where they both win.
 */
@Injectable()
export class VerificationRecordRepository extends OrganizationScopedRepository<VerificationRecordEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(VerificationRecordEntity, dataSource);
  }

  async findByIntentId(
    organizationId: string,
    intentId: string,
  ): Promise<VerificationRecordEntity | null> {
    return this.findOneBy({ organizationId, intentId });
  }

  /**
   * `PENDING → JUDGED`, conditionally.
   *
   * Zero rows means somebody else judged it first. That is not an error and not
   * a reason to judge it again: a verdict is evidence, and a second one for the
   * same call would leave two answers to a question a dispute expects to have
   * exactly one answer to.
   */
  async markJudgedIfPending(
    organizationId: string,
    id: string,
    patch: QueryDeepPartialEntity<VerificationRecordEntity>,
    queryRunner?: QueryRunner,
  ): Promise<number> {
    const criteria = { organizationId, id, state: VerificationRecordState.PENDING };
    const values = { ...patch, state: VerificationRecordState.JUDGED };

    if (!queryRunner) {
      const result = await this.update(criteria, values);
      return result.affected ?? 0;
    }

    // Inside a caller's transaction, so the verdict and its evidence pack
    // commit together. The scope guard still runs — `criteria` carries
    // `organizationId` — but the statement is issued through the caller's
    // manager rather than the repository's own connection, which is the same
    // shape `LedgerEntryRepository.insertBatch` uses.
    assertOrganizationScopedCriteria(criteria, 'markJudgedIfPending');
    const result = await queryRunner.manager.update(VerificationRecordEntity, criteria, values);
    return result.affected ?? 0;
  }

  /**
   * Drops the raw bodies from records older than `cutoff`, and says how many.
   *
   * The second half of the evidence pack's retention promise, and the half that
   * is easy to forget: `evidence_bodies` is a *copy*: the originals arrived
   * here at `enqueue` and stay until something removes them. A sweep that only
   * cleared the copy would leave the platform holding request bodies it
   * published a 72-hour limit on, while a test asserting "the body is gone"
   * passed.
   *
   * Keyed on `created_at`, not `evaluated_at`. `evaluated_at` is null on a
   * record that was never judged — a worker died, the retries ran out — and
   * those records have bodies too. Keying on the nullable column would keep
   * them forever, which is precisely the case the promise has to cover.
   *
   * **Deliberately cross-organization**: the retention promise is the
   * platform's, and a sweep that had to enumerate tenants would miss the next
   * one created. The statement writes nulls and reads nothing back, so no row
   * of one tenant is ever visible to another.
   */
  async scrubBodiesOlderThan(cutoff: Date, limit: number): Promise<number> {
    const stale = await this.createQueryBuilder('record')
      .select(['record.id', 'record.organizationId'])
      .where('record.organizationId IS NOT NULL')
      .andWhere('record.createdAt < :cutoff', { cutoff })
      .andWhere('(record.request IS NOT NULL OR record.response IS NOT NULL)')
      .orderBy('record.createdAt', 'ASC')
      .limit(limit)
      .getMany();

    let scrubbed = 0;
    for (const record of stale) {
      const result = await this.update(
        { organizationId: record.organizationId, id: record.id },
        { request: null, response: null },
      );
      scrubbed += result.affected ?? 0;
    }

    return scrubbed;
  }

  /**
   * `JUDGED → SETTLED`, conditionally.
   *
   * The inner guard on double settlement. The intent's own compare-and-swap is
   * the outer one and the ledger's idempotent hold resolution is the last; this
   * one is what makes the *record* say, durably and atomically, that the money
   * question has been answered — which is what the restart sweep reads.
   */
  async markSettledIfJudged(
    organizationId: string,
    id: string,
    patch: QueryDeepPartialEntity<VerificationRecordEntity>,
  ): Promise<number> {
    const result = await this.update(
      { organizationId, id, state: VerificationRecordState.JUDGED },
      { ...patch, state: VerificationRecordState.SETTLED },
    );
    return result.affected ?? 0;
  }

  /**
   * Records whose work never finished.
   *
   * **This query deliberately spans organizations**, like
   * `PaymentIntentRepository.findDueForExpiry` and for the same reason: a
   * restart sweep is a platform-level job with no calling tenant. The guard on
   * the base class stops a request-serving query that *forgot* its tenant; it
   * cannot stop a deliberate act, and this is one. The cost is bounded by the
   * projection, whose first field is the tenant id every follow-up write is
   * scoped to.
   */
  async findUnsettled(olderThan: Date, limit: number): Promise<UnsettledVerificationRecord[]> {
    return this.manager
      .createQueryBuilder(VerificationRecordEntity, 'record')
      .select('record.organization_id', 'organizationId')
      .addSelect('record.id', 'id')
      .addSelect('record.intent_id', 'intentId')
      .addSelect('record.state', 'state')
      .addSelect('record.settlement_outcome', 'settlementOutcome')
      .where('record.state <> :settled', { settled: VerificationRecordState.SETTLED })
      .andWhere('record.created_at < :olderThan', { olderThan })
      .orderBy('record.created_at', 'ASC')
      .limit(limit)
      .getRawMany<UnsettledVerificationRecord>();
  }

  /** Records a failed attempt without changing the state. */
  async recordFailure(organizationId: string, id: string, error: string): Promise<void> {
    await this.createQueryBuilder('record')
      .update()
      .set({
        attempts: () => '"attempts" + 1',
        lastError: error.slice(0, 512),
      })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .execute();
  }
}

/**
 * The worker's progress on one record.
 *
 * Three values and one direction. Kept here beside the queries that switch on
 * them rather than in the domain, because the CHECK constraint in the migration
 * is the authority and this is the layer that talks to it.
 */
export const VerificationRecordState = {
  /** Written when the intent reached `VERIFYING`. Nothing has judged it. */
  PENDING: 'PENDING',
  /** A verdict exists. The hold has **not** necessarily been resolved. */
  JUDGED: 'JUDGED',
  /** The hold was resolved and the intent is terminal. Nothing left to do. */
  SETTLED: 'SETTLED',
} as const;

export type VerificationRecordStateValue =
  (typeof VerificationRecordState)[keyof typeof VerificationRecordState];
