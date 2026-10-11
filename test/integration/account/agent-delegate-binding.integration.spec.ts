import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { privateKeyToAccount } from 'viem/accounts';

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
  const delegateKey = privateKeyToAccount(`0x${'d1'.repeat(32)}`);

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
    await dataSource.runMigrations({ transaction: 'all' });

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
        `VALUES ($1, $2, $3, 'agent', 'x402_sk_live_test', $4, '{}')`,
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
