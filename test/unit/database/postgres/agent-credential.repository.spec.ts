import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';

/**
 * `findByTokenHash` is the one deliberate cross-tenant read on this table —
 * same shape as `SlashProposalRepository.tenantOf` and
 * `ToolRequestRepository.tenantOf`. A session source authenticating a bearer
 * token cannot supply an `organizationId`: discovering which tenant issued
 * the credential *is* the lookup. So this is exercised against a stubbed
 * `dataSource.manager` — proving the query goes through `this.manager
 * .createQueryBuilder(...)`, which bypasses `OrganizationScopedRepository`'s
 * guard on purpose, rather than through `this.createQueryBuilder(...)`,
 * which would reject it as `ORGANIZATION_SCOPE_MISSING`.
 */
function buildRepository() {
  let resultRow: AgentCredentialEntity | null = null;
  const wheres: Array<{ sql: string; params: Record<string, unknown> }> = [];

  const qb: any = {
    where(sql: string, params: Record<string, unknown> = {}) {
      wheres.push({ sql, params });
      return qb;
    },
    getOne: jest.fn().mockImplementation(async () => resultRow),
  };

  const manager = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    connection: {
      getMetadata: () => ({ target: AgentCredentialEntity, name: 'AgentCredentialEntity' }),
    },
  };

  const dataSource = { manager } as unknown as DataSource;
  const repository = new AgentCredentialRepository(dataSource);

  return {
    repository,
    manager,
    wheres,
    setResult(row: AgentCredentialEntity | null) {
      resultRow = row;
    },
  };
}

function buildCredential(overrides: Partial<AgentCredentialEntity> = {}): AgentCredentialEntity {
  return {
    id: 'cred-1',
    organizationId: 'org-1',
    agentId: 'agent-1',
    name: 'CI deploy',
    tokenLast4: '2fds',
    tokenHash: 'digest-of-token',
    scopes: [],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    rotatedFromId: null,
    ...overrides,
  } as AgentCredentialEntity;
}

describe('AgentCredentialRepository.findByTokenHash', () => {
  it('finds the credential across tenants by the token digest alone', async () => {
    const { repository, manager, setResult, wheres } = buildRepository();
    const credential = buildCredential();
    setResult(credential);

    const found = await repository.findByTokenHash('digest-of-token');

    expect(found).toBe(credential);
    // Went through `manager.createQueryBuilder`, not the guarded
    // `this.createQueryBuilder` — the deliberate bypass.
    expect(manager.createQueryBuilder).toHaveBeenCalledWith(AgentCredentialEntity, 'credential');
    expect(wheres).toEqual([
      { sql: 'credential.token_hash = :tokenHash', params: { tokenHash: 'digest-of-token' } },
    ]);
  });

  it('returns null when no credential has that digest', async () => {
    const { repository, setResult } = buildRepository();
    setResult(null);

    const found = await repository.findByTokenHash('no-such-digest');

    expect(found).toBeNull();
  });

  it('returns a revoked credential rather than hiding it — revocation is the caller’s call', async () => {
    const { repository, setResult } = buildRepository();
    const revoked = buildCredential({ revokedAt: new Date('2026-01-01T00:00:00Z') });
    setResult(revoked);

    const found = await repository.findByTokenHash('digest-of-token');

    expect(found).toBe(revoked);
    expect(found?.revokedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });
});
