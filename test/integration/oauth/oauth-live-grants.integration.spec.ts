import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * `AgentCredentialRepository.maxLiveOAuthPerAgent`, behind the
 * `assay_oauth_live_grants_per_agent` gauge (spec §6.7), on the real
 * migrations: the same "live" as `countLiveOAuthForAgent`, maximised over
 * agents.
 */
describe('maxLiveOAuthPerAgent — real migrations', () => {
  const DATABASE = 'assay_oauth_live_grants_test';
  const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
  const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222';
  const DAY = 24 * 3_600_000;

  let dataSource: DataSource;
  let credentials: AgentCredentialRepository;
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
      deletedAt?: Date | null;
    } = {},
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO "agent_credentials"
         ("organization_id", "agent_id", "name", "prefix", "token_hash", "issued_via",
          "oauth_client_id", "expires_at", "revoked_at", "revoked_by", "deleted_at")
       VALUES ($1, $2, 'Example grant', NULL, NULL, 'OAUTH', $3, $4, $5, $6, $7)`,
      [
        row.organizationId ?? ORGANIZATION,
        row.agentId ?? randomUUID(),
        clientId,
        row.expiresAt === undefined ? new Date(Date.now() + 30 * DAY) : row.expiresAt,
        row.revokedAt ?? null,
        row.revokedAt ? 'test' : null,
        row.deletedAt ?? null,
      ],
    );
  }

  it('is 0 with no live grant', async () => {
    await insertGrant({ revokedAt: new Date(Date.now() - DAY) });
    await expect(credentials.maxLiveOAuthPerAgent()).resolves.toBe(0);
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
      `INSERT INTO "agent_credentials" ("organization_id", "agent_id", "name", "prefix", "token_hash")
       VALUES ($1, $2, 'Example key', 'assay_sk_live_ab', $3)`,
      [ORGANIZATION, busy, randomUUID().replace(/-/g, '')],
    );

    await expect(credentials.maxLiveOAuthPerAgent()).resolves.toBe(4);
    await expect(credentials.countLiveOAuthForAgent(ORGANIZATION, busy)).resolves.toBe(4);
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
