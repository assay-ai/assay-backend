import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { SortDirection } from '@shared/api';
import { digestToken } from '@shared/crypto/token-digest';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_AGENT_ID = '55555555-5555-5555-5555-555555555555';
const CREDENTIAL_ID = '33333333-3333-3333-3333-333333333333';
const ACTOR = { type: 'user' as const, id: 'cred-actor' };

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    agentId: AGENT_ID,
    name: 'CI deploy',
    prefix: 'x402_sk_live_abc123',
    tokenHash: 'deadbeef',
    scopes: ['tools:call'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    rotatedFromId: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

function buildHarness(rows: ReturnType<typeof credentialRow>[] = []) {
  const fake = fakeQueryBuilder(rows);
  const credentials = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(async (entity: Record<string, unknown>) => ({
      id: CREDENTIAL_ID,
      createdAt: new Date('2026-08-10T10:00:00.000Z'),
      ...entity,
    })),
    findOneBy: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const agents = {
    findById: jest.fn(async (id: string) =>
      id === AGENT_ID ? { id, organizationId: ORGANIZATION_ID } : null,
    ),
  };

  // The writes go through the transaction's manager; it forwards to the same
  // spies the assertions below read.
  const manager = {
    save: jest.fn((_entity: unknown, row: Record<string, unknown>) => credentials.save(row)),
    update: jest.fn((_entity: unknown, criteria: unknown, values: unknown) =>
      (credentials.update as jest.Mock)(criteria, values),
    ),
  };
  const dataSource = {
    transaction: jest.fn(async (work: (m: unknown) => unknown) => work(manager)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new AgentCredentialsService(
    credentials as any,
    agents as any,
    dataSource as any,
    audit as any,
  );
  return { service, fake, credentials, agents, manager, dataSource, audit };
}

describe('AgentCredentialsService.list', () => {
  it('scopes to organization and agent', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(fake.wheres).toEqual([
      {
        sql: 'credential.organizationId = :organizationId',
        params: { organizationId: ORGANIZATION_ID },
      },
      { sql: 'credential.agentId = :agentId', params: { agentId: AGENT_ID } },
    ]);
  });

  it('never includes tokenHash on the wire', async () => {
    const { service } = buildHarness([credentialRow()]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0]).not.toHaveProperty('tokenHash');
    expect(Object.keys(page.items[0])).toEqual([
      'id',
      'agentId',
      'name',
      'prefix',
      'scopes',
      'lastUsedAt',
      'expiresAt',
      'revokedAt',
      'rotatedFromId',
      // Agent payment delegation: the delegate key this credential proved it holds.
      'delegateAccount',
      'delegateBoundAt',
      'createdAt',
    ]);
  });
});

describe('AgentCredentialsService.create', () => {
  it('refuses an agent that does not exist, before minting anything', async () => {
    const { service, credentials } = buildHarness();

    await expectErrorCodeAsync(
      () => service.create(ORGANIZATION_ID, OTHER_AGENT_ID, { name: 'orphan' }, ACTOR),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it("refuses another organization's agent with the same 404", async () => {
    const { service, credentials, agents } = buildHarness();
    agents.findById.mockResolvedValueOnce({
      id: AGENT_ID,
      organizationId: '99999999-9999-9999-9999-999999999999',
    });

    await expectErrorCodeAsync(
      () => service.create(ORGANIZATION_ID, AGENT_ID, { name: 'cross-tenant' }, ACTOR),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it('returns the full token exactly once and stores only its hash', async () => {
    const { service, credentials } = buildHarness();

    const response = await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'CI deploy' }, ACTOR);

    expect(response.token).toMatch(/^x402_sk_live_/);
    expect(response.token.startsWith(response.prefix)).toBe(true);
    expect(response.prefix).toHaveLength(20);
    expect(response.prefix.length).toBeLessThan(response.token.length);

    const created = credentials.create.mock.calls[0][0];
    expect(created.tokenHash).not.toBe(response.token);
    expect(created.tokenHash).toHaveLength(64); // sha256 hex
    expect(created).not.toHaveProperty('token');
  });

  it('defaults scopes to an empty array and expiresAt to null', async () => {
    const { service } = buildHarness();
    const response = await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'no scopes' }, ACTOR);

    expect(response.scopes).toEqual([]);
    expect(response.expiresAt).toBeNull();
  });

  it('two credentials for the same agent get different tokens and different hashes', async () => {
    const { service, credentials } = buildHarness();

    await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'one' }, ACTOR);
    await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'two' }, ACTOR);

    const [first, second] = credentials.create.mock.calls.map((call) => call[0]);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });

  it('scopes the written row to the caller organization and named agent', async () => {
    const { service, credentials } = buildHarness();
    await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'CI deploy' }, ACTOR);

    const created = credentials.create.mock.calls[0][0];
    expect(created.organizationId).toBe(ORGANIZATION_ID);
    expect(created.agentId).toBe(AGENT_ID);
  });
});

describe('AgentCredentialsService.revoke', () => {
  it('returns ACCOUNT_CREDENTIAL_NOT_FOUND for a cross-organization or missing id', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(null);

    await expectErrorCodeAsync(
      () => service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR),
      AccountErrorCode.ACCOUNT_CREDENTIAL_NOT_FOUND,
    );
  });

  it('returns ACCOUNT_CREDENTIAL_NOT_FOUND when the credential belongs to a different agent', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow({ agentId: OTHER_AGENT_ID }));

    await expectErrorCodeAsync(
      () => service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR),
      AccountErrorCode.ACCOUNT_CREDENTIAL_NOT_FOUND,
    );
    expect(credentials.update).not.toHaveBeenCalled();
  });

  it('sets revoked_at and revoked_by rather than deleting the row', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(credentials.update).toHaveBeenCalledWith(
      { organizationId: ORGANIZATION_ID, id: CREDENTIAL_ID },
      { revokedAt: expect.any(Date), revokedBy: 'cred-actor' },
    );
  });

  it('is idempotent — revoking an already-revoked credential does not overwrite the original time', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(
      credentialRow({ revokedAt: new Date('2026-08-01T00:00:00.000Z'), revokedBy: 'someone-else' }),
    );

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(credentials.update).not.toHaveBeenCalled();
  });
});

describe('AgentCredentialsService — audit log (BUG-R2-B4-01)', () => {
  it('records credential.created in the transaction that saves the credential', async () => {
    const { service, audit, manager, dataSource } = buildHarness();

    const response = await service.create(
      ORGANIZATION_ID,
      AGENT_ID,
      { name: 'CI deploy', scopes: ['tools:call'] },
      ACTOR,
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(manager, {
      organizationId: ORGANIZATION_ID,
      actor: ACTOR,
      action: 'credential.created',
      resourceType: 'agent_credential',
      resourceId: CREDENTIAL_ID,
      before: null,
      after: { agentId: AGENT_ID, name: 'CI deploy', scopes: ['tools:call'], expiresAt: null },
    });

    // Neither the token, its stored prefix nor its hash is in the entry.
    const recorded = JSON.stringify(audit.record.mock.calls[0][1]);
    expect(recorded).not.toContain(response.token);
    expect(recorded).not.toContain(response.prefix);
    expect(recorded).not.toContain(digestToken(response.token));
  });

  it('fails the create when the audit entry cannot be recorded', async () => {
    const { service, audit } = buildHarness();
    audit.record.mockRejectedValue(new Error('audit down'));

    await expect(
      service.create(ORGANIZATION_ID, AGENT_ID, { name: 'CI deploy' }, ACTOR),
    ).rejects.toThrow('audit down');
  });

  it('records credential.revoked in the transaction that revokes it', async () => {
    const { service, credentials, audit, manager } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    const revokedAt = (credentials.update.mock.calls[0][1] as { revokedAt: Date }).revokedAt;
    expect(audit.record).toHaveBeenCalledWith(manager, {
      organizationId: ORGANIZATION_ID,
      actor: ACTOR,
      action: 'credential.revoked',
      resourceType: 'agent_credential',
      resourceId: CREDENTIAL_ID,
      before: { revokedAt: null },
      after: { revokedAt: revokedAt.toISOString(), name: 'CI deploy' },
    });
    expect(JSON.stringify(audit.record.mock.calls[0][1])).not.toContain('deadbeef');
  });

  it('records nothing for a credential that was already revoked, or is not found', async () => {
    const { service, credentials, audit } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow({ revokedAt: new Date() }));
    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    credentials.findOneBy.mockResolvedValue(null);
    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR).catch(() => undefined);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails the revoke when the audit entry cannot be recorded', async () => {
    const { service, credentials, audit } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());
    audit.record.mockRejectedValue(new Error('audit down'));

    await expect(service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR)).rejects.toThrow(
      'audit down',
    );
  });
});
