import { DataSource } from 'typeorm';

import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { SortDirection } from '@shared/api';

import { buildAgent } from '../../auth/helpers/fake-agent-repository';
import { fakeQueryBuilder } from '../../account/helpers/fake-query-builder';

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

/**
 * `AgentRepository` is a plain `AbstractRepository`, so `this.createQueryBuilder(...)`
 * is TypeORM's own — it resolves through `manager.connection.getMetadata` and
 * delegates to `manager.createQueryBuilder`. Stubbing exactly those two, and
 * nothing else, is the same technique `organization-scoped.repository.spec.ts`
 * uses to exercise a repository without a live Postgres.
 */
function buildRepository(rows: AgentEntity[]) {
  const fake = fakeQueryBuilder(rows);
  const manager = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    connection: {
      getMetadata: () => ({ target: AgentEntity, name: 'AgentEntity' }),
    },
  };

  const dataSource = { manager } as unknown as DataSource;
  const repository = new AgentRepository(dataSource);

  return { repository, manager, fake };
}

describe('AgentRepository.list', () => {
  it('constrains organizationId by hand — there is no OrganizationScopedRepository guard on this table', async () => {
    const { repository, fake } = buildRepository([]);

    await repository.list(ORGANIZATION_ID, baseQuery());

    expect(fake.wheres[0]).toEqual({
      sql: 'agent.organizationId = :organizationId',
      params: { organizationId: ORGANIZATION_ID },
    });
  });

  it('orders by created_at with id as the tiebreak', async () => {
    const { repository, fake } = buildRepository([]);

    await repository.list(ORGANIZATION_ID, baseQuery());

    expect(fake.orders).toEqual([
      ['agent.created_at', 'DESC'],
      ['agent.id', 'DESC'],
    ]);
  });

  it('returns the page the query builder produced', async () => {
    const row = buildAgent({ id: 'agent-1', organizationId: ORGANIZATION_ID });
    const { repository } = buildRepository([row]);

    const page = await repository.list(ORGANIZATION_ID, baseQuery());

    expect(page.items).toEqual([row]);
    expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });

  it('applies limit + 1 so hasMore can be answered honestly', async () => {
    const { repository, fake } = buildRepository([]);

    await repository.list(ORGANIZATION_ID, baseQuery({ limit: 10 }));

    expect(fake.taken).toBe(11);
  });

  it('applies from/to as a real filter on agents.created_at — it is no longer a no-op', async () => {
    const { repository, fake } = buildRepository([]);
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-09-01T00:00:00.000Z');

    await repository.list(ORGANIZATION_ID, baseQuery({ from, to }));

    expect(fake.wheres).toContainEqual({
      sql: 'agent.created_at >= :__from',
      params: { __from: from },
    });
    expect(fake.wheres).toContainEqual({
      sql: 'agent.created_at < :__to',
      params: { __to: to },
    });
  });
});
