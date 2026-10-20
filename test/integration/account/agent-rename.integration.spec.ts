import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AuditLogEntryRepository } from '@database/postgres/repositories/audit-log-entry.repository';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { AgentsService } from '@modules/account/services/agents.service';
import { AuditLogService } from '@modules/account/services/audit-log.service';
import { SortDirection } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import { expectErrorCodeAsync } from '../../unit/helpers/expect-error-code';
import {
  ensureTestDatabase,
  resetSchemaIfMigrationsChanged,
  testConnectionOptions,
} from '../helpers/test-database';

/**
 * `PATCH /agents/:agentId` against the real migrations: the label is the only
 * column that changes, the audit row lands in the same transaction, and one
 * organization can never rename another's agent.
 */
describe('AgentsService.rename — real rows', () => {
  const DATABASE = 'assay_agent_rename_test';
  let dataSource: DataSource;
  let agents: AgentRepository;
  let service: AgentsService;
  let reader: AuditLogService;
  let writer: AuditLogWriter;
  const actor: AuditActor = { type: 'user', id: 'login-session-1' };
  const config = { get: (_key: string, fallback: string) => fallback } as any;

  beforeAll(async () => {
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [OrganizationEntity, AgentEntity, AgentCredentialEntity, AuditLogEntryEntity],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await resetSchemaIfMigrationsChanged(dataSource);
    await dataSource.runMigrations({ transaction: 'each' });

    agents = new AgentRepository(dataSource);
    writer = new AuditLogWriter(dataSource);
    reader = new AuditLogService(new AuditLogEntryRepository(dataSource));
    service = new AgentsService(
      agents,
      new AgentCredentialRepository(dataSource),
      config,
      dataSource,
      writer,
    );
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  afterEach(() => jest.restoreAllMocks());

  const provision = () =>
    agents.createWithOrganization({
      privyUserId: `did:privy:${randomUUID()}`,
      email: 'dan@example.com',
      organizationName: 'dan',
      createdVia: 'PRIVY_SIGNUP',
      label: 'My agent',
    });

  const entries = async (organizationId: string) =>
    (await reader.list(organizationId, { limit: 100, order: SortDirection.DESC } as any)).items;

  it('changes the label and nothing else, and records agent.renamed', async () => {
    const agent = await provision();
    const before = await agents.findById(agent.id);

    const renamed = await service.rename(agent.organizationId, agent.id, 'Research bot', actor);

    expect(renamed.label).toBe('Research bot');
    const after = await agents.findById(agent.id);
    expect(after).toMatchObject({
      ...before,
      label: 'Research bot',
      updatedAt: expect.any(Date),
      version: expect.any(Number),
    });
    expect(after?.email).toBe('dan@example.com');
    expect(after?.status).toBe('ACTIVE');

    const [entry] = await entries(agent.organizationId);
    expect(entry).toMatchObject({
      action: 'agent.renamed',
      actorType: 'user',
      actorId: 'login-session-1',
      resourceType: 'agent',
      resourceId: agent.id,
      before: { label: 'My agent' },
      after: { label: 'Research bot' },
    });
  });

  it("refuses another organization's agent and leaves its row and log untouched", async () => {
    const mine = await provision();
    const theirs = await provision();

    await expectErrorCodeAsync(
      () => service.rename(mine.organizationId, theirs.id, 'Mine now', actor),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );

    expect((await agents.findById(theirs.id))?.label).toBe('My agent');
    expect(await entries(theirs.organizationId)).toEqual([]);
    expect(await entries(mine.organizationId)).toEqual([]);
  });

  it('a failed audit write rolls the rename back', async () => {
    const agent = await provision();
    jest.spyOn(writer, 'record').mockRejectedValueOnce(new Error('audit down'));

    await expect(
      service.rename(agent.organizationId, agent.id, 'Research bot', actor),
    ).rejects.toThrow('audit down');

    expect((await agents.findById(agent.id))?.label).toBe('My agent');
  });
});
