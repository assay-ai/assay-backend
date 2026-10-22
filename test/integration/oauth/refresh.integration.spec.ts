import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

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
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthRefreshTokenRepository } from '@database/postgres/repositories/oauth-refresh-token.repository';
import {
  NotificationEvent,
  NotificationPort,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';
import { seal as sealGrace } from '@modules/oauth/domain/grace-box';
import { mint } from '@modules/oauth/domain/opaque-token';
import { OAuthGrantWriter } from '@modules/oauth/services/oauth-grant.writer';
import {
  OAuthTokenService,
  TokenPair,
  isOAuthError,
} from '@modules/oauth/services/oauth-token.service';
import {
  OAuthDatabaseFacts,
  OAuthSignalsReader,
} from '@modules/observability/services/oauth-signals.reader';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AuditLogWriter } from '@shared/audit';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * Token service B (spec §6.3.11, §6.3.12): refresh rotation, the 30 s grace,
 * reuse detection and client revocation, on real migrations and real Redis.
 */
describe('OAuth refresh rotation — real database and Redis', () => {
  const DATABASE = 'assay_oauth_refresh_test';
  const MCP = 'https://mcp.example.test';
  const ORGANIZATION = '22222222-2222-4222-8222-222222222222';
  const REDIRECT = 'http://127.0.0.1:33418/callback';
  const APPROVER = 'user-credential-1';
  const DAY = 86_400_000;

  let dataSource: DataSource;
  let redis: Redis;
  let clients: OAuthClientRepository;
  let credentials: AgentCredentialRepository;
  let service: OAuthTokenService;
  let signals: OAuthSignalsReader;
  let baseline: OAuthDatabaseFacts;
  let notifications: NotificationRequest[];
  let bumps: string[];
  let client: OAuthClientEntity;
  let otherClient: OAuthClientEntity;
  let builtin: OAuthClientEntity;

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

    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });

    clients = new OAuthClientRepository(dataSource);
    credentials = new AgentCredentialRepository(dataSource);
    client = await insertClient();
    otherClient = await insertClient();
    builtin = await insertClient(OAuthClientKind.BUILTIN);
    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Example org', 'ACTIVE')`,
      [ORGANIZATION],
    );
  });

  beforeEach(async () => {
    notifications = [];
    bumps = [];
    signals = new OAuthSignalsReader(dataSource, new CacheService(redis));
    baseline = await signals.databaseFacts(new Date(0));
    service = makeService(new CacheService(redis));
  });

  /** The service under test, on `cache` (a real Redis unless a test fakes one). */
  function makeService(cache: CacheService): OAuthTokenService {
    const audit = new AuditLogWriter(dataSource);
    const notifier: NotificationPort = {
      notify: async (request) => {
        notifications.push(request);
        return { deliveredNow: true };
      },
    };
    const epoch = {
      bump: async (organizationId: string) => {
        bumps.push(organizationId);
      },
    } as unknown as AccessEpochService;
    return new OAuthTokenService(
      dataSource,
      new OAuthAuthorizationCodeRepository(dataSource),
      clients,
      new OAuthGrantWriter(dataSource, credentials, audit),
      audit,
      epoch,
      { issuer: MCP, paymentClients: [`${MCP}/oauth/clients/assay-mcp`] },
      new OAuthRefreshTokenRepository(dataSource),
      new OAuthAccessTokenRepository(dataSource),
      credentials,
      cache,
      notifier,
    );
  }

  afterAll(async () => {
    redis?.disconnect();
    await dataSource?.destroy();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function insertClient(
    kind: OAuthClientKind = OAuthClientKind.DCR,
  ): Promise<OAuthClientEntity> {
    return clients.save(
      clients.create({
        clientId:
          kind === OAuthClientKind.BUILTIN
            ? `${MCP}/oauth/clients/assay-mcp`
            : `dcr_${randomBytes(16).toString('base64url').slice(0, 22)}`,
        kind,
        clientName: 'Example client',
        clientUri: null,
        redirectUris: [REDIRECT],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
        lastUsedAt: null,
      }),
    );
  }

  interface Grant {
    agentId: string;
    credentialId: string;
    pair: TokenPair;
  }

  /** A real grant: an approved code, exchanged. */
  async function grant(oauthClient: OAuthClientEntity = client): Promise<Grant> {
    const agentId = randomUUID();
    await dataSource.query(
      `INSERT INTO "agents"
         ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id")
       VALUES ($1, $2, $3, 'ACTIVE', $4, 'eip155:1')`,
      [
        agentId,
        ORGANIZATION,
        `did:privy:test-${agentId}`,
        `eip155:1:0x${randomBytes(20).toString('hex')}`,
      ],
    );
    const { code, verifier } = await mintFor(agentId, oauthClient, null);
    const pair = expectPair(
      await service.exchangeCode({
        code,
        redirectUri: REDIRECT,
        clientId: oauthClient.clientId,
        codeVerifier: verifier,
      }),
    );
    const [credential] = await credentials.find({
      where: { organizationId: ORGANIZATION, agentId },
    });
    return { agentId, credentialId: credential.id, pair };
  }

  async function mintFor(
    agentId: string,
    oauthClient: OAuthClientEntity,
    replaces: string | null,
  ): Promise<{ code: string; verifier: string }> {
    const verifier = randomBytes(32).toString('base64url');
    const code = await service.mintCode(
      {
        oauthClientId: oauthClient.id,
        redirectUri: REDIRECT,
        codeChallenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
        scope: 'assay:agent offline_access',
        boundOrganizationId: ORGANIZATION,
      },
      { agentId, name: 'Example app', approvedBy: APPROVER, replaces },
    );
    return { code, verifier };
  }

  function refresh(refreshToken: string, clientId = client.clientId, scope?: string) {
    return service.refresh({ refreshToken, clientId, scope });
  }

  function expectPair(result: unknown): TokenPair {
    if (isOAuthError(result)) throw new Error(`expected a token pair, got ${result.error}`);
    return result as TokenPair;
  }

  function hashOf(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async function credential(id: string): Promise<AgentCredentialEntity> {
    return dataSource.getRepository(AgentCredentialEntity).findOneByOrFail({ id });
  }

  async function refreshRow(token: string): Promise<OAuthRefreshTokenEntity> {
    return dataSource
      .getRepository(OAuthRefreshTokenEntity)
      .findOneByOrFail({ tokenHash: hashOf(token) });
  }

  async function accessRow(token: string): Promise<OAuthAccessTokenEntity> {
    return dataSource
      .getRepository(OAuthAccessTokenEntity)
      .findOneByOrFail({ tokenHash: hashOf(token) });
  }

  /**
   * Moves the whole history of `token`'s grant `seconds` into the past (issue,
   * use and expiry times of every token), as if that much time had passed.
   */
  async function ageUse(token: string, seconds: number): Promise<void> {
    const shift = `make_interval(secs => $2)`;
    await dataSource.query(
      `UPDATE "oauth_refresh_tokens"
          SET "created_at" = "created_at" - ${shift}, "used_at" = "used_at" - ${shift},
              "expires_at" = "expires_at" - ${shift}
        WHERE "credential_id" = (SELECT "credential_id" FROM "oauth_refresh_tokens"
                                  WHERE "token_hash" = $1)`,
      [hashOf(token), seconds],
    );
    await dataSource.query(
      `UPDATE "oauth_access_tokens"
          SET "created_at" = "created_at" - ${shift},
              "first_used_at" = "first_used_at" - ${shift},
              "expires_at" = "expires_at" - ${shift}
        WHERE "credential_id" = (SELECT "credential_id" FROM "oauth_refresh_tokens"
                                  WHERE "token_hash" = $1)`,
      [hashOf(token), seconds],
    );
  }

  async function auditOf(action: string, credentialId: string): Promise<AuditLogEntryEntity[]> {
    return dataSource.getRepository(AuditLogEntryEntity).find({
      where: { organizationId: ORGANIZATION, action, resourceId: credentialId },
      order: { createdAt: 'ASC' },
    });
  }

  async function liveTokens(credentialId: string): Promise<{ access: number; refresh: number }> {
    const [row] = (await dataSource.query(
      `SELECT (SELECT count(*) FROM "oauth_access_tokens"
                WHERE "credential_id" = $1 AND "revoked_at" IS NULL)::int AS "access",
              (SELECT count(*) FROM "oauth_refresh_tokens"
                WHERE "credential_id" = $1 AND "revoked_at" IS NULL)::int AS "refresh"`,
      [credentialId],
    )) as { access: number; refresh: number }[];
    return row;
  }

  /** How far a dashboard fact (spec §6.7, read from the database) moved in this test. */
  async function fact(name: keyof OAuthDatabaseFacts): Promise<number> {
    return (await signals.databaseFacts(new Date(0)))[name] - baseline[name];
  }

  // ── rotation ───────────────────────────────────────────────────────────────

  it('rotation moves credential expires_at to child expiry', async () => {
    const { credentialId, pair } = await grant();
    const before = await credential(credentialId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const next = expectPair(await refresh(pair.refresh_token));
    expect(next).toEqual({
      access_token: expect.stringMatching(/^assay_at_[A-Za-z0-9_-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^assay_rt_[A-Za-z0-9_-]{43}$/),
      scope: 'assay:agent offline_access',
    });
    expect(next.refresh_token).not.toBe(pair.refresh_token);

    const parent = await refreshRow(pair.refresh_token);
    const child = await refreshRow(next.refresh_token);
    expect(parent.usedAt).not.toBeNull();
    expect(parent.revokedAt).toBeNull();
    expect(child.parentId).toBe(parent.id);
    expect(child.credentialId).toBe(credentialId);
    expect(child.oauthClientId).toBe(client.id);
    expect(child.usedAt).toBeNull();
    expect(child.expiresAt.getTime() - child.createdAt.getTime()).toBe(30 * DAY);

    const access = await accessRow(next.access_token);
    expect(access.refreshTokenId).toBe(child.id);
    expect(access.audience).toBe(MCP);
    expect(access.expiresAt.getTime() - access.createdAt.getTime()).toBe(3_600_000);

    const after = await credential(credentialId);
    expect(after.expiresAt?.getTime()).toBe(child.expiresAt.getTime());
    expect(after.expiresAt!.getTime()).toBeGreaterThan(before.expiresAt!.getTime());

    // A refresh never creates a credential row (R-OA-17).
    const rows = await credentials.find({
      where: { organizationId: ORGANIZATION, agentId: after.agentId },
    });
    expect(rows).toHaveLength(1);

    // The child rotates in turn.
    expectPair(await refresh(next.refresh_token));
  });

  it('a narrower scope narrows the access token only; a wider one is invalid_scope', async () => {
    const { pair } = await grant();
    const narrowed = expectPair(await refresh(pair.refresh_token, client.clientId, 'assay:agent'));
    expect(narrowed.scope).toBe('assay:agent');
    expect((await accessRow(narrowed.access_token)).scope).toBe('assay:agent');
    // RFC 6749 §6: the new refresh token keeps the grant's scope.
    expect((await refreshRow(narrowed.refresh_token)).scope).toBe('assay:agent offline_access');

    expect(await refresh(narrowed.refresh_token, client.clientId, 'assay:agent admin')).toEqual(
      expect.objectContaining({ error: 'invalid_scope' }),
    );
    // The refused request did not burn the token; with no scope, the full one comes back.
    const full = expectPair(await refresh(narrowed.refresh_token));
    expect(full.scope).toBe('assay:agent offline_access');
  });

  // ── grace ──────────────────────────────────────────────────────────────────

  it('two refreshes within 30 s → identical pair, one oauth.refresh_grace_used', async () => {
    const { credentialId, pair } = await grant();
    const first = expectPair(await refresh(pair.refresh_token));
    await ageUse(pair.refresh_token, 20);
    const second = expectPair(await refresh(pair.refresh_token));
    expect(second).toEqual(first);

    const used = await auditOf('oauth.refresh_grace_used', credentialId);
    expect(used).toHaveLength(1);
    expect(used[0].actorType).toBe('system');
    expect(used[0].after).toEqual(expect.objectContaining({ clientId: client.clientId }));
    expect(JSON.stringify(used[0])).not.toContain(hashOf(pair.refresh_token));
    expect(await fact('refreshGraceUses')).toBe(1);

    // Still exactly one child: the parent and its child.
    const [{ rows }] = (await dataSource.query(
      `SELECT count(*)::int AS "rows" FROM "oauth_refresh_tokens" WHERE "credential_id" = $1`,
      [credentialId],
    )) as { rows: number }[];
    expect(rows).toBe(2);
    expect((await credential(credentialId)).revokedAt).toBeNull();
  });

  it('parallel refreshes of one token: one child, every caller gets the same pair', async () => {
    const { credentialId, pair } = await grant();
    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(pair.refresh_token)));
    const pairs = results.map(expectPair);
    for (const one of pairs) expect(one).toEqual(pairs[0]);

    const [{ children }] = (await dataSource.query(
      `SELECT count(*)::int AS "children" FROM "oauth_refresh_tokens"
        WHERE "credential_id" = $1 AND "parent_id" IS NOT NULL`,
      [credentialId],
    )) as { children: number }[];
    expect(children).toBe(1);
    expect(await auditOf('oauth.refresh_grace_used', credentialId)).toHaveLength(5);
  });

  it('the grace entry is sealed: Redis holds no token', async () => {
    const { pair } = await grant();
    const next = expectPair(await refresh(pair.refresh_token));
    const sealed = await redis.get(`oauth:rt-grace:${hashOf(pair.refresh_token)}`);
    expect(sealed).toEqual(expect.any(String));
    expect(sealed).not.toContain(next.access_token);
    expect(sealed).not.toContain(next.refresh_token);
    const ttl = await redis.ttl(`oauth:rt-grace:${hashOf(pair.refresh_token)}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('Redis flushed inside grace → invalid_grant, no revoke', async () => {
    const { credentialId, pair } = await grant();
    const next = expectPair(await refresh(pair.refresh_token));
    await redis.del(`oauth:rt-grace:${hashOf(pair.refresh_token)}`);

    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
    expect((await credential(credentialId)).revokedAt).toBeNull();
    expect(await auditOf('oauth.refresh_grace_used', credentialId)).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    // The child still works.
    expectPair(await refresh(next.refresh_token));
  });

  it('a grace read that never answers → invalid_grant within its bound, no revoke', async () => {
    const { credentialId, pair } = await grant();
    expectPair(await refresh(pair.refresh_token));
    const hung = makeService({
      getRedisClient: () => ({ get: () => new Promise(() => undefined) }),
    } as unknown as CacheService);

    const started = Date.now();
    expect(
      await hung.refresh({ refreshToken: pair.refresh_token, clientId: client.clientId }),
    ).toEqual({ error: 'invalid_grant' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await credential(credentialId)).revokedAt).toBeNull();
    expect(notifications).toHaveLength(0);
  });

  it('a grace entry whose child never committed → invalid_grant, no revoke', async () => {
    const { credentialId, pair } = await grant();
    const next = expectPair(await refresh(pair.refresh_token));
    // A timed-out SET from another process landing late: a sealed pair whose
    // rotation rolled back, so its tokens are in no table.
    const parentHash = hashOf(pair.refresh_token);
    await redis.set(
      `oauth:rt-grace:${parentHash}`,
      sealGrace(pair.refresh_token, parentHash, {
        access_token: mint('assay_at_'),
        refresh_token: mint('assay_rt_'),
        expires_in: 3600,
        scope: 'assay:agent offline_access',
      }),
      'EX',
      30,
    );

    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
    expect((await credential(credentialId)).revokedAt).toBeNull();
    expect(await auditOf('oauth.refresh_grace_used', credentialId)).toHaveLength(0);
    expect(await fact('refreshGraceUses')).toBe(0);
    expect(notifications).toHaveLength(0);
    // The committed child still works.
    expectPair(await refresh(next.refresh_token));
  });

  it('a grace entry whose child was revoked → invalid_grant, no revoke', async () => {
    const { credentialId, pair } = await grant();
    const next = expectPair(await refresh(pair.refresh_token));
    await dataSource.query(
      `UPDATE "oauth_refresh_tokens" SET "revoked_at" = now() WHERE "token_hash" = $1`,
      [hashOf(next.refresh_token)],
    );

    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
    expect((await credential(credentialId)).revokedAt).toBeNull();
    expect(await auditOf('oauth.refresh_grace_used', credentialId)).toHaveLength(0);
  });

  it.each([
    ['revoked', `"revoked_at" = now(), "revoked_by" = 'user-elsewhere'`],
    ['expired', `"expires_at" = now() - interval '1 second'`],
  ])(
    'a grace pair whose credential was %s after the pre-checks → invalid_grant, no revoke',
    async (_label, change) => {
      const { credentialId, pair } = await grant();
      expectPair(await refresh(pair.refresh_token));
      const before = await credential(credentialId);
      // The window: after refresh's credential check, before the grace read.
      // A revocation here has committed but its sweep has not reached the child.
      const grants = (service as unknown as { grants: OAuthGrantWriter }).grants;
      const rotate = grants.rotateRefresh.bind(grants);
      const spy = jest.spyOn(grants, 'rotateRefresh').mockImplementation(async (input) => {
        const result = await rotate(input);
        await dataSource.query(`UPDATE "agent_credentials" SET ${change} WHERE "id" = $1`, [
          credentialId,
        ]);
        return result;
      });
      try {
        expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
      } finally {
        spy.mockRestore();
      }
      const after = await credential(credentialId);
      // Nothing revoked by the grace path itself.
      expect(after.revokedBy).toBe(_label === 'revoked' ? 'user-elsewhere' : before.revokedBy);
      expect(await auditOf('oauth.refresh_grace_used', credentialId)).toHaveLength(0);
      expect(await fact('refreshGraceUses')).toBe(0);
      expect(notifications).toHaveLength(0);
    },
  );

  // ── reuse after the grace ──────────────────────────────────────────────────

  it('reuse at 31 s after a child access token was used → grant revoked + notification + oauth_refresh_reuse_total{kind="revoked"}', async () => {
    const { agentId, credentialId, pair } = await grant();
    const next = expectPair(await refresh(pair.refresh_token));
    await dataSource.query(
      `UPDATE "oauth_access_tokens" SET "first_used_at" = now() WHERE "token_hash" = $1`,
      [hashOf(next.access_token)],
    );
    await ageUse(pair.refresh_token, 31);

    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });

    const after = await credential(credentialId);
    expect(after.revokedAt).not.toBeNull();
    expect(after.revokedBy).toBe('system:oauth-refresh-reuse');
    expect(await liveTokens(credentialId)).toEqual({ access: 0, refresh: 0 });

    const detected = await auditOf('oauth.refresh_reuse_detected', credentialId);
    expect(detected).toHaveLength(1);
    expect(detected[0].actorType).toBe('system');
    expect(detected[0].actorId).toBe('oauth');
    expect(detected[0].after).toEqual(
      expect.objectContaining({ clientId: client.clientId, agentId }),
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        organizationId: ORGANIZATION,
        event: NotificationEvent.OAUTH_GRANT_STOPPED_REUSE,
        body: 'We stopped Example app because its sign-in was used twice. Sign in again on that device.',
        subjectType: 'credential',
        subjectId: credentialId,
      }),
    );
    expect(JSON.stringify(notifications[0])).not.toContain(next.access_token);
    expect(await fact('stoppedForRefreshReuse')).toBe(1);
    expect(bumps).toEqual([ORGANIZATION]);

    // The child is dead with the grant.
    expect(await refresh(next.refresh_token)).toEqual({ error: 'invalid_grant' });
  });

  it('reuse at 31 s after the child refresh token was used → grant revoked', async () => {
    const { credentialId, pair } = await grant();
    const child = expectPair(await refresh(pair.refresh_token));
    expectPair(await refresh(child.refresh_token));
    await ageUse(pair.refresh_token, 31);

    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
    expect((await credential(credentialId)).revokedBy).toBe('system:oauth-refresh-reuse');
    expect(await liveTokens(credentialId)).toEqual({ access: 0, refresh: 0 });
  });

  it('reuse at 31 s with no used descendant → invalid_grant, credential live, oauth.refresh_stale_reuse', async () => {
    const { credentialId, pair } = await grant();
    const next = expectPair(await refresh(pair.refresh_token));
    // The parent's own first access token was used: it is not a descendant.
    await dataSource.query(
      `UPDATE "oauth_access_tokens" SET "first_used_at" = "created_at" WHERE "token_hash" = $1`,
      [hashOf(pair.access_token)],
    );
    await ageUse(pair.refresh_token, 31);

    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
    expect((await credential(credentialId)).revokedAt).toBeNull();
    const stale = await auditOf('oauth.refresh_stale_reuse', credentialId);
    expect(stale).toHaveLength(1);
    expect(stale[0].after).toEqual(expect.objectContaining({ clientId: client.clientId }));
    expect(await auditOf('oauth.refresh_reuse_detected', credentialId)).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(await fact('refreshStaleReuse')).toBe(1);
    expect(await fact('stoppedForRefreshReuse')).toBe(0);
    expectPair(await refresh(next.refresh_token));
  });

  // ── refusals ───────────────────────────────────────────────────────────────

  it('unknown client → invalid_client, token not burned', async () => {
    const { pair } = await grant();
    expect(await refresh(pair.refresh_token, 'dcr_AAAAAAAAAAAAAAAAAAAAAA')).toEqual({
      error: 'invalid_client',
    });
    expect((await refreshRow(pair.refresh_token)).usedAt).toBeNull();
    expectPair(await refresh(pair.refresh_token));
  });

  it('wrong client → invalid_grant', async () => {
    const { pair } = await grant();
    expect(await refresh(pair.refresh_token, otherClient.clientId)).toEqual({
      error: 'invalid_grant',
    });
    // Not burned: the right client still rotates it.
    expect((await refreshRow(pair.refresh_token)).usedAt).toBeNull();
    expectPair(await refresh(pair.refresh_token));
  });

  it('unknown, malformed, revoked and expired refresh tokens → invalid_grant', async () => {
    expect(await refresh(`assay_rt_${randomBytes(32).toString('base64url')}`)).toEqual({
      error: 'invalid_grant',
    });
    expect(await refresh('assay_rt_short')).toEqual({ error: 'invalid_grant' });

    const revoked = await grant();
    await dataSource.query(
      `UPDATE "oauth_refresh_tokens" SET "revoked_at" = now() WHERE "token_hash" = $1`,
      [hashOf(revoked.pair.refresh_token)],
    );
    expect(await refresh(revoked.pair.refresh_token)).toEqual({ error: 'invalid_grant' });

    const expired = await grant();
    await dataSource.query(
      `UPDATE "oauth_refresh_tokens" SET "expires_at" = now() - interval '1 second'
        WHERE "token_hash" = $1`,
      [hashOf(expired.pair.refresh_token)],
    );
    expect(await refresh(expired.pair.refresh_token)).toEqual({ error: 'invalid_grant' });

    const credentialRevoked = await grant();
    await dataSource.query(
      `UPDATE "agent_credentials" SET "revoked_at" = now(), "revoked_by" = 'user-1' WHERE "id" = $1`,
      [credentialRevoked.credentialId],
    );
    expect(await refresh(credentialRevoked.pair.refresh_token)).toEqual({ error: 'invalid_grant' });
  });

  it('30-day expiry → credential not live (countLive excludes it)', async () => {
    const { agentId, credentialId, pair } = await grant();
    expect(await credentials.countLiveOAuthForAgent(ORGANIZATION, agentId)).toBe(1);

    // 30 days and a second pass with no refresh.
    await dataSource.query(
      `UPDATE "oauth_refresh_tokens"
          SET "created_at" = "created_at" - interval '30 days 1 second',
              "expires_at" = "expires_at" - interval '30 days 1 second'
        WHERE "credential_id" = $1`,
      [credentialId],
    );
    await dataSource.query(
      `UPDATE "agent_credentials" SET "expires_at" = "expires_at" - interval '30 days 1 second'
        WHERE "id" = $1`,
      [credentialId],
    );

    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
    expect(await credentials.countLiveOAuthForAgent(ORGANIZATION, agentId)).toBe(0);
    expect((await credential(credentialId)).revokedAt).toBeNull();
  });

  it('suspended agent: refresh succeeds', async () => {
    const { agentId, pair } = await grant();
    await dataSource.query(`UPDATE "agents" SET "status" = 'SUSPENDED' WHERE "id" = $1`, [agentId]);
    expectPair(await refresh(pair.refresh_token));
  });

  // ── locking ────────────────────────────────────────────────────────────────

  it('a revocation while a rotation is parked on the agent lock: no deadlock, nothing live survives', async () => {
    const { agentId, credentialId, pair } = await grant();
    const holder = new Client({ ...pgOptions(), database: DATABASE });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [`oauth-grants:${agentId}`]);
      // The rotation holds the refresh row and waits for the agent lock.
      const rotation = refresh(pair.refresh_token);
      await waitForWaiters(holder, 1);
      // The person revokes the grant meanwhile (client logout here). Its
      // transaction skips the held row and commits; its sweep then waits on it.
      const revocation = service.revoke({ token: pair.refresh_token, clientId: client.clientId });
      await waitForWaiters(holder, 2);
      expect((await credential(credentialId)).revokedAt).not.toBeNull();
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`oauth-grants:${agentId}`]);
      await revocation;

      expect(await rotation).toEqual({ error: 'invalid_grant' });
      expect((await credential(credentialId)).revokedAt).not.toBeNull();
      expect(await liveTokens(credentialId)).toEqual({ access: 0, refresh: 0 });
      const [{ children }] = (await dataSource.query(
        `SELECT count(*)::int AS "children" FROM "oauth_refresh_tokens"
          WHERE "credential_id" = $1 AND "parent_id" IS NOT NULL`,
        [credentialId],
      )) as { children: number }[];
      expect(children).toBe(0);
    } finally {
      await holder.end();
    }
  });

  it('a revocation while the holder of a skipped token rolls back: the sweep revokes it', async () => {
    const { credentialId, pair } = await grant();
    const holder = new Client({ ...pgOptions(), database: DATABASE });
    await holder.connect();
    try {
      // A rotation that locked the parent and then dies before reaching the credential.
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM "oauth_refresh_tokens" WHERE "token_hash" = $1 FOR UPDATE`,
        [hashOf(pair.refresh_token)],
      );
      const revocation = service.revoke({ token: pair.refresh_token, clientId: client.clientId });
      // The revoking transaction skipped the row and committed; its sweep now waits on it.
      await waitForWaiters(holder, 1);
      expect((await credential(credentialId)).revokedAt).not.toBeNull();
      await holder.query('ROLLBACK');
      await revocation;

      expect(await liveTokens(credentialId)).toEqual({ access: 0, refresh: 0 });
      const revokedAt = (await credential(credentialId)).revokedAt;
      expect((await refreshRow(pair.refresh_token)).revokedAt).toEqual(revokedAt);
    } finally {
      await holder.end();
    }
  });

  it('reuse detection against an in-flight child rotation: one detection, no grandchild, nothing live', async () => {
    const { agentId, credentialId, pair } = await grant();
    const child = expectPair(await refresh(pair.refresh_token));
    await dataSource.query(
      `UPDATE "oauth_access_tokens" SET "first_used_at" = now() WHERE "token_hash" = $1`,
      [hashOf(child.access_token)],
    );
    await ageUse(pair.refresh_token, 31);

    const holder = new Client({ ...pgOptions(), database: DATABASE });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [`oauth-grants:${agentId}`]);
      // The replay holds the parent and queues first on the agent lock …
      const replay = refresh(pair.refresh_token);
      await waitForWaiters(holder, 1);
      // … then the child's rotation holds the child and queues behind it.
      const rotation = refresh(child.refresh_token);
      await waitForWaiters(holder, 2);
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`oauth-grants:${agentId}`]);

      expect(await replay).toEqual({ error: 'invalid_grant' });
      expect(await rotation).toEqual({ error: 'invalid_grant' });
      expect(await auditOf('oauth.refresh_reuse_detected', credentialId)).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(await liveTokens(credentialId)).toEqual({ access: 0, refresh: 0 });
      const childRow = await refreshRow(child.refresh_token);
      const [{ grandchildren }] = (await dataSource.query(
        `SELECT count(*)::int AS "grandchildren" FROM "oauth_refresh_tokens" WHERE "parent_id" = $1`,
        [childRow.id],
      )) as { grandchildren: number }[];
      expect(grandchildren).toBe(0);
    } finally {
      await holder.end();
    }
  });

  it('two concurrent reuse presentations: the grant is stopped once', async () => {
    const { agentId, credentialId, pair } = await grant();
    const child = expectPair(await refresh(pair.refresh_token));
    await dataSource.query(
      `UPDATE "oauth_access_tokens" SET "first_used_at" = now() WHERE "token_hash" = $1`,
      [hashOf(child.access_token)],
    );
    await ageUse(pair.refresh_token, 31);

    // Force the race: both presentations pass the pre-checks against a live
    // grant. The first holds the parent row and queues on the agent lock; the
    // second queues on the parent row behind it. Released, the first revokes;
    // the second then holds the parent, finds the credential revoked under its
    // lock, and stops (`not_live`): no second revocation, notice or metric.
    const holder = new Client({ ...pgOptions(), database: DATABASE });
    await holder.connect();
    let results: unknown[];
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [`oauth-grants:${agentId}`]);
      const presentations = [refresh(pair.refresh_token), refresh(pair.refresh_token)];
      await waitForWaiters(holder, 2);
      expect((await credential(credentialId)).revokedAt).toBeNull();
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`oauth-grants:${agentId}`]);
      results = await Promise.all(presentations);
    } finally {
      await holder.end();
    }
    expect(results).toEqual([{ error: 'invalid_grant' }, { error: 'invalid_grant' }]);
    expect(await auditOf('oauth.refresh_reuse_detected', credentialId)).toHaveLength(1);
    expect(await auditOf('oauth.refresh_stale_reuse', credentialId)).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    expect(await fact('stoppedForRefreshReuse')).toBe(1);
    expect(await fact('refreshStaleReuse')).toBe(0);
    expect(await liveTokens(credentialId)).toEqual({ access: 0, refresh: 0 });
  });

  it('a failed post-commit sweep is logged: reuse still answers, bumps and notifies; logout still returns', async () => {
    const reused = await grant();
    const child = expectPair(await refresh(reused.pair.refresh_token));
    await dataSource.query(
      `UPDATE "oauth_access_tokens" SET "first_used_at" = now() WHERE "token_hash" = $1`,
      [hashOf(child.access_token)],
    );
    await ageUse(reused.pair.refresh_token, 31);
    const loggedOut = await grant();

    // Only the sweep's statements read "agent_credentials" c.
    const query = EntityManager.prototype.query;
    const spy = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      sql: string,
      ...rest: unknown[]
    ) {
      if (sql.includes('FROM "agent_credentials" c')) throw new Error('deadlock detected');
      return query.call(this, sql, ...(rest as [unknown[]]));
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(await refresh(reused.pair.refresh_token)).toEqual({ error: 'invalid_grant' });
      expect((await credential(reused.credentialId)).revokedAt).not.toBeNull();
      expect(bumps).toEqual([ORGANIZATION]);
      expect(notifications).toHaveLength(1);

      await expect(
        service.revoke({ token: loggedOut.pair.refresh_token, clientId: client.clientId }),
      ).resolves.toBeUndefined();
      expect((await credential(loggedOut.credentialId)).revokedAt).not.toBeNull();
      expect(bumps).toEqual([ORGANIZATION, ORGANIZATION]);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('post-commit token sweep failed'));
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('a code exchange replacing a grant while that grant rotates: no deadlock, nothing of the old grant live', async () => {
    const old = await grant(builtin);
    const { code, verifier } = await mintFor(old.agentId, builtin, old.credentialId);
    const holder = new Client({ ...pgOptions(), database: DATABASE });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [`oauth-grants:${old.agentId}`]);
      // The exchange holds its code row and queues first on the agent lock …
      const exchange = service.exchangeCode({
        code,
        redirectUri: REDIRECT,
        clientId: builtin.clientId,
        codeVerifier: verifier,
      });
      await waitForWaiters(holder, 1);
      // … then the old grant's rotation holds its refresh token and queues behind it.
      const rotation = refresh(old.pair.refresh_token, builtin.clientId);
      await waitForWaiters(holder, 2);
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
        `oauth-grants:${old.agentId}`,
      ]);

      expectPair(await exchange);
      expect(await rotation).toEqual({ error: 'invalid_grant' });
      expect((await credential(old.credentialId)).revokedBy).toBe('system:oauth-replaced');
      expect(await liveTokens(old.credentialId)).toEqual({ access: 0, refresh: 0 });
      const [{ children }] = (await dataSource.query(
        `SELECT count(*)::int AS "children" FROM "oauth_refresh_tokens"
          WHERE "credential_id" = $1 AND "parent_id" IS NOT NULL`,
        [old.credentialId],
      )) as { children: number }[];
      expect(children).toBe(0);
    } finally {
      await holder.end();
    }
  });

  // ── grace store failures (fail closed) ─────────────────────────────────────

  function failingCache(set: () => Promise<unknown>): CacheService {
    return {
      getRedisClient: () => ({ set, get: async () => null }),
    } as unknown as CacheService;
  }

  async function expectRolledBack(credentialId: string, token: string, expiresAt: Date | null) {
    expect((await refreshRow(token)).usedAt).toBeNull();
    expect((await credential(credentialId)).expiresAt).toEqual(expiresAt);
    const [{ children }] = (await dataSource.query(
      `SELECT count(*)::int AS "children" FROM "oauth_refresh_tokens"
        WHERE "credential_id" = $1 AND "parent_id" IS NOT NULL`,
      [credentialId],
    )) as { children: number }[];
    expect(children).toBe(0);
  }

  it('a hung Redis: the rotation times out, rolls back and answers temporarily_unavailable', async () => {
    const { credentialId, pair } = await grant();
    const expiresAt = (await credential(credentialId)).expiresAt;
    const hung = makeService(failingCache(() => new Promise(() => undefined)));

    const started = Date.now();
    expect(
      await hung.refresh({ refreshToken: pair.refresh_token, clientId: client.clientId }),
    ).toEqual({
      error: 'temporarily_unavailable',
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(5000);
    await expectRolledBack(credentialId, pair.refresh_token, expiresAt);

    // Redis back: the same token rotates.
    expectPair(await refresh(pair.refresh_token));
  });

  it('a Redis error: the rotation rolls back and answers temporarily_unavailable', async () => {
    const { credentialId, pair } = await grant();
    const expiresAt = (await credential(credentialId)).expiresAt;
    const broken = makeService(failingCache(() => Promise.reject(new Error('redis is down'))));

    expect(
      await broken.refresh({ refreshToken: pair.refresh_token, clientId: client.clientId }),
    ).toEqual({ error: 'temporarily_unavailable' });
    await expectRolledBack(credentialId, pair.refresh_token, expiresAt);
    expectPair(await refresh(pair.refresh_token));
  });

  // ── revocation (RFC 7009) ──────────────────────────────────────────────────

  it('revoke refresh → credential revoked_at set; revoke unknown → no error', async () => {
    const { agentId, credentialId, pair } = await grant();
    await service.revoke({ token: pair.refresh_token, clientId: client.clientId });

    const after = await credential(credentialId);
    expect(after.revokedAt).not.toBeNull();
    expect(await liveTokens(credentialId)).toEqual({ access: 0, refresh: 0 });
    const revoked = await auditOf('credential.revoked', credentialId);
    expect(revoked).toHaveLength(1);
    expect(revoked[0].actorType).toBe('agent');
    expect(revoked[0].actorId).toBe(agentId);
    expect(revoked[0].after).toEqual(
      expect.objectContaining({
        reason: 'client_logout',
        issuedVia: 'OAUTH',
        clientId: client.clientId,
      }),
    );
    expect(bumps).toEqual([ORGANIZATION]);
    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });

    await expect(
      service.revoke({
        token: `assay_rt_${randomBytes(32).toString('base64url')}`,
        clientId: client.clientId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.revoke({ token: 'nonsense', clientId: client.clientId }),
    ).resolves.toBeUndefined();
    // A second revocation of the same token writes nothing more.
    await service.revoke({ token: pair.refresh_token, clientId: client.clientId });
    expect(await auditOf('credential.revoked', credentialId)).toHaveLength(1);
  });

  it('revoke access token → only that token is revoked', async () => {
    const { credentialId, pair } = await grant();
    await service.revoke({ token: pair.access_token, clientId: client.clientId });
    expect((await accessRow(pair.access_token)).revokedAt).not.toBeNull();
    expect((await credential(credentialId)).revokedAt).toBeNull();
    expect((await refreshRow(pair.refresh_token)).revokedAt).toBeNull();
    expectPair(await refresh(pair.refresh_token));
  });

  it('revoke by another client → no-op', async () => {
    const { credentialId, pair } = await grant();
    await service.revoke({ token: pair.refresh_token, clientId: otherClient.clientId });
    await service.revoke({ token: pair.access_token, clientId: otherClient.clientId });
    expect((await credential(credentialId)).revokedAt).toBeNull();
    expect((await accessRow(pair.access_token)).revokedAt).toBeNull();
  });

  it('no raw token in any column, and no hash outside the hash columns', async () => {
    const { pair } = await grant();
    const next = expectPair(await refresh(pair.refresh_token));
    await ageUse(pair.refresh_token, 20);
    expectPair(await refresh(pair.refresh_token));
    await ageUse(pair.refresh_token, 11);
    expect(await refresh(pair.refresh_token)).toEqual({ error: 'invalid_grant' });
    await service.revoke({ token: next.refresh_token, clientId: client.clientId });

    const secrets = [pair.access_token, pair.refresh_token, next.access_token, next.refresh_token];
    const hashes = secrets.map(hashOf);
    const columns = (await dataSource.query(
      `SELECT "table_name", "column_name" FROM information_schema.columns
        WHERE "table_schema" = 'public'
          AND "data_type" IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`,
    )) as { table_name: string; column_name: string }[];
    for (const { table_name: table, column_name: column } of columns) {
      const needles = [...secrets, ...(column === 'token_hash' ? [] : hashes)];
      for (const needle of needles) {
        const [hit] = (await dataSource.query(
          `SELECT count(*)::int AS "n" FROM "${table}" WHERE "${column}"::text LIKE $1`,
          [`%${needle}%`],
        )) as { n: number }[];
        expect({ table, column, hits: hit.n }).toEqual({ table, column, hits: 0 });
      }
    }
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
