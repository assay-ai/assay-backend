import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';
import { OAuthAccessTokenMcpSessionSource } from '@modules/auth/services/oauth-access-token-mcp-session.source';
import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { EscrowDelegationStatus } from '@modules/settlement/ports/escrow-delegation.port';
import {
  EscrowDelegationService,
  EscrowDelegationWithUnsettled,
} from '@modules/settlement/services/escrow-delegation.service';
import { hashOpaqueToken, mint } from '@modules/oauth/domain/opaque-token';

import { deployment } from '../../unit/chains/evm/evm-fixtures';
import {
  ensureTestDatabase,
  resetSchemaIfMigrationsChanged,
  testConnectionOptions,
} from '../helpers/test-database';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;

/**
 * The payer's standing delegations as `EscrowDelegationService.list` reads
 * them from the escrow (`delegatesOf` + `delegationOf`); `authorize` stands for
 * the payer's own `AuthorizeDelegate`, which the server can never sign.
 */
class AuthorizedDelegations {
  private readonly standing = new Map<AccountId, EscrowDelegationWithUnsettled[]>();
  readonly reads: AccountId[] = [];

  authorize(payer: AccountId, delegate: AccountId, validUntil: bigint): void {
    const list = this.standing.get(payer) ?? [];
    list.push({
      delegate,
      maxVoucherAmount: 500_000n,
      maxPerWindow: 5_000_000n,
      spentInWindow: 0n,
      validUntil,
      status: EscrowDelegationStatus.ACTIVE,
    } as EscrowDelegationWithUnsettled);
    this.standing.set(payer, list);
  }

  async list(payer: AccountId): Promise<readonly EscrowDelegationWithUnsettled[]> {
    this.reads.push(payer);
    return this.standing.get(payer) ?? [];
  }
}

/**
 * Binding an agent credential to its delegate key, against the real migrations
 * and a real Redis: the challenge is stored with a TTL and consumed once, the
 * proof is a signature by the delegate key, and the binding lands on the
 * credential's own row — which the DB-credential session source then carries
 * into every MCP session.
 */
describe('agent_credentials.delegate_account — binding a credential to its delegate key', () => {
  const DATABASE = 'assay_agent_delegate_test';
  let dataSource: DataSource;
  let redis: Redis;
  let service: AgentDelegateService;
  let credentials: AgentCredentialRepository;
  const chain = new AuthorizedDelegations();
  const organizationId = randomUUID();
  const agentId = randomUUID();
  // A fresh key per test: the database outlives a run, and a key is bound to one
  // live credential platform-wide, so a fixed key would collide with the last run.
  let delegateKey = privateKeyToAccount(generatePrivateKey());
  beforeEach(() => {
    delegateKey = privateKeyToAccount(generatePrivateKey());
  });

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
        OAuthClientEntity,
        OAuthAccessTokenEntity,
      ],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await resetSchemaIfMigrationsChanged(dataSource);
    await dataSource.runMigrations({ transaction: 'each' });

    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT || 6379),
    });
    credentials = new AgentCredentialRepository(dataSource);
    const adapter = new EvmChainAdapter(new Map(), new Map([[CHAIN, deployment(CHAIN)]]), [CHAIN]);
    service = new AgentDelegateService(
      credentials,
      new ChainAdapterRegistry([adapter], [CHAIN]),
      redis,
      chain as unknown as EscrowDelegationService,
    );
  }, 300_000);

  afterAll(async () => {
    await redis?.quit();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  /** Polls `condition` until it holds; fails after about two seconds. */
  async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('condition never held');
  }

  async function credential(): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO "agent_credentials" ("id", "organization_id", "agent_id", "name", "prefix", "token_hash", "scopes") ` +
        `VALUES ($1, $2, $3, 'agent', 'assay_sk_live_test', $4, '{}')`,
      [id, organizationId, agentId, `hash-${id}`],
    );
    return id;
  }

  const session = (credentialId: string): McpSession => ({
    credentialId,
    organizationId,
    agentId,
    agentAccount: `${CHAIN}:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296` as AccountId,
    chainId: CHAIN,
    label: null,
    callerKind: McpCallerKind.AGENT,
    paymentsAllowed: true,
    storedCredential: true,
  });

  async function sign(typedData: Record<string, unknown>) {
    const typed = typedData as {
      domain: { name: string; version: string; chainId: string; verifyingContract: `0x${string}` };
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      message: Record<string, string>;
    };
    return delegateKey.signTypedData({
      domain: { ...typed.domain, chainId: Number(typed.domain.chainId) },
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    } as never);
  }

  it('binds the delegate on the credential’s row, once, after a proof by the key', async () => {
    const id = await credential();
    const challenge = await service.challenge(session(id), delegateKey.address);
    const signature = await sign(challenge.typedData);

    const bound = await service.bind(session(id), challenge.challengeId, signature);
    expect(bound.delegate).toBe(`${CHAIN}:${delegateKey.address}`);

    const [row] = await dataSource.query(
      `SELECT "delegate_account", "delegate_bound_at" FROM "agent_credentials" WHERE "id" = $1`,
      [id],
    );
    expect(row.delegate_account).toBe(`${CHAIN}:${delegateKey.address}`);
    expect(row.delegate_bound_at).not.toBeNull();

    // The challenge is gone: a replayed proof binds nothing.
    await expect(service.bind(session(id), challenge.challengeId, signature)).rejects.toMatchObject(
      {
        errorCode: 'ACCOUNT_DELEGATE_CHALLENGE_INVALID',
      },
    );
  });

  /** §7.10 item 1, R-PAY-3: the delegate status, with the agent's label beside the credential. */
  it('paidCalls ACTIVE with the caps after an authorize fixture; null without a bound delegate', async () => {
    const id = await credential();
    const labelled = { ...session(id), label: 'research bot' };
    const before = chain.reads.length;
    expect(await service.current(labelled)).toEqual({
      credentialId: id,
      agentLabel: 'research bot',
      delegate: null,
      boundAt: null,
      paidCalls: null,
    });
    // No key bound, no chain read.
    expect(chain.reads).toHaveLength(before);

    const challenge = await service.challenge(labelled, delegateKey.address);
    await service.bind(labelled, challenge.challengeId, await sign(challenge.typedData));
    const delegate = `${CHAIN}:${delegateKey.address}` as AccountId;
    expect((await service.current(labelled)).paidCalls).toMatchObject({ status: 'NONE' });

    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
    chain.authorize(labelled.agentAccount, delegate, validUntil);
    const status = await service.current(labelled);
    expect(status).toMatchObject({
      credentialId: id,
      agentLabel: 'research bot',
      delegate,
      paidCalls: {
        status: 'ACTIVE',
        maxVoucherAmount: '500000',
        maxPerWindow: '5000000',
        spentInWindow: '0',
        validUntil: new Date(Number(validUntil) * 1000).toISOString(),
      },
    });
    expect(status.boundAt).not.toBeNull();
    expect(chain.reads.at(-1)).toBe(labelled.agentAccount);
  });

  /** D1-S03: one key, one live credential, across organizations. */
  it('refuses to bind a key another live credential holds, in any organization', async () => {
    const first = await credential();
    const c1 = await service.challenge(session(first), delegateKey.address);
    await service.bind(session(first), c1.challengeId, await sign(c1.typedData));

    const otherOrg = randomUUID();
    const second = randomUUID();
    await dataSource.query(
      `INSERT INTO "agent_credentials" ("id", "organization_id", "agent_id", "name", "prefix", "token_hash", "scopes") ` +
        `VALUES ($1, $2, $3, 'other agent', 'assay_sk_live_test', $4, '{}')`,
      [second, otherOrg, randomUUID(), `hash-${second}`],
    );
    const s2 = { ...session(second), organizationId: otherOrg };
    const c2 = await service.challenge(s2, delegateKey.address);
    await expect(service.bind(s2, c2.challengeId, await sign(c2.typedData))).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DELEGATE_ALREADY_BOUND',
    });
    const [row] = await dataSource.query(
      `SELECT "delegate_account" FROM "agent_credentials" WHERE "id" = $1`,
      [second],
    );
    expect(row.delegate_account).toBeNull();

    // The index refuses a direct duplicate too, whatever the case.
    await expect(
      dataSource.query(
        `UPDATE "agent_credentials" SET "delegate_account" = lower($2), "delegate_bound_at" = now() WHERE "id" = $1`,
        [second, `${CHAIN}:${delegateKey.address}`],
      ),
    ).rejects.toThrow(/uq_agent_credentials_delegate_live/);

    // Once the holder is revoked, the key can move.
    await dataSource.query(
      `UPDATE "agent_credentials" SET "revoked_at" = now(), "revoked_by" = 'test' WHERE "id" = $1`,
      [first],
    );
    const c3 = await service.challenge(s2, delegateKey.address);
    await expect(service.bind(s2, c3.challengeId, await sign(c3.typedData))).resolves.toMatchObject(
      {
        delegate: `${CHAIN}:${delegateKey.address}`,
      },
    );
  });

  it('releases an expired holder of the key', async () => {
    const expired = await credential();
    await dataSource.query(
      `UPDATE "agent_credentials" SET "delegate_account" = $2, "delegate_bound_at" = now(), "expires_at" = now() - interval '1 minute' WHERE "id" = $1`,
      [expired, `${CHAIN}:0x${'7'.repeat(40)}`],
    );
    const key = privateKeyToAccount(generatePrivateKey());
    // Re-point the expired row at THIS key, then bind it elsewhere.
    await dataSource.query(
      `UPDATE "agent_credentials" SET "delegate_account" = $2 WHERE "id" = $1`,
      [expired, `${CHAIN}:${key.address}`],
    );
    const live = await credential();
    const c = await service.challenge(session(live), key.address);
    const typed = c.typedData as {
      domain: { name: string; version: string; chainId: string };
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      message: Record<string, string>;
    };
    const signature = await key.signTypedData({
      domain: { ...typed.domain, chainId: Number(typed.domain.chainId) },
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    } as never);
    await expect(service.bind(session(live), c.challengeId, signature)).resolves.toBeDefined();
    const [row] = await dataSource.query(
      `SELECT "delegate_account" FROM "agent_credentials" WHERE "id" = $1`,
      [expired],
    );
    expect(row.delegate_account).toBeNull();
  });

  /**
   * Migration 1759600000002 on a database that already has duplicates (only
   * possible before it): EVERY live holder is unbound — the one that re-bound
   * last is no more legitimate than the other — while a revoked row is left be.
   */
  it('unbinds every live holder of a key bound twice before the unique index', async () => {
    // Back to before the unique index, however many migrations came after it.
    for (;;) {
      const [last] = (await dataSource.query(
        `SELECT "name" FROM "migrations" ORDER BY "timestamp" DESC, "id" DESC LIMIT 1`,
      )) as Array<{ name: string }>;
      // No wrapping transaction: some down() steps drop an index CONCURRENTLY.
      await dataSource.undoLastMigration({ transaction: 'none' });
      if (last?.name === 'AgentCredentialDelegateUnique1759600000002') break;
    }
    const key = `${CHAIN}:${privateKeyToAccount(generatePrivateKey()).address}`;
    const early = await credential();
    const late = await credential();
    const revoked = await credential();
    await dataSource.query(
      `UPDATE "agent_credentials" SET "delegate_account" = $2, "delegate_bound_at" = now() - interval '1 hour' WHERE "id" = $1`,
      [early, key],
    );
    await dataSource.query(
      `UPDATE "agent_credentials" SET "delegate_account" = lower($2), "delegate_bound_at" = now() WHERE "id" = $1`,
      [late, key],
    );
    await dataSource.query(
      `UPDATE "agent_credentials" SET "delegate_account" = $2, "delegate_bound_at" = now(), "revoked_at" = now(), "revoked_by" = 'test' WHERE "id" = $1`,
      [revoked, key],
    );
    await dataSource.runMigrations({ transaction: 'each' });

    const rows: { id: string; delegate_account: string | null }[] = await dataSource.query(
      `SELECT "id", "delegate_account" FROM "agent_credentials" WHERE "id" = ANY($1)`,
      [[early, late, revoked]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.delegate_account]));
    expect(byId[early]).toBeNull();
    expect(byId[late]).toBeNull();
    expect(byId[revoked]).toBe(key);
  });

  /**
   * R-OA-22: a grant of a client outside `OAUTH_PAYMENT_CLIENTS`, resolved by
   * the real OAuth session source on the MCP host, cannot ask for a challenge
   * or bind a key. Nothing is written to Redis or to the credential row.
   */
  it('third-party OAuth session → challenge and bind refused ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED', async () => {
    const mcp = 'https://mcp.example.com';
    const orgId = randomUUID();
    const oauthAgentId = randomUUID();
    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Example org', 'ACTIVE')`,
      [orgId],
    );
    await dataSource.query(
      `INSERT INTO "agents" ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id")
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5)`,
      [
        oauthAgentId,
        orgId,
        `did:privy:test-${oauthAgentId}`,
        `${CHAIN}:${privateKeyToAccount(generatePrivateKey()).address}`,
        CHAIN,
      ],
    );
    const [client] = (await dataSource.query(
      `INSERT INTO "oauth_clients" ("client_id", "kind", "client_name", "redirect_uris", "metadata")
       VALUES ($1, 'DCR', 'Example app', ARRAY['https://app.example.com/callback'], '{}')
       RETURNING "id"`,
      [`dcr_${randomUUID().replace(/-/g, '').slice(0, 22)}`],
    )) as { id: string }[];
    const [grant] = (await dataSource.query(
      `INSERT INTO "agent_credentials"
         ("organization_id", "agent_id", "name", "issued_via", "oauth_client_id", "scopes", "expires_at")
       VALUES ($1, $2, 'Example app', 'OAUTH', $3, '{}', now() + interval '30 days')
       RETURNING "id"`,
      [orgId, oauthAgentId, client.id],
    )) as { id: string }[];
    const accessToken = mint('assay_at_');
    await dataSource.query(
      `INSERT INTO "oauth_access_tokens"
         ("organization_id", "credential_id", "token_hash", "scope", "audience", "expires_at")
       VALUES ($1, $2, $3, 'assay:agent', $4, now() + interval '1 hour')`,
      [orgId, grant.id, hashOpaqueToken(accessToken), mcp],
    );

    const source = new OAuthAccessTokenMcpSessionSource(
      new OAuthAccessTokenRepository(dataSource),
      credentials,
      new OAuthClientRepository(dataSource),
      new CredentialSessionResolver(credentials, new AgentRepository(dataSource)),
      { audience: mcp, paymentClients: [`${mcp}/oauth/clients/assay-mcp`] },
      'mcp',
    );
    try {
      const oauthSession = await source.resolve(accessToken);
      expect(oauthSession).toMatchObject({ credentialId: grant.id, paymentsAllowed: false });

      await expect(service.challenge(oauthSession, delegateKey.address)).rejects.toMatchObject({
        errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
      });
      await expect(service.bind(oauthSession, randomUUID(), '0x00')).rejects.toMatchObject({
        errorCode: 'ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED',
      });

      expect(await redis.exists(`agent-delegate-challenge:${grant.id}`)).toBe(0);
      const [row] = await dataSource.query(
        `SELECT "delegate_account", "delegate_bound_at" FROM "agent_credentials" WHERE "id" = $1`,
        [grant.id],
      );
      expect(row).toEqual({ delegate_account: null, delegate_bound_at: null });
    } finally {
      // The database outlives a run, and the migration-revert test above cannot
      // undo the OAuth migration while an OAuth credential row exists.
      // Let the source's fire-and-forget stamps land first, so none races the DELETEs.
      await waitFor(async () => {
        const [stamps] = (await dataSource.query(
          `SELECT
             (SELECT "first_used_at" FROM "oauth_access_tokens" WHERE "credential_id" = $1) AS "first_used_at",
             (SELECT "last_used_at" FROM "agent_credentials" WHERE "id" = $1) AS "last_used_at"`,
          [grant.id],
        )) as { first_used_at: Date | null; last_used_at: Date | null }[];
        return stamps.first_used_at !== null && stamps.last_used_at !== null;
      }).catch(() => undefined); // never resolved: no stamp is coming, clean up anyway
      await dataSource.query(`DELETE FROM "oauth_access_tokens" WHERE "credential_id" = $1`, [
        grant.id,
      ]);
      await dataSource.query(`DELETE FROM "agent_credentials" WHERE "id" = $1`, [grant.id]);
      await dataSource.query(`DELETE FROM "oauth_clients" WHERE "id" = $1`, [client.id]);
      await dataSource.query(`DELETE FROM "agents" WHERE "id" = $1`, [oauthAgentId]);
      await dataSource.query(`DELETE FROM "organizations" WHERE "id" = $1`, [orgId]);
    }
  });

  it('keeps the account and the instant together, by CHECK', async () => {
    const id = await credential();
    await expect(
      dataSource.query(
        `UPDATE "agent_credentials" SET "delegate_account" = 'eip155:46630:0x5555555555555555555555555555555555555555' WHERE "id" = $1`,
        [id],
      ),
    ).rejects.toThrow(/chk_agent_credentials_delegate_pair/);
  });
});
