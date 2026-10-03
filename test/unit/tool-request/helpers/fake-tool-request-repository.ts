import { randomUUID } from 'node:crypto';

import { ToolRequestEntity } from '@database/postgres/entities/tool-request.entity';

/**
 * Hand-written fake, matching `test/unit/slash/helpers/fake-slash-repositories.ts`
 * (`FakeSlashProposals`).
 *
 * No `jest.mock` of the repository: what these tests need to assert is what
 * the row ends up saying (status, the two clocks, who owns it), and a fake
 * that holds rows can answer that where a mock asserting "was called with"
 * cannot.
 *
 * Covers the CRUD-shaped methods `ToolRequestService` and
 * `ToolRequestQueueService` call directly. `createQueryBuilder` /
 * `queueQueryBuilder` — the two list endpoints — are faked separately with
 * `fakeQueryBuilder` in this same `helpers/` directory, the pattern every
 * other module with a `paginate()` caller uses (see
 * `test/unit/account/helpers/fake-query-builder.ts`): a query builder
 * generates SQL, and a `Map` cannot stand in for that.
 */
export class FakeToolRequestRepository {
  readonly rows = new Map<string, ToolRequestEntity>();

  /** Records every CAS attempt, so a test can prove which predicate refused. */
  readonly transitions: {
    id: string;
    from: readonly string[];
    to: string;
    affected: number;
  }[] = [];

  seed(
    overrides: Partial<ToolRequestEntity> & { id: string; organizationId: string },
  ): ToolRequestEntity {
    const row = Object.assign(
      new ToolRequestEntity(),
      {
        requestedByAgentId: 'agent_1',
        title: 'A tool that does not exist yet',
        description: 'Please build it',
        upstreamUrl: null,
        expectedMonthlyCalls: null,
        status: 'OPEN',
        ownerOperatorId: null,
        firstResponseDueAt: new Date('2026-08-26T10:00:00.000Z'),
        firstRespondedAt: null,
        resolutionNote: null,
        closedAt: null,
        createdAt: new Date('2026-08-24T10:00:00.000Z'),
        updatedAt: new Date('2026-08-24T10:00:00.000Z'),
        version: 1,
      },
      overrides,
    );
    this.rows.set(row.id, row);
    return row;
  }

  async save(entity: ToolRequestEntity): Promise<ToolRequestEntity> {
    if (!entity.id) entity.id = randomUUID();
    if (!entity.createdAt) entity.createdAt = new Date();
    entity.updatedAt = new Date();
    if (entity.version === undefined || entity.version === null) entity.version = 1;
    this.rows.set(entity.id, entity);
    return entity;
  }

  async findOneBy(where: {
    organizationId: string;
    id?: string;
  }): Promise<ToolRequestEntity | null> {
    for (const row of this.rows.values()) {
      if (row.organizationId !== where.organizationId) continue;
      if (where.id !== undefined && row.id !== where.id) continue;
      return row;
    }
    return null;
  }

  async findOneScoped(organizationId: string, id: string): Promise<ToolRequestEntity | null> {
    return this.findOneBy({ organizationId, id });
  }

  async tenantOf(id: string): Promise<string | null> {
    return this.rows.get(id)?.organizationId ?? null;
  }

  async transitionIfIn(
    organizationId: string,
    id: string,
    expectedFrom: readonly string[],
    patch: Partial<ToolRequestEntity> & { status: string },
  ): Promise<number> {
    const row = this.rows.get(id);
    const affected =
      row !== undefined &&
      row.organizationId === organizationId &&
      expectedFrom.includes(row.status)
        ? 1
        : 0;

    this.transitions.push({ id, from: expectedFrom, to: patch.status, affected });

    if (affected === 1 && row !== undefined) {
      Object.assign(row, patch);
      row.updatedAt = new Date();
    }

    return affected;
  }
}
