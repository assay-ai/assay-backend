import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import type Redis from 'ioredis';

import { NotificationChannelRepository } from '@database/postgres/repositories/notification-channel.repository';
import { NotificationDeliveryRepository } from '@database/postgres/repositories/notification-delivery.repository';
import { NotificationPreferenceRepository } from '@database/postgres/repositories/notification-preference.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ALERT_PORT } from '@shared/alerting';
import { ProviderStakeGraceRepository } from '@database/postgres/repositories/provider-stake-grace.repository';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { EgressHttpClient } from '@shared/network/egress/egress-http.client';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { AccountBlockRepository } from '@database/postgres/repositories/account-block.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { EvmGasGrantRepository } from '@database/postgres/repositories/evm-gas-grant.repository';
import { BindingCredentialRepository } from '@database/postgres/repositories/binding-credential.repository';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolVersionRepository } from '@database/postgres/repositories/tool-version.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { CompositeMcpSessionSource } from '@modules/auth/services/composite-mcp-session.source';
import { DbCredentialMcpSessionSource } from '@modules/auth/services/db-credential-mcp-session.source';
import { OAuthAccessTokenMcpSessionSource } from '@modules/auth/services/oauth-access-token-mcp-session.source';
import { PrivyMcpSessionSource } from '@modules/auth/services/privy-mcp-session.source';
import { BlocklistSessionSource } from '@modules/blocklist/services/blocklist-session.source';
import { McpModule } from '@modules/mcp/mcp.module';
import { ConfigMcpSessionSource } from '@modules/mcp/services/config-mcp-session.source';
import { MCP_SESSION_SOURCE } from '@modules/mcp/ports/mcp-session.port';
import { McpCatalogueService } from '@modules/mcp/services/mcp-catalogue.service';
import { MCP_PRICING, McpPricingConfig } from '@modules/mcp/services/mcp-pricing.config';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import { McpToolCallService } from '@modules/mcp/services/mcp-tool-call.service';
import {
  KILL_SWITCH_REDIS,
  KILL_SWITCH_SUBSCRIBER,
} from '@modules/verification/services/redis-policy-kill-switch.service';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { PostgresModule } from '@database/postgres/postgres.module';
import { McpApiModule } from '@modules/mcp/mcp-api.module';
import { McpController } from '@modules/mcp/controllers/mcp.controller';
import {
  AgentServersController,
  McpUrlsController,
} from '@modules/mcp/controllers/mcp-urls.controller';
import { McpHttpModule } from '@modules/mcp/mcp-http.module';
import { McpUrlsApiModule } from '@modules/mcp/mcp-urls-api.module';
import { McpUrlPreviewService } from '@modules/mcp/services/mcp-url-preview.service';
import {
  AgentAccessController,
  CredentialAccessController,
} from '@modules/toolset/controllers/agent-access.controller';
import { RefusedCallsController } from '@modules/toolset/controllers/refused-calls.controller';
import { ToolsetsController } from '@modules/toolset/controllers/toolsets.controller';
import { ToolsetApiModule } from '@modules/toolset/toolset-api.module';
import { PublicDemoService } from '@modules/mcp/services/public-demo.service';
import { DEMO_RATE_REDIS } from '@modules/mcp/services/redis-demo-rate-limiter.service';
import { SIGNING_RATE_REDIS } from '@modules/verification/signing/signing.constants';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';

/**
 * `McpModule` resolves inside a real Nest container.
 *
 * The reason this is worth a test of its own is the module's shape: the MCP server is
 * the seam where four domains meet, and it reaches across all of them through
 * string tokens — `TOOL_CATALOGUE`, `MCP_SESSION_SOURCE`, `MCP_PRICING` —
 * which is exactly the arrangement TypeScript cannot check. A mistyped token
 * here is a failed boot of the service every agent calls.
 *
 * `PaymentModule` and `LedgerModule` bring TypeORM repositories with them, so
 * the graph is stubbed at the `DataSource` rather than connected: the claim
 * under test is that the tokens resolve, not that Postgres is reachable.
 *
 * The verification worker adds `VerificationModule`, which brings two live `ioredis` clients
 * for the policy kill switch (`KILL_SWITCH_REDIS` / `KILL_SWITCH_SUBSCRIBER`).
 * `RedisPolicyKillSwitchService.onModuleDestroy` stops its poll timer and
 * unsubscribes but does not close either connection — a live process never
 * needs to, and closing a client it does not own is not that service's call
 * to make. A short-lived `createApplicationContext` in a test has no such
 * long-lived process, so this closes both explicitly wherever they were
 * actually constructed; otherwise ioredis's reconnect loop keeps the Jest
 * worker alive long after every assertion here has already run.
 */
/**
 * The two repositories `ProviderModule` and `ToolModule` now reach for.
 *
 * The binding half of the catalogue lives on `tool_bindings`
 * (`DatabaseToolCatalogue`) and the provider registry on
 * `providers` (`DbProviderRegistry`), so the graph under test names two
 * classes that live in the `@Global` `PostgresModule` the composition root
 * supplies. Supplying them as stubs — globally, because a provider declared in
 * the harness is invisible to an imported module — keeps this file's claim
 * exactly what it always was: **the tokens resolve**. Whether Postgres is
 * reachable is a different test, and it is not a unit one.
 *
 * Notifications add a fourth: `PaymentModule` and `LedgerModule` now both import
 * `NotificationModule` directly (`DepositFinalityService` and
 * `LedgerJournalService` are real `NOTIFICATION_PORT` producers), so this
 * graph now also names `NotificationService`'s own four repositories and the
 * shared cache client its suppression check reads. Same stub, same claim —
 * `NotificationModule` itself still runs its real `BullModule.registerQueue`,
 * exactly as `VerificationModule`'s `verification.judge` queue already does in
 * this file without a live connection.
 *
 * SLA windows add a fifth: `VerificationModule` now imports
 * `SlaWindowModule` for `SLA_WINDOW_POSTER`, which needs `SlaWindowRepository`
 * / `SlaWindowCallRepository` / `SlaStrikeRepository` alongside the
 * `ToolBindingRepository` already stubbed here. Same claim, same stub — only
 * `postCall`'s DI wiring is under test, not what it does with a database.
 *
 * Escrow spend gating adds a sixth, and in doing so surfaces a gap this file already had.
 * `LedgerModule` now also imports `ChainsModule` (`EscrowSpendGateService`
 * needs `ESCROW_BALANCE_READER`), which reorders roughly when `LedgerModule`'s
 * own providers are resolved relative to everything else in the graph.
 * `LedgerJournalService` needs `LedgerEntryRepository` / `AccountBalanceRepository`
 * and `EscrowSpendGateService` needs `LedgerHoldRepository` — **none of which
 * were ever stubbed here**. Before that this was invisible: whichever
 * unstubbed dependency Nest happened to resolve first threw a message that
 * happened to contain the substring `DataSource` (`LedgerJournalService`'s own
 * unresolved `postgresDataSource` argument), which satisfied the tolerance
 * regex below by accident and made the test read as "only a connectivity
 * failure". The reordering changed *which* unstubbed dependency is hit first —
 * `SlaWindowModule → SlashOpenerModule`'s `SlashProposalRepository` /
 * `SlashProposalEventRepository`, whose error message contains no such
 * substring — and stopped the accident from hiding the gap. All five
 * repositories are stubbed now, on the same claim as everything above: the
 * tokens resolve. This is not new reachability; `SlashOpenerModule` was always
 * one `VerificationModule → SlaWindowModule` hop from this graph.
 */
@Global()
@Module({
  providers: [
    { provide: ToolBindingRepository, useValue: { findByTool: async () => [] } },
    // `ToolRegistrySeeder` mirrors the seeded tools into `tools` at boot.
    {
      provide: ToolRepository,
      useValue: { upsertSeeded: async () => undefined, find: async () => [] },
    },
    // `DatabaseToolContracts` reads the contracts from `tool_versions` (T3).
    { provide: ToolVersionRepository, useValue: { find: async () => [] } },
    // `DatabaseToolCatalogue` reads published revisions from `binding_versions`.
    { provide: BindingCredentialRepository, useValue: { findForOrigin: async () => null } },
    { provide: BindingVersionRepository, useValue: { find: async () => [] } },
    // `ChainsModule` imports `EvmModule`, whose `EvmGasGrantService`
    // writes the EVM gas-grant ledger. Another `@Global` `PostgresModule` repository,
    // stubbed on the same terms as the four above.
    {
      provide: EvmGasGrantRepository,
      useValue: { hasGranted: async () => false, grantedWeiSince: async () => 0n },
    },
    {
      provide: EvmChainStateRepository,
      useValue: { findAllStates: async () => [], findBlocked: async () => [] },
    },
    { provide: ProviderRepository, useValue: { find: async () => [] } },
    // `BlocklistModule`, imported by `ProviderModule` and `PaymentModule`.
    { provide: AccountBlockRepository, useValue: { findActive: async () => [] } },
    { provide: PaymentIntentRepository, useValue: { countCallsByBinding: async () => 0 } },
    { provide: ProviderStakeGraceRepository, useValue: { find: async () => [] } },
    // `DbChainEnrolmentSource`'s repository. Nothing in this graph
    // consumes `CHAIN_ENROLMENT_SOURCE` yet, but `ProviderModule` constructs
    // the source, so the token has to resolve.
    { provide: ProviderChainEnrolmentRepository, useValue: { findByProviders: async () => [] } },
    // `DbChainEnrolmentSource` pages through `ALERT_PORT` when a row
    // is unreadable, because dropping one silently removes a provider from the
    // market. `AlertingModule` is `@Global` and supplied by every bootstrap
    // module; this harness supplies it the same way it supplies the other
    // globals.
    { provide: ALERT_PORT, useValue: { emit: async () => undefined } },
    {
      provide: CacheService,
      useValue: { get: async () => null, set: async () => undefined, del: async () => undefined },
    },
    { provide: NotificationRepository, useValue: { insert: async () => undefined } },
    { provide: NotificationChannelRepository, useValue: { findForOrganization: async () => [] } },
    { provide: NotificationPreferenceRepository, useValue: { findForEvent: async () => [] } },
    { provide: NotificationDeliveryRepository, useValue: { insert: async () => undefined } },
    {
      provide: REDIS_CACHE_CLIENT,
      useValue: { set: async () => 'OK' },
    },
    { provide: SlaWindowRepository, useValue: {} },
    // `McpModule` now imports `AuthModule`, whose Privy source reads
    // `agents` and fetches JWKS. This spec builds the graph without
    // `PostgresModule`/`NetworkModule`, so both need a stub here — the point of
    // the test is that the wiring RESOLVES, not that it talks to anything.
    { provide: AgentRepository, useValue: {} },
    // `AuthModule` also exports `DbCredentialMcpSessionSource`, which
    // reads `agent_credentials` directly — same stub-the-boundary reasoning
    // as `AgentRepository` above.
    { provide: AgentCredentialRepository, useValue: {} },
    // `AuthModule`'s OAuth access-token source reads both.
    { provide: OAuthAccessTokenRepository, useValue: {} },
    { provide: OAuthClientRepository, useValue: {} },
    { provide: EgressHttpClient, useValue: {} },
    { provide: SlaWindowCallRepository, useValue: {} },
    { provide: SlaStrikeRepository, useValue: {} },
    // `LedgerModule`'s own providers, unstubbed until now — see the
    // class comment for how that stayed invisible.
    { provide: LedgerEntryRepository, useValue: {} },
    { provide: AccountBalanceRepository, useValue: {} },
    { provide: LedgerHoldRepository, useValue: { sumOpenByAccount: async () => 0n } },
    // Reachable via `VerificationModule → SlaWindowModule → SlashOpenerModule`
    // since SLA windows landed — always unstubbed, never hit before the reorder.
    { provide: SlashProposalRepository, useValue: {} },
    { provide: SlashProposalEventRepository, useValue: {} },
  ],
  exports: [
    ToolBindingRepository,
    ToolRepository,
    ToolVersionRepository,
    BindingVersionRepository,
    BindingCredentialRepository,
    EvmGasGrantRepository,
    EvmChainStateRepository,
    ProviderRepository,
    AccountBlockRepository,
    PaymentIntentRepository,
    ProviderStakeGraceRepository,
    ProviderChainEnrolmentRepository,
    ALERT_PORT,
    CacheService,
    NotificationRepository,
    NotificationChannelRepository,
    NotificationPreferenceRepository,
    NotificationDeliveryRepository,
    REDIS_CACHE_CLIENT,
    SlaWindowRepository,
    AgentRepository,
    AgentCredentialRepository,
    OAuthAccessTokenRepository,
    OAuthClientRepository,
    EgressHttpClient,
    SlaWindowCallRepository,
    SlaStrikeRepository,
    LedgerEntryRepository,
    AccountBalanceRepository,
    LedgerHoldRepository,
    SlashProposalRepository,
    SlashProposalEventRepository,
  ],
})
class StubRepositoriesModule {}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    StubRepositoriesModule,
    McpModule,
  ],
})
class McpWiringHarnessModule {}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    StubRepositoriesModule,
    McpApiModule,
  ],
})
class McpApiWiringHarnessModule {}

describe('McpModule wiring', () => {
  jest.setTimeout(30_000);

  it('resolves the server factory and everything it composes', async () => {
    const app = await NestFactory.createApplicationContext(McpWiringHarnessModule, {
      logger: false,
      // Otherwise a Nest initialisation error calls `process.exit(1)` and kills
      // the Jest worker instead of failing the test.
      abortOnError: false,
    }).catch((error: unknown) => error as Error);

    // Postgres or Redis being unreachable from wherever the unit suite runs is
    // tolerated — `PaymentModule` opens a Postgres connection at boot and
    // `VerificationModule` opens two Redis connections for the kill switch. A
    // DI failure and an infrastructure failure are different things, and only
    // the first one is this test's business.
    if (app instanceof Error) {
      expect(app.message).toMatch(/connect|ECONNREFUSED|DataSource|getaddrinfo/i);
      return;
    }

    // Resolved before `close()` — once the container is torn down, `app.get`
    // can no longer resolve anything, so the references have to be taken
    // while it is still alive.
    const killSwitchRedis = app.get<Redis>(KILL_SWITCH_REDIS);
    const killSwitchSubscriber = app.get<Redis>(KILL_SWITCH_SUBSCRIBER);
    const signingRateRedis = app.get<Redis>(SIGNING_RATE_REDIS, { strict: false });

    try {
      expect(app.get(McpServerFactory)).toBeInstanceOf(McpServerFactory);
      expect(app.get(McpCatalogueService)).toBeInstanceOf(McpCatalogueService);
      expect(app.get(McpToolCallService)).toBeInstanceOf(McpToolCallService);
      expect(app.get(MCP_SESSION_SOURCE)).toBeDefined();

      const pricing = app.get<McpPricingConfig>(MCP_PRICING);
      expect(pricing.platformFeeBps).toBeGreaterThan(0);
      expect(pricing.platformFeeBps).toBeLessThanOrEqual(10_000);
    } finally {
      // `app.close()` first, while both clients are still live, so
      // `RedisPolicyKillSwitchService.onModuleDestroy`'s `unsubscribe` call
      // has a connection to run against — issuing it against an
      // already-`quit()` client just queues behind ioredis's own reconnect
      // attempt and is the actual hang this replaces. Only after that does
      // this close the two connections the service itself never does (see
      // the class comment).
      await app.close().catch(() => undefined);
      await Promise.allSettled([
        killSwitchRedis.quit(),
        killSwitchSubscriber.quit(),
        signingRateRedis.quit(),
      ]);
    }
  });
});

/**
 * `McpApiModule` is the public-demo half, and until this test it had no wiring
 * cover at all — `McpModule` above did. That gap is how `PublicDemoService`
 * came to inject `ENABLED_CHAINS` from a module that imports neither
 * `EnabledChainsModule` nor anything re-exporting the token: every unit test
 * passed, and `SERVICE_TYPE=api` refused to boot with
 *
 *   Nest can't resolve dependencies of the PublicDemoService (..., ?).
 *   Please make sure that the argument "ENABLED_CHAINS" at index [6] is
 *   available in the McpApiModule context.
 *
 * A DI edge is only ever proved by building the container.
 */
/** Every repository `PostgresModule` exports, and its `DataSource`, as inert stubs. */
const POSTGRES_REPOSITORIES = (Reflect.getMetadata('exports', PostgresModule) as unknown[]).filter(
  (token): token is new (...args: never[]) => unknown =>
    typeof token === 'function' && token !== TypeOrmModule,
);

@Global()
@Module({
  providers: [
    ...POSTGRES_REPOSITORIES.map((token) => ({ provide: token, useValue: {} })),
    { provide: getDataSourceToken('postgres'), useValue: {} },
  ],
  exports: [...POSTGRES_REPOSITORIES, getDataSourceToken('postgres')],
})
class StubPostgresModule {}

describe('McpApiModule wiring', () => {
  jest.setTimeout(30_000);

  // Unset, each of these refuses at boot and the test would pass on that
  // refusal without resolving anything.
  const BOOT_ENV: Readonly<Record<string, string>> = {
    ENABLED_CHAINS: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    DEMO_MCP_TOKEN: 'mcp_wiring_demo_token',
    DEMO_ORGANIZATION_ID: '00000000-0000-4000-8000-000000000001',
  };
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(BOOT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves PublicDemoService, including the ENABLED_CHAINS it injects', async () => {
    // `McpApiModule` imports `PostgresModule`, whose `TypeOrmModule.forRootAsync`
    // connects at boot and retries for ~30 s. Under a harness with no database
    // config that retry outlived the test, and on a machine with a Postgres on
    // :5432 its lazy `require('pgpass')` ran after Jest had torn the module
    // registry down — `TypeError: pgPass is not a function`, reported against
    // whichever suite happened to be running. Swapped for stubs of every
    // repository it exports: the claim is that the tokens resolve.
    // Strict: any compile error fails the test, DI or not. A tolerant branch
    // here once let this test pass without resolving anything.
    const app = await Test.createTestingModule({ imports: [McpApiWiringHarnessModule] })
      .overrideModule(PostgresModule)
      .useModule(StubPostgresModule)
      // `QuoteIndexInvalidationSubscriber` registers itself on the DataSource.
      .overrideProvider(getDataSourceToken('postgres'))
      .useValue({ subscribers: [] })
      .compile();

    const killSwitchRedis = app.get<Redis>(KILL_SWITCH_REDIS);
    const killSwitchSubscriber = app.get<Redis>(KILL_SWITCH_SUBSCRIBER);

    try {
      expect(app.get(PublicDemoService)).toBeInstanceOf(PublicDemoService);
      expect(app.get<readonly ChainId[]>(ENABLED_CHAINS).length).toBeGreaterThan(0);
    } finally {
      // Compiled, never initialised: the clients were constructed but no
      // lifecycle hook ran, so they are dropped rather than asked to unsubscribe.
      // Every ioredis client the graph builds, or its reconnect loop keeps the
      // Jest worker alive after the last assertion.
      killSwitchRedis.disconnect();
      killSwitchSubscriber.disconnect();
      for (const token of [SIGNING_RATE_REDIS, DEMO_RATE_REDIS]) {
        try {
          app.get<Redis>(token, { strict: false }).disconnect();
        } catch {
          // Not part of this graph.
        }
      }
      await app.close().catch(() => undefined);
    }
  });
});

/**
 * The toolset routes on the API host, the Connect preview, and the MCP host
 * itself — each built as a container, because a DI edge is only ever proved
 * that way (the preview once asked for `TOOL_CATALOGUE` from a module that did
 * not import it, and every unit test passed).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    StubRepositoriesModule,
    StubPostgresModule,
    ToolsetApiModule,
    McpUrlsApiModule,
    McpHttpModule,
  ],
})
class ToolsetWiringHarnessModule {}

describe('toolset, Connect preview and MCP host wiring', () => {
  jest.setTimeout(30_000);

  const BOOT_ENV: Readonly<Record<string, string>> = {
    ENABLED_CHAINS: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  };
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(BOOT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves the controllers and every service behind them', async () => {
    const app = await Test.createTestingModule({ imports: [ToolsetWiringHarnessModule] })
      .overrideModule(PostgresModule)
      .useModule(StubPostgresModule)
      .overrideProvider(getDataSourceToken('postgres'))
      .useValue({ subscribers: [] })
      .compile();

    try {
      for (const token of [
        ToolsetsController,
        AgentAccessController,
        CredentialAccessController,
        RefusedCallsController,
        McpUrlsController,
        AgentServersController,
        McpController,
        McpUrlPreviewService,
      ]) {
        expect(app.get(token, { strict: false })).toBeInstanceOf(token);
      }
    } finally {
      for (const token of [KILL_SWITCH_REDIS, KILL_SWITCH_SUBSCRIBER, SIGNING_RATE_REDIS]) {
        try {
          app.get<Redis>(token, { strict: false }).disconnect();
        } catch {
          // Not part of this graph.
        }
      }
      await app.close().catch(() => undefined);
    }
  });
});

/**
 * `MCP_SESSION_SOURCE` with `AUTH_SESSION_SOURCE=both`: the blocklist still
 * wraps the whole chain, and the chain is config, API keys, OAuth access
 * tokens, then Privy (spec §6.4 item 3). A blocked caller is refused whichever
 * source recognised it, OAuth included.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => ({ auth: { sessionSource: 'both' } })],
    }),
    StubRepositoriesModule,
    StubPostgresModule,
    McpModule,
  ],
})
class SessionSourceWiringHarnessModule {}

describe('MCP_SESSION_SOURCE wiring (AUTH_SESSION_SOURCE=both)', () => {
  jest.setTimeout(30_000);

  const BOOT_ENV: Readonly<Record<string, string>> = {
    ENABLED_CHAINS: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  };
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(BOOT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the blocklist still wraps the composite: config, db, oauth, privy', async () => {
    const app = await Test.createTestingModule({ imports: [SessionSourceWiringHarnessModule] })
      .overrideModule(PostgresModule)
      .useModule(StubPostgresModule)
      // `QuoteIndexInvalidationSubscriber` registers itself on the DataSource.
      .overrideProvider(getDataSourceToken('postgres'))
      .useValue({ subscribers: [] })
      .compile();

    try {
      const source = app.get(MCP_SESSION_SOURCE);
      expect(source).toBeInstanceOf(BlocklistSessionSource);

      const inner = (source as unknown as { inner: unknown }).inner;
      expect(inner).toBeInstanceOf(CompositeMcpSessionSource);

      const sources = (inner as unknown as { sources: readonly unknown[] }).sources;
      expect(sources.map((each) => (each as object).constructor)).toEqual([
        ConfigMcpSessionSource,
        DbCredentialMcpSessionSource,
        OAuthAccessTokenMcpSessionSource,
        PrivyMcpSessionSource,
      ]);
      // The same instance `AuthModule` exports, not a second one.
      expect(sources[2]).toBe(app.get(OAuthAccessTokenMcpSessionSource, { strict: false }));
    } finally {
      for (const token of [KILL_SWITCH_REDIS, KILL_SWITCH_SUBSCRIBER, SIGNING_RATE_REDIS]) {
        try {
          app.get<Redis>(token, { strict: false }).disconnect();
        } catch {
          // Not part of this graph.
        }
      }
      await app.close().catch(() => undefined);
    }
  });
});
