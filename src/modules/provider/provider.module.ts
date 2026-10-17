import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { ChainsModule } from '@modules/chains/chains.module';

import {
  STAKE_CACHE_TTL_MS_ENV,
  STAKE_STALE_MAX_MS_ENV,
} from './constants/onchain-stake.constants';
import { PROVIDER_REGISTRY } from './ports/provider-registry.port';
import { PROVIDER_STAKE_SOURCE } from './ports/provider-stake.port';
import { CHAIN_ENROLMENT_SOURCE } from './ports/chain-enrolment.port';
import { STAKE_GRACE_SOURCE } from './ports/stake-grace.port';
import {
  CompositeProviderStakeSource,
  PROVIDER_STAKE_SOURCE_MODE,
  PROVIDER_STAKE_SOURCE_MODE_ENV,
} from './services/composite-provider-stake.source';
import {
  ConfigProviderRegistry,
  PROVIDER_REGISTRY_SNAPSHOT,
} from './services/config-provider-registry';
import {
  ConfigProviderStakeSource,
  PROVIDER_STAKE_SNAPSHOT,
} from './services/config-provider-stake.source';
import { BINDING_STATS_CONFIG, loadBindingStatsConfig } from './constants/binding-stats.constants';
import { DbProviderRegistry } from './services/db-provider-registry';
import { DbChainEnrolmentSource } from './services/db-chain-enrolment.source';
import { DbStakeGraceSource } from './services/db-stake-grace.source';
import {
  DEFAULT_ONCHAIN_PROVIDER_STAKE_CONFIG,
  ONCHAIN_PROVIDER_STAKE_CONFIG,
  OnChainProviderStakeSource,
} from './services/onchain-provider-stake.source';
import { loadProviderRegistry, loadProviderStakes } from './services/provider-seed';

/**
 * Provider domain — the supply side, self-service end to end.
 *
 * Scope: open registration, proven payout address, earnings and payouts; the
 * binding editor, mapping tester and the publish gate; the stake lifecycle; SLA
 * declaration and strikes.
 *
 * What is here is the **ports the router reads through**, and the
 * first two are at different stages of the same journey:
 *
 * ```text
 * PROVIDER_REGISTRY      DbProviderRegistry            ← `providers`
 * PROVIDER_STAKE_SOURCE  CompositeProviderStakeSource  ← config | chain
 * STAKE_GRACE_SOURCE     DbStakeGraceSource            ← `provider_stake_grace`
 * CHAIN_ENROLMENT_SOURCE DbChainEnrolmentSource        ← `provider_chain_enrolments`
 * ```
 *
 * The third never had a stand-in to migrate off: a grace period is a row we
 * write, and a grace period with no row is not a grace period.
 *
 * The split between them is the load-bearing part, and the first row is the
 * proof: swapping the registry from a seed file to the table was a one-line
 * change here, with no edit to the router, to the gate, or to any test of
 * either. The composite stake source does the same to the second row. Two ports rather than one
 * snapshot type is what buys that — status and tier are ours, and only the
 * stake migrates to the chain.
 *
 * `ConfigProviderRegistry` is kept, unbound, for tests that need a registry
 * without a database.
 *
 * ## Why the second row is a composite and not `OnChainProviderStakeSource`
 *
 * Because the direct binding is an outage. A provider who has not signed a
 * stake-authority challenge has no `providers.stake_authority`, so the chain
 * source cannot derive a PDA and leaves them absent, and `evaluateStakeGate`
 * turns absent into `STAKE_UNKNOWN` and refuses. Binding the chain source here
 * would therefore take every PAID/FREEMIUM binding of every already-registered
 * provider out of routing in one deploy. `CompositeProviderStakeSource` stages
 * it instead, per provider, under `PROVIDER_STAKE_SOURCE_MODE` — whose default
 * is `config`, so that deploying the chain reader changes nothing until an operator says
 * so. The long version is on that class.
 *
 * Both underlying sources stay bound as concrete classes: the composite holds
 * one of each, and the router still cannot tell which one answered.
 *
 * `ChainsModule` arrives for `ONCHAIN_STAKE_READER` — the settlement-program
 * account read, which may not live outside `chains/`. `CacheService` needs no
 * import; `RedisCacheModule` is `@Global()`.
 *
 * Its error catalog is already populated: `errors/provider.errors.ts`.
 *
 * `NotificationModule` is deliberately **not** imported here even though
 * `StakeMonitorService` needs `NOTIFICATION_PORT`: that service is a
 * provider of `ProviderStakeMonitorSchedulerModule`
 * (`provider-scheduler.module.ts`), not of this one, and re-exporting a
 * BullMQ-backed module from here would drag it into every consumer of
 * `ProviderModule` — including `ToolModule`, and the lightweight
 * `tool-module-wiring.spec.ts` / `mcp-module-wiring.spec.ts` harnesses that
 * construct it without a live queue connection. `NotificationModule` is
 * imported directly where it is actually used instead.
 */
@Module({
  imports: [ChainsModule, BlocklistModule],
  providers: [
    // Empty until an operator seeds them, via `PROVIDER_REGISTRY_SEED_FILE`
    // and `PROVIDER_STAKE_SEED_FILE`. A router with an empty registry refuses
    // every call with `TOOL_NO_ELIGIBLE_BINDING`, which is the correct
    // behaviour for a platform with no providers — and is loudly different from
    // routing to one it knows nothing about.
    { provide: PROVIDER_REGISTRY_SNAPSHOT, useFactory: () => loadProviderRegistry() },
    { provide: PROVIDER_STAKE_SNAPSHOT, useFactory: () => loadProviderStakes() },
    ConfigProviderRegistry,
    ConfigProviderStakeSource,
    DbProviderRegistry,
    // Until this line, `POST /providers` wrote a row routing never
    // read, and a registered provider could not receive traffic until an
    // operator edited `PROVIDER_REGISTRY_SEED_FILE` — which made open
    // registration half true. The publish gate is where that had to end: it
    // decides routability, and publishing into a registry that has never heard
    // of you is publishing into silence.
    { provide: PROVIDER_REGISTRY, useExisting: DbProviderRegistry },
    // The observed-stats window and minimum sample, validated at boot. Read
    // by the registry (the minimum sample) and exported for the scheduler's
    // refresh (the window), so both sides of `binding_stats` agree.
    { provide: BINDING_STATS_CONFIG, useFactory: loadBindingStatsConfig, inject: [ConfigService] },

    // The freshness window and the staleness budget are constants with
    // env overrides rather than literals, because the second one is the bound
    // on how long a slashed provider can keep taking paid traffic while the RPC
    // is down — a number an operator has to be able to move during an incident
    // without a redeploy. `now` is injected in the kill-switch style so a test
    // can age a reading instead of waiting for it.
    {
      provide: ONCHAIN_PROVIDER_STAKE_CONFIG,
      useFactory: (config: ConfigService) => ({
        freshTtlMs: positiveMs(
          config.get<string>(STAKE_CACHE_TTL_MS_ENV),
          DEFAULT_ONCHAIN_PROVIDER_STAKE_CONFIG.freshTtlMs,
        ),
        staleMaxMs: positiveMs(
          config.get<string>(STAKE_STALE_MAX_MS_ENV),
          DEFAULT_ONCHAIN_PROVIDER_STAKE_CONFIG.staleMaxMs,
        ),
        now: () => Date.now(),
      }),
      inject: [ConfigService],
    },
    OnChainProviderStakeSource,

    // The raw env value, parsed and validated inside the class rather than
    // here: an unrecognised mode must fail the boot with a message naming what
    // *is* supported, and that rule belongs with the enum it protects.
    {
      provide: PROVIDER_STAKE_SOURCE_MODE,
      useFactory: (config: ConfigService) =>
        config.get<string>(PROVIDER_STAKE_SOURCE_MODE_ENV) ?? null,
      inject: [ConfigService],
    },
    CompositeProviderStakeSource,

    // Unchanged for the router, which is the whole point: this is
    // still one `useExisting` on a port it does not look past. What changed is
    // that the class behind it can now be told to ask the chain.
    { provide: PROVIDER_STAKE_SOURCE, useExisting: CompositeProviderStakeSource },

    // The stake grace period. The third thing the router reads about a provider, and
    // the only one of the three that is a record we write rather than a state
    // we observe: an open row in `provider_stake_grace` is the platform's
    // promise that this binding keeps taking paid traffic for seven more days.
    // Bound directly to the table — there is no config stand-in and there never
    // was one, because a grace period with no row is not a grace period.
    DbStakeGraceSource,
    { provide: STAKE_GRACE_SOURCE, useExisting: DbStakeGraceSource },

    // Which chains a provider has enrolled on, and the payout
    // address and stake authority they proved on each. Bound directly to the
    // table for the same reason grace is: an enrolment is a declaration we
    // recorded, not a state the chain can be asked about. What the chain
    // answers is how much is staked behind `stakeAuthorityAccountId` — and
    // that is `PROVIDER_STAKE_SOURCE`'s question, asked on every decision,
    // because this row proves nothing about collateral.
    DbChainEnrolmentSource,
    { provide: CHAIN_ENROLMENT_SOURCE, useExisting: DbChainEnrolmentSource },
  ],
  exports: [
    PROVIDER_REGISTRY,
    PROVIDER_STAKE_SOURCE,
    STAKE_GRACE_SOURCE,
    CHAIN_ENROLMENT_SOURCE,
    BINDING_STATS_CONFIG,
  ],
})
export class ProviderModule {}

/**
 * Milliseconds from an env var, falling back to the constant.
 *
 * `Number('')` is `0` and `Number('abc')` is `NaN`. A freshness window of zero
 * puts an RPC read on every routing decision; a staleness budget of zero drops
 * every provider to "no known stake" the instant the RPC hiccups, and `NaN`
 * compares false against everything so it would never expire a reading at all.
 * Each of those is worse than the default, so each falls back to it — the same
 * rule `verifierSigningConfigFactory` applies to its rate limits, for the same
 * reason.
 */
function positiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
