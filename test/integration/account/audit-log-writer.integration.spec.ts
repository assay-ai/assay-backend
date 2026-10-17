import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { NotificationChannelEntity } from '@database/postgres/entities/notification-channel.entity';
import { NotificationPreferenceEntity } from '@database/postgres/entities/notification-preference.entity';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AuditLogEntryRepository } from '@database/postgres/repositories/audit-log-entry.repository';
import { NotificationChannelRepository } from '@database/postgres/repositories/notification-channel.repository';
import { NotificationPreferenceRepository } from '@database/postgres/repositories/notification-preference.repository';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { AuditLogService } from '@modules/account/services/audit-log.service';
import { NOTIFICATION_CATALOGUE } from '@modules/notification/constants/notification-catalogue';
import {
  NotificationChannel,
  NotificationEvent,
} from '@modules/notification/ports/notification.port';
import { NotificationSettingsService } from '@modules/notification/services/notification-settings.service';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';
import { SortDirection } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';
import { digestToken } from '@shared/crypto/token-digest';
import { RequestContext } from '@shared/observability';

import { USDC_ASSET, ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * BUG-R2-B4-01, against the real migrations: every audited write appends its
 * `audit_log_entries` row in the same transaction, the row never carries a
 * secret, and one organization never reads another's entries.
 */
describe('audit_log_entries — the writer and its call sites', () => {
  const DATABASE = 'x402_audit_log_writer_test';
  let dataSource: DataSource;
  let writer: AuditLogWriter;
  let reader: AuditLogService;
  let policies: SpendPolicyService;
  let credentials: AgentCredentialsService;
  let settings: NotificationSettingsService;

  // Fresh per test: the database outlives a run.
  let organizationId: string;
  let otherOrganizationId: string;
  let agentId: string;
  const actor: AuditActor = { type: 'user', id: 'login-session-1' };
  const page = { limit: 100, order: SortDirection.DESC } as any;

  beforeAll(async () => {
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [
        AuditLogEntryEntity,
        SpendPolicyEntity,
        AgentCredentialEntity,
        NotificationChannelEntity,
        NotificationPreferenceEntity,
      ],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });

    writer = new AuditLogWriter(dataSource);
    reader = new AuditLogService(new AuditLogEntryRepository(dataSource));
    policies = new SpendPolicyService(new SpendPolicyRepository(dataSource), dataSource, writer);
    // The agent lookup is not under test: every agent id belongs to the caller.
    const agents = {
      findById: async (id: string) => ({ id, organizationId }),
    } as unknown as AgentRepository;
    credentials = new AgentCredentialsService(
      new AgentCredentialRepository(dataSource),
      agents,
      dataSource,
      writer,
    );
    settings = new NotificationSettingsService(
      new NotificationChannelRepository(dataSource),
      new NotificationPreferenceRepository(dataSource),
      {} as any,
      {} as any,
      dataSource,
      writer,
    );
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(() => {
    organizationId = randomUUID();
    otherOrganizationId = randomUUID();
    agentId = randomUUID();
    jest.restoreAllMocks();
  });

  const entries = async (organization = organizationId) =>
    (await reader.list(organization, page)).items;

  it('spend policy: created, then updated and paused, each with its actor and request id', async () => {
    await RequestContext.run({ requestId: 'req-policy-1', organizationId }, async () => {
      await policies.patch(
        organizationId,
        agentId,
        { assetId: USDC_ASSET, decimals: 6, dailyCap: '1000000' },
        actor,
      );
      await policies.patch(organizationId, agentId, { dailyCap: '2000000' }, actor);
      await policies.patch(organizationId, agentId, { paused: true }, actor);
    });

    const [paused, updated, created] = await entries();
    expect(created).toMatchObject({
      actorType: 'user',
      actorId: 'login-session-1',
      action: 'spend_policy.created',
      resourceType: 'spend_policy',
      before: null,
      after: { dailyCap: '1000000', paused: false, policyVersion: 1 },
      requestId: 'req-policy-1',
      ipAddress: null,
      userAgent: null,
    });
    expect(updated).toMatchObject({
      action: 'spend_policy.updated',
      before: { dailyCap: '1000000', policyVersion: 1 },
      after: { dailyCap: '2000000', policyVersion: 2 },
    });
    expect(paused).toMatchObject({
      action: 'spend_policy.updated',
      before: { paused: false, policyVersion: 2 },
      after: { paused: true, policyVersion: 3 },
    });

    // Each entry names the version row it describes.
    const live = await dataSource.query(
      `SELECT "id" FROM "spend_policies" WHERE "organization_id" = $1 AND "superseded_at" IS NULL`,
      [organizationId],
    );
    expect(paused.resourceId).toBe(live[0].id);
  });

  it('spend policy: a request that changes nothing writes no version and no entry', async () => {
    await policies.patch(
      organizationId,
      agentId,
      { assetId: USDC_ASSET, decimals: 6, dailyCap: '1000000' },
      actor,
    );

    const unchanged = await policies.patch(organizationId, agentId, { dailyCap: '1000000' }, actor);

    expect(unchanged.policyVersion).toBe(1);
    const rows = await dataSource.query(
      `SELECT "policy_version", "superseded_at" FROM "spend_policies" WHERE "organization_id" = $1`,
      [organizationId],
    );
    expect(rows).toEqual([{ policy_version: 1, superseded_at: null }]);
    expect((await entries()).map((entry) => entry.action)).toEqual(['spend_policy.created']);
  });

  it('spend policy: a failed audit write rolls the version back', async () => {
    await policies.patch(organizationId, agentId, { assetId: USDC_ASSET, decimals: 6 }, actor);
    jest.spyOn(writer, 'record').mockRejectedValueOnce(new Error('audit down'));

    await expect(policies.patch(organizationId, agentId, { paused: true }, actor)).rejects.toThrow(
      'audit down',
    );

    const rows = await dataSource.query(
      `SELECT "policy_version", "paused", "superseded_at" FROM "spend_policies" WHERE "organization_id" = $1`,
      [organizationId],
    );
    expect(rows).toEqual([{ policy_version: 1, paused: false, superseded_at: null }]);
    expect(await entries()).toHaveLength(1);
  });

  it('credentials: created and revoked, with no token, prefix or hash in any entry', async () => {
    const created = await credentials.create(
      organizationId,
      agentId,
      { name: 'CI deploy', scopes: ['tools:call'] },
      actor,
    );
    await credentials.revoke(organizationId, agentId, created.id, actor);
    // Idempotent: a second revoke records nothing.
    await credentials.revoke(organizationId, agentId, created.id, actor);

    const [revoked, minted, ...rest] = await entries();
    expect(rest).toEqual([]);
    expect(minted).toMatchObject({
      actorType: 'user',
      actorId: 'login-session-1',
      action: 'credential.created',
      resourceType: 'agent_credential',
      resourceId: created.id,
      before: null,
      after: { agentId, name: 'CI deploy', scopes: ['tools:call'], expiresAt: null },
    });
    expect(revoked).toMatchObject({
      action: 'credential.revoked',
      resourceType: 'agent_credential',
      resourceId: created.id,
      before: { revokedAt: null },
      after: { name: 'CI deploy', revokedAt: expect.any(String) },
    });

    const stored = JSON.stringify(
      await dataSource.query(`SELECT * FROM "audit_log_entries" WHERE "organization_id" = $1`, [
        organizationId,
      ]),
    );
    expect(stored).not.toContain(created.token);
    expect(stored).not.toContain(created.prefix);
    expect(stored).not.toContain(digestToken(created.token));
  });

  it('credentials: a failed audit write leaves the credential unrevoked, and unminted', async () => {
    const created = await credentials.create(organizationId, agentId, { name: 'kept' }, actor);

    jest.spyOn(writer, 'record').mockRejectedValue(new Error('audit down'));
    await expect(credentials.revoke(organizationId, agentId, created.id, actor)).rejects.toThrow(
      'audit down',
    );
    await expect(
      credentials.create(organizationId, agentId, { name: 'never' }, actor),
    ).rejects.toThrow('audit down');

    const rows = await dataSource.query(
      `SELECT "name", "revoked_at" FROM "agent_credentials" WHERE "organization_id" = $1`,
      [organizationId],
    );
    expect(rows).toEqual([{ name: 'kept', revoked_at: null }]);
  });

  it('notification channel and preference changes', async () => {
    const event = Object.values(NotificationEvent).find(
      (name) => !NOTIFICATION_CATALOGUE[name].nonSuppressible,
    ) as NotificationEvent;

    const channel = await settings.upsertChannel(
      organizationId,
      NotificationChannel.EMAIL,
      'ops@example.com',
      true,
      actor,
    );
    await settings.upsertChannel(
      organizationId,
      NotificationChannel.EMAIL,
      undefined,
      false,
      actor,
    );
    // Changes nothing: no entry.
    await settings.upsertChannel(
      organizationId,
      NotificationChannel.EMAIL,
      undefined,
      false,
      actor,
    );
    await settings.upsertChannel(
      organizationId,
      NotificationChannel.WEBHOOK,
      'https://hooks.example/T0/B0/s3cr3t',
      true,
      actor,
    );
    const item = (enabled: boolean) => ({ event, channel: NotificationChannel.EMAIL, enabled });
    await settings.upsertPreferences(organizationId, [item(false)], actor);
    await settings.upsertPreferences(organizationId, [item(false)], actor);
    await settings.upsertPreferences(organizationId, [item(true)], actor);

    const all = await entries();
    expect(all.map((entry) => entry.action).reverse()).toEqual([
      'notification_channel.created',
      'notification_channel.updated',
      'notification_channel.created',
      'notification_preference.updated',
      'notification_preference.updated',
    ]);
    const [prefOn, prefOff, webhook, toggled, email] = all;
    expect(email).toMatchObject({
      actorType: 'user',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      after: { channel: 'EMAIL', destination: 'ops@example.com', enabled: true },
    });
    expect(toggled).toMatchObject({
      before: { channel: 'EMAIL', enabled: true },
      after: { channel: 'EMAIL', enabled: false },
    });
    expect(webhook.after).toEqual({ channel: 'WEBHOOK', destinationChanged: true, enabled: true });
    expect(JSON.stringify(all)).not.toContain('s3cr3t');
    expect(prefOff).toMatchObject({
      resourceType: 'notification_preference',
      before: null,
      after: { event, channel: 'EMAIL', enabled: false },
    });
    expect(prefOn).toMatchObject({
      resourceId: prefOff.resourceId,
      before: { enabled: false },
      after: { event, channel: 'EMAIL', enabled: true },
    });
  });

  it('recordAfterCommit writes without a surrounding transaction', async () => {
    await writer.recordAfterCommit({
      organizationId,
      actor,
      action: 'limit.updated',
      resourceType: 'escrow',
      resourceId: 'eip155:46630:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296',
      after: { maxVoucherAmount: '2500000', maxPerWindow: '9000000' },
    });

    expect(await entries()).toEqual([
      expect.objectContaining({ action: 'limit.updated', resourceType: 'escrow', before: null }),
    ]);
  });

  it('tenant isolation: another organization never sees the entries', async () => {
    await policies.patch(organizationId, agentId, { assetId: USDC_ASSET, decimals: 6 }, actor);
    await credentials.create(organizationId, agentId, { name: 'CI deploy' }, actor);

    expect(await entries()).toHaveLength(2);
    expect(await entries(otherOrganizationId)).toEqual([]);
    // Not by search, and not by naming the other tenant's resource either.
    const [credential] = await entries();
    expect(
      (
        await reader.list(otherOrganizationId, {
          ...page,
          search: 'credential',
          resourceId: credential.resourceId,
        })
      ).items,
    ).toEqual([]);
  });
});
