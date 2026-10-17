import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChainsModule } from '@modules/chains/chains.module';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import { ProviderModule } from '@modules/provider/provider.module';
import { loadMinimumStakeByChain } from '@modules/provider/services/provider-stake.service';
import { NetworkModule } from '@shared/network/network.module';

import { BINDING_INVOKER } from './ports/binding-invoker.port';
import { BindingAttemptRecorder } from './services/binding-attempt-recorder.service';
import { BindingCallCounterService } from './services/binding-call-counter.service';
import { BindingCeilingService } from './services/binding-ceiling.service';
import { loadToolCatalogue } from './services/catalogue-seed';
import { TOOL_CATALOGUE } from './ports/tool-catalogue.port';
import { DatabaseToolCatalogue } from './services/database-tool-catalogue';
import {
  DatabaseToolContracts,
  ToolContractChangesService,
} from './services/database-tool-contracts';
import { TOOL_CONTRACT_CHANGES, TOOL_CONTRACTS } from './ports/tool-contracts.port';
import { EgressBindingInvoker } from './services/egress-binding.invoker';
import {
  InMemoryToolCatalogue,
  TOOL_CATALOGUE_SNAPSHOT,
} from './services/in-memory-tool-catalogue';
import { ProviderRouterService } from './services/provider-router.service';
import { QuoteIndexService } from './services/quote-index.service';
import { QuoteIndexInvalidationSubscriber } from './services/quote-index-invalidation.subscriber';
import { ToolRegistrySeeder } from './services/tool-registry.seeder';
import {
  DEFAULT_ROUTER_TUNING,
  ROUTER_CONFIG,
  ROUTING_RANDOM,
  cryptoRandom,
  RouterConfig,
} from './services/routing.config';

/**
 * Tool domain — the catalogue, bindings and the call path.
 *
 * Scope: tools, bindings and the request/response mapping engine; the router with timeout,
 * failover and the `stake >= minimumStake` gate; the three-class response classifier.
 *
 * The mapping engine and the classifier are pure — `domain/mapping/` and
 * `domain/classification/` read no clock, open no socket and touch no database, which is what
 * lets a provider test a mapping against a saved response before publishing it (the mapping
 * tester) and lets a disputed call be re-classified from its receipt months later. The router
 * keeps that split rather than dissolving it:
 * `domain/routing/` is equally pure and holds the entire decision, and the two
 * classes in `services/` are the only things here that do I/O.
 *
 * ```text
 * ProviderRouterService   select → reserve → attempt → classify → fail over
 *   └── TOOL_CATALOGUE          which bindings exist       (tools seeded, bindings in Postgres)
 *   └── PROVIDER_REGISTRY       status, tier, stats
 *   └── PROVIDER_STAKE_SOURCE   stake
 *   └── STAKE_GRACE_SOURCE      an open grace row          (`provider_stake_grace`)
 *   └── BindingCallCounterService  lifetime calls per binding  → the exploration floor
 *   └── BindingCeilingService      declared ceilings           → shed, and spend the token
 *   └── BindingAttemptRecorder     every attempt it is owed    → `binding_attempts` → stats
 *   └── BINDING_INVOKER         the actual HTTP call
 * ```
 *
 * The router is what the MCP server calls, so it could not wait for the
 * tables. Each source is behind a port the router does not look past — which
 * is what let the binding editor move the binding half of the catalogue onto
 * `tool_bindings` by changing one `useExisting` here, with no edit to the
 * router and none to its tests.
 *
 * See `docs/mapping-format.md` for the format providers write in the binding editor, and
 * `errors/tool.errors.ts` for the catalog.
 */
@Module({
  // `EgressBindingInvoker` dials provider endpoints — URLs typed by strangers,
  // since provider registration is open, with no approval. `NetworkModule` is
  // `@Global`, but it is imported here so this module's graph stands on its own.
  // `ChainsModule` is imported for `ENABLED_CHAINS` alone: the `ROUTER_CONFIG`
  // factory asserts at boot that every chain this deployment offers has a stake
  // floor. `ProviderModule` already imports it, but does not re-export
  // it — and a module imports what it uses.
  imports: [ChainsModule, NetworkModule, ProviderModule],
  providers: [
    // The **tool contract** half of the catalogue: empty unless an operator
    // points `TOOL_CATALOGUE_SEED_FILE` at one. Still a seed on purpose — a
    // tool's schemas are ours to author, not a provider's to edit (the launch
    // catalogue). The seed's `bindings` array is now read only by
    // tests that construct `InMemoryToolCatalogue` directly.
    { provide: TOOL_CATALOGUE_SNAPSHOT, useFactory: () => loadToolCatalogue() },
    InMemoryToolCatalogue,
    // The seeded tools, mirrored into `tools` at boot so bindings and toolsets
    // can reference them (`fk_tool_bindings_tool`).
    ToolRegistrySeeder,

    // Contracts come from `tools` and `tool_versions` (T3): the source of
    // truth. The seed above only upserts version 1.0.0 of seeded tools, for
    // local runs and tests.
    DatabaseToolContracts,
    { provide: TOOL_CONTRACTS, useExisting: DatabaseToolContracts },
    ToolContractChangesService,
    { provide: TOOL_CONTRACT_CHANGES, useExisting: ToolContractChangesService },

    // Bindings come from `tool_bindings`, written by the provider's own
    // console. `ToolBindingRepository` resolves out of the `@Global`
    // `PostgresModule` the composition root brings in.
    DatabaseToolCatalogue,
    { provide: TOOL_CATALOGUE, useExisting: DatabaseToolCatalogue },

    EgressBindingInvoker,
    { provide: BINDING_INVOKER, useExisting: EgressBindingInvoker },

    {
      provide: ROUTER_CONFIG,
      useFactory: (config: ConfigService, enabled: readonly ChainId[]): RouterConfig => {
        // One reader for the two env vars, shared with `ProviderApiModule` and
        // the stake monitor, so the router's floor and the provider console's
        // cannot disagree. `$50` at USDC's 6 decimals by default.
        // Keyed on the chain the floor's own asset names, and asserted to cover
        // every enabled chain — one derivation, shared with the binding
        // editor's write-time gate, so the two gates cannot refuse against
        // different numbers. Every chain needs its own floor and none may be
        // discounted, so a chain this
        // deployment offers with no floor fails the boot rather than serving
        // paid calls it cannot price the collateral for.
        const minimumStakeByChain = loadMinimumStakeByChain(config, enabled);

        return {
          ...DEFAULT_ROUTER_TUNING,
          maxAttempts: Number(config.get<string>('ROUTER_MAX_ATTEMPTS') ?? 3),
          totalDeadlineMs: Number(config.get<string>('ROUTER_TOTAL_DEADLINE_MS') ?? 30_000),
          minimumStakeByChain,
        };
      },
      inject: [ConfigService, ENABLED_CHAINS],
    },

    // How many calls each binding has served, which is what the
    // exploration floor in `computeWeights` reserves traffic against. It
    // resolves `PaymentIntentRepository` out of the `@Global` `PostgresModule`
    // and the shared cache client out of the `@Global` `RedisCacheModule`, the
    // same arrangement `DatabaseToolCatalogue` already relies on.
    BindingCallCounterService,

    // The provider's own declared ceilings, so that reaching one sheds
    // traffic instead of pushing a call at an endpoint that already said it
    // could not take it. `gatherCandidates` reads it in the same
    // wave as the registry and the stake source, and `selectAndReserve` spends
    // exactly one token, after the draw, on the binding about to be dialled.
    BindingCeilingService,

    // Every attempt the provider is accountable for, into `binding_attempts`
    // — the raw window the scheduler's stats refresh turns into
    // `ProviderStats`. `BindingAttemptRepository` comes from the `@Global`
    // `PostgresModule`.
    BindingAttemptRecorder,

    // Production randomness. Bound rather than called directly so that the
    // traffic split is a testable claim — see `pickWeighted`.
    { provide: ROUTING_RANDOM, useValue: cryptoRandom },

    ProviderRouterService,

    // What `tools/list` and the Connect preview price from: candidates cached
    // per tool, reloaded every minute and on every write a price depends on.
    QuoteIndexService,
    QuoteIndexInvalidationSubscriber,
  ],
  // `BINDING_INVOKER` is exported for the mapping tester, which dials a
  // provider's endpoint through the *same* invoker production uses, rather
  // than a sandbox copy of it. A copy is how a tester goes green on a call
  // production would have made differently.
  // `BindingCallCounterService` is exported for the MCP server: the increment belongs
  // at the point that writes `payment_intents.binding_id`, which is the MCP
  // loop's own transition, not anywhere inside routing. Counting where the
  // router *selects* would charge a binding that failover then abandoned.
  exports: [
    ProviderRouterService,
    QuoteIndexService,
    TOOL_CATALOGUE,
    TOOL_CONTRACTS,
    TOOL_CONTRACT_CHANGES,
    BINDING_INVOKER,
    BindingCallCounterService,
  ],
})
export class ToolModule {}
