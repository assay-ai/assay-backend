import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';

import { deployment } from '../../unit/chains/evm/evm-fixtures';
import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;

/**
 * Binding an agent credential to its delegate key, against the real migrations
 * and a real Redis: the challenge is stored with a TTL and consumed once, the
 * proof is a signature by the delegate key, and the binding lands on the
 * credential's own row — which the DB-credential session source then carries
 * into every MCP session.
 */
describe('agent_credentials.delegate_account — binding a credential to its delegate key', () => {
  const DATABASE = 'x402_agent_delegate_test';
  let dataSource: DataSource;
  let redis: Redis;
  let service: AgentDelegateService;
  let credentials: AgentCredentialRepository;
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
      entities: [AgentCredentialEntity],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
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
    );
  }, 300_000);

  afterAll(async () => {
    await redis?.quit();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

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
