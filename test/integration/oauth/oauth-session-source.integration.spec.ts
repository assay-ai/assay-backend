import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { DataSource, IsNull } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { OAuthRefreshTokenEntity } from '@database/postgres/entities/oauth-refresh-token.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';
import { DbCredentialMcpSessionSource } from '@modules/auth/services/db-credential-mcp-session.source';
import { OAuthAccessTokenMcpSessionSource } from '@modules/auth/services/oauth-access-token-mcp-session.source';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { OAuthGrantWriter } from '@modules/oauth/services/oauth-grant.writer';
import {
  OAuthTokenService,
  TokenPair,
  isOAuthError,
} from '@modules/oauth/services/oauth-token.service';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AppRole } from '@shared/app-role/app-role';
import { AuditLogWriter } from '@shared/audit';
import { digestToken } from '@shared/crypto/token-digest';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * The OAuth session source (spec §6.4) against real migrations, on grants the
 * real token service issues: an access token resolves to the session an API
 * key of the same agent gets (R-OA-18), every request reads the database
 * (R-OA-19), and only payment clients may use the API host (R-OA-21).
 */
describe('OAuthAccessTokenMcpSessionSource — real migrations', () => {
  const DATABASE = 'assay_oauth_session_source_test';
  const MCP = 'https://mcp.example.test';
  const REDIRECT = 'http://127.0.0.1:33418/callback';
  const ORGANIZATION = randomUUID();
  const CHAIN = 'eip155:46630';

  let dataSource: DataSource;
  let clients: OAuthClientRepository;
  let credentials: AgentCredentialRepository;
  let resolver: CredentialSessionResolver;
  let tokenService: OAuthTokenService;
  let thirdParty: OAuthClientEntity;
  let builtin: OAuthClientEntity;

  beforeAll(async () => {
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [
        AgentCredentialEntity,
        AgentEntity,
        OrganizationEntity,
        AuditLogEntryEntity,
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

    clients = new OAuthClientRepository(dataSource);
    credentials = new AgentCredentialRepository(dataSource);
    resolver = new CredentialSessionResolver(credentials, new AgentRepository(dataSource));
    const audit = new AuditLogWriter(dataSource);
    const epoch = { bump: async () => undefined } as unknown as AccessEpochService;
    tokenService = new OAuthTokenService(
      dataSource,
      new OAuthAuthorizationCodeRepository(dataSource),
      clients,
      new OAuthGrantWriter(dataSource, credentials, audit),
      audit,
      epoch,
      { issuer: MCP },
    );

    thirdParty = await insertClient(OAuthClientKind.DCR);
    builtin = await insertClient(OAuthClientKind.BUILTIN);
    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Example org', 'ACTIVE')`,
      [ORGANIZATION],
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  async function insertClient(kind: OAuthClientKind): Promise<OAuthClientEntity> {
    // The built-in row is upserted at boot in a real run; one per database here.
    if (kind === OAuthClientKind.BUILTIN) {
      const existing = await clients.findByClientId(`${MCP}/oauth/clients/assay-mcp`);
      if (existing) return existing;
    }
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

  async function insertAgent(): Promise<string> {
    const agentId = randomUUID();
    await dataSource.query(
      `INSERT INTO "agents"
         ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id", "label")
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5, 'research-bot')`,
      [
        agentId,
        ORGANIZATION,
        `did:privy:test-${agentId}`,
        `${CHAIN}:0x${randomBytes(20).toString('hex')}`,
        CHAIN,
      ],
    );
    return agentId;
  }

  /** A grant issued the real way: code minted, then exchanged with PKCE. */
  async function issueGrant(
    agentId: string,
    client: OAuthClientEntity,
  ): Promise<{ pair: TokenPair; credentialId: string }> {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const code = await tokenService.mintCode(
      {
        oauthClientId: client.id,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        scope: 'assay:agent offline_access',
        boundOrganizationId: ORGANIZATION,
      },
      { agentId, name: 'Example app', approvedBy: 'user-1', replaces: null },
    );
    const result = await tokenService.exchangeCode({
      code,
      redirectUri: REDIRECT,
      clientId: client.clientId,
      codeVerifier: verifier,
      resource: undefined,
    });
    if (isOAuthError(result)) throw new Error(`exchange failed: ${result.error}`);
    const pair = result as TokenPair;
    const [token] = (await dataSource.query(
      `SELECT "credential_id" FROM "oauth_access_tokens" WHERE "token_hash" = $1`,
      [digestToken(pair.access_token)],
    )) as { credential_id: string }[];
    return { pair, credentialId: token.credential_id };
  }

  async function insertApiKey(agentId: string): Promise<{ token: string; id: string }> {
    const token = `assay_sk_live_${randomBytes(24).toString('base64url')}`;
    const [row] = (await dataSource.query(
      `INSERT INTO "agent_credentials" ("organization_id", "agent_id", "name", "prefix", "token_hash", "scopes")
       VALUES ($1, $2, 'CI deploy', $3, $4, '{}') RETURNING "id"`,
      [ORGANIZATION, agentId, token.slice(0, 22), digestToken(token)],
    )) as { id: string }[];
    return { token, id: row.id };
  }

  function source(role: AppRole, audience = MCP): OAuthAccessTokenMcpSessionSource {
    return new OAuthAccessTokenMcpSessionSource(
      new OAuthAccessTokenRepository(dataSource),
      credentials,
      clients,
      resolver,
      { audience, paymentClients: [builtin.clientId] },
      role,
    );
  }

  const apiKeys = () => new DbCredentialMcpSessionSource(credentials, resolver);

  async function setDelegate(credentialId: string, delegate: string | null): Promise<void> {
    await dataSource.query(
      `UPDATE "agent_credentials"
          SET "delegate_account" = $2::text,
              "delegate_bound_at" = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
        WHERE "id" = $1`,
      [credentialId, delegate],
    );
  }

  it('assay-mcp grant: the full session equals an API key session but for credentialId (R-OA-18)', async () => {
    const agentId = await insertAgent();
    const { pair, credentialId } = await issueGrant(agentId, builtin);
    const key = await insertApiKey(agentId);

    for (const role of ['mcp', 'api'] as const) {
      const viaGrant = await source(role).resolve(pair.access_token);
      const viaKey = await apiKeys().resolve(key.token);
      expect(viaGrant).toEqual({ ...viaKey, credentialId });
      expect(viaGrant.paymentsAllowed).toBe(true);
    }

    // The same delegate, on whichever credential holds it (one live holder per key).
    const delegate = `${CHAIN}:0x${randomBytes(20).toString('hex')}`;
    await setDelegate(credentialId, delegate);
    const viaGrant: McpSession = await source('mcp').resolve(pair.access_token);
    await setDelegate(credentialId, null);
    await setDelegate(key.id, delegate);
    const viaKey = await apiKeys().resolve(key.token);
    expect(viaGrant.delegateAccount).toBe(delegate);
    expect(viaGrant).toEqual({ ...viaKey, credentialId });
  });

  it('third-party grant: the MCP host gets paymentsAllowed false, the API host 403', async () => {
    const agentId = await insertAgent();
    const { pair, credentialId } = await issueGrant(agentId, thirdParty);
    const key = await insertApiKey(agentId);

    const viaGrant = await source('mcp').resolve(pair.access_token);
    const viaKey = await apiKeys().resolve(key.token);
    expect(viaGrant).toEqual({ ...viaKey, credentialId, paymentsAllowed: false });

    await expect(source('api').resolve(pair.access_token)).rejects.toMatchObject({
      errorCode: 'AUTH_CLIENT_NOT_ALLOWED_HERE',
      statusCode: 403,
    });
  });

  it('revoking the credential refuses the very next request (R-OA-19)', async () => {
    const agentId = await insertAgent();
    const { pair, credentialId } = await issueGrant(agentId, builtin);
    await expect(source('mcp').resolve(pair.access_token)).resolves.toMatchObject({
      credentialId,
    });

    await dataSource.query(
      `UPDATE "agent_credentials" SET "revoked_at" = now(), "revoked_by" = 'user-1' WHERE "id" = $1`,
      [credentialId],
    );

    await expect(source('mcp').resolve(pair.access_token)).rejects.toMatchObject({
      errorCode: 'MCP_CREDENTIAL_INVALID',
    });
  });

  it('a revoked or expired access token is refused, the grant otherwise live', async () => {
    const agentId = await insertAgent();
    const first = await issueGrant(agentId, builtin);
    await dataSource.query(
      `UPDATE "oauth_access_tokens" SET "revoked_at" = now() WHERE "token_hash" = $1`,
      [digestToken(first.pair.access_token)],
    );
    await expect(source('mcp').resolve(first.pair.access_token)).rejects.toMatchObject({
      errorCode: 'MCP_CREDENTIAL_INVALID',
    });

    const second = await issueGrant(agentId, builtin);
    await dataSource.query(
      `UPDATE "oauth_access_tokens" SET "expires_at" = now() - interval '1 second' WHERE "token_hash" = $1`,
      [digestToken(second.pair.access_token)],
    );
    await expect(source('mcp').resolve(second.pair.access_token)).rejects.toMatchObject({
      errorCode: 'MCP_CREDENTIAL_INVALID',
    });
  });

  it('a token issued for another audience is refused (T15)', async () => {
    const agentId = await insertAgent();
    const { pair } = await issueGrant(agentId, builtin);

    await expect(
      source('mcp', 'https://mcp.other.example').resolve(pair.access_token),
    ).rejects.toMatchObject({ errorCode: 'MCP_CREDENTIAL_INVALID' });
  });

  it('a refresh token is not an access token', async () => {
    const agentId = await insertAgent();
    const { pair } = await issueGrant(agentId, builtin);

    await expect(source('mcp').resolve(pair.refresh_token)).rejects.toMatchObject({
      errorCode: 'MCP_CREDENTIAL_INVALID',
    });
  });

  it('stamps first_used_at once, and never overwrites it', async () => {
    const agentId = await insertAgent();
    const { pair } = await issueGrant(agentId, builtin);
    const hash = digestToken(pair.access_token);
    const firstUsedAt = async (): Promise<Date | null> => {
      const [row] = (await dataSource.query(
        `SELECT "first_used_at" FROM "oauth_access_tokens" WHERE "token_hash" = $1`,
        [hash],
      )) as { first_used_at: Date | null }[];
      return row.first_used_at;
    };
    const waitForStamp = async (): Promise<Date> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const value = await firstUsedAt();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('first_used_at was never stamped');
    };

    expect(await firstUsedAt()).toBeNull();
    await source('mcp').resolve(pair.access_token);
    const stamped = await waitForStamp();

    // Even a stale read (two requests racing) cannot move it: the write is
    // guarded by `first_used_at IS NULL` in the database.
    await new OAuthAccessTokenRepository(dataSource).update(
      {
        organizationId: ORGANIZATION,
        tokenHash: hash,
        firstUsedAt: IsNull(),
      },
      { firstUsedAt: new Date(Date.now() + 60_000) },
    );
    await source('mcp').resolve(pair.access_token);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await firstUsedAt())?.getTime()).toBe(stamped.getTime());
  });
});
