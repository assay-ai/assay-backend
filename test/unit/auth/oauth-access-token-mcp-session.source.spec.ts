import {
  AgentCredentialEntity,
  CredentialIssuedVia,
} from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { BlocklistSessionSource } from '@modules/blocklist/services/blocklist-session.source';
import { SessionSourceMode } from '@modules/auth/domain/session-source-mode';
import { createSessionSource } from '@modules/auth/services/composite-mcp-session.source';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';
import { DbCredentialMcpSessionSource } from '@modules/auth/services/db-credential-mcp-session.source';
import { OAuthAccessTokenMcpSessionSource } from '@modules/auth/services/oauth-access-token-mcp-session.source';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { unauthorizedReasonOf } from '@modules/mcp/ports/mcp-unauthorized.port';
import { OAuthSessionConfig } from '@modules/oauth/config/oauth.config';
import { AppRole } from '@shared/app-role/app-role';
import { AppError } from '@shared/errors/app-errors';
import { digestToken } from '@shared/crypto/token-digest';

import { blocklistOf, SeededBlock } from '../helpers/blocklist';
import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeAgentRepository, buildAgent } from './helpers/fake-agent-repository';
import { buildCredential } from './helpers/fake-agent-credential-repository';

const MCP = 'https://mcp.example.com';
const ORG = '0b5c1e9a-4f1d-4c62-9a57-3d2f6c1e8b04';
const BUILTIN_CLIENT_ID = `${MCP}/oauth/clients/assay-mcp`;
const THIRD_PARTY_CLIENT_ID = 'dcr_AAAAAAAAAAAAAAAAAAAAAA';
const ACCESS_TOKEN = `assay_at_${'a'.repeat(43)}`;
const API_KEY = 'assay_sk_live_abcdefghijklmnopqrstuvwxyz012345';
const ACCOUNT = 'eip155:46630:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296' as AccountId;
const CHAIN = 'eip155:46630' as ChainId;
const DELEGATE = 'eip155:46630:0x00000000000000000000000000000000000000d1' as AccountId;
const CONFIG: OAuthSessionConfig = { audience: MCP, paymentClients: [BUILTIN_CLIENT_ID] };

/** `oauth_access_tokens`, in memory, counting every call. */
class FakeAccessTokens {
  readonly rows = new Map<string, OAuthAccessTokenEntity>();
  readonly updateCalls: Array<{ criteria: Record<string, unknown>; patch: unknown }> = [];
  calls = 0;

  findByTokenHash(hash: string): Promise<OAuthAccessTokenEntity | null> {
    this.calls += 1;
    return Promise.resolve(this.rows.get(hash) ?? null);
  }

  update(criteria: Record<string, unknown>, patch: Partial<OAuthAccessTokenEntity>) {
    this.calls += 1;
    this.updateCalls.push({ criteria, patch });
    // Mirrors `WHERE first_used_at IS NULL`: only the first stamp lands.
    for (const row of this.rows.values()) {
      if (row.id === criteria.id && row.firstUsedAt === null) {
        row.firstUsedAt = patch.firstUsedAt ?? null;
      }
    }
    return Promise.resolve({ affected: 1 });
  }
}

/** `agent_credentials`, in memory: by token hash (API keys) and by scoped id (grants). */
class FakeCredentials {
  readonly rows: AgentCredentialEntity[] = [];
  readonly updateCalls: Array<{ criteria: unknown; patch: unknown }> = [];
  calls = 0;

  findByTokenHash(hash: string): Promise<AgentCredentialEntity | null> {
    this.calls += 1;
    return Promise.resolve(this.rows.find((row) => row.tokenHash === hash) ?? null);
  }

  findOneBy(where: Partial<AgentCredentialEntity>): Promise<AgentCredentialEntity | null> {
    this.calls += 1;
    if (!where.organizationId) throw new Error('ORGANIZATION_SCOPE_MISSING');
    const found = this.rows.find((row) =>
      Object.entries(where).every(
        ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
      ),
    );
    return Promise.resolve(found ?? null);
  }

  update(criteria: unknown, patch: unknown) {
    this.calls += 1;
    this.updateCalls.push({ criteria, patch });
    return Promise.resolve({ affected: 1 });
  }
}

class FakeClients {
  readonly rows: OAuthClientEntity[] = [];
  calls = 0;

  findOneBy(where: { id: string }): Promise<OAuthClientEntity | null> {
    this.calls += 1;
    return Promise.resolve(this.rows.find((row) => row.id === where.id) ?? null);
  }
}

function client(id: string, clientId: string, kind: OAuthClientKind): OAuthClientEntity {
  return { id, clientId, kind } as OAuthClientEntity;
}

/**
 * `OAuthAccessTokenMcpSessionSource` (spec §6.4): an OAuth access token is one
 * more way to hold an agent credential, so it resolves through the same
 * resolver as an API key, with one deliberate difference, `paymentsAllowed`
 * and the API host, decided by the client (§6.3.13, H2).
 */
describe('OAuthAccessTokenMcpSessionSource', () => {
  function build(role?: AppRole) {
    const tokens = new FakeAccessTokens();
    const credentials = new FakeCredentials();
    const clients = new FakeClients();
    const agents = new FakeAgentRepository();
    const resolver = new CredentialSessionResolver(
      credentials as unknown as AgentCredentialRepository,
      agents as unknown as AgentRepository,
    );
    const source = new OAuthAccessTokenMcpSessionSource(
      tokens as unknown as OAuthAccessTokenRepository,
      credentials as unknown as AgentCredentialRepository,
      clients as unknown as OAuthClientRepository,
      resolver,
      CONFIG,
      role,
    );
    const apiKeySource = new DbCredentialMcpSessionSource(
      credentials as unknown as AgentCredentialRepository,
      resolver,
    );

    agents.seed(
      buildAgent({
        id: 'agent-1',
        organizationId: ORG,
        primaryAccountId: ACCOUNT,
        chainId: CHAIN,
        label: 'research-bot',
      }),
    );
    clients.rows.push(
      client('client-builtin', BUILTIN_CLIENT_ID, OAuthClientKind.BUILTIN),
      client('client-third', THIRD_PARTY_CLIENT_ID, OAuthClientKind.DCR),
    );

    return { tokens, credentials, clients, agents, source, apiKeySource };
  }

  function seedGrant(
    fx: ReturnType<typeof build>,
    options: {
      clientRowId?: string;
      token?: Partial<OAuthAccessTokenEntity>;
      credential?: Partial<AgentCredentialEntity>;
    } = {},
  ) {
    const credential = buildCredential({
      organizationId: ORG,
      id: 'grant-1',
      issuedVia: CredentialIssuedVia.OAUTH,
      oauthClientId: options.clientRowId ?? 'client-builtin',
      prefix: null,
      tokenHash: null,
      name: 'Example app',
      delegateAccount: DELEGATE,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      ...options.credential,
    });
    fx.credentials.rows.push(credential);
    const token = {
      id: 'token-1',
      organizationId: ORG,
      credentialId: credential.id,
      refreshTokenId: 'refresh-1',
      tokenHash: digestToken(ACCESS_TOKEN),
      scope: 'assay:agent',
      audience: MCP,
      expiresAt: new Date(Date.now() + 3_600_000),
      firstUsedAt: null,
      revokedAt: null,
      ...options.token,
    } as OAuthAccessTokenEntity;
    fx.tokens.rows.set(token.tokenHash, token);
    return { credential, token };
  }

  function callsOf(fx: ReturnType<typeof build>): number {
    return fx.tokens.calls + fx.credentials.calls + fx.clients.calls;
  }

  describe('refuses what is not an access token before any read (R-OA-20)', () => {
    it.each([
      ['a Privy JWT', 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'],
      ['an API key', API_KEY],
      ['a refresh token', `assay_rt_${'a'.repeat(43)}`],
      ['an authorization code', `assay_ac_${'a'.repeat(43)}`],
      ['a truncated access token', 'assay_at_short'],
      ['an empty string', ''],
    ])('%s → MCP_CREDENTIAL_INVALID and zero repository calls', async (_label, token) => {
      const fx = build('mcp');
      seedGrant(fx);

      await expectErrorCodeAsync(() => fx.source.resolve(token), 'MCP_CREDENTIAL_INVALID');
      expect(callsOf(fx)).toBe(0);
    });

    it('null → MCP_CREDENTIAL_INVALID and zero repository calls', async () => {
      const fx = build('mcp');

      await expectErrorCodeAsync(() => fx.source.resolve(null), 'MCP_CREDENTIAL_INVALID');
      expect(callsOf(fx)).toBe(0);
    });
  });

  describe('how long a session may be reused (B2 session cache)', () => {
    it('is not kept until first_used_at reads back as written: reuse detection decides on it', async () => {
      const fx = build('mcp');
      seedGrant(fx, { token: { firstUsedAt: null } });

      const first = await fx.source.resolveForCache(ACCESS_TOKEN);

      expect(first.cacheable).toBe(false);
    });

    it('holds until the token expires, or the grant if it ends first', async () => {
      const fx = build('mcp');
      const tokenExpiry = new Date(Date.now() + 3_600_000);
      seedGrant(fx, { token: { firstUsedAt: new Date(), expiresAt: tokenExpiry } });
      const used = await fx.source.resolveForCache(ACCESS_TOKEN);
      expect(used.cacheable).toBe(true);
      expect(used.notAfter).toEqual(tokenExpiry);

      const soon = build('mcp');
      const grantExpiry = new Date(Date.now() + 60_000);
      seedGrant(soon, {
        token: { firstUsedAt: new Date(), expiresAt: tokenExpiry },
        credential: { expiresAt: grantExpiry },
      });
      expect((await soon.source.resolveForCache(ACCESS_TOKEN)).notAfter).toEqual(grantExpiry);
    });

    it('answers resolve with the same session', async () => {
      const fx = build('mcp');
      seedGrant(fx, { token: { firstUsedAt: new Date() } });
      const { session } = await fx.source.resolveForCache(ACCESS_TOKEN);
      expect(await fx.source.resolve(ACCESS_TOKEN)).toEqual(session);
    });
  });

  describe('the token row', () => {
    it('looks the token up by its digest, never by the token itself', async () => {
      const fx = build('mcp');
      seedGrant(fx);
      const spy = jest.spyOn(fx.tokens, 'findByTokenHash');

      await fx.source.resolve(ACCESS_TOKEN);

      expect(spy).toHaveBeenCalledWith(digestToken(ACCESS_TOKEN));
      expect(spy.mock.calls.flat()).not.toContain(ACCESS_TOKEN);
    });

    it('unknown token → invalid', async () => {
      const fx = build('mcp');

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
    });

    it('expired token → invalid', async () => {
      const fx = build('mcp');
      seedGrant(fx, { token: { expiresAt: new Date(Date.now() - 1000) } });

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
    });

    it('revoked token → invalid', async () => {
      const fx = build('mcp');
      seedGrant(fx, { token: { revokedAt: new Date() } });

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
    });

    it('audience mismatch → invalid', async () => {
      const fx = build('mcp');
      seedGrant(fx, { token: { audience: 'https://mcp.other.example' } });

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
      expect(fx.credentials.calls).toBe(0);
    });
  });

  describe('the private 401 reason (the mcp_unauthorized counter)', () => {
    async function reasonOf(fx: ReturnType<typeof build>): Promise<unknown> {
      const error = await fx.source.resolve(ACCESS_TOKEN).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ errorCode: 'MCP_CREDENTIAL_INVALID' });
      return unauthorizedReasonOf(error);
    }

    it.each([
      ['an unknown token', {}, false, 'unknown'],
      ['an expired token', { token: { expiresAt: new Date(Date.now() - 1000) } }, true, 'expired'],
      ['a revoked token', { token: { revokedAt: new Date() } }, true, 'revoked'],
      ['another audience', { token: { audience: 'https://mcp.other.example' } }, true, 'audience'],
      ['a revoked grant', { credential: { revokedAt: new Date() } }, true, 'revoked'],
      [
        'an expired grant',
        { credential: { expiresAt: new Date(Date.now() - 1000) } },
        true,
        'expired',
      ],
    ] as const)('%s → %s', async (_label, options, seed, reason) => {
      const fx = build('mcp');
      if (seed) seedGrant(fx, options as Parameters<typeof seedGrant>[1]);
      await expect(reasonOf(fx)).resolves.toBe(reason);
    });

    it('is private: never on the wire, and the message is the same for every reason', async () => {
      const fx = build('mcp');
      seedGrant(fx, { token: { revokedAt: new Date() } });
      const error = (await fx.source.resolve(ACCESS_TOKEN).catch((e: unknown) => e)) as AppError;
      expect(error.publicContext).toBeUndefined();
      expect(JSON.stringify(error.toJSON())).not.toContain('revoked');
      expect(error.message).toBe(McpErrors.credentialInvalid().message);
    });

    it("a token of another shape carries no reason (not this source's token)", async () => {
      const fx = build('mcp');
      const error = await fx.source.resolve('assay_sk_live_x').catch((e: unknown) => e);
      expect(unauthorizedReasonOf(error)).toBeNull();
    });
  });

  describe('the credential', () => {
    it('revoked credential → invalid, on either host', async () => {
      for (const role of ['mcp', 'api'] as const) {
        const fx = build(role);
        seedGrant(fx, { clientRowId: 'client-third', credential: { revokedAt: new Date() } });

        await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
      }
    });

    it('expired credential → invalid', async () => {
      const fx = build('mcp');
      seedGrant(fx, { credential: { expiresAt: new Date(Date.now() - 1000) } });

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
    });

    it('loads only an OAUTH row, scoped to the token organization', async () => {
      const fx = build('mcp');
      seedGrant(fx, {
        credential: { issuedVia: CredentialIssuedVia.API_KEY, oauthClientId: null },
      });
      const spy = jest.spyOn(fx.credentials, 'findOneBy');

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
      expect(spy).toHaveBeenCalledWith({
        organizationId: ORG,
        id: 'grant-1',
        issuedVia: CredentialIssuedVia.OAUTH,
      });
    });

    it('a credential in another organization than the token → invalid', async () => {
      const fx = build('mcp');
      seedGrant(fx, { credential: { organizationId: 'org-2' } });

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
    });

    it('a missing client row → invalid', async () => {
      const fx = build('mcp');
      seedGrant(fx, { clientRowId: 'client-gone' });

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'MCP_CREDENTIAL_INVALID');
    });

    it('a suspended agent is refused as suspended, not as invalid (T16)', async () => {
      const fx = build('mcp');
      seedGrant(fx);
      fx.agents.rows.get('did:privy:test-subject')!.status = 'SUSPENDED';

      await expectErrorCodeAsync(() => fx.source.resolve(ACCESS_TOKEN), 'AUTH_AGENT_SUSPENDED');
    });
  });

  describe('hosts and the payment-client exception (§6.3.13)', () => {
    it('api role + third-party client → 403 AUTH_CLIENT_NOT_ALLOWED_HERE', async () => {
      const fx = build('api');
      seedGrant(fx, { clientRowId: 'client-third' });

      const error = await fx.source.resolve(ACCESS_TOKEN).catch((e: unknown) => e);
      expect(error).toMatchObject({ errorCode: 'AUTH_CLIENT_NOT_ALLOWED_HERE', statusCode: 403 });
      // Refused before the stamp and before a session is built.
      expect(fx.tokens.updateCalls).toEqual([]);
      expect(fx.agents.findByIdWithOrganizationCalls).toBe(0);
    });

    it('no APP_ROLE provided → the strict api side', async () => {
      const fx = build(undefined);
      seedGrant(fx, { clientRowId: 'client-third' });

      await expectErrorCodeAsync(
        () => fx.source.resolve(ACCESS_TOKEN),
        'AUTH_CLIENT_NOT_ALLOWED_HERE',
      );
    });

    it('mcp role + third-party → session with paymentsAllowed false', async () => {
      const fx = build('mcp');
      seedGrant(fx, { clientRowId: 'client-third' });

      const session = await fx.source.resolve(ACCESS_TOKEN);

      expect(session.paymentsAllowed).toBe(false);
      expect(session.agentId).toBe('agent-1');
    });

    it('a non-BUILTIN row carrying the built-in id is not a payment client (kind belt)', async () => {
      const fx = build('mcp');
      fx.clients.rows.push(client('client-odd', BUILTIN_CLIENT_ID, OAuthClientKind.CIMD));
      seedGrant(fx, { clientRowId: 'client-odd' });

      const session = await fx.source.resolve(ACCESS_TOKEN);

      expect(session.paymentsAllowed).toBe(false);
    });

    it.each(['mcp', 'api'] as const)(
      '%s role + assay-mcp → session with paymentsAllowed true',
      async (role) => {
        const fx = build(role);
        seedGrant(fx);

        const session = await fx.source.resolve(ACCESS_TOKEN);

        expect(session.paymentsAllowed).toBe(true);
      },
    );
  });

  describe('first_used_at', () => {
    it('first_used_at stamped once', async () => {
      const fx = build('mcp');
      const { token } = seedGrant(fx);

      await fx.source.resolve(ACCESS_TOKEN);
      const stamped = token.firstUsedAt;
      await fx.source.resolve(ACCESS_TOKEN);

      expect(stamped).toBeInstanceOf(Date);
      expect(token.firstUsedAt).toBe(stamped);
      expect(fx.tokens.updateCalls).toHaveLength(1);
      const [{ criteria, patch }] = fx.tokens.updateCalls;
      expect(criteria).toMatchObject({ organizationId: ORG, id: 'token-1' });
      // `IsNull()`: the write itself only lands on an unstamped row.
      expect(criteria.firstUsedAt).toMatchObject({ _type: 'isNull' });
      expect(patch).toEqual({ firstUsedAt: stamped });
    });

    it('a failed stamp never fails the request', async () => {
      const fx = build('mcp');
      seedGrant(fx);
      jest.spyOn(fx.tokens, 'update').mockRejectedValueOnce(new Error('db down'));

      await expect(fx.source.resolve(ACCESS_TOKEN)).resolves.toMatchObject({
        credentialId: 'grant-1',
      });
    });
  });

  describe('equals an API key session for the same agent (R-OA-18)', () => {
    it('payment-client grant: the full session equals the API key session but for credentialId', async () => {
      const fx = build('mcp');
      seedGrant(fx);
      fx.credentials.rows.push(
        buildCredential({
          organizationId: ORG,
          id: 'key-1',
          tokenHash: digestToken(API_KEY),
          delegateAccount: DELEGATE,
        }),
      );

      const viaGrant = await fx.source.resolve(ACCESS_TOKEN);
      const viaKey = await fx.apiKeySource.resolve(API_KEY);

      expect(viaGrant).toStrictEqual({ ...viaKey, credentialId: 'grant-1' });
      expect(viaGrant).toStrictEqual({
        credentialId: 'grant-1',
        storedCredential: true,
        organizationId: ORG,
        agentId: 'agent-1',
        agentAccount: ACCOUNT,
        chainId: CHAIN,
        label: 'research-bot',
        callerKind: McpCallerKind.AGENT,
        delegateAccount: DELEGATE,
        paymentsAllowed: true,
      } satisfies McpSession);
    });

    it('third-party grant on the MCP host: the same session but paymentsAllowed false', async () => {
      const fx = build('mcp');
      seedGrant(fx, { clientRowId: 'client-third' });
      fx.credentials.rows.push(
        buildCredential({
          organizationId: ORG,
          id: 'key-1',
          tokenHash: digestToken(API_KEY),
          delegateAccount: DELEGATE,
        }),
      );

      const viaGrant = await fx.source.resolve(ACCESS_TOKEN);
      const viaKey = await fx.apiKeySource.resolve(API_KEY);

      expect(viaGrant).toStrictEqual({
        ...viaKey,
        credentialId: 'grant-1',
        paymentsAllowed: false,
      });
    });
  });

  /**
   * `BlocklistSessionSource` wraps the composite (§6.4 item 3), so a blocked
   * organization, payer wallet or delegate is refused through the OAuth source
   * exactly as through an API key of the same agent.
   */
  describe('behind the blocklist, as McpModule wires it', () => {
    const declines = { resolve: () => Promise.reject(McpErrors.credentialInvalid()) };

    function wired(fx: ReturnType<typeof build>, ...blocks: SeededBlock[]) {
      return new BlocklistSessionSource(
        createSessionSource(SessionSourceMode.BOTH, {
          config: declines,
          db: fx.apiKeySource,
          oauth: fx.source,
          privy: declines,
        }),
        blocklistOf(...blocks),
      );
    }

    it.each([
      ['organization', { kind: BlockSubjectKind.ORGANIZATION, subject: ORG }, 'ACCOUNT_BLOCKED'],
      ['payer wallet', { kind: BlockSubjectKind.WALLET, subject: ACCOUNT }, 'ACCOUNT_BLOCKED'],
      ['delegate wallet', { kind: BlockSubjectKind.WALLET, subject: DELEGATE }, 'ACCOUNT_BLOCKED'],
    ])(
      'a blocked %s refuses the assay-mcp grant with the code an API key gets',
      async (_label, blocked: SeededBlock, code) => {
        const fx = build('mcp');
        seedGrant(fx);
        fx.credentials.rows.push(
          buildCredential({
            organizationId: ORG,
            id: 'key-1',
            tokenHash: digestToken(API_KEY),
            delegateAccount: DELEGATE,
          }),
        );
        const source = wired(fx, blocked);

        await expectErrorCodeAsync(() => source.resolve(API_KEY), code);
        await expectErrorCodeAsync(() => source.resolve(ACCESS_TOKEN), code);
      },
    );

    it('an unblocked grant passes through untouched', async () => {
      const fx = build('mcp');
      seedGrant(fx);
      const source = wired(fx, {
        kind: BlockSubjectKind.ORGANIZATION,
        subject: '7f3e2d1c-0b9a-4876-9543-210fedcba987',
      });

      await expect(source.resolve(ACCESS_TOKEN)).resolves.toMatchObject({
        credentialId: 'grant-1',
        paymentsAllowed: true,
      });
    });
  });
});
