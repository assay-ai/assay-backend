import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { OAuthRefreshTokenEntity } from '@database/postgres/entities/oauth-refresh-token.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthRefreshTokenRepository } from '@database/postgres/repositories/oauth-refresh-token.repository';
import { NotificationPort } from '@modules/notification/ports/notification.port';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { OAuthGrantWriter } from '@modules/oauth/services/oauth-grant.writer';
import {
  OAuthTokenService,
  TokenPair,
  isOAuthError,
} from '@modules/oauth/services/oauth-token.service';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { SortDirection } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * R-OA-23, F3 steps 1–3: revoking an OAuth grant from Agents & keys
 * (`DELETE /agents/:agentId/credentials/:id`, `AgentCredentialsService.revoke`)
 * revokes the credential row and every one of its tokens in one transaction,
 * audits `credential.revoked`, and invalidates cached access after commit.
 */
describe('OAuth grant revocation cascade — real migrations', () => {
  const DATABASE = 'assay_oauth_revoke_cascade_test';
  const MCP = 'https://mcp.example.test';
  const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
  const REDIRECT = 'http://127.0.0.1:33418/callback';
  const ACTOR: AuditActor = { type: 'user', id: 'user-revoker-1' };

  let dataSource: DataSource;
  let tokens: OAuthTokenService;
  let credentials: AgentCredentialsService;
  let resolver: CredentialSessionResolver;
  let builtin: OAuthClientEntity;
  let bumps: string[];
  let failAudit = false;

  beforeAll(async () => {
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [
        AgentCredentialEntity,
        AuditLogEntryEntity,
        OAuthClientEntity,
        OAuthAuthorizationCodeEntity,
        OAuthRefreshTokenEntity,
        OAuthAccessTokenEntity,
      ],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
      extra: { max: 20 },
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });

    const realAudit = new AuditLogWriter(dataSource);
    // The same writer, able to fail on demand after the cascade's updates ran.
    const audit = {
      record: async (...args: Parameters<AuditLogWriter['record']>) => {
        if (failAudit) throw new Error('audit down');
        return realAudit.record(...args);
      },
      recordAfterCommit: realAudit.recordAfterCommit.bind(realAudit),
    } as unknown as AuditLogWriter;
    bumps = [];
    const epoch = {
      bump: async (organizationId: string) => {
        bumps.push(organizationId);
      },
    } as unknown as AccessEpochService;
    const clients = new OAuthClientRepository(dataSource);
    const credentialRepository = new AgentCredentialRepository(dataSource);

    tokens = new OAuthTokenService(
      dataSource,
      new OAuthAuthorizationCodeRepository(dataSource),
      clients,
      new OAuthGrantWriter(dataSource, credentialRepository, realAudit),
      realAudit,
      epoch,
      { issuer: MCP },
      new OAuthRefreshTokenRepository(dataSource),
      new OAuthAccessTokenRepository(dataSource),
      credentialRepository,
      // Refresh is not exercised here: these collaborators are never called.
      {} as unknown as CacheService,
      {} as unknown as OAuthMetrics,
      {} as unknown as NotificationPort,
    );
    // The agent lookup is not under test: every agent id belongs to the organization.
    const agents = {
      findById: async (id: string) => ({ id, organizationId: ORGANIZATION }),
      findByIdWithOrganization: async (id: string) => ({
        agent: {
          id,
          organizationId: ORGANIZATION,
          status: 'ACTIVE',
          primaryAccountId: 'eip155:1:0x0000000000000000000000000000000000000001',
          chainId: 'eip155:1',
          label: 'agent',
        },
        organizationStatus: 'ACTIVE',
      }),
    } as unknown as AgentRepository;
    credentials = new AgentCredentialsService(
      credentialRepository,
      agents,
      dataSource,
      audit,
      epoch,
      clients,
      { builtinClientId: `${MCP}/oauth/clients/assay-mcp`, verifiedClients: [] },
    );
    resolver = new CredentialSessionResolver(credentialRepository, agents);

    builtin = await clients.save(
      clients.create({
        clientId: `${MCP}/oauth/clients/assay-mcp`,
        kind: OAuthClientKind.BUILTIN,
        clientName: 'Assay app (assay-mcp)',
        clientUri: null,
        redirectUris: [REDIRECT],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
        lastUsedAt: null,
      }),
    );
    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Example org', 'ACTIVE')`,
      [ORGANIZATION],
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(() => {
    bumps.length = 0;
    failAudit = false;
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  interface Grant {
    agentId: string;
    credentialId: string;
    pair: TokenPair;
  }

  /** A real grant: a code minted, then exchanged (§6.3.10). */
  async function grant(agentId: string = randomUUID()): Promise<Grant> {
    await dataSource.query(
      `INSERT INTO "agents"
         ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id")
       VALUES ($1, $2, $3, 'ACTIVE', $4, 'eip155:1') ON CONFLICT DO NOTHING`,
      [
        agentId,
        ORGANIZATION,
        `did:privy:test-${agentId}`,
        `eip155:1:0x${randomBytes(20).toString('hex')}`,
      ],
    );
    const verifier = randomBytes(32).toString('base64url');
    const code = await tokens.mintCode(
      {
        oauthClientId: builtin.id,
        redirectUri: REDIRECT,
        codeChallenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
        scope: 'assay:agent offline_access',
        boundOrganizationId: ORGANIZATION,
      },
      { agentId, name: 'Example app', approvedBy: 'user-approver-1', replaces: null },
    );
    const result = await tokens.exchangeCode({
      code,
      redirectUri: REDIRECT,
      clientId: builtin.clientId,
      codeVerifier: verifier,
    });
    if (isOAuthError(result)) throw new Error(`exchange failed: ${result.error}`);
    const [row] = (await dataSource.query(
      `SELECT "id" FROM "agent_credentials" WHERE "agent_id" = $1 AND "issued_via" = 'OAUTH'
        ORDER BY "created_at" DESC LIMIT 1`,
      [agentId],
    )) as { id: string }[];
    return { agentId, credentialId: row.id, pair: result };
  }

  /** More tokens on the chain, as rotations would leave them (one used parent, a live child). */
  async function addRotatedTokens(g: Grant): Promise<void> {
    const [{ id: parentId }] = (await dataSource.query(
      `SELECT "id" FROM "oauth_refresh_tokens" WHERE "credential_id" = $1`,
      [g.credentialId],
    )) as { id: string }[];
    await dataSource.query(`UPDATE "oauth_refresh_tokens" SET "used_at" = now() WHERE "id" = $1`, [
      parentId,
    ]);
    const [{ id: childId }] = (await dataSource.query(
      `INSERT INTO "oauth_refresh_tokens"
         ("organization_id", "credential_id", "oauth_client_id", "token_hash", "parent_id",
          "scope", "expires_at")
       VALUES ($1, $2, $3, $4, $5, 'assay:agent offline_access', now() + interval '30 days')
       RETURNING "id"`,
      [ORGANIZATION, g.credentialId, builtin.id, randomHash(), parentId],
    )) as { id: string }[];
    await dataSource.query(
      `INSERT INTO "oauth_access_tokens"
         ("organization_id", "credential_id", "refresh_token_id", "token_hash", "scope",
          "audience", "expires_at", "first_used_at")
       VALUES ($1, $2, $3, $4, 'assay:agent offline_access', $5, now() + interval '1 hour', now())`,
      [ORGANIZATION, g.credentialId, childId, randomHash(), MCP],
    );
  }

  function randomHash(): string {
    return randomBytes(32).toString('hex');
  }

  async function credentialRow(id: string): Promise<AgentCredentialEntity> {
    return dataSource
      .getRepository(AgentCredentialEntity)
      .findOneOrFail({ where: { organizationId: ORGANIZATION, id } });
  }

  async function tokenRevocations(
    credentialId: string,
  ): Promise<{ table: string; revoked_at: Date | null }[]> {
    return (await dataSource.query(
      `SELECT 'refresh' AS "table", "revoked_at" FROM "oauth_refresh_tokens" WHERE "credential_id" = $1
       UNION ALL
       SELECT 'access', "revoked_at" FROM "oauth_access_tokens" WHERE "credential_id" = $1`,
      [credentialId],
    )) as { table: string; revoked_at: Date | null }[];
  }

  async function revokedEntries(credentialId: string): Promise<AuditLogEntryEntity[]> {
    return dataSource.getRepository(AuditLogEntryEntity).find({
      where: {
        organizationId: ORGANIZATION,
        action: 'credential.revoked',
        resourceId: credentialId,
      },
    });
  }

  async function expectRefused(credentialId: string): Promise<void> {
    await expect(
      resolver.sessionFor(await credentialRow(credentialId), { paymentsAllowed: true }),
    ).rejects.toMatchObject({ errorCode: McpErrorCode.MCP_CREDENTIAL_INVALID, statusCode: 401 });
  }

  // ── tests ──────────────────────────────────────────────────────────────────

  it('DELETE on an OAuth row: the row and every token revoked in one transaction', async () => {
    const g = await grant();
    await addRotatedTokens(g);
    const bystander = await grant();
    expect(await tokenRevocations(g.credentialId)).toHaveLength(4);

    await credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, ACTOR);

    const row = await credentialRow(g.credentialId);
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedBy).toBe(ACTOR.id);
    const revoked = await tokenRevocations(g.credentialId);
    expect(revoked).toHaveLength(4);
    for (const token of revoked) {
      // One instant for the whole cascade: written by one transaction.
      expect(token.revoked_at?.getTime()).toBe(row.revokedAt?.getTime());
    }
    // Another grant of the same client is untouched.
    expect((await credentialRow(bystander.credentialId)).revokedAt).toBeNull();
    for (const token of await tokenRevocations(bystander.credentialId)) {
      expect(token.revoked_at).toBeNull();
    }
  });

  it('a failure inside the transaction revokes nothing: neither the row nor any token', async () => {
    const g = await grant();
    failAudit = true;

    await expect(
      credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, ACTOR),
    ).rejects.toThrow('audit down');

    expect((await credentialRow(g.credentialId)).revokedAt).toBeNull();
    for (const token of await tokenRevocations(g.credentialId)) {
      expect(token.revoked_at).toBeNull();
    }
    expect(bumps).toEqual([]);
  });

  it('next MCP request is refused (MCP_CREDENTIAL_INVALID → 401); refresh token rows are dead', async () => {
    const g = await grant();
    // Positive control: the live grant resolves.
    await expect(
      resolver.sessionFor(await credentialRow(g.credentialId), { paymentsAllowed: true }),
    ).resolves.toMatchObject({ credentialId: g.credentialId });

    await credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, ACTOR);

    await expectRefused(g.credentialId);
    // The access token the client holds is itself revoked (the OAuth source's
    // own check), and so is its refresh token (refresh step 1: invalid_grant).
    const hash = (token: string) => createHash('sha256').update(token).digest('hex');
    const [access] = (await dataSource.query(
      `SELECT "revoked_at" FROM "oauth_access_tokens" WHERE "token_hash" = $1`,
      [hash(g.pair.access_token)],
    )) as { revoked_at: Date | null }[];
    const [refresh] = (await dataSource.query(
      `SELECT "revoked_at" FROM "oauth_refresh_tokens" WHERE "token_hash" = $1`,
      [hash(g.pair.refresh_token)],
    )) as { revoked_at: Date | null }[];
    expect(access.revoked_at).not.toBeNull();
    expect(refresh.revoked_at).not.toBeNull();
  });

  it('audits credential.revoked naming the credential and client, never a token or hash', async () => {
    const g = await grant();

    await credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, ACTOR);

    const [entry, ...rest] = await revokedEntries(g.credentialId);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      actorType: 'user',
      actorId: ACTOR.id,
      resourceType: 'agent_credential',
      before: { revokedAt: null },
      after: {
        name: 'Example app',
        issuedVia: 'OAUTH',
        clientId: builtin.clientId,
        revokedAt: expect.any(String),
      },
    });
    const text = JSON.stringify(entry);
    const hash = (token: string) => createHash('sha256').update(token).digest('hex');
    for (const secret of [g.pair.access_token, g.pair.refresh_token]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(hash(secret));
    }
  });

  it('invalidates cached access after commit, once; a second revoke changes nothing', async () => {
    const g = await grant();
    bumps.length = 0;

    await credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, ACTOR);
    const first = await credentialRow(g.credentialId);
    await credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, {
      type: 'user',
      id: 'someone-else',
    });

    expect(bumps).toEqual([ORGANIZATION]);
    const second = await credentialRow(g.credentialId);
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
    expect(second.revokedBy).toBe(ACTOR.id);
    expect(await revokedEntries(g.credentialId)).toHaveLength(1);
  });

  it('a rotation holding its refresh token: no deadlock, and every token still ends up revoked', async () => {
    const g = await grant();
    const rotation = new Client({ ...pgOptions(), database: DATABASE });
    const parker = new Client({ ...pgOptions(), database: DATABASE });
    const observer = new Client({ ...pgOptions(), database: DATABASE });
    await Promise.all([rotation.connect(), parker.connect(), observer.connect()]);
    try {
      // A rotation in flight (§6.3.11, Task 1.8): it holds its refresh token row.
      await rotation.query('BEGIN');
      const [held] = (
        await rotation.query<{ id: string }>(
          `SELECT "id" FROM "oauth_refresh_tokens" WHERE "credential_id" = $1 FOR UPDATE`,
          [g.credentialId],
        )
      ).rows;
      // Park the revoke after it locked the credential row and skipped the
      // held refresh token: hold the access token row it updates next.
      await parker.query('BEGIN');
      await parker.query(
        `SELECT "id" FROM "oauth_access_tokens" WHERE "credential_id" = $1 FOR UPDATE`,
        [g.credentialId],
      );
      const revoke = credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, ACTOR);
      await waitForWaiters(observer, 1);

      // The rotation now waits for the credential row the revoke holds. With a
      // revoke that waited for the refresh token instead, this is a deadlock.
      const rotationCredential = rotation.query<{ revoked_at: Date | null }>(
        `SELECT "revoked_at" FROM "agent_credentials" WHERE "id" = $1 FOR UPDATE`,
        [g.credentialId],
      );
      await waitForWaiters(observer, 2);
      await parker.query('COMMIT');
      await revoke;

      // Under the credential lock the rotation finds it revoked and revokes its own token.
      const [credential] = (await rotationCredential).rows;
      expect(credential.revoked_at).not.toBeNull();
      await rotation.query(`UPDATE "oauth_refresh_tokens" SET "revoked_at" = $2 WHERE "id" = $1`, [
        held.id,
        credential.revoked_at,
      ]);
      await rotation.query('COMMIT');
    } finally {
      await Promise.all([rotation.end(), parker.end(), observer.end()]);
    }

    expect((await credentialRow(g.credentialId)).revokedAt).not.toBeNull();
    for (const token of await tokenRevocations(g.credentialId)) {
      expect(token.revoked_at).not.toBeNull();
    }
    expect(await revokedEntries(g.credentialId)).toHaveLength(1);
  });

  it('the list shows the revoked grant as an OAuth row of the built-in client', async () => {
    const g = await grant();
    await credentials.revoke(ORGANIZATION, g.agentId, g.credentialId, ACTOR);

    const page = await credentials.list(ORGANIZATION, g.agentId, {
      limit: 25,
      order: SortDirection.DESC,
    } as never);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: g.credentialId,
      issuedVia: 'OAUTH',
      prefix: null,
      revokedAt: expect.any(Date),
      oauthClient: {
        clientId: builtin.clientId,
        name: 'Assay app (assay-mcp)',
        registrableDomain: null,
        verified: false,
        paymentClient: true,
      },
    });
  });

  function pgOptions() {
    const connection = testConnectionOptions();
    return {
      host: connection.host,
      port: connection.port,
      user: connection.username,
      password: connection.password,
    };
  }

  /** Polls until at least `count` backends wait on a lock: a condition, not a timer. */
  async function waitForWaiters(observer: Client, count: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const { rows } = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS "n" FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.datname = $1`,
        [DATABASE],
      );
      if (rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fewer than ${count} lock waiters after 5 s`);
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
