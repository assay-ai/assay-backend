import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { CHAIN_IDS, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { PROVIDER_REGISTRY } from '@modules/provider/ports/provider-registry.port';
import { PROVIDER_STAKE_SOURCE } from '@modules/provider/ports/provider-stake.port';
import { CHAIN_ENROLMENT_SOURCE } from '@modules/provider/ports/chain-enrolment.port';
import { STAKE_GRACE_SOURCE } from '@modules/provider/ports/stake-grace.port';

import { ROUTING_CONTEXT } from './helpers/routing-fixtures';
import { DbChainEnrolmentSource } from '@modules/provider/services/db-chain-enrolment.source';
import { BINDING_INVOKER } from '@modules/tool/ports/binding-invoker.port';
import { TOOL_CATALOGUE } from '@modules/tool/ports/tool-catalogue.port';
import { BindingCallCounterService } from '@modules/tool/services/binding-call-counter.service';
import { BindingCeilingService } from '@modules/tool/services/binding-ceiling.service';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';
import { ROUTER_CONFIG, ROUTING_RANDOM, RouterConfig } from '@modules/tool/services/routing.config';
import { ToolModule } from '@modules/tool/tool.module';
import { AccountBlockRepository } from '@database/postgres/repositories/account-block.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ALERT_PORT } from '@shared/alerting';
import { ProviderStakeGraceRepository } from '@database/postgres/repositories/provider-stake-grace.repository';
import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { EvmGasGrantRepository } from '@database/postgres/repositories/evm-gas-grant.repository';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolVersionRepository } from '@database/postgres/repositories/tool-version.repository';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

/**
 * `ToolModule` resolves inside a real Nest container.
 *
 * `AppApiModule` already imports `ToolModule` and `ProviderModule`, so with
 * the router in place a mistyped DI token is no longer a dormant bug in an empty
 * module — it is a failed boot of the API. The router has seven injected
 * dependencies across two modules and every one of them is a string token,
 * which is exactly the arrangement TypeScript cannot check.
 *
 * Nothing here needs Postgres or Redis: the module's graph is `ConfigModule`,
 * `NetworkModule`, `ProviderModule` and `ChainsModule`, which
 * is why this can live in the unit suite and run on every commit. Nothing in
 * that graph opens a socket at boot: the Solana RPC client is lazy and the
 * facilitator adapter only dials when called. The repositories and the cache
 * the graph reaches for are stubbed below rather than connected,
 * for the same reason.
 *
 * The stake source is asserted **through `PROVIDER_STAKE_SOURCE`, never as a
 * class**, and that is deliberate rather than incidental. The class behind that
 * token was replaced once — `ConfigProviderStakeSource` became
 * `CompositeProviderStakeSource` — and this file did not have to say so,
 * because the router does not know either name. A test that named the class
 * would have failed on a change the router could not see, which is the opposite
 * of what it is for.
 */
/**
 * The repositories and the cache that `ProviderModule` and `ToolModule` now
 * reach for.
 *
 * The binding half of the catalogue lives on `tool_bindings`
 * (`DatabaseToolCatalogue`) and the provider registry on
 * `providers` (`DbProviderRegistry`), so the graph under test names two
 * classes that live in the `@Global` `PostgresModule` the composition root
 * supplies. A third is of the same kind: `OnChainProviderStakeSource`
 * caches chain readings through `CacheService`, which reaches this graph from
 * the `@Global` `RedisCacheModule` — imported by every bootstrap module and by
 * no domain module, the arrangement `PaymentModule` already relies on.
 *
 * Supplying all three as stubs — globally, because a provider declared in the
 * harness is invisible to an imported module — keeps this file's claim exactly
 * what it always was: **the tokens resolve**. Whether Postgres or Redis is
 * reachable is a different test, and it is not a unit one.
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
    { provide: BindingVersionRepository, useValue: { find: async () => [] } },
    // `ChainsModule` imports `EvmModule`, whose `EvmGasGrantService`
    // writes the gas-grant ledger. Another `@Global` `PostgresModule` repository,
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
    // `DbStakeGraceSource` reads the open grace rows behind
    // `STAKE_GRACE_SOURCE`, so the router's graph now names a fourth
    // `@Global` `PostgresModule` class. Same stub, same claim.
    { provide: ProviderStakeGraceRepository, useValue: { find: async () => [] } },
    // `DbChainEnrolmentSource` reads `provider_chain_enrolments` behind
    // `CHAIN_ENROLMENT_SOURCE`. `ProviderModule` instantiates the source, so the
    // repository has to resolve — which is what this file is for, and it is how
    // the omission was caught.
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
    // `BindingCallCounterService` counts a binding's calls in
    // Redis and rebuilds that counter from `payment_intents`, so the graph
    // names a fifth `@Global` class and, for the first time here, the shared
    // cache *client* rather than `CacheService` — the counter runs `INCR`,
    // which the JSON-serialising wrapper does not expose.
    { provide: PaymentIntentRepository, useValue: { countCallsByBinding: async () => 0 } },
    // `BindingAttemptRecorder` appends every attempt the provider is
    // accountable for to `binding_attempts`, the observed stats' raw window.
    { provide: BindingAttemptRepository, useValue: { appendMany: async () => undefined } },
    {
      provide: REDIS_CACHE_CLIENT,
      useValue: {
        get: async () => null,
        exists: async () => 0,
        incr: async () => 1,
        set: async () => 'OK',
      },
    },
  ],
  exports: [
    ToolBindingRepository,
    ToolRepository,
    ToolVersionRepository,
    BindingVersionRepository,
    EvmGasGrantRepository,
    EvmChainStateRepository,
    ProviderRepository,
    AccountBlockRepository,
    ProviderStakeGraceRepository,
    ProviderChainEnrolmentRepository,
    ALERT_PORT,
    CacheService,
    PaymentIntentRepository,
    BindingAttemptRepository,
    REDIS_CACHE_CLIENT,
  ],
})
class StubRepositoriesModule {}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    StubRepositoriesModule,
    ToolModule,
  ],
})
class ToolWiringHarnessModule {}

describe('ToolModule wiring', () => {
  jest.setTimeout(30_000);

  // Hermetic: the module refuses to boot without ENABLED_CHAINS, and a fresh
  // clone has no `.env` to supply it. Tests that need a different value set and
  // restore it themselves.
  let ambientEnabledChains: string | undefined;
  beforeEach(() => {
    ambientEnabledChains = process.env.ENABLED_CHAINS;
    process.env.ENABLED_CHAINS ??= CHAIN_IDS.SOLANA_DEVNET;
  });
  afterEach(() => {
    if (ambientEnabledChains === undefined) delete process.env.ENABLED_CHAINS;
    else process.env.ENABLED_CHAINS = ambientEnabledChains;
  });

  it('resolves the router and every port it routes through', async () => {
    const app = await NestFactory.createApplicationContext(ToolWiringHarnessModule, {
      logger: false,
      // Otherwise a Nest initialisation error calls `process.exit(1)` and kills
      // the Jest worker instead of failing the test.
      abortOnError: false,
    });

    try {
      expect(app.get(ProviderRouterService)).toBeInstanceOf(ProviderRouterService);
      expect(app.get(TOOL_CATALOGUE)).toBeDefined();
      expect(app.get(PROVIDER_REGISTRY, { strict: false })).toBeDefined();
      expect(app.get(PROVIDER_STAKE_SOURCE, { strict: false })).toBeDefined();
      expect(app.get(STAKE_GRACE_SOURCE, { strict: false })).toBeDefined();
      // Asserted as the CLASS, unlike `PROVIDER_STAKE_SOURCE` above,
      // and the difference is deliberate: the stake source has two
      // implementations and the router must not know which one it got, whereas
      // an enrolment is a row we wrote and there is no config stand-in for it —
      // the same reason `STAKE_GRACE_SOURCE` has none. Binding
      // `{ provide: CHAIN_ENROLMENT_SOURCE, useValue: { enrolmentsOf: async () => new Map() } }`
      // passed the whole unit suite, so `toBeDefined()` here would only prove
      // that a literal returning an empty map is bound. This line is what says
      // the binding reaches the database.
      expect(app.get(CHAIN_ENROLMENT_SOURCE, { strict: false })).toBeInstanceOf(
        DbChainEnrolmentSource,
      );
      expect(app.get(BINDING_INVOKER)).toBeInstanceOf(EgressBindingInvoker);
      expect(typeof app.get(ROUTING_RANDOM)).toBe('function');
      // Exported, because the increment belongs to whoever writes
      // `payment_intents.binding_id` — the MCP loop — and not to the router.
      expect(app.get(BindingCallCounterService)).toBeInstanceOf(BindingCallCounterService);
      // The declared-ceiling shed. Asserted here because a service registered in
      // a module nobody can instantiate is a boot
      // failure discovered on deploy rather than in this file.
      expect(app.get(BindingCeilingService)).toBeInstanceOf(BindingCeilingService);

      const config = app.get<RouterConfig>(ROUTER_CONFIG);
      // The economic parameters, arriving through configuration rather than as
      // constants: `max($50, 1000 × price)`. Keyed per chain, under the chain
      // the floor's own asset names.
      //
      // **The keying half of this loop is currently unreachable, and that is
      // recorded rather than removed.** The factory writes
      // `new Map([[chainIdOf(floor.asset), parameters]])` and then refuses to
      // boot unless every enabled chain is a key, so
      // `chainIdOf(parameters.floor.asset) === chainId` is a tautology for
      // every chain this loop can visit — the boot throw has already rejected
      // the cases where it would not hold (proved: mis-keying the map fires
      // that throw, not this assertion). The `50000000` / `1000` assertions are
      // real and pin the numbers.
      //
      // It becomes reachable the day `minimumStakeByChain` can hold TWO
      // entries, which needs the per-chain floor surface
      // `loadMinimumStakeParameters` does not have — the same piece of work as
      // the unsatisfiable-for-two-chains boot assertion. At that point this is
      // the natural home for "each key carries a floor denominated on its own
      // chain", so it is kept as the statement of the map's shape.
      const enabled = app.get<readonly ChainId[]>(ENABLED_CHAINS);
      expect(enabled.length).toBeGreaterThan(0);
      for (const chainId of enabled) {
        const parameters = config.minimumStakeByChain.get(chainId);
        expect(parameters).toBeDefined();
        expect(parameters?.floor.amount).toBe('50000000');
        expect(parameters?.priceMultiple).toBe(1000);
        expect(chainIdOf(parameters!.floor.asset)).toBe(chainId);
      }
      expect(config.maxProviderShare).toBe(0.6);
      expect(config.maxAttempts).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  /**
   * A chain this deployment offers with no stake floor is a
   * **boot** failure, not a routing verdict.
   *
   * Discovering it per call would surface as `STAKE_UNKNOWN` on every paid
   * binding of that chain, which reads as an RPC outage: an operator would go
   * and check the chain rather than the environment, and the platform would
   * meanwhile be serving a chain it cannot price collateral for. So the
   * `ROUTER_CONFIG` factory throws where somebody is looking.
   *
   * **This case changed with two-chain support, and the change is the point.** It
   * used to enable devnet AND mainnet and expect the boot to fail, because
   * `loadMinimumStakeByChain` keyed one `PLATFORM_STAKE_ASSET_ID` under one
   * chain and no value of it covered two — the assertion was unsatisfiable by
   * construction, and it was the thing standing in front of the second chain.
   * The floor is now derived per chain from `chain-metadata.ts`'s own
   * `settlementAsset`, so two chains boot (asserted below), and what remains
   * refusable is a `PLATFORM_STAKE_ASSET_ID` that names no enabled chain — a
   * stale value that silently agrees with nothing.
   */
  it('refuses to boot when PLATFORM_STAKE_ASSET_ID names no enabled chain', async () => {
    const previous = process.env.ENABLED_CHAINS;
    const previousAsset = process.env.PLATFORM_STAKE_ASSET_ID;
    process.env.ENABLED_CHAINS = CHAIN_IDS.SOLANA_DEVNET;
    process.env.PLATFORM_STAKE_ASSET_ID = ASSET_IDS.USDC_SOLANA_MAINNET;

    try {
      await expect(
        NestFactory.createApplicationContext(ToolWiringHarnessModule, {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toMatchObject({ errorCode: 'PROVIDER_MINIMUM_STAKE_UNCONFIGURED' });
    } finally {
      if (previous === undefined) delete process.env.ENABLED_CHAINS;
      else process.env.ENABLED_CHAINS = previous;
      if (previousAsset === undefined) delete process.env.PLATFORM_STAKE_ASSET_ID;
      else process.env.PLATFORM_STAKE_ASSET_ID = previousAsset;
    }
  });

  it('BOOTS with two chains, each with its own floor in its own asset', async () => {
    // The two-chain fix, through a real container: the assertion above is the
    // one the single-chain floor could not satisfy, and this is what satisfying
    // it looks like.
    const previous = process.env.ENABLED_CHAINS;
    process.env.ENABLED_CHAINS = `${CHAIN_IDS.SOLANA_DEVNET},${CHAIN_IDS.SOLANA_MAINNET}`;

    const app = await NestFactory.createApplicationContext(ToolWiringHarnessModule, {
      logger: false,
      abortOnError: false,
    });

    try {
      const config = app.get<RouterConfig>(ROUTER_CONFIG);

      expect([...config.minimumStakeByChain.keys()].sort()).toEqual(
        [CHAIN_IDS.SOLANA_DEVNET, CHAIN_IDS.SOLANA_MAINNET].sort(),
      );
      // Each floor names its own chain — the invariant `eligibility.ts` reads
      // back when it resolves a floor for the chain a call settles on.
      for (const [chainId, parameters] of config.minimumStakeByChain) {
        expect(chainIdOf(parameters.floor.asset)).toBe(chainId);
      }
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.ENABLED_CHAINS;
      else process.env.ENABLED_CHAINS = previous;
    }
  });

  it('refuses every call while no provider is registered', async () => {
    const app = await NestFactory.createApplicationContext(ToolWiringHarnessModule, {
      logger: false,
      abortOnError: false,
    });

    try {
      const router = app.get(ProviderRouterService);

      // The catalogue and the registry both ship empty. A platform with no
      // providers must say so, not route to one it knows nothing about.
      await expect(
        router.route({
          toolId: 'search_web',
          callId: 'test-call-id',
          input: {},
          context: ROUTING_CONTEXT,
        }),
      ).rejects.toMatchObject({
        errorCode: 'TOOL_NOT_FOUND',
      });
    } finally {
      await app.close();
    }
  });
});
