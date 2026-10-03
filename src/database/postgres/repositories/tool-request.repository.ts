import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';

import { ToolRequestEntity } from '../entities/tool-request.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `tool_requests`. Modelled on `SlashProposalRepository`, which is the
 * established pattern in this codebase for a table that is organization-scoped
 * for its own tenant's reads and deliberately cross-tenant for the operator's
 * queue.
 */
@Injectable()
export class ToolRequestRepository extends OrganizationScopedRepository<ToolRequestEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolRequestEntity, dataSource);
  }

  async findOneScoped(organizationId: string, id: string): Promise<ToolRequestEntity | null> {
    return this.findOneBy({ organizationId, id });
  }

  /**
   * Which tenant a request belongs to.
   *
   * The one deliberate cross-tenant *point* read on this surface — same role
   * as `SlashProposalRepository.tenantOf`: it is how an operator route starts
   * from an id alone, and everything the caller does afterwards is scoped to
   * what this returned, so the base class's guard is entered one step later
   * rather than weakened.
   *
   * Returns null for an id that does not exist, and the caller turns that
   * into the same 404 a deleted request would give — never a 403, so an id
   * cannot be used to probe whether it belongs to someone else.
   */
  async tenantOf(id: string): Promise<string | null> {
    const row = await this.manager
      .createQueryBuilder(ToolRequestEntity, 'request')
      .select('request.organization_id', 'organizationId')
      .where('request.id = :id', { id })
      .getRawOne<{ organizationId: string }>();
    return row?.organizationId ?? null;
  }

  /**
   * The operator queue, as a query builder for `paginate` to finish.
   *
   * Deliberately cross-organization, for the reason `SlashProposalRepository
   * .queueQueryBuilder` gives for its own queue: the caller is a platform
   * operator with no tenant of their own, reached only through
   * `OperatorAuthGuard`, never `SessionAuthGuard`. The base class's guard
   * stops a request-serving query that *forgot* its tenant; it cannot stop a
   * deliberate act, and this is one.
   *
   * Filtered to `first_responded_at IS NULL` — the migration's own partial
   * index (`idx_tool_requests_awaiting_response`) exists for exactly this
   * predicate — because the tool request queue is "oldest-unanswered first",
   * not every request ever filed. A request already answered belongs to the
   * requester's own history (`GET /tool-requests/:id`), not to a queue an
   * operator is meant to work down.
   */
  queueQueryBuilder(): SelectQueryBuilder<ToolRequestEntity> {
    return this.manager
      .createQueryBuilder(ToolRequestEntity, 'request')
      .where('request.first_responded_at IS NULL');
  }

  /**
   * Move the case, but only from where the caller thought it was.
   *
   * Same compare-and-swap shape as `SlashProposalRepository.transitionIfIn`,
   * and for the same reason: an operator's click and a retried request both
   * reach this method, and zero rows affected means somebody else answered it
   * first — not an error, a race the caller gets to interpret.
   */
  async transitionIfIn(
    organizationId: string,
    id: string,
    expectedFrom: readonly string[],
    patch: Partial<ToolRequestEntity> & { status: string },
  ): Promise<number> {
    const result = await this.createQueryBuilder('request')
      .update()
      .set(patch)
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .andWhere('status IN (:...expectedFrom)', { expectedFrom })
      .execute();
    return result.affected ?? 0;
  }
}
