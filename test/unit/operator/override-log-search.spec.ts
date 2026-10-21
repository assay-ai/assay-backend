import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';

/**
 * BUG-OPS-CORE-03: the Activity box reads "who, reason, ticket", so `q`
 * must match the ticket and the actor/approver as well as the reason.
 */
describe('OverrideLogEntryRepository.feedQueryBuilder search', () => {
  function capture(search: string): { sql: string; params: Record<string, unknown> } {
    const where: { sql: string; params: Record<string, unknown> }[] = [];
    const qb = {
      andWhere: jest.fn((sql: string, params: Record<string, unknown> = {}) => {
        where.push({ sql, params });
        return qb;
      }),
    };
    const repository = Object.create(OverrideLogEntryRepository.prototype) as OverrideLogEntryRepository;
    (repository as unknown as { createQueryBuilder: () => unknown }).createQueryBuilder = () => qb;

    repository.feedQueryBuilder({ search });

    expect(where).toHaveLength(1);
    return where[0];
  }

  it('matches the reason, the ticket and the actor or approver name and email', () => {
    const { sql, params } = capture('E2E-OPS-CORE-T1');

    expect(sql).toContain("to_tsvector('simple', entry.reason)");
    expect(sql).toContain('entry.ticket_ref ILIKE :searchLike');
    expect(sql).toContain('entry.actor_operator_id, entry.approver_operator_id');
    expect(sql).toContain('op.display_name ILIKE :searchLike');
    expect(sql).toContain('op.email ILIKE :searchLike');
    expect(params).toEqual({ search: 'E2E-OPS-CORE-T1', searchLike: '%E2E-OPS-CORE-T1%' });
  });

  it('matches LIKE wildcards literally', () => {
    const { params } = capture('50%_a');

    expect(params.searchLike).toBe('%50\\%\\_a%');
  });
});
