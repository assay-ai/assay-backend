import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import {
  OAUTH_REVOKED_BY_CODE_REUSED,
  OAUTH_REVOKED_BY_REFRESH_REUSE,
} from '@modules/oauth/constants/oauth.constants';
import { OAuthSignalsReader } from '@modules/observability/services/oauth-signals.reader';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * The database facts behind the operator dashboard's OAuth signals (spec
 * §6.7), `OAuthSignalsReader.databaseFacts`, on the real migrations. Live
 * grants use the same "live" as `countLiveOAuthForAgent`.
 */
describe('OAuth dashboard signals, database facts — real migrations', () => {
  const DATABASE = 'assay_oauth_signals_test';
  const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
  const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222';
  const DAY = 24 * 3_600_000;

  let dataSource: DataSource;
  let credentials: AgentCredentialRepository;
  let reader: OAuthSignalsReader;
  let clientId: string;

  beforeAll(async () => {
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [AgentCredentialEntity, OAuthClientEntity],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
    credentials = new AgentCredentialRepository(dataSource);
    reader = new OAuthSignalsReader(dataSource, {} as CacheService);
    const [client] = (await dataSource.query(
      `INSERT INTO "oauth_clients" ("client_id", "kind", "client_name", "redirect_uris", "metadata")
       VALUES ('dcr_abcdefghijklmnopqrstuv', 'DCR', 'Example client',
               ARRAY['http://127.0.0.1:33418/callback'], '{}')
       RETURNING "id"`,
    )) as { id: string }[];
    clientId = client.id;
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  async function insertGrant(
    row: {
      organizationId?: string;
      agentId?: string;
      expiresAt?: Date | null;
      revokedAt?: Date | null;
      revokedBy?: string;
      deletedAt?: Date | null;
    } = {},
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO "agent_credentials"
         ("organization_id", "agent_id", "name", "token_last4", "token_hash", "issued_via",
          "oauth_client_id", "expires_at", "revoked_at", "revoked_by", "deleted_at")
       VALUES ($1, $2, 'Example grant', NULL, NULL, 'OAUTH', $3, $4, $5, $6, $7)`,
      [
        row.organizationId ?? ORGANIZATION,
        row.agentId ?? randomUUID(),
        clientId,
        row.expiresAt === undefined ? new Date(Date.now() + 30 * DAY) : row.expiresAt,
        row.revokedAt ?? null,
        row.revokedAt ? (row.revokedBy ?? 'test') : null,
        row.deletedAt ?? null,
      ],
    );
  }

  const facts = () => reader.databaseFacts(new Date(Date.now() - DAY));

  it('is 0 with no live grant', async () => {
    await insertGrant({ revokedAt: new Date(Date.now() - DAY) });
    await expect(facts()).resolves.toMatchObject({ liveGrants: 0, maxLiveGrantsPerAgent: 0 });
  });

  it('is the largest live count of one agent; revoked, expired and soft-deleted do not count', async () => {
    const busy = randomUUID();
    for (let index = 0; index < 4; index += 1) await insertGrant({ agentId: busy });
    await insertGrant({ agentId: busy, revokedAt: new Date(Date.now() - DAY) });
    await insertGrant({ agentId: busy, expiresAt: new Date(Date.now() - 60_000) });
    await insertGrant({ agentId: busy, deletedAt: new Date(Date.now() - DAY) });
    // The same agent id under another tenant is another agent.
    for (let index = 0; index < 3; index += 1) {
      await insertGrant({ agentId: busy, organizationId: OTHER_ORGANIZATION });
    }
    await insertGrant();
    // An API key is not a grant.
    await dataSource.query(
      `INSERT INTO "agent_credentials" ("organization_id", "agent_id", "name", "token_last4", "token_hash")
       VALUES ($1, $2, 'Example key', '2fds', $3)`,
      [ORGANIZATION, busy, randomUUID().replace(/-/g, '')],
    );

    await expect(facts()).resolves.toMatchObject({ liveGrants: 8, maxLiveGrantsPerAgent: 4 });
    await expect(credentials.countLiveOAuthForAgent(ORGANIZATION, busy)).resolves.toBe(4);
  });

  it('counts grants stopped for reuse in the window, by revoked_by', async () => {
    const recent = new Date(Date.now() - 60_000);
    await insertGrant({ revokedAt: recent, revokedBy: OAUTH_REVOKED_BY_REFRESH_REUSE });
    await insertGrant({ revokedAt: recent, revokedBy: OAUTH_REVOKED_BY_REFRESH_REUSE });
    await insertGrant({ revokedAt: recent, revokedBy: OAUTH_REVOKED_BY_CODE_REUSED });
    // Outside the 24 h window, and a revocation for another reason.
    await insertGrant({
      revokedAt: new Date(Date.now() - 2 * DAY),
      revokedBy: OAUTH_REVOKED_BY_CODE_REUSED,
    });
    await insertGrant({ revokedAt: recent, revokedBy: 'user:someone' });

    await expect(facts()).resolves.toMatchObject({
      stoppedForRefreshReuse: 2,
      stoppedForCodeReuse: 1,
    });
  });

  it('counts the grace uses and stale reuses audited in the window', async () => {
    const audit = (action: string, at: Date) =>
      dataSource.query(
        `INSERT INTO "audit_log_entries"
           ("organization_id", "actor_type", "actor_id", "action", "resource_type", "created_at")
         VALUES ($1, 'system', 'oauth', $2, 'agent_credential', $3)`,
        [ORGANIZATION, action, at],
      );
    const now = new Date();
    await audit('oauth.refresh_grace_used', now);
    await audit('oauth.refresh_grace_used', now);
    await audit('oauth.refresh_grace_used', new Date(Date.now() - 2 * DAY));
    await audit('oauth.refresh_stale_reuse', now);
    await audit('credential.revoked', now);

    await expect(facts()).resolves.toMatchObject({ refreshGraceUses: 2, refreshStaleReuse: 1 });
  });

  it('counts DCR registrations in the window, the most under one name, and CIMD clients', async () => {
    const client = (kind: string, name: string, createdAt = new Date()) =>
      dataSource.query(
        `INSERT INTO "oauth_clients"
           ("client_id", "kind", "client_name", "redirect_uris", "metadata", "created_at")
         VALUES ($1, $2, $3, ARRAY['http://127.0.0.1/callback'], '{}', $4)`,
        [`${kind.toLowerCase()}_${randomUUID()}`, kind, name, createdAt],
      );
    const before = await facts();
    await client('DCR', 'Flood client');
    await client('DCR', 'Flood client');
    await client('DCR', 'Flood client');
    await client('DCR', 'Other client');
    await client('DCR', 'Flood client', new Date(Date.now() - 2 * DAY));
    await client('CIMD', 'Hosted client');

    const after = await facts();
    expect(after.dcrRegistrations - before.dcrRegistrations).toBe(4);
    expect(after.dcrMaxPerClientName).toBe(3);
    expect(after.cimdClients - before.cimdClients).toBe(1);
  });
});

async function dropDatabase(database: string): Promise<void> {
  const connection = testConnectionOptions();
  const admin = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
