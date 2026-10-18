import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Redis from 'ioredis';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { OAuthRefreshTokenEntity } from '@database/postgres/entities/oauth-refresh-token.entity';
import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';
import {
  OAUTH_CLEANUP_LOCK_KEY,
  OAuthCleanupService,
} from '@modules/oauth/services/oauth-cleanup.service';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * The OAuth cleanup job (spec §6.2, IM-6) against the real migrations and a
 * real Redis: dead tokens and codes go, unreferenced old DCR/CIMD clients go,
 * and nothing else does. Credential rows are never deleted.
 */
describe('OAuth cleanup — real database and Redis', () => {
  const DATABASE = 'assay_oauth_cleanup_test';
  const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
  const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222';
  const VERIFIED_CLIENT_ID = 'https://client.example.com/oauth/client.json';
  const DAY = 24 * 3_600_000;

  let dataSource: DataSource;
  let redis: Redis;
  let registry: MetricsRegistryService;
  let service: OAuthCleanupService;

  beforeAll(async () => {
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [
        AgentCredentialEntity,
        OAuthClientEntity,
        OAuthAuthorizationCodeEntity,
        OAuthRefreshTokenEntity,
        OAuthAccessTokenEntity,
      ],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });
  });

  beforeEach(async () => {
    await redis.del(OAUTH_CLEANUP_LOCK_KEY);
    registry = new MetricsRegistryService();
    service = new OAuthCleanupService(dataSource, redis, new OAuthMetrics(registry), {
      now: () => Date.now(),
      verifiedClientIds: [VERIFIED_CLIENT_ID],
    });
  });

  afterAll(async () => {
    await redis?.del(OAUTH_CLEANUP_LOCK_KEY);
    redis?.disconnect();
    await dataSource?.destroy();
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  function ago(ms: number): Date {
    return new Date(Date.now() - ms);
  }

  async function insertClient(
    row: { kind?: string; clientId?: string; createdAt?: Date } = {},
  ): Promise<string> {
    const [inserted] = (await dataSource.query(
      `INSERT INTO "oauth_clients" ("client_id", "kind", "client_name", "redirect_uris", "metadata", "created_at")
       VALUES ($1, $2, 'Example client', ARRAY['http://127.0.0.1:33418/callback'], '{}', $3)
       RETURNING "id"`,
      [
        row.clientId ?? `dcr_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
        row.kind ?? 'DCR',
        row.createdAt ?? new Date(),
      ],
    )) as { id: string }[];
    return inserted.id;
  }

  async function insertGrant(
    oauthClientId: string,
    row: {
      organizationId?: string;
      agentId?: string;
      expiresAt?: Date | null;
      revokedAt?: Date | null;
      deletedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const [inserted] = (await dataSource.query(
      `INSERT INTO "agent_credentials"
         ("organization_id", "agent_id", "name", "prefix", "token_hash", "issued_via",
          "oauth_client_id", "expires_at", "revoked_at", "revoked_by", "deleted_at")
       VALUES ($1, $2, 'Example grant', NULL, NULL, 'OAUTH', $3, $4, $5, $6, $7)
       RETURNING "id"`,
      [
        row.organizationId ?? ORGANIZATION,
        row.agentId ?? randomUUID(),
        oauthClientId,
        row.expiresAt === undefined ? new Date(Date.now() + 30 * DAY) : row.expiresAt,
        row.revokedAt ?? null,
        row.revokedAt ? 'test' : null,
        row.deletedAt ?? null,
      ],
    )) as { id: string }[];
    return inserted.id;
  }

  async function insertCode(oauthClientId: string, expiresAt: Date): Promise<string> {
    const [inserted] = (await dataSource.query(
      `INSERT INTO "oauth_authorization_codes"
         ("code_hash", "oauth_client_id", "organization_id", "agent_id", "credential_name",
          "approved_by", "redirect_uri", "code_challenge", "scope", "resource", "expires_at")
       VALUES ($1, $2, $3, $4, 'Example grant', 'login-session-1',
               'http://127.0.0.1:33418/callback', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
               'mcp', 'https://mcp.example.com', $5)
       RETURNING "id"`,
      [digest(randomUUID()), oauthClientId, ORGANIZATION, randomUUID(), expiresAt],
    )) as { id: string }[];
    return inserted.id;
  }

  async function insertRefreshToken(
    credentialId: string,
    oauthClientId: string,
    row: { expiresAt: Date; usedAt?: Date | null; revokedAt?: Date | null },
  ): Promise<string> {
    const [inserted] = (await dataSource.query(
      `INSERT INTO "oauth_refresh_tokens"
         ("organization_id", "credential_id", "oauth_client_id", "token_hash", "scope",
          "expires_at", "used_at", "revoked_at")
       VALUES ($1, $2, $3, $4, 'mcp', $5, $6, $7)
       RETURNING "id"`,
      [
        ORGANIZATION,
        credentialId,
        oauthClientId,
        digest(randomUUID()),
        row.expiresAt,
        row.usedAt ?? null,
        row.revokedAt ?? null,
      ],
    )) as { id: string }[];
    return inserted.id;
  }

  async function insertAccessToken(credentialId: string, expiresAt: Date): Promise<string> {
    const [inserted] = (await dataSource.query(
      `INSERT INTO "oauth_access_tokens"
         ("organization_id", "credential_id", "token_hash", "scope", "audience", "expires_at")
       VALUES ($1, $2, $3, 'mcp', 'https://mcp.example.com', $4)
       RETURNING "id"`,
      [ORGANIZATION, credentialId, digest(randomUUID()), expiresAt],
    )) as { id: string }[];
    return inserted.id;
  }

  async function exists(table: string, id: string): Promise<boolean> {
    const rows = (await dataSource.query(`SELECT 1 FROM "${table}" WHERE "id" = $1`, [
      id,
    ])) as unknown[];
    return rows.length === 1;
  }

  async function gaugeValue(): Promise<number | undefined> {
    const metric = await registry.registry
      .getSingleMetric('assay_oauth_live_grants_per_agent')
      ?.get();
    return metric?.values[0]?.value;
  }

  it('the cleanup deletes have expires_at indexes', async () => {
    const rows = (await dataSource.query(
      `SELECT "indexname", "indexdef" FROM "pg_indexes" WHERE "indexname" = ANY($1) ORDER BY 1`,
      [
        [
          'idx_oauth_access_tokens_expires',
          'idx_oauth_authorization_codes_expires',
          'idx_oauth_refresh_tokens_expires_dead',
        ],
      ],
    )) as { indexname: string; indexdef: string }[];
    expect(rows.map((row) => row.indexname)).toEqual([
      'idx_oauth_access_tokens_expires',
      'idx_oauth_authorization_codes_expires',
      'idx_oauth_refresh_tokens_expires_dead',
    ]);
    expect(rows[2].indexdef).toContain('used_at IS NOT NULL');
  });

  // ── clients ────────────────────────────────────────────────────────────────

  it('referenced DCR client survives', async () => {
    const byGrant = await insertClient({ createdAt: ago(60 * DAY) });
    await insertGrant(byGrant, { revokedAt: ago(40 * DAY), expiresAt: ago(40 * DAY) });
    const byCode = await insertClient({ createdAt: ago(60 * DAY) });
    await insertCode(byCode, new Date(Date.now() + 60_000));

    await service.run();

    expect(await exists('oauth_clients', byGrant)).toBe(true);
    expect(await exists('oauth_clients', byCode)).toBe(true);
  });

  it('a soft-deleted grant still holds its client', async () => {
    const client = await insertClient({ createdAt: ago(60 * DAY) });
    await insertGrant(client, { deletedAt: ago(40 * DAY) });

    await service.run();

    expect(await exists('oauth_clients', client)).toBe(true);
  });

  it('unreferenced 31-day DCR client deleted', async () => {
    const dcr = await insertClient({ createdAt: ago(31 * DAY) });
    const cimd = await insertClient({
      kind: 'CIMD',
      clientId: `https://${randomUUID()}.example.com/client.json`,
      createdAt: ago(31 * DAY),
    });
    const young = await insertClient({ createdAt: ago(29 * DAY) });

    const summary = await service.run();

    expect(await exists('oauth_clients', dcr)).toBe(false);
    expect(await exists('oauth_clients', cimd)).toBe(false);
    expect(await exists('oauth_clients', young)).toBe(true);
    expect(summary).toMatchObject({ skipped: false });
    expect(summary.skipped === false && summary.clients).toBeGreaterThanOrEqual(2);
  });

  it('a client whose only code expired over a day ago is deleted in the same run', async () => {
    const client = await insertClient({ createdAt: ago(31 * DAY) });
    const code = await insertCode(client, ago(DAY + 60_000));

    await service.run();

    expect(await exists('oauth_authorization_codes', code)).toBe(false);
    expect(await exists('oauth_clients', client)).toBe(false);
  });

  it('builtin never deleted', async () => {
    const builtin = await insertClient({
      kind: 'BUILTIN',
      clientId: `https://${randomUUID()}.example.com/oauth/clients/assay-mcp`,
      createdAt: ago(400 * DAY),
    });

    await service.run();

    expect(await exists('oauth_clients', builtin)).toBe(true);
  });

  it('an OAUTH_VERIFIED_CLIENTS client is never deleted', async () => {
    const verified = await insertClient({
      kind: 'CIMD',
      clientId: VERIFIED_CLIENT_ID,
      createdAt: ago(400 * DAY),
    });

    await service.run();

    expect(await exists('oauth_clients', verified)).toBe(true);
  });

  it('deletes no client when the verified list could not be read', async () => {
    const client = await insertClient({ createdAt: ago(60 * DAY) });
    const blind = new OAuthCleanupService(
      dataSource,
      redis,
      new OAuthMetrics(new MetricsRegistryService()),
      { now: () => Date.now(), verifiedClientIds: null },
    );

    const summary = await blind.run();

    expect(await exists('oauth_clients', client)).toBe(true);
    expect(summary).toMatchObject({ skipped: false, clients: 0 });
  });

  // ── tokens and codes ───────────────────────────────────────────────────────

  it('deletes access tokens 7 days past expiry, and only those', async () => {
    const client = await insertClient();
    const grant = await insertGrant(client);
    const dead = await insertAccessToken(grant, ago(7 * DAY + 60_000));
    const recent = await insertAccessToken(grant, ago(6 * DAY));
    const live = await insertAccessToken(grant, new Date(Date.now() + 3_600_000));

    await service.run();

    expect(await exists('oauth_access_tokens', dead)).toBe(false);
    expect(await exists('oauth_access_tokens', recent)).toBe(true);
    expect(await exists('oauth_access_tokens', live)).toBe(true);
  });

  it('deletes used or revoked refresh tokens 30 days past expiry, and only those', async () => {
    const client = await insertClient();
    const grant = await insertGrant(client);
    const old = ago(30 * DAY + 60_000);
    const used = await insertRefreshToken(grant, client, { expiresAt: old, usedAt: ago(59 * DAY) });
    const revoked = await insertRefreshToken(grant, client, {
      expiresAt: old,
      revokedAt: ago(40 * DAY),
    });
    const neverUsed = await insertRefreshToken(grant, client, { expiresAt: old });
    const usedRecently = await insertRefreshToken(grant, client, {
      expiresAt: ago(29 * DAY),
      usedAt: ago(50 * DAY),
    });

    await service.run();

    expect(await exists('oauth_refresh_tokens', used)).toBe(false);
    expect(await exists('oauth_refresh_tokens', revoked)).toBe(false);
    expect(await exists('oauth_refresh_tokens', neverUsed)).toBe(true);
    expect(await exists('oauth_refresh_tokens', usedRecently)).toBe(true);
  });

  it('deletes codes 1 day past expiry, and only those', async () => {
    const client = await insertClient();
    const dead = await insertCode(client, ago(DAY + 60_000));
    const recent = await insertCode(client, ago(DAY - 60_000));

    await service.run();

    expect(await exists('oauth_authorization_codes', dead)).toBe(false);
    expect(await exists('oauth_authorization_codes', recent)).toBe(true);
  });

  it('credential rows untouched', async () => {
    const client = await insertClient({ createdAt: ago(400 * DAY) });
    const ids = [
      await insertGrant(client, { expiresAt: ago(400 * DAY) }),
      await insertGrant(client, { revokedAt: ago(400 * DAY), expiresAt: ago(400 * DAY) }),
      await insertGrant(client, { deletedAt: ago(400 * DAY) }),
      await insertGrant(client),
    ];
    for (const id of ids) {
      await insertRefreshToken(id, client, {
        expiresAt: ago(100 * DAY),
        revokedAt: ago(100 * DAY),
      });
      await insertAccessToken(id, ago(100 * DAY));
    }
    const before = (await dataSource.query(
      `SELECT * FROM "agent_credentials" WHERE "id" = ANY($1) ORDER BY "id"`,
      [ids],
    )) as unknown[];

    await service.run();

    const after = (await dataSource.query(
      `SELECT * FROM "agent_credentials" WHERE "id" = ANY($1) ORDER BY "id"`,
      [ids],
    )) as unknown[];
    expect(after).toHaveLength(4);
    expect(after).toEqual(before);
    expect(await exists('oauth_clients', client)).toBe(true);
  });

  // ── lock ───────────────────────────────────────────────────────────────────

  it('second concurrent run is a no-op (lock)', async () => {
    const client = await insertClient();
    const grant = await insertGrant(client);
    const dead = await insertAccessToken(grant, ago(8 * DAY));

    const [first, second] = await Promise.all([service.run(), service.run()]);

    const ran = [first, second].filter((summary) => !summary.skipped);
    const skipped = [first, second].filter((summary) => summary.skipped);
    expect(ran).toHaveLength(1);
    expect(skipped).toEqual([{ skipped: true }]);
    expect(await exists('oauth_access_tokens', dead)).toBe(false);
    expect(await redis.ttl(OAUTH_CLEANUP_LOCK_KEY)).toBeGreaterThan(0);

    // Held for its full hour: a later run in the same window changes nothing.
    const again = await insertAccessToken(grant, ago(8 * DAY));
    await expect(service.run()).resolves.toEqual({ skipped: true });
    expect(await exists('oauth_access_tokens', again)).toBe(true);
  });

  // ── gauge ──────────────────────────────────────────────────────────────────

  it('sets assay_oauth_live_grants_per_agent to the largest live count of one agent', async () => {
    await dataSource.query(`UPDATE "agent_credentials" SET "revoked_at" = now(), "revoked_by" = 'test'
                            WHERE "revoked_at" IS NULL`);
    const client = await insertClient();
    const busy = randomUUID();
    for (let index = 0; index < 4; index += 1) await insertGrant(client, { agentId: busy });
    // Not live: revoked, idle-expired, soft-deleted.
    await insertGrant(client, { agentId: busy, revokedAt: ago(DAY) });
    await insertGrant(client, { agentId: busy, expiresAt: ago(60_000) });
    await insertGrant(client, { agentId: busy, deletedAt: ago(DAY) });
    // The same agent id under another tenant is another agent.
    for (let index = 0; index < 3; index += 1) {
      await insertGrant(client, { agentId: busy, organizationId: OTHER_ORGANIZATION });
    }
    await insertGrant(client);

    await service.run();

    expect(await gaugeValue()).toBe(4);
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
