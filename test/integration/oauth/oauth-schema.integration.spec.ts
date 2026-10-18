import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { OAuthRefreshTokenEntity } from '@database/postgres/entities/oauth-refresh-token.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthRefreshTokenRepository } from '@database/postgres/repositories/oauth-refresh-token.repository';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * The OAuth data model (spec §6.2) against the real migrations: an OAuth grant
 * is an `agent_credentials` row with no token of its own, an API key is a row
 * with no OAuth client, and the database refuses anything in between.
 */
describe('OAuth schema — real migrations', () => {
  const DATABASE = 'assay_oauth_schema_test';
  const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
  const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222';
  const OAUTH_MIGRATION = 'OAuth1762400000000';
  const HOUR = 3_600_000;

  let dataSource: DataSource;
  let credentials: AgentCredentialRepository;
  let clients: OAuthClientRepository;

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
    credentials = new AgentCredentialRepository(dataSource);
    clients = new OAuthClientRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async function insertClient(): Promise<OAuthClientEntity> {
    return clients.save(
      clients.create({
        clientId: `dcr_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
        kind: OAuthClientKind.DCR,
        clientName: 'Example client',
        clientUri: null,
        redirectUris: ['http://127.0.0.1:33418/callback'],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
        lastUsedAt: null,
      }),
    );
  }

  /** Raw insert, so every column the test names reaches Postgres as written. */
  async function insertCredential(row: {
    organizationId?: string;
    agentId?: string;
    issuedVia?: string;
    prefix?: string | null;
    tokenHash?: string | null;
    oauthClientId?: string | null;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
  }): Promise<string> {
    const columns = ['organization_id', 'agent_id', 'name', 'prefix', 'token_hash'];
    const values: unknown[] = [
      row.organizationId ?? ORGANIZATION,
      row.agentId ?? randomUUID(),
      'test credential',
      row.prefix === undefined ? 'assay_sk_live_ab' : row.prefix,
      row.tokenHash === undefined ? digest(randomUUID()) : row.tokenHash,
    ];
    if (row.issuedVia !== undefined) {
      columns.push('issued_via');
      values.push(row.issuedVia);
    }
    if (row.oauthClientId !== undefined) {
      columns.push('oauth_client_id');
      values.push(row.oauthClientId);
    }
    if (row.expiresAt !== undefined) {
      columns.push('expires_at');
      values.push(row.expiresAt);
    }
    if (row.revokedAt !== undefined) {
      columns.push('revoked_at', 'revoked_by');
      values.push(row.revokedAt, row.revokedAt === null ? null : 'test');
    }
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const [inserted] = (await dataSource.query(
      `INSERT INTO "agent_credentials" (${columns.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${placeholders}) RETURNING "id"`,
      values,
    )) as { id: string }[];
    return inserted.id;
  }

  async function insertOAuthCredential(
    clientId: string,
    row: {
      organizationId?: string;
      agentId?: string;
      expiresAt?: Date | null;
      revokedAt?: Date | null;
    } = {},
  ): Promise<string> {
    return insertCredential({
      ...row,
      issuedVia: 'OAUTH',
      prefix: null,
      tokenHash: null,
      oauthClientId: clientId,
    });
  }

  it('refuses an API_KEY row with an oauth_client_id', async () => {
    const client = await insertClient();
    await expect(
      insertCredential({ issuedVia: 'API_KEY', oauthClientId: client.id }),
    ).rejects.toMatchObject({ constraint: 'ck_agent_credentials_issued_via' });
  });

  it('refuses an OAUTH row with a token_hash or prefix', async () => {
    const client = await insertClient();
    await expect(
      insertCredential({ issuedVia: 'OAUTH', prefix: null, oauthClientId: client.id }),
    ).rejects.toMatchObject({ constraint: 'ck_agent_credentials_issued_via' });
    await expect(
      insertCredential({ issuedVia: 'OAUTH', tokenHash: null, oauthClientId: client.id }),
    ).rejects.toMatchObject({ constraint: 'ck_agent_credentials_issued_via' });
  });

  it('refuses an OAUTH row without oauth_client_id', async () => {
    await expect(
      insertCredential({ issuedVia: 'OAUTH', prefix: null, tokenHash: null, oauthClientId: null }),
    ).rejects.toMatchObject({ constraint: 'ck_agent_credentials_issued_via' });
  });

  it('refuses an issued_via outside API_KEY and OAUTH', async () => {
    await expect(insertCredential({ issuedVia: 'PRIVY' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_agent_credentials_issued_via_kind',
    });
  });

  it('oauth_clients delete is RESTRICTed while a credential references it', async () => {
    const client = await insertClient();
    await insertOAuthCredential(client.id);
    await expect(
      dataSource.query(`DELETE FROM "oauth_clients" WHERE "id" = $1`, [client.id]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'fk_agent_credentials_oauth_client' });
  });

  it('oauth_clients delete is RESTRICTed while an authorization code references it', async () => {
    const client = await insertClient();
    const codes = new OAuthAuthorizationCodeRepository(dataSource);
    await codes.save(
      codes.create({
        codeHash: digest(randomUUID()),
        oauthClientId: client.id,
        organizationId: ORGANIZATION,
        agentId: randomUUID(),
        credentialName: 'Example client',
        replacesCredentialId: null,
        approvedBy: 'login-session-1',
        redirectUri: 'http://127.0.0.1:33418/callback',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        scope: 'mcp',
        resource: 'https://mcp.example.test',
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        credentialId: null,
      }),
    );
    await expect(
      dataSource.query(`DELETE FROM "oauth_clients" WHERE "id" = $1`, [client.id]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'fk_oauth_authorization_codes_client' });
  });

  it('an OAuth row maps through the entity with a null prefix and token hash', async () => {
    const client = await insertClient();
    const id = await insertOAuthCredential(client.id);
    const row = await credentials.findOneOrFail({ where: { id, organizationId: ORGANIZATION } });
    expect(row).toMatchObject({
      issuedVia: 'OAUTH',
      oauthClientId: client.id,
      prefix: null,
      tokenHash: null,
    });
  });

  it('existing API-key rows default to issued_via API_KEY', async () => {
    // Step back over the OAuth migration (and any later one), write a key the
    // old way, and re-apply. Grants block the revert, so the rows earlier
    // tests made are removed first; later tests make their own.
    await expect(undoThrough(OAUTH_MIGRATION)).rejects.toThrow(/OAuth credential row/);
    await dataSource.query(`DELETE FROM "oauth_access_tokens"`);
    await dataSource.query(`DELETE FROM "oauth_refresh_tokens"`);
    await dataSource.query(`DELETE FROM "agent_credentials" WHERE "issued_via" = 'OAUTH'`);
    await undoThrough(OAUTH_MIGRATION);
    await expect(
      dataSource.query(`SELECT to_regclass('oauth_clients') AS "table"`),
    ).resolves.toEqual([{ table: null }]);
    const [{ id }] = (await dataSource.query(
      `INSERT INTO "agent_credentials" ("organization_id", "agent_id", "name", "prefix", "token_hash") ` +
        `VALUES ($1, $2, 'old key', 'assay_sk_live_ab', $3) RETURNING "id"`,
      [ORGANIZATION, randomUUID(), digest('old key')],
    )) as { id: string }[];
    await dataSource.runMigrations({ transaction: 'each' });

    const [row] = (await dataSource.query(
      `SELECT "issued_via", "oauth_client_id" FROM "agent_credentials" WHERE "id" = $1`,
      [id],
    )) as { issued_via: string; oauth_client_id: string | null }[];
    expect(row).toEqual({ issued_via: 'API_KEY', oauth_client_id: null });

    const fresh = await insertCredential({});
    const [freshRow] = (await dataSource.query(
      `SELECT "issued_via" FROM "agent_credentials" WHERE "id" = $1`,
      [fresh],
    )) as { issued_via: string }[];
    expect(freshRow.issued_via).toBe('API_KEY');
  });

  it('countLiveOAuthForAgent ignores revoked, expired and soft-deleted rows', async () => {
    const client = await insertClient();
    const agentId = randomUUID();
    const later = new Date(Date.now() + HOUR);
    await insertOAuthCredential(client.id, { agentId });
    await insertOAuthCredential(client.id, { agentId, expiresAt: later });
    await insertOAuthCredential(client.id, { agentId, expiresAt: later });
    await insertOAuthCredential(client.id, { agentId, revokedAt: new Date() });
    await insertOAuthCredential(client.id, { agentId, expiresAt: new Date(Date.now() - HOUR) });
    await insertOAuthCredential(client.id, { agentId, expiresAt: new Date(Date.now() - 50) });
    const softDeleted = await insertOAuthCredential(client.id, { agentId });
    await dataSource.query(`UPDATE "agent_credentials" SET "deleted_at" = now() WHERE "id" = $1`, [
      softDeleted,
    ]);
    // Neither an API key of the same agent, another agent's grant, nor a row
    // of the same agent id under another organization counts.
    await insertCredential({ agentId });
    await insertOAuthCredential(client.id);
    await insertOAuthCredential(client.id, { agentId, organizationId: OTHER_ORGANIZATION });

    await expect(credentials.countLiveOAuthForAgent(ORGANIZATION, agentId)).resolves.toBe(3);
  });

  it('finds access and refresh tokens by hash across tenants', async () => {
    const client = await insertClient();
    const credentialId = await insertOAuthCredential(client.id, {
      organizationId: OTHER_ORGANIZATION,
    });
    const refreshTokens = new OAuthRefreshTokenRepository(dataSource);
    const accessTokens = new OAuthAccessTokenRepository(dataSource);

    const refresh = await refreshTokens.save(
      refreshTokens.create({
        organizationId: OTHER_ORGANIZATION,
        credentialId,
        oauthClientId: client.id,
        tokenHash: digest('refresh'),
        parentId: null,
        scope: 'mcp',
        expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
        usedAt: null,
        revokedAt: null,
      }),
    );
    await accessTokens.save(
      accessTokens.create({
        organizationId: OTHER_ORGANIZATION,
        credentialId,
        refreshTokenId: refresh.id,
        tokenHash: digest('access'),
        scope: 'mcp',
        audience: 'https://mcp.example.test',
        expiresAt: new Date(Date.now() + HOUR),
        firstUsedAt: null,
        revokedAt: null,
      }),
    );

    // No tenant is supplied: the lookup is what discovers it.
    await expect(refreshTokens.findByTokenHash(digest('refresh'))).resolves.toMatchObject({
      id: refresh.id,
      organizationId: OTHER_ORGANIZATION,
      credentialId,
    });
    await expect(accessTokens.findByTokenHash(digest('access'))).resolves.toMatchObject({
      refreshTokenId: refresh.id,
      organizationId: OTHER_ORGANIZATION,
      credentialId,
    });
    await expect(accessTokens.findByTokenHash(digest('nothing'))).resolves.toBeNull();
  });

  /**
   * Undoes migrations, newest first, until `name` itself has been reverted, and
   * fails if it never was. Later migrations on this branch therefore cannot
   * turn the "existing rows" case into a test of some other migration.
   */
  async function undoThrough(name: string): Promise<void> {
    for (;;) {
      const [last] = (await dataSource.query(
        `SELECT "name" FROM "migrations" ORDER BY "id" DESC LIMIT 1`,
      )) as { name: string }[];
      if (!last) throw new Error(`${name} was never applied`);
      await dataSource.undoLastMigration({ transaction: 'each' });
      if (last.name === name) return;
    }
  }

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
});
