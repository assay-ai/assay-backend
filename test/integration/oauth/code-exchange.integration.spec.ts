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
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthRefreshTokenRepository } from '@database/postgres/repositories/oauth-refresh-token.repository';
import { OAuthGrantWriter } from '@modules/oauth/services/oauth-grant.writer';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import {
  OAuthCodeApproval,
  OAuthCodeRequest,
  OAuthTokenService,
  TokenPair,
  isOAuthError,
} from '@modules/oauth/services/oauth-token.service';
import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AuditLogWriter } from '@shared/audit';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * Token service A (spec §6.3.10): minting a code, exchanging it once, and the
 * grant it creates — one `agent_credentials` row, the same row an API key is.
 */
describe('OAuth code exchange — real migrations', () => {
  const DATABASE = 'assay_oauth_code_exchange_test';
  const MCP = 'https://mcp.example.test';
  const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
  const REDIRECT = 'http://127.0.0.1:33418/callback';
  const APPROVER = 'user-credential-1';
  const DAY = 86_400_000;

  let dataSource: DataSource;
  let clients: OAuthClientRepository;
  let service: OAuthTokenService;
  let bumps: string[];
  let failBump = false;
  let client: OAuthClientEntity;
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

    clients = new OAuthClientRepository(dataSource);
    const audit = new AuditLogWriter(dataSource);
    bumps = [];
    const epoch = {
      bump: async (organizationId: string) => {
        if (failBump) throw new Error('redis down');
        bumps.push(organizationId);
      },
    } as unknown as AccessEpochService;
    const writer = new OAuthGrantWriter(
      dataSource,
      new AgentCredentialRepository(dataSource),
      audit,
    );
    service = new OAuthTokenService(
      dataSource,
      new OAuthAuthorizationCodeRepository(dataSource),
      clients,
      writer,
      audit,
      epoch,
      { issuer: MCP },
      new OAuthRefreshTokenRepository(dataSource),
      new OAuthAccessTokenRepository(dataSource),
      new AgentCredentialRepository(dataSource),
      {} as CacheService,
      new OAuthMetrics(new MetricsRegistryService()),
      { notify: async () => ({ deliveredNow: true }) },
    );
    client = await insertClient();
    builtin = await insertClient(OAuthClientKind.BUILTIN);
    await insertOrganization(ORGANIZATION);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(() => {
    bumps.length = 0;
    failBump = false;
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

  async function insertOrganization(id: string, status = 'ACTIVE'): Promise<void> {
    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Example org', $2)`,
      [id, status],
    );
  }

  /** An agent of `organizationId`; ACTIVE with a linked wallet unless told otherwise. */
  async function insertAgent(
    agentId: string,
    options: { organizationId?: string; status?: string; wallet?: boolean } = {},
  ): Promise<void> {
    const wallet = options.wallet ?? true;
    await dataSource.query(
      `INSERT INTO "agents"
         ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id")
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [
        agentId,
        options.organizationId ?? ORGANIZATION,
        `did:privy:test-${agentId}`,
        options.status ?? 'ACTIVE',
        wallet ? `eip155:1:0x${randomBytes(20).toString('hex')}` : null,
        wallet ? 'eip155:1' : null,
      ],
    );
  }

  function pkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    return { verifier, challenge };
  }

  interface Minted {
    code: string;
    verifier: string;
    agentId: string;
  }

  async function mint(
    overrides: {
      agentId?: string;
      replaces?: string | null;
      oauthClient?: OAuthClientEntity;
      organizationId?: string;
      skipAgent?: boolean;
    } = {},
  ): Promise<Minted> {
    const { verifier, challenge } = pkce();
    const agentId = overrides.agentId ?? randomUUID();
    if (!overrides.skipAgent) await insertAgent(agentId);
    const request: OAuthCodeRequest = {
      oauthClientId: (overrides.oauthClient ?? client).id,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scope: 'assay:agent offline_access',
      boundOrganizationId: overrides.organizationId ?? ORGANIZATION,
    };
    const approval: OAuthCodeApproval = {
      agentId,
      name: 'Example app',
      approvedBy: APPROVER,
      replaces: overrides.replaces ?? null,
    };
    const code = await service.mintCode(request, approval);
    return { code, verifier, agentId };
  }

  function exchange(
    minted: Minted,
    overrides: Partial<{
      redirectUri: string;
      clientId: string;
      codeVerifier: string;
      resource: string;
    }> = {},
    oauthClient: OAuthClientEntity = client,
  ) {
    return service.exchangeCode({
      code: minted.code,
      redirectUri: REDIRECT,
      clientId: oauthClient.clientId,
      codeVerifier: minted.verifier,
      resource: undefined,
      ...overrides,
    });
  }

  function expectPair(result: unknown): TokenPair {
    if (isOAuthError(result)) throw new Error(`expected a token pair, got ${result.error}`);
    return result as TokenPair;
  }

  async function credentialsOf(agentId: string): Promise<AgentCredentialEntity[]> {
    return dataSource.getRepository(AgentCredentialEntity).find({
      where: { organizationId: ORGANIZATION, agentId },
      order: { createdAt: 'ASC' },
    });
  }

  async function auditActions(action: string): Promise<AuditLogEntryEntity[]> {
    return dataSource
      .getRepository(AuditLogEntryEntity)
      .find({ where: { organizationId: ORGANIZATION, action }, order: { createdAt: 'ASC' } });
  }

  async function insertLiveGrant(
    agentId: string,
    oauthClient: OAuthClientEntity = client,
    expiresIn = '1 day',
  ): Promise<string> {
    const [row] = (await dataSource.query(
      `INSERT INTO "agent_credentials"
         ("organization_id", "agent_id", "name", "issued_via", "oauth_client_id", "expires_at")
       VALUES ($1, $2, 'existing', 'OAUTH', $3, now() + $4::interval) RETURNING "id"`,
      [ORGANIZATION, agentId, oauthClient.id, expiresIn],
    )) as { id: string }[];
    return row.id;
  }

  function codeHashOf(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  async function liveCredentials(agentId: string): Promise<number> {
    const [{ live }] = (await dataSource.query(
      `SELECT count(*)::int AS "live" FROM "agent_credentials"
        WHERE "agent_id" = $1 AND "revoked_at" IS NULL`,
      [agentId],
    )) as { live: number }[];
    return live;
  }

  /**
   * Asserts none of `secrets` appears in any text-like column, and none of
   * `hashes` appears outside the `code_hash`/`token_hash` columns (R-OA-26).
   */
  async function assertNoSecretsStored(secrets: string[], hashes: string[]): Promise<void> {
    const columns = (await dataSource.query(
      `SELECT "table_name", "column_name" FROM information_schema.columns
        WHERE "table_schema" = 'public'
          AND "data_type" IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`,
    )) as { table_name: string; column_name: string }[];
    expect(columns.length).toBeGreaterThan(10);

    for (const { table_name: table, column_name: column } of columns) {
      const needles = [
        ...secrets,
        ...(column === 'code_hash' || column === 'token_hash' ? [] : hashes),
      ];
      for (const needle of needles) {
        const [hit] = (await dataSource.query(
          `SELECT count(*)::int AS "n" FROM "${table}" WHERE "${column}"::text LIKE $1`,
          [`%${needle}%`],
        )) as { n: number }[];
        expect({ table, column, hits: hit.n }).toEqual({ table, column, hits: 0 });
      }
    }
  }

  // ── tests ──────────────────────────────────────────────────────────────────

  it('mints assay_ac_ codes stored only as their digest, valid 60 s', async () => {
    const minted = await mint();
    expect(minted.code).toMatch(/^assay_ac_[A-Za-z0-9_-]{43}$/);
    const [row] = (await dataSource.query(
      `SELECT "code_hash", "resource", "expires_at" - "created_at" AS "ttl"
         FROM "oauth_authorization_codes" WHERE "code_hash" = $1`,
      [createHash('sha256').update(minted.code).digest('hex')],
    )) as { code_hash: string; resource: string; ttl: { seconds?: number; minutes?: number } }[];
    expect(row).toBeDefined();
    expect(row.resource).toBe(MCP);
    expect((row.ttl.minutes ?? 0) * 60 + (row.ttl.seconds ?? 0)).toBe(60);
  });

  it('code valid 60 s: at 61 s → invalid_grant', async () => {
    const minted = await mint();
    await dataSource.query(
      `UPDATE "oauth_authorization_codes"
          SET "created_at" = "created_at" - interval '61 seconds',
              "expires_at" = "expires_at" - interval '61 seconds'
        WHERE "code_hash" = $1`,
      [createHash('sha256').update(minted.code).digest('hex')],
    );
    expect(await exchange(minted)).toEqual(expect.objectContaining({ error: 'invalid_grant' }));
    expect(await credentialsOf(minted.agentId)).toHaveLength(0);
  });

  it('code valid 60 s: at 59 s → a token pair', async () => {
    const minted = await mint();
    await dataSource.query(
      `UPDATE "oauth_authorization_codes"
          SET "created_at" = "created_at" - interval '59 seconds',
              "expires_at" = "expires_at" - interval '59 seconds'
        WHERE "code_hash" = $1`,
      [codeHashOf(minted.code)],
    );
    expectPair(await exchange(minted));
  });

  it('wrong verifier → invalid_grant AND a correct retry also fails (burned)', async () => {
    const minted = await mint();
    const before = (await auditActions('oauth.code_rejected')).length;
    expect(await exchange(minted, { codeVerifier: pkce().verifier })).toEqual(
      expect.objectContaining({ error: 'invalid_grant' }),
    );
    expect(await exchange(minted)).toEqual(expect.objectContaining({ error: 'invalid_grant' }));
    expect(await credentialsOf(minted.agentId)).toHaveLength(0);
    const rejected = await auditActions('oauth.code_rejected');
    expect(rejected).toHaveLength(before + 1);
    expect(rejected[rejected.length - 1].after).toEqual(
      expect.objectContaining({ reason: 'pkce', clientId: client.clientId }),
    );
  });

  it('second exchange of a used code revokes the first grant and audits oauth.code_reused', async () => {
    const minted = await mint();
    const pair = expectPair(await exchange(minted));
    const [credential] = await credentialsOf(minted.agentId);

    expect(await exchange(minted)).toEqual(expect.objectContaining({ error: 'invalid_grant' }));

    const [after] = await credentialsOf(minted.agentId);
    expect(after.revokedAt).not.toBeNull();
    expect(after.revokedBy).toBe('system:oauth-code-reused');
    const live = (await dataSource.query(
      `SELECT (SELECT count(*) FROM "oauth_access_tokens"
                WHERE "credential_id" = $1 AND "revoked_at" IS NULL)::int AS "access",
              (SELECT count(*) FROM "oauth_refresh_tokens"
                WHERE "credential_id" = $1 AND "revoked_at" IS NULL)::int AS "refresh"`,
      [credential.id],
    )) as { access: number; refresh: number }[];
    expect(live[0]).toEqual({ access: 0, refresh: 0 });

    const reused = (await auditActions('oauth.code_reused')).filter(
      (entry) => entry.resourceId === credential.id,
    );
    expect(reused).toHaveLength(1);
    expect(reused[0].actorType).toBe('system');
    expect(reused[0].actorId).toBe('oauth');
    expect(JSON.stringify(reused[0])).not.toContain(pair.access_token);
    expect(bumps).toContain(ORGANIZATION);

    // A third presentation is still a replay: audited, though nothing is left to revoke.
    expect(await exchange(minted)).toEqual(expect.objectContaining({ error: 'invalid_grant' }));
    const again = (await auditActions('oauth.code_reused')).filter(
      (entry) => entry.resourceId === credential.id,
    );
    expect(again).toHaveLength(2);
    expect(again[1].after).toEqual(expect.objectContaining({ alreadyRevoked: true }));
  });

  it('a replay racing the first exchange: no live grant survives (deterministic)', async () => {
    const minted = await mint();
    const holder = new Client({ ...pgOptions(), database: DATABASE });
    await holder.connect();
    try {
      // Park the first exchange inside its grant transaction, after the burn.
      await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [
        `oauth-grants:${minted.agentId}`,
      ]);
      const first = exchange(minted);
      await waitForWaiters(holder, 1);
      // The replay arrives while the first grant is not yet committed.
      const replay = exchange(minted);
      await waitForWaiters(holder, 2);
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
        `oauth-grants:${minted.agentId}`,
      ]);
      const [a, b] = await Promise.all([first, replay]);

      expect(b).toEqual(expect.objectContaining({ error: 'invalid_grant' }));
      // A held the code row when B arrived, so A's grant was created and then
      // revoked by B: A gets a pair whose tokens are already dead.
      const pair = expectPair(a);
      const [token] = (await dataSource.query(
        `SELECT "revoked_at" FROM "oauth_access_tokens" WHERE "token_hash" = $1`,
        [codeHashOf(pair.access_token)],
      )) as { revoked_at: Date | null }[];
      expect(token.revoked_at).not.toBeNull();
      expect(await liveCredentials(minted.agentId)).toBe(0);
      const reused = (await auditActions('oauth.code_reused')).filter(
        (entry) =>
          entry.resourceId === minted.agentId ||
          (entry.after as { agentId?: string } | null)?.agentId === minted.agentId,
      );
      expect(reused.length).toBeGreaterThanOrEqual(1);
    } finally {
      await holder.end();
    }
  });

  it('a replay marked before the grant transaction starts: the first exchange creates nothing', async () => {
    const minted = await mint();
    // What a replay's compare-and-set leaves behind when it lands first.
    await dataSource.query(
      `UPDATE "oauth_authorization_codes" SET "reuse_detected_at" = now() WHERE "code_hash" = $1`,
      [codeHashOf(minted.code)],
    );
    expect(await exchange(minted)).toEqual({ error: 'invalid_grant' });
    expect(await credentialsOf(minted.agentId)).toHaveLength(0);
    const reused = (await auditActions('oauth.code_reused')).filter(
      (entry) => entry.resourceId === minted.agentId,
    );
    expect(reused).toHaveLength(1);
    expect(reused[0].after).toEqual(expect.objectContaining({ grantCreated: false }));
  });

  it('many parallel exchanges of one code: at most one pair, and no live grant survives', async () => {
    const minted = await mint();
    const results = await Promise.all(Array.from({ length: 8 }, () => exchange(minted)));
    const pairs = results.filter((result) => !isOAuthError(result));
    expect(pairs.length).toBeLessThanOrEqual(1);
    expect(results.filter(isOAuthError).length).toBeGreaterThanOrEqual(7);
    expect(await liveCredentials(minted.agentId)).toBe(0);
  });

  it('wrong redirect_uri → invalid_grant, oauth.code_rejected', async () => {
    const minted = await mint();
    const before = (await auditActions('oauth.code_rejected')).length;
    expect(await exchange(minted, { redirectUri: 'http://127.0.0.1:33418/other' })).toEqual(
      expect.objectContaining({ error: 'invalid_grant' }),
    );
    const rejected = await auditActions('oauth.code_rejected');
    expect(rejected).toHaveLength(before + 1);
    expect(rejected[rejected.length - 1].after).toEqual(
      expect.objectContaining({ reason: 'redirect_uri' }),
    );
    expect(await credentialsOf(minted.agentId)).toHaveLength(0);
  });

  it('wrong client_id → invalid_grant, oauth.code_rejected', async () => {
    const other = await insertClient();
    const minted = await mint();
    const before = (await auditActions('oauth.code_rejected')).length;
    expect(await exchange(minted, {}, other)).toEqual(
      expect.objectContaining({ error: 'invalid_grant' }),
    );
    const rejected = await auditActions('oauth.code_rejected');
    expect(rejected).toHaveLength(before + 1);
    expect(rejected[rejected.length - 1].after).toEqual(
      expect.objectContaining({ reason: 'client_id' }),
    );
    // Burned: the right client cannot use it afterwards.
    expect(await exchange(minted)).toEqual(expect.objectContaining({ error: 'invalid_grant' }));
  });

  it('resource on another origin → invalid_target (and the code is burned)', async () => {
    const minted = await mint();
    expect(await exchange(minted, { resource: 'https://other.example.test' })).toEqual(
      expect.objectContaining({ error: 'invalid_target' }),
    );
    expect(await exchange(minted)).toEqual(expect.objectContaining({ error: 'invalid_grant' }));
  });

  it('a resource on the MCP origin with a path is accepted', async () => {
    const minted = await mint();
    expectPair(await exchange(minted, { resource: `${MCP}/c/weather` }));
  });

  it('creates exactly one agent_credentials row, issued_via OAUTH, scopes {}, expires_at = refresh expires_at', async () => {
    const minted = await mint();
    const pair = expectPair(await exchange(minted));

    expect(pair).toEqual({
      access_token: expect.stringMatching(/^assay_at_[A-Za-z0-9_-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^assay_rt_[A-Za-z0-9_-]{43}$/),
      scope: 'assay:agent offline_access',
    });

    const rows = await credentialsOf(minted.agentId);
    expect(rows).toHaveLength(1);
    const [credential] = rows;
    expect(credential.issuedVia).toBe('OAUTH');
    expect(credential.oauthClientId).toBe(client.id);
    expect(credential.scopes).toEqual([]);
    expect(credential.name).toBe('Example app');
    expect(credential.prefix).toBeNull();
    expect(credential.tokenHash).toBeNull();
    expect(credential.revokedAt).toBeNull();

    const refresh = await dataSource
      .getRepository(OAuthRefreshTokenEntity)
      .find({ where: { organizationId: ORGANIZATION, credentialId: credential.id } });
    expect(refresh).toHaveLength(1);
    expect(refresh[0].parentId).toBeNull();
    expect(refresh[0].oauthClientId).toBe(client.id);
    expect(credential.expiresAt?.getTime()).toBe(refresh[0].expiresAt.getTime());
    expect(refresh[0].expiresAt.getTime() - refresh[0].createdAt.getTime()).toBe(30 * DAY);

    const access = await dataSource
      .getRepository(OAuthAccessTokenEntity)
      .find({ where: { organizationId: ORGANIZATION, credentialId: credential.id } });
    expect(access).toHaveLength(1);
    expect(access[0].audience).toBe(MCP);
    expect(access[0].refreshTokenId).toBe(refresh[0].id);
    expect(access[0].expiresAt.getTime() - access[0].createdAt.getTime()).toBe(3_600_000);

    const [code] = (await dataSource.query(
      `SELECT "used_at", "credential_id" FROM "oauth_authorization_codes" WHERE "code_hash" = $1`,
      [createHash('sha256').update(minted.code).digest('hex')],
    )) as { used_at: Date | null; credential_id: string | null }[];
    expect(code.used_at).not.toBeNull();
    expect(code.credential_id).toBe(credential.id);

    const created = (await auditActions('credential.created')).filter(
      (entry) => entry.resourceId === credential.id,
    );
    expect(created).toHaveLength(1);
    expect(created[0].actorType).toBe('user');
    expect(created[0].actorId).toBe(APPROVER);
    expect(created[0].resourceType).toBe('agent_credential');
    expect(created[0].after).toEqual({
      agentId: minted.agentId,
      name: 'Example app',
      scopes: [],
      // The rolling refresh expiry at creation (R-OA-13).
      expiresAt: credential.expiresAt!.toISOString(),
      issuedVia: 'OAUTH',
      clientId: client.clientId,
      replaces: null,
    });
    // No narrowing copied: nothing to invalidate.
    expect(bumps).toHaveLength(0);
  });

  it('replaces copies narrowing and revokes the old live row', async () => {
    const first = await mint({ oauthClient: builtin });
    expectPair(await exchange(first, {}, builtin));
    const [old] = await credentialsOf(first.agentId);
    const toolId = randomUUID();
    await dataSource.query(
      `UPDATE "agent_credentials"
          SET "access_mode" = 'RESTRICTED', "allowed_toolsets" = '[{"kind":"CATEGORY","slug":"weather"}]',
              "allowed_tool_ids" = ARRAY[$2]::uuid[]
        WHERE "id" = $1`,
      [old.id, toolId],
    );

    const second = await mint({ agentId: first.agentId, replaces: old.id, oauthClient: builtin });
    expectPair(await exchange(second, {}, builtin));

    const rows = await credentialsOf(first.agentId);
    expect(rows).toHaveLength(2);
    const replaced = rows.find((row) => row.id === old.id)!;
    const fresh = rows.find((row) => row.id !== old.id)!;
    expect(replaced.revokedAt).not.toBeNull();
    expect(replaced.revokedBy).toBe('system:oauth-replaced');
    expect(fresh.revokedAt).toBeNull();
    expect(fresh.accessMode).toBe('RESTRICTED');
    expect(fresh.allowedToolsets).toEqual([{ kind: 'CATEGORY', slug: 'weather' }]);
    expect(fresh.allowedToolIds).toEqual([toolId]);

    const [{ live }] = (await dataSource.query(
      `SELECT count(*)::int AS "live" FROM "oauth_refresh_tokens"
        WHERE "credential_id" = $1 AND "revoked_at" IS NULL`,
      [old.id],
    )) as { live: number }[];
    expect(live).toBe(0);

    const created = (await auditActions('credential.created')).filter(
      (entry) => entry.resourceId === fresh.id,
    );
    expect(created[0].after).toEqual(expect.objectContaining({ replaces: old.id }));

    const revoked = (await auditActions('credential.revoked')).filter(
      (entry) => entry.resourceId === old.id,
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0].actorType).toBe('user');
    expect(revoked[0].actorId).toBe(APPROVER);
    expect(revoked[0].before).toEqual({ revokedAt: null });
    expect(revoked[0].after).toEqual({
      revokedAt: replaced.revokedAt!.toISOString(),
      name: old.name,
      issuedVia: 'OAUTH',
      clientId: builtin.clientId,
      reason: 'replaced',
      replacedBy: fresh.id,
    });
    expect(bumps).toEqual([ORGANIZATION]);
  });

  it('replaces from a client that is not the built-in one is ignored', async () => {
    const first = await mint();
    expectPair(await exchange(first));
    const [old] = await credentialsOf(first.agentId);

    expectPair(await exchange(await mint({ agentId: first.agentId, replaces: old.id })));
    const rows = await credentialsOf(first.agentId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === old.id)!.revokedAt).toBeNull();
  });

  it('replaces naming another agent’s credential is ignored', async () => {
    const other = await mint({ oauthClient: builtin });
    expectPair(await exchange(other, {}, builtin));
    const [foreign] = await credentialsOf(other.agentId);

    const minted = await mint({ replaces: foreign.id, oauthClient: builtin });
    expectPair(await exchange(minted, {}, builtin));

    const [still] = await credentialsOf(other.agentId);
    expect(still.revokedAt).toBeNull();
    const [fresh] = await credentialsOf(minted.agentId);
    expect(fresh.accessMode).toBeNull();
  });

  it('refuses the 51st live grant with invalid_grant "grant limit reached"; an expired grant does not count', async () => {
    const agentId = randomUUID();
    for (let i = 0; i < 50; i += 1) await insertLiveGrant(agentId);

    const minted = await mint({ agentId });
    expect(await exchange(minted)).toEqual({
      error: 'invalid_grant',
      error_description: 'grant limit reached',
    });

    await dataSource.query(
      `UPDATE "agent_credentials" SET "expires_at" = now() - interval '1 second'
        WHERE "id" = (SELECT "id" FROM "agent_credentials" WHERE "agent_id" = $1 LIMIT 1)`,
      [agentId],
    );
    expectPair(await exchange(await mint({ agentId })));
  });

  it('replacing a live grant at the cap succeeds and stays at 50 live', async () => {
    const agentId = randomUUID();
    for (let i = 0; i < 49; i += 1) await insertLiveGrant(agentId);
    const old = await insertLiveGrant(agentId, builtin);

    expectPair(
      await exchange(await mint({ agentId, replaces: old, oauthClient: builtin }), {}, builtin),
    );
    expect(await liveCredentials(agentId)).toBe(50);
  });

  it('replacing a grant that is no longer live does not free a slot at the cap', async () => {
    const agentId = randomUUID();
    for (let i = 0; i < 50; i += 1) await insertLiveGrant(agentId);
    const old = await insertLiveGrant(agentId, builtin, '-1 second');

    expect(
      await exchange(await mint({ agentId, replaces: old, oauthClient: builtin }), {}, builtin),
    ).toEqual({ error: 'invalid_grant', error_description: 'grant limit reached' });
  });

  it('re-checks the agent at exchange: suspended, no wallet, suspended org, missing', async () => {
    const notActive = { error: 'invalid_grant', error_description: 'agent not active' };

    const suspended = randomUUID();
    await insertAgent(suspended, { status: 'SUSPENDED' });
    expect(await exchange(await mint({ agentId: suspended }))).toEqual(notActive);

    const noWallet = randomUUID();
    await insertAgent(noWallet, { wallet: false });
    expect(await exchange(await mint({ agentId: noWallet }))).toEqual(notActive);

    const pausedOrg = randomUUID();
    await insertOrganization(pausedOrg, 'SUSPENDED');
    const inPausedOrg = randomUUID();
    await insertAgent(inPausedOrg, { organizationId: pausedOrg });
    expect(await exchange(await mint({ agentId: inPausedOrg, organizationId: pausedOrg }))).toEqual(
      notActive,
    );

    const missing = randomUUID();
    expect(await exchange(await mint({ agentId: missing, skipAgent: true }))).toEqual(notActive);

    for (const agentId of [suspended, noWallet, inPausedOrg, missing]) {
      expect(await credentialsOf(agentId)).toHaveLength(0);
    }
  });

  it('an access-epoch failure after commit still returns the pair', async () => {
    const first = await mint({ oauthClient: builtin });
    expectPair(await exchange(first, {}, builtin));
    const [old] = await credentialsOf(first.agentId);

    failBump = true;
    expectPair(
      await exchange(
        await mint({ agentId: first.agentId, replaces: old.id, oauthClient: builtin }),
        {},
        builtin,
      ),
    );
    expect(await liveCredentials(first.agentId)).toBe(1);
  });

  it('exchanges racing for the last slots: never more than 50 live grants', async () => {
    const agentId = randomUUID();
    for (let i = 0; i < 47; i += 1) await insertLiveGrant(agentId);
    const minted = await Promise.all(Array.from({ length: 12 }, () => mint({ agentId })));

    const results = await Promise.all(minted.map((one) => exchange(one)));
    expect(results.filter((result) => !isOAuthError(result))).toHaveLength(3);
    expect(results.filter(isOAuthError)).toHaveLength(9);
    for (const refused of results.filter(isOAuthError)) {
      expect(refused).toEqual({ error: 'invalid_grant', error_description: 'grant limit reached' });
    }

    const [{ live }] = (await dataSource.query(
      `SELECT count(*)::int AS "live" FROM "agent_credentials"
        WHERE "agent_id" = $1 AND "revoked_at" IS NULL`,
      [agentId],
    )) as { live: number }[];
    expect(live).toBe(50);
  });

  it('no raw secret in any column, and no hash outside the hash columns (happy, rejected and replay paths)', async () => {
    // Happy path.
    const minted = await mint();
    const pair = expectPair(await exchange(minted));
    const [access] = (await dataSource.query(
      `SELECT count(*)::int AS "n" FROM "oauth_access_tokens" WHERE "token_hash" = $1`,
      [codeHashOf(pair.access_token)],
    )) as { n: number }[];
    expect(access.n).toBe(1);

    // Replay path: writes oauth.code_reused.
    expect(await exchange(minted)).toEqual(expect.objectContaining({ error: 'invalid_grant' }));

    // Rejected path: writes oauth.code_rejected.
    const rejected = await mint();
    const wrongVerifier = pkce().verifier;
    expect(await exchange(rejected, { codeVerifier: wrongVerifier })).toEqual(
      expect.objectContaining({ error: 'invalid_grant' }),
    );

    await assertNoSecretsStored(
      [
        pair.access_token,
        pair.refresh_token,
        minted.code,
        minted.verifier,
        rejected.code,
        rejected.verifier,
        wrongVerifier,
      ],
      [
        codeHashOf(pair.access_token),
        codeHashOf(pair.refresh_token),
        codeHashOf(minted.code),
        codeHashOf(rejected.code),
      ],
    );
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
