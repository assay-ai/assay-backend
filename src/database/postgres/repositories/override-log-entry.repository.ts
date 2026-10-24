import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner, SelectQueryBuilder } from 'typeorm';

import { containsLikePattern } from '@shared/utils/like-pattern.util';

import { OverrideLogEntryEntity } from '../entities/override-log-entry.entity';
import { AbstractRepository } from './abstract.repository';

export interface OverrideLogFilter {
  readonly family?: string;
  readonly actorOperatorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly ticketRef?: string;
  readonly search?: string;
}

/**
 * The override register.
 *
 * ## Why this is not an `OrganizationScopedRepository`
 *
 * `organization_id` is nullable here — it names the *subject* of an
 * intervention, and killing a policy or rotating a verifier key has no subject
 * tenant. The scoped base class asserts the column is constrained on every read
 * and write, which is the correct rule for a table where the column is the
 * tenant boundary and the wrong one where it is a nullable attribute.
 *
 * The boundary this table actually needs is the opposite of the usual one: the
 * register is read by operators, across tenants, by design. What must not
 * happen is a *provider* reading it, and that is enforced by which guard the
 * route sits behind, not by a predicate.
 *
 * ## There is no update method, and there will not be one
 *
 * `trg_override_log_entries_append_only` refuses `UPDATE` and `DELETE` at the
 * database. The absence here is the second hedge and the entity's lack of a
 * mutator is the third. None is sufficient alone — a trigger cannot stop a
 * developer writing a second write path, a missing method cannot stop `psql`,
 * and neither can stop a superuser. Together they cover every route this table
 * has actually been corrupted through anywhere it has been built before.
 */
@Injectable()
export class OverrideLogEntryRepository extends AbstractRepository<OverrideLogEntryEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OverrideLogEntryEntity, dataSource);
  }

  /**
   * Append one entry, inside the caller's transaction.
   *
   * `queryRunner` is not optional by accident. Every writer of this table is
   * also mutating something else — a case, a binding, a deadline — and the two
   * writes have to commit together or the register is a record of *some* of
   * what happened. `OverrideLogService` is the only caller, and it opens the
   * transaction; there is no path that writes the log without the mutation, and
   * none that writes the mutation without the log.
   */
  async append(
    queryRunner: QueryRunner,
    entry: Partial<OverrideLogEntryEntity>,
  ): Promise<OverrideLogEntryEntity> {
    const row = queryRunner.manager.create(OverrideLogEntryEntity, entry);
    return queryRunner.manager.save(OverrideLogEntryEntity, row);
  }

  /**
   * The console's feed, filtered.
   *
   * Keyset on `(created_at DESC, id DESC)`, matching
   * `idx_override_log_entries_feed` and the surface-wide cursor contract. An
   * offset would be wrong here for the ordinary reason — the table is
   * append-heavy and a row arriving mid-read shifts every page — and for one
   * specific to this table: the reader is usually working an incident, so the
   * head is exactly where new rows are appearing while they read.
   */
  /**
   * The console's feed, filtered — as a builder for `paginate` to finish.
   *
   * The keyset predicate and the cursor are `@shared/api`'s, not this file's:
   * cursor arithmetic lives in exactly one place, and a list that encodes its
   * own position is what `surface-consistency.spec.ts` fails the build on.
   * What belongs here is the *filtering*, which is specific to a register.
   */
  feedQueryBuilder(filter: OverrideLogFilter): SelectQueryBuilder<OverrideLogEntryEntity> {
    const qb = this.createQueryBuilder('entry');

    if (filter.family) qb.andWhere('entry.family = :family', { family: filter.family });
    if (filter.actorOperatorId) {
      qb.andWhere('entry.actor_operator_id = :actor', { actor: filter.actorOperatorId });
    }
    if (filter.targetType) {
      qb.andWhere('entry.target_type = :targetType', { targetType: filter.targetType });
    }
    if (filter.targetId) qb.andWhere('entry.target_id = :targetId', { targetId: filter.targetId });
    if (filter.ticketRef) qb.andWhere('entry.ticket_ref = :ticket', { ticket: filter.ticketRef });

    if (filter.search) {
      // `plainto_tsquery`, not `to_tsquery`: the input is whatever an operator
      // typed into a search box during an incident, and `to_tsquery` throws a
      // syntax error on an unbalanced quote. A search that 500s on a stray
      // apostrophe is a search nobody trusts at 03:00.
      //
      // The console's box reads "who, reason, ticket", so the same term also
      // matches the ticket and the actor's or approver's display name or email,
      // literally (`containsLikePattern` escapes `%` and `_`). The exact-match
      // `actorOperatorId` / `ticketRef` filters stay the precise ones.
      qb.andWhere(
        `(to_tsvector('simple', entry.reason) @@ plainto_tsquery('simple', :search)` +
          ` OR entry.ticket_ref ILIKE :searchLike` +
          ` OR EXISTS (SELECT 1 FROM operators op` +
          ` WHERE op.id IN (entry.actor_operator_id, entry.approver_operator_id)` +
          ` AND (op.display_name ILIKE :searchLike OR op.email ILIKE :searchLike)))`,
        { search: filter.search, searchLike: containsLikePattern(filter.search) },
      );
    }

    return qb;
  }

  /** Every entry against one target, oldest first — the object's own history. */
  async findByTarget(targetType: string, targetId: string): Promise<OverrideLogEntryEntity[]> {
    return this.createQueryBuilder('entry')
      .where('entry.target_type = :targetType', { targetType })
      .andWhere('entry.target_id = :targetId', { targetId })
      .orderBy('entry.created_at', 'ASC')
      .getMany();
  }
}
