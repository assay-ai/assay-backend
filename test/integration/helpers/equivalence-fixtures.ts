import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';

import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { privateKeyToAccount } from 'viem/accounts';

import { AppApiModule } from '@bootstrap/api/app.module';
import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { mcpCorsOptions } from '@bootstrap/mcp/mcp-cors';
import { McpExceptionsFilter } from '@bootstrap/mcp/mcp-exceptions.filter';
import { PrivyMcpSessionSource } from '@modules/auth/services/privy-mcp-session.source';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EVM_RPC_CLIENTS } from '@modules/chains/evm/evm.constants';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpCallerKind, McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { PROVIDER_REGISTRY } from '@modules/provider/ports/provider-registry.port';
import { PROVIDER_STAKE_SOURCE, stakeKey } from '@modules/provider/ports/provider-stake.port';
import {
  ProviderRoutingState,
  ProviderStatus,
  ProviderTier,
} from '@modules/provider/ports/provider.types';
import { ConfigProviderRegistry } from '@modules/provider/services/config-provider-registry';
import {
  ProviderResponse,
  ResponseBodyKind,
} from '@modules/tool/domain/classification/classification.types';
import {
  BINDING_INVOKER,
  BindingInvocation,
  BindingInvokerPort,
} from '@modules/tool/ports/binding-invoker.port';
import { UpstreamRequest, mapRequest } from '@modules/tool/domain/mapping';
import { TOOL_CATALOGUE } from '@modules/tool/ports/tool-catalogue.port';
import {
  TOOL_CONTRACT_CHANGES,
  ToolContractChanges,
} from '@modules/tool/ports/tool-contracts.port';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { DatabaseToolCatalogue } from '@modules/tool/services/database-tool-catalogue';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { MoneyUtil } from '@utils/money.util';
import { digestToken } from '@shared/crypto/token-digest';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';

import { EvmSigner, generateSigner } from '../../unit/chains/evm/evm-fixtures';
import { InMemoryProviderStakeSource } from '../../unit/helpers/in-memory-provider-stake.source';
import { freshMigratedDatabase, runDatabaseName } from './slash-prorata-context';
import { testConnectionOptions } from './test-database';

/**
 * Twin fixtures for the equivalence suite (spec §12.1, Task 1.17).
 *
 * Both real apps, `AppMcpModule` and `AppApiModule`, boot against a migrated
 * test database and a real Redis. Only the Privy session source is replaced,
 * in both apps, by a table of person sessions: the consent API and the
 * person-only routes need a person, and a Privy login is not what is tested.
 * Every agent credential, an API key or an OAuth grant, goes through the real
 * session sources.
 *
 * A **world** is one fresh organization with one agent that holds both kinds
 * of credential: an API key minted through `POST /agents/:id/credentials`, and
 * an OAuth grant issued through the real browser flow (authorize, consent,
 * continue, code exchange with PKCE). A case that changes state the agent
 * owns (budgets, limits, pause) runs each credential in a world of its own,
 * built the same way, so neither run sees the other's footprint.
 */

export const MCP = 'https://mcp.example.test';
export const WEB = 'https://app.example.test';
export const BUILTIN = `${MCP}/oauth/clients/assay-mcp`;
export const REDIRECT = 'http://127.0.0.1:61234/callback';
/** eip155: the namespace with delegate binding and rail B. */
export const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
export const CREDENTIAL_NAME = 'Equivalence app';

const EVM_DEPLOYMENTS = JSON.stringify({
  [CHAIN]: {
    config: '0x1111111111111111111111111111111111111111',
    stake: '0x2222222222222222222222222222222222222222',
    escrow: '0x3333333333333333333333333333333333333333',
    asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
    escrowImplementation: '0x8888888888888888888888888888888888888888',
    admin: '0x9999999999999999999999999999999999999999',
    owner: '0x7777777777777777777777777777777777777777',
  },
});

// ── the market: the tools, one provider, the chain ───────────────────────────

/**
 * The seller side, which neither credential can see or change: three tools
 * (free, freemium, paid) and the maker's own provider tool, behind one staked
 * provider on {@link CHAIN}. The tool
 * contracts are seeded the real way (`TOOL_CATALOGUE_SEED_JSON` → `tools`, at
 * boot); the bindings, the provider's registry entry, stake and enrolment, the
 * HTTP call to the provider and the chain reads are the MCP app's ports to the
 * outside world and are answered here.
 */
export const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;
export const PROVIDER_ID = 'a6f0e8a4-2f4b-4b3e-9f61-6f7c5a1e0b01';
export const PROVIDER_PAYOUT = `${CHAIN}:0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2` as AccountId;
export const PRICE_ATOMIC = '50000'; // 0.05 USDG
export const ESCROW_CONTRACT = `${CHAIN}:0x3333333333333333333333333333333333333333` as AccountId;

const schema = (property: string) => ({
  type: 'object',
  required: [property],
  properties: { [property]: { type: 'string' } },
});

export const TOOLS = {
  free: {
    id: '4b1c6a0e-7d55-4f0e-8a6e-0f2f0c7e1a01',
    name: 'equivalence_weather_now',
    category: 'weather',
    pricingMode: PricingMode.FREE,
  },
  freemium: {
    id: '4b1c6a0e-7d55-4f0e-8a6e-0f2f0c7e1a02',
    name: 'equivalence_weather_forecast',
    category: 'weather',
    pricingMode: PricingMode.FREEMIUM,
  },
  paid: {
    id: '4b1c6a0e-7d55-4f0e-8a6e-0f2f0c7e1a03',
    name: 'equivalence_web_search',
    category: 'search',
    pricingMode: PricingMode.PAID,
  },
} as const;

/** The maker's handle, and its one LISTED provider tool (what `/@{handle}` serves). */
export const MAKER_HANDLE = 'eqpub';
export const MAKER_TOOL = {
  id: '4b1c6a0e-7d55-4f0e-8a6e-0f2f0c7e1a04',
  name: `${MAKER_HANDLE}__lookup`,
  category: 'reference',
  pricingMode: PricingMode.FREE,
} as const;
// Seeded as a standard tool (a seed holds only those), then made the maker's
// own provider tool, `{handle}__{tool}`, in `publishMarket`.
const SEEDED = [...Object.values(TOOLS), { ...MAKER_TOOL, name: 'equivalence_maker_lookup' }];

/** Free calls per agent and day on the freemium binding. */
export const FREEMIUM_QUOTA = 2;

/** The seeded binding of a tool (one per tool, all at {@link PROVIDER_ID}). */
export const bindingIdOf = (toolId: string): string => `${toolId.slice(0, -2)}b${toolId.slice(-1)}`;

/**
 * Ids that are the SAME in every world, by placeholder. The normaliser keeps
 * them distinct (`<tool:paid>`, not a bare `<uuid>`), so a row or a call that
 * names the wrong tool, binding, provider or shared toolset on one side fails.
 * Each boot starts from these (`EquivalenceApps.knownIds`); `publishMarket`
 * adds the shared toolsets.
 */
const seededKnownIds = (): Map<string, string> =>
  new Map<string, string>([
    ...Object.entries(TOOLS).flatMap(([kind, tool]): [string, string][] => [
      [tool.id, `<tool:${kind}>`],
      [bindingIdOf(tool.id), `<binding:${kind}>`],
    ]),
    [MAKER_TOOL.id, '<tool:maker>'],
    [bindingIdOf(MAKER_TOOL.id), '<binding:maker>'],
    [PROVIDER_ID, '<provider>'],
  ]);

const catalogueSeed = () => ({
  tools: SEEDED.map((tool) => ({
    id: tool.id,
    name: tool.name,
    category: tool.category,
    tags: ['equivalence'],
    description: `${tool.name.replace(/_/g, ' ')}: an answer for one query. Use it to test.`,
    inputSchema: schema('query'),
    outputSchema: schema('answer'),
    verificationPolicyId: 'policy-default',
    tier: 'VERIFIED',
  })),
  bindings: SEEDED.map((tool) => ({
    id: bindingIdOf(tool.id),
    toolId: tool.id,
    providerId: PROVIDER_ID,
    endpoint: 'https://provider.example.test/api',
    requestMapping: { method: 'POST', path: '/answer', body: { q: { $path: '$.query' } } },
    responseMapping: { answer: { $path: '$.answer' } },
    pricingMode: tool.pricingMode,
    priceAmount: tool.pricingMode === PricingMode.FREE ? '0' : PRICE_ATOMIC,
    assetId: USDG,
    settlementChains: [CHAIN],
    freeQuotaPerAgent: tool.pricingMode === PricingMode.FREEMIUM ? FREEMIUM_QUOTA : null,
    freeDailyBudget: null,
    slaFailureRate: 0.02,
    timeoutMs: 5000,
    status: 'ACTIVE',
    version: 1,
  })),
});

/** What one call to the provider carried: the request the binding's mapping renders. */
export interface ProviderCall {
  readonly toolId: string;
  readonly bindingId: string;
  readonly request: UpstreamRequest;
  readonly timeoutMs: number;
  readonly omit: BindingInvocation['omit'] | null;
}

/** What the provider answers, and every request it was sent. */
export class ProviderStub implements BindingInvokerPort {
  readonly calls: ProviderCall[] = [];

  async invoke(invocation: BindingInvocation): Promise<ProviderResponse> {
    // Rendered as `EgressBindingInvoker` renders it before dialling: method,
    // path, query, headers and body from the binding's request mapping.
    this.calls.push({
      toolId: invocation.tool.id,
      bindingId: invocation.binding.id,
      request: mapRequest(invocation.binding.requestMapping, invocation.input, {
        inputSchema: invocation.tool.inputSchema,
      }),
      timeoutMs: invocation.timeoutMs,
      omit: invocation.omit ?? null,
    });
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { kind: ResponseBodyKind.JSON, value: { answer: 'forty-two' } },
    };
  }
}

interface DelegationRecord {
  maxVoucherAmount: bigint;
  maxPerWindow: bigint;
  spentInWindow: bigint;
  windowStartedAt: bigint;
  validUntil: bigint;
  listPosition: number;
  revoked: boolean;
}

/**
 * The eip155 chain as the adapter reads it: delegation records the payer
 * authorised (`AuthorizeDelegate`), and nothing else. The suite writes them
 * as the payer's on-chain act would; the server never can.
 */
export class FakeEvmChain {
  readonly delegations = new Map<string, DelegationRecord>();
  /** Every chain WRITE attempted: the suite asserts there are none. */
  readonly writes: string[] = [];

  async readContract(args: { functionName: string; args: readonly unknown[] }): Promise<unknown> {
    if (args.functionName === 'delegationOf') {
      const [payer, delegate] = args.args as string[];
      return (
        this.delegations.get(`${payer.toLowerCase()}:${delegate.toLowerCase()}`) ?? {
          maxVoucherAmount: 0n,
          maxPerWindow: 0n,
          spentInWindow: 0n,
          windowStartedAt: 0n,
          validUntil: 0n,
          listPosition: 0,
          revoked: false,
        }
      );
    }
    throw new Error(`unexpected chain read ${args.functionName}`);
  }

  async writeContract(args: { functionName: string }): Promise<never> {
    this.writes.push(args.functionName);
    throw new Error(`unexpected chain write ${args.functionName}`);
  }

  authorize(payer: AccountId, delegate: AccountId): void {
    const address = (account: AccountId) => account.split(':')[2].toLowerCase();
    const now = BigInt(Math.floor(Date.now() / 1000));
    this.delegations.set(`${address(payer)}:${address(delegate)}`, {
      maxVoucherAmount: 500_000n,
      maxPerWindow: 5_000_000n,
      spentInWindow: 0n,
      windowStartedAt: 0n,
      validUntil: now + 30n * 86_400n,
      listPosition: 1,
      revoked: false,
    });
  }
}

/** Every buyer's escrow is open and funded, with room under its own limits. */
export class FundedEscrows implements EscrowBalanceReaderPort {
  async read(_account: AccountId, asset: AssetId): Promise<EscrowChainBalance | null> {
    return {
      balance: MoneyUtil.of('100000000', asset, 6),
      seqHigh: 0n,
      withdrawRequested: 0n,
      withdrawAvailableAt: 0,
      maxVoucherAmount: 1_000_000n,
      maxPerWindow: 10_000_000n,
      spentInWindow: 0n,
      windowStartedAt: 0,
      observedAt: new Date(),
    };
  }

  async readMany(): Promise<ReadonlyMap<AccountId, EscrowChainBalance>> {
    return new Map();
  }

  async escrowAddresses(): Promise<{
    readonly escrowPda: AccountId;
    readonly escrowTokenAccount: AccountId;
  }> {
    return { escrowPda: ESCROW_CONTRACT, escrowTokenAccount: ESCROW_CONTRACT };
  }
}

export interface Market {
  readonly provider: ProviderStub;
  readonly chain: FakeEvmChain;
  readonly escrows: FundedEscrows;
}

/** The MCP app's ports to the provider and the chain, answered by {@link Market}. */
function marketOverrides(market: Market, builder: TestingModuleBuilder): TestingModuleBuilder {
  const provider: ProviderRoutingState = {
    providerId: PROVIDER_ID,
    status: ProviderStatus.ACTIVE,
    tier: ProviderTier.ESTABLISHED,
    stats: {
      availabilityRate: 0.99,
      paidQualityRate: 0.95,
      freeQualityRate: 0.9,
      p50LatencyMs: 200,
      p95LatencyMs: 800,
      callsServed: 50_000,
      upheldSlashes: 0,
    },
    payoutAccountByChain: new Map([[CHAIN, PROVIDER_PAYOUT]]),
    payoutEnrolmentChains: new Set([CHAIN]),
  };
  const enrolments: ChainEnrolmentPort = {
    enrolmentsOf: async () =>
      new Map([
        [
          enrolmentKey(PROVIDER_ID, CHAIN),
          {
            providerId: PROVIDER_ID,
            chainId: CHAIN,
            payoutAccountId: PROVIDER_PAYOUT,
            stakeAuthorityAccountId: PROVIDER_PAYOUT,
            status: ChainEnrolmentStatus.ACTIVE,
            enrolledAt: new Date(0),
          } as ChainEnrolment,
        ],
      ]),
  };
  return builder
    .overrideProvider(TOOL_CATALOGUE)
    .useFactory({
      // The tool contracts from the database (seeded at boot); the bindings
      // from the same seed, as a provider's console would have published them.
      factory: (contracts: DatabaseToolCatalogue, seeded: InMemoryToolCatalogue) => ({
        findTool: (id: string) => contracts.findTool(id),
        listTools: () => contracts.listTools(),
        findRemovedByName: (name: string) => contracts.findRemovedByName(name),
        findBindings: async (id: string) =>
          (await contracts.findTool(id)) ? seeded.findBindings(id) : [],
      }),
      inject: [DatabaseToolCatalogue, InMemoryToolCatalogue],
    })
    .overrideProvider(PROVIDER_REGISTRY)
    .useValue(new ConfigProviderRegistry({ [PROVIDER_ID]: provider }))
    .overrideProvider(PROVIDER_STAKE_SOURCE)
    .useValue(
      new InMemoryProviderStakeSource({
        [stakeKey(PROVIDER_ID, CHAIN)]: MoneyUtil.of('1000000000', USDG, 6),
      }),
    )
    .overrideProvider(CHAIN_ENROLMENT_SOURCE)
    .useValue(enrolments)
    .overrideProvider(BINDING_INVOKER)
    .useValue(market.provider)
    .overrideProvider(ESCROW_BALANCE_READER)
    .useValue(market.escrows)
    .overrideProvider(EVM_RPC_CLIENTS)
    .useValue(new Map([[CHAIN, market.chain]]));
}

// ── payment keys and vouchers (what an agent's own machine does) ─────────────

/** A delegate (payment) key, held by the agent and never by the server. */
export interface DelegateKey {
  readonly signer: EvmSigner;
  /** CAIP-10 on {@link CHAIN}. */
  readonly account: AccountId;
}

export function newDelegateKey(): DelegateKey {
  const signer = generateSigner(CHAIN);
  return { signer, account: signer.account };
}

/** Signs a delegate-binding challenge's EIP-712 typed data with the key. */
export async function signBindingChallenge(
  key: DelegateKey,
  typedData: Record<string, unknown>,
): Promise<string> {
  const typed = typedData as {
    domain: { name: string; version: string; chainId: string };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, string>;
  };
  return privateKeyToAccount(key.signer.privateKey).signTypedData({
    domain: { ...typed.domain, chainId: Number(typed.domain.chainId) },
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  } as never);
}

/** The `x402/paymentRequired` fields a voucher binds. */
export interface PaymentRequirement {
  readonly payer: AccountId;
  readonly payTo: AccountId;
  readonly provider: AccountId;
  readonly providerId: string;
  readonly amount: { amount: string; asset: string; decimals: number };
  readonly resource: string;
  readonly requestHash: string;
  readonly seq: string;
}

/** The `_meta["x402/voucher"]` envelope for a requirement, signed by `key`. */
export function signVoucher(
  mcp: INestApplication,
  requirement: PaymentRequirement,
  key: DelegateKey,
): { voucher: Voucher; signature: string; providerId: string } {
  const now = Math.floor(Date.now() / 1000);
  const voucher: Voucher = {
    payer: requirement.payer,
    payTo: requirement.payTo,
    provider: requirement.provider,
    amount: requirement.amount as Voucher['amount'],
    resource: requirement.resource,
    requestHash: requirement.requestHash,
    seq: requirement.seq,
    issuedAt: now - 5,
    expiresAt: now + 120,
  };
  const adapter = mcp.get(ChainAdapterRegistry, { strict: false }).resolve(CHAIN);
  const digest = adapter.buildVoucherMessage(voucher);
  return { voucher, signature: key.signer.sign(digest), providerId: requirement.providerId };
}

/** Which credential of a world a run uses. */
export type Via = 'key' | 'grant';
export const BOTH: readonly Via[] = ['key', 'grant'];

export interface WorldCredential {
  readonly id: string;
  /** The bearer an agent presents: the API key, or the grant's access token. */
  readonly bearer: string;
}

export interface GrantCredential extends WorldCredential {
  readonly refresh: string;
  readonly clientId: string;
}

export interface World {
  readonly organizationId: string;
  /** The agent both credentials act as. */
  readonly agentId: string;
  /** The agent's linked wallet, CAIP-10. */
  readonly wallet: AccountId;
  /** The person who minted the key and approved the grant. */
  readonly person: { readonly agentId: string; readonly token: string };
  readonly key: WorldCredential;
  readonly grant: GrantCredential;
}

export const credentialOf = (world: World, via: Via): WorldCredential =>
  via === 'key' ? world.key : world.grant;

export interface WorldOptions {
  /** A fixed organization id (the maker's is {@link PROVIDER_ID}). */
  readonly organizationId?: string;
  /** The grant's client: the built-in `assay-mcp` (default), or a third-party DCR client. */
  readonly client?: 'builtin' | 'third-party';
  /** Grant `assay_replaces`, for the F5 re-login. */
  readonly replaces?: string;
}

export interface SharedUrls {
  readonly maker: World;
  readonly handle: string;
  readonly unlistedToken: string;
}

export interface EquivalenceApps {
  readonly mcp: INestApplication;
  readonly api: INestApplication;
  readonly dataSource: DataSource;
  readonly redis: Redis;
  readonly market: Market;
  /** Ids shared by every world, by placeholder (see `seededKnownIds`). */
  readonly knownIds: ReadonlyMap<string, string>;
  /** A new organization, its agent, an API key and an OAuth grant for that agent. */
  world(options?: WorldOptions): Promise<World>;
  /** Two worlds built alike: the key runs in the first, the grant in the second. */
  pair(options?: WorldOptions): Promise<Record<Via, World>>;
  /** Another grant for an existing world's agent (a re-login, a second app). */
  grantFor(world: World, options?: WorldOptions): Promise<GrantCredential>;
  /** Another API key for an existing world's agent. */
  keyFor(world: World, name?: string): Promise<WorldCredential>;
  /** A third-party (DCR) client id, registered once per boot. */
  thirdPartyClientId(): Promise<string>;
  /** A person's request on the API app (`/api/v1` + path), envelope unwrapped. */
  asPerson(
    world: World,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** A toolset of the three tools, published `versions` times at `visibility`. */
  toolsetFor(
    world: World,
    slug: string,
    visibility: 'PRIVATE' | 'PUBLIC' | 'UNLISTED',
    versions?: number,
  ): Promise<{ id: string; unlistedToken: string | null }>;
  claimHandle(world: World, handle: string): Promise<void>;
  /** The shared URLs every world can reach; once per boot. */
  publishMarket(): Promise<SharedUrls>;
  close(): Promise<void>;
}

export interface BootOptions {
  readonly database: string;
  readonly env?: Record<string, string>;
}

/** A fresh client address per request, so per-IP limits never leak across cases. */
export function newIp(): string {
  return `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 250) + 1}`;
}

/** A random EVM address, CAIP-10 on {@link CHAIN}. */
export function randomWallet(): AccountId {
  return `${CHAIN}:${privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`).address}` as AccountId;
}

/**
 * Closes an ioredis client without leaving a timer behind: `disconnect()` on
 * a socket arms a 2 s force-close timer that keeps Jest alive (review M7).
 */
async function quit(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  await client.quit().catch(() => client.disconnect());
}

export async function bootEquivalenceApps(options: BootOptions): Promise<EquivalenceApps> {
  const saved = { ...process.env };
  const dataSource = await freshMigratedDatabase(options.database);
  const connection = testConnectionOptions();
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || '6379';
  Object.assign(process.env, {
    NODE_ENV: 'local',
    TYPEORM_CACHE_TTL_MULTIPLIER: '1',
    TYPEORM_CACHE_ENABLED: 'false',
    SERVICE_TYPE: 'all',
    MCP_PUBLIC_URL: MCP,
    WEB_APP_URL: WEB,
    AUTH_SESSION_SOURCE: 'both',
    PRIVY_APP_ID: 'equivalence-test-app',
    PRIVY_DEFAULT_CHAIN_ID: CHAIN,
    PRIVY_USER_LOOKUP_ENABLED: 'false',
    ENABLED_CHAINS: CHAIN,
    EVM_DEPLOYMENTS,
    EVM_RPC_URLS: JSON.stringify({ [CHAIN]: 'https://rpc.testnet.chain.example' }),
    EVM_RELAYER_GAS_GRANT_MAX_WEI: '2000000000000000',
    EVM_RELAYER_GAS_GRANT_DAILY_MAX_WEI: '50000000000000000',
    EVM_RELAYER_FLOAT_LOW_WEI: '10000000000000000',
    BULLBOARD_ENABLED: 'false',
    BULLBOARD_USERNAME: 'equivalence-test',
    BULLBOARD_PASSWORD: 'equivalence-test-password',
    JWT_SECRET: 'equivalence-test-jwt-'.repeat(3),
    MCP_SEARCH_CURSOR_SECRET: 'equivalence-test-'.repeat(3),
    DATABASE_HOST: connection.host,
    DATABASE_PORT: String(connection.port),
    DATABASE_USER: connection.username,
    DATABASE_PASSWORD: connection.password,
    DATABASE_NAME: runDatabaseName(options.database),
    OAUTH_REQUEST_COOKIE_SECRET: randomBytes(32).toString('hex'),
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_URL: `redis://${redisHost}:${redisPort}`,
    TOOL_CATALOGUE_SEED_JSON: JSON.stringify(catalogueSeed()),
    ...options.env,
  });
  const knownIds = seededKnownIds();
  const market: Market = {
    provider: new ProviderStub(),
    chain: new FakeEvmChain(),
    escrows: new FundedEscrows(),
  };

  // The person sessions, by bearer. Only Privy's source is replaced: every
  // agent credential still goes through the real config, API-key and OAuth
  // sources, behind the real blocklist wrapper.
  const persons = new Map<string, McpSession>();
  const personSource: McpSessionPort = {
    resolve: async (token: string | null) => {
      const session = token ? persons.get(token) : undefined;
      if (!session) throw McpErrors.credentialInvalid();
      return session;
    },
  };

  const mcpRef = await marketOverrides(
    market,
    Test.createTestingModule({ imports: [AppMcpModule] })
      .overrideProvider(PrivyMcpSessionSource)
      .useValue(personSource),
  ).compile();
  const mcpApp = mcpRef.createNestApplication<NestExpressApplication>({ logger: false });
  mcpApp.set('trust proxy', 1);
  mcpApp.enableCors(mcpCorsOptions);
  mcpApp.useGlobalFilters(new McpExceptionsFilter());
  // Bound once, on 127.0.0.1 exactly: supertest then reuses this address
  // instead of an ephemeral wildcard listen per request, which another local
  // process holding the same port on 127.0.0.1 could answer.
  await mcpApp.listen(0, '127.0.0.1');

  const apiRef = await Test.createTestingModule({ imports: [AppApiModule] })
    .overrideProvider(PrivyMcpSessionSource)
    .useValue(personSource)
    .compile();
  const api = apiRef.createNestApplication({ logger: false });
  api.setGlobalPrefix('api');
  api.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  api.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  api.useGlobalFilters(new AllExceptionsFilter());
  api.useGlobalInterceptors(new TransformInterceptor());
  await api.listen(0, '127.0.0.1');

  const redis = new Redis({ host: redisHost, port: Number(redisPort), maxRetriesPerRequest: 1 });

  let dcrClientId: string | null = null;
  async function thirdPartyClientId(): Promise<string> {
    if (dcrClientId) return dcrClientId;
    const registered = await request(mcpApp.getHttpServer())
      .post('/oauth/register')
      .set('X-Forwarded-For', newIp())
      .send({
        client_name: 'Example Desktop Client',
        redirect_uris: ['http://127.0.0.1/callback'],
      });
    if (registered.status !== 201) {
      throw new Error(`DCR failed: ${registered.status} ${JSON.stringify(registered.body)}`);
    }
    dcrClientId = registered.body.client_id as string;
    return dcrClientId;
  }

  async function insertAgent(
    organizationId: string,
    wallet: AccountId | null,
    label: string,
  ): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO "agents"
         ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id", "label")
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6)`,
      [id, organizationId, `did:privy:test-${id}`, wallet, wallet ? CHAIN : null, label],
    );
    return id;
  }

  async function keyFor(world: World, name = CREDENTIAL_NAME): Promise<WorldCredential> {
    const created = await request(api.getHttpServer())
      .post(`/api/v1/agents/${world.agentId}/credentials`)
      .set('Authorization', `Bearer ${world.person.token}`)
      .send({ name });
    if (created.status !== 201) {
      throw new Error(`key mint failed: ${created.status} ${JSON.stringify(created.body)}`);
    }
    const body = created.body.data ?? created.body;
    return { id: body.id as string, bearer: body.token as string };
  }

  async function grantFor(world: World, grantOptions: WorldOptions = {}): Promise<GrantCredential> {
    const clientId = grantOptions.client === 'third-party' ? await thirdPartyClientId() : BUILTIN;
    const redirect =
      grantOptions.client === 'third-party' ? 'http://127.0.0.1:50123/callback' : REDIRECT;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'equivalence',
      scope: 'assay:agent offline_access',
      ...(grantOptions.replaces ? { assay_replaces: grantOptions.replaces } : {}),
    });
    const started = await request(mcpApp.getHttpServer())
      .get(`/oauth/authorize?${params}`)
      .set('X-Forwarded-For', newIp());
    const location: string = started.headers.location ?? '';
    const rid = /#request=([A-Za-z0-9_-]{43})$/.exec(location)?.[1];
    if (started.status !== 302 || !rid) {
      throw new Error(`authorize failed: ${started.status} ${location}`);
    }
    const cookie = (started.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

    const auth = { Authorization: `Bearer ${world.person.token}` };
    const read = await request(api.getHttpServer()).get(`/api/v1/oauth/requests/${rid}`).set(auth);
    if (read.status !== 200) throw new Error(`consent read failed: ${read.status}`);
    const approved = await request(api.getHttpServer())
      .post(`/api/v1/oauth/requests/${rid}/approve`)
      .set(auth)
      .send({ agentId: world.agentId, name: CREDENTIAL_NAME });
    if (approved.status !== 200) {
      throw new Error(`approve failed: ${approved.status} ${JSON.stringify(approved.body)}`);
    }

    const resumed = await request(mcpApp.getHttpServer())
      .get(`/oauth/authorize/continue?request=${encodeURIComponent(rid)}`)
      .set('Cookie', cookie);
    const code = resumed.headers.location
      ? new URL(resumed.headers.location).searchParams.get('code')
      : null;
    if (!code) throw new Error(`continue failed: ${resumed.status}`);

    const exchanged = await request(mcpApp.getHttpServer())
      .post('/oauth/token')
      .set('X-Forwarded-For', newIp())
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: clientId,
        code_verifier: verifier,
      });
    if (exchanged.status !== 200) {
      throw new Error(`exchange failed: ${exchanged.status} ${JSON.stringify(exchanged.body)}`);
    }
    const [row] = (await dataSource.query(
      `SELECT "credential_id" FROM "oauth_access_tokens" WHERE "token_hash" = $1`,
      [digestToken(exchanged.body.access_token)],
    )) as { credential_id: string }[];
    return {
      id: row.credential_id,
      bearer: exchanged.body.access_token as string,
      refresh: exchanged.body.refresh_token as string,
      clientId,
    };
  }

  async function world(worldOptions: WorldOptions = {}): Promise<World> {
    const organizationId = worldOptions.organizationId ?? randomUUID();
    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Equivalence org', 'ACTIVE')`,
      [organizationId],
    );
    const personAgent = await insertAgent(organizationId, randomWallet(), 'person');
    const wallet = randomWallet();
    const agentId = await insertAgent(organizationId, wallet, 'research-bot');
    // The payer's escrow, opened by a deposit (the chain side is `FundedEscrows`).
    await dataSource.query(
      `INSERT INTO "buyer_escrows"
         ("organization_id", "account_id", "asset_id", "escrow_account_id",
          "escrow_asset_account_id", "next_seq", "opened_at")
       VALUES ($1, $2, $3, $4, $4, 1, now())`,
      [organizationId, wallet, USDG, ESCROW_CONTRACT],
    );
    // ...and its ledger mirror, which a paid call holds against.
    await mcpApp.get(LedgerJournalService, { strict: false }).appendNow({
      organizationId,
      accountId: wallet as unknown as LedgerAccountId,
      entryType: LedgerEntryType.DEPOSIT,
      money: MoneyUtil.of('100000000', USDG, 6),
    });
    const personToken = `person-${randomBytes(16).toString('hex')}`;
    persons.set(personToken, {
      credentialId: `user-${personAgent}`,
      organizationId,
      agentId: personAgent,
      agentAccount: randomWallet(),
      chainId: CHAIN,
      label: null,
      callerKind: McpCallerKind.HUMAN,
      paymentsAllowed: true,
    });
    const partial = {
      organizationId,
      agentId,
      wallet,
      person: { agentId: personAgent, token: personToken },
    } as World;
    const key = await keyFor(partial);
    const grant = await grantFor(partial, worldOptions);
    return { ...partial, key, grant };
  }

  /** The person's request on the API app, unwrapped from the platform envelope. */
  async function asPerson(
    world: World,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const call = request(api.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${world.person.token}`);
    const response = body === undefined ? await call : await call.send(body as object);
    return { status: response.status, body: response.body?.data ?? response.body };
  }

  async function toolsetFor(
    world: World,
    slug: string,
    visibility: 'PRIVATE' | 'PUBLIC' | 'UNLISTED',
    versions = 1,
  ): Promise<{ id: string; unlistedToken: string | null }> {
    const created = await asPerson(world, 'post', '/toolsets', { name: `Kit ${slug}`, slug });
    if (created.status !== 201) {
      throw new Error(`toolset create failed: ${created.status} ${JSON.stringify(created.body)}`);
    }
    const id = created.body.id as string;
    const entries = await asPerson(world, 'put', `/toolsets/${id}/entries`, {
      entries: Object.values(TOOLS).map((tool) => ({ toolId: tool.id })),
    });
    if (entries.status !== 200) {
      throw new Error(`toolset entries failed: ${entries.status} ${JSON.stringify(entries.body)}`);
    }
    let unlistedToken: string | null = null;
    for (let version = 0; version < versions; version += 1) {
      const published = await asPerson(world, 'post', `/toolsets/${id}/publish`, { visibility });
      if (published.status !== 200) {
        throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.body)}`);
      }
      const toolset = published.body.toolset as { unlistedToken?: string | null };
      unlistedToken = toolset.unlistedToken ?? unlistedToken;
    }
    return { id, unlistedToken };
  }

  async function claimHandle(world: World, handle: string): Promise<void> {
    const claimed = await asPerson(world, 'put', '/org/handle', { handle });
    if (claimed.status !== 200) {
      throw new Error(`handle claim failed: ${claimed.status} ${JSON.stringify(claimed.body)}`);
    }
  }

  /**
   * The seller side's shared URLs: the maker (the provider's own organization)
   * claims {@link MAKER_HANDLE}, lists its provider tool, and publishes a
   * PUBLIC toolset of the three tools twice (`kit`, `kit@1`) and an UNLISTED one.
   */
  async function publishMarket(): Promise<SharedUrls> {
    const maker = await world({ organizationId: PROVIDER_ID });
    await claimHandle(maker, MAKER_HANDLE);
    await dataSource.query(
      `UPDATE "tools"
          SET "kind" = 'PROVIDER', "owner_org_id" = $2, "visibility" = 'LISTED', "name" = $3,
              "review_status" = 'APPROVED', "approved_version" = "current_version",
              "reviewed_at" = now()
        WHERE "id" = $1`,
      [MAKER_TOOL.id, PROVIDER_ID, MAKER_TOOL.name],
    );
    for (const app of [mcpApp, api]) {
      await app
        .get<ToolContractChanges>(TOOL_CONTRACT_CHANGES, { strict: false })
        .contractsChanged();
    }
    const kit = await toolsetFor(maker, 'kit', 'PUBLIC', 2);
    const link = await toolsetFor(maker, 'link-kit', 'UNLISTED');
    knownIds.set(kit.id, '<toolset:kit>');
    knownIds.set(link.id, '<toolset:link-kit>');
    return { maker, handle: MAKER_HANDLE, unlistedToken: link.unlistedToken! };
  }

  async function pair(worldOptions: WorldOptions = {}): Promise<Record<Via, World>> {
    return { key: await world(worldOptions), grant: await world(worldOptions) };
  }

  async function close(): Promise<void> {
    // `app.close()` leaves the named DataSource and several ioredis clients
    // open (see `oauth-endpoints.integration.spec.ts`), so each is closed here.
    for (const app of [api, mcpApp]) {
      const appData = app.get<DataSource>(getDataSourceToken('postgres'), { strict: false });
      const clients = new Set<Redis>();
      for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.providers.values()) {
          if (wrapper.instance instanceof Redis) clients.add(wrapper.instance);
        }
      }
      // Each app listens (see boot): its idle keep-alive sockets would hold
      // the process open after `close()` (review M7).
      (app.getHttpServer() as Server).closeAllConnections();
      await app.close().catch(() => undefined);
      await appData?.destroy().catch(() => undefined);
      for (const client of clients) await quit(client);
    }
    await quit(redis);
    await dataSource.destroy();
    process.env = saved;
  }

  return {
    mcp: mcpApp,
    api,
    dataSource,
    redis,
    market,
    knownIds,
    world,
    pair,
    grantFor,
    keyFor,
    thirdPartyClientId,
    asPerson,
    toolsetFor,
    claimHandle,
    publishMarket,
    close,
  };
}
