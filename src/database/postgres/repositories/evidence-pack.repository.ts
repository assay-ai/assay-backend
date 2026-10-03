import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { EvidencePackEntity } from '../entities/evidence-pack.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** The tail of an organization's chain — everything the next link needs. */
export interface EvidenceChainTail {
  readonly seq: string;
  readonly contentHash: string;
}

/**
 * `evidence_packs`.
 *
 * **There is no update and no delete here, and that is the point.** The
 * database refuses both anyway (`trg_evidence_packs_append_only`), so what a
 * method would buy is a caller who believes rewriting evidence is a supported
 * operation right up until production says otherwise. The two hedges cover
 * different mistakes: the missing method stops the code being written, the
 * trigger stops the code that was written anyway.
 */
@Injectable()
export class EvidencePackRepository extends OrganizationScopedRepository<EvidencePackEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(EvidencePackEntity, dataSource);
  }

  /**
   * The last link of one organization's chain, read **inside the caller's
   * transaction** and under its advisory lock.
   *
   * Taking a `QueryRunner` is not optional plumbing: read outside the sealing
   * transaction, this answer is stale the instant a concurrent judgement
   * commits, and two packs would claim the same predecessor. That collision is
   * caught by `uq_evidence_packs_prev` rather than producing a fork — but the
   * lock plus this read is what stops it being an error path in the first
   * place.
   */
  async findTail(
    queryRunner: QueryRunner,
    organizationId: string,
  ): Promise<EvidenceChainTail | null> {
    const rows = (await queryRunner.manager.query(
      `SELECT "seq", "content_hash" FROM "evidence_packs"
        WHERE "organization_id" = $1
        ORDER BY "seq" DESC
        LIMIT 1`,
      [organizationId],
    )) as Array<{ seq: string; content_hash: string }>;

    const tail = rows[0];
    return tail ? { seq: tail.seq, contentHash: tail.content_hash } : null;
  }

  /**
   * Serialises this organization's chain for the rest of the caller's
   * transaction.
   *
   * `pg_advisory_xact_lock` rather than a row lock, because the thing being
   * locked is a *position that does not exist yet* — `SELECT … FOR UPDATE` on
   * the tail cannot stop a second writer whose tail read returned the same row.
   * It releases at COMMIT or ROLLBACK with no unlock call, which matters here:
   * the sealing transaction can abort on a constraint, and a lock that leaked
   * on that path would wedge every later judgement for the same tenant.
   *
   * Keyed on the organization, so two tenants never wait on each other.
   *
   * Removing this line does not break a unit test — it breaks
   * `evidence-pack-sealer.integration.spec.ts`'s concurrency case, which was
   * verified by neutering exactly this call.
   */
  async lockChain(queryRunner: QueryRunner, organizationId: string): Promise<void> {
    await queryRunner.manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [organizationId]);
  }

  /**
   * Writes one pack inside the caller's transaction, and returns its id.
   *
   * Goes through `queryRunner.manager` in the same shape as
   * `LedgerEntryRepository.insertBatch`: the transaction belongs to the caller,
   * because the pack has to commit with the verdict or not at all.
   */
  async insertSealed(
    queryRunner: QueryRunner,
    row: QueryDeepPartialEntity<EvidencePackEntity>,
  ): Promise<string> {
    const result = await queryRunner.manager.insert(EvidencePackEntity, row);
    return (result.identifiers[0] as { id: string }).id;
  }

  /** The buyer's read. Scoped the ordinary way: the pack's tenant is the buyer. */
  async findByVerdictId(
    organizationId: string,
    verdictId: string,
  ): Promise<EvidencePackEntity | null> {
    return this.findOneBy({ organizationId, verdictId } as never);
  }

  /**
   * The provider's read.
   *
   * **Deliberately cross-organization**, the same idiom as
   * `PaymentIntentRepository.countCallsByBinding`: the tenant on this row is the
   * *buying* organization, while the party being charged on the verdict is the
   * provider. Scoping to the caller's own `organization_id` would not narrow the
   * answer, it would return nothing at all — which is exactly the gap this read
   * exists to close, since the evidence pack's whole justification is that a
   * provider can see why they were charged.
   *
   * `organizationId IS NOT NULL` satisfies the scoped repository's query-builder
   * guard while reading across tenants on purpose; the caller is responsible for
   * returning only the fields a provider may see (`seq` and `prev_hash` are not
   * among them — see the entity's `seq` comment).
   */
  async findByVerdictIdForProvider(
    providerId: string,
    verdictId: string,
  ): Promise<EvidencePackEntity | null> {
    return this.createQueryBuilder('pack')
      .where('pack.organizationId IS NOT NULL')
      .andWhere('pack.providerId = :providerId', { providerId })
      .andWhere('pack.verdictId = :verdictId', { verdictId })
      .getOne();
  }
}
