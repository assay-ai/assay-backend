import { AuditLogService } from '@modules/account/services/audit-log.service';
import { SortDirection } from '@shared/api';

import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    actorType: 'user',
    actorId: 'user-1',
    action: 'credential.revoked',
    resourceType: 'agent_credential',
    resourceId: 'cred-1',
    before: null,
    after: null,
    ipAddress: null,
    userAgent: null,
    requestId: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

function buildHarness(rows: ReturnType<typeof entryRow>[] = []) {
  const fake = fakeQueryBuilder(rows);
  const auditLog = { createQueryBuilder: jest.fn().mockReturnValue(fake.qb) };
  const service = new AuditLogService(auditLog as any);
  return { service, fake, auditLog };
}

describe('AuditLogService.list', () => {
  it('scopes to the caller organization', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery());

    expect(fake.wheres[0]).toEqual({
      sql: 'entry.organizationId = :organizationId',
      params: { organizationId: ORGANIZATION_ID },
    });
  });

  it.each([
    ['actorId', 'entry.actorId = :actorId', 'actorId', 'user-1'],
    ['action', 'entry.action = :action', 'action', 'credential.revoked'],
    ['resourceType', 'entry.resourceType = :resourceType', 'resourceType', 'agent_credential'],
    ['resourceId', 'entry.resourceId = :resourceId', 'resourceId', 'cred-1'],
  ])('filters on %s as an exact match', async (field, sql, param, value) => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery({ [field]: value }));

    expect(fake.wheres).toContainEqual({ sql, params: { [param]: value } });
  });

  it('matches % and _ in the search literally, not as wildcards', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery({ search: '50%_a\\b' }));

    expect(fake.wheres.some((w) => w.params.search === '%50\\%\\_a\\\\b%')).toBe(true);
  });

  it('filters on search across actor, action and resource (BUG-R2-B4-02)', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery({ search: 'zzz' }));

    const where = fake.wheres.find((w) => w.params.search === '%zzz%');
    expect(where?.sql).toMatch(/entry\.actorId ILIKE :search/);
    expect(where?.sql).toMatch(/entry\.action ILIKE :search/);
    expect(where?.sql).toMatch(/entry\.resourceId ILIKE :search/);
  });

  it('maps every column onto the wire DTO', async () => {
    const { service } = buildHarness([entryRow()]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0]).toEqual(entryRow());
  });
});
