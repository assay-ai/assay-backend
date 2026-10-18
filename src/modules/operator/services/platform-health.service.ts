import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PlatformMetricsRepository } from '@database/postgres/repositories/platform-metrics.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import {
  PROVIDER_STAKE_SOURCE,
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
} from '@modules/provider/ports/provider-stake.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { ProviderSlashHoldRepository } from '@database/postgres/repositories/provider-slash-hold.repository';
import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { chainStateLagMs } from '@modules/chains/evm/chain-state/evm-chain-state.indexer';

import { ChainStateHealthDto, PlatformHealthDto } from '../dto/operator-console.dto';

/** `EVM_CHAIN_STATE_MAX_LAG_MS`, the indexer's own bound (default five minutes). */
const CHAIN_STATE_MAX_LAG_MS = Number(process.env.EVM_CHAIN_STATE_MAX_LAG_MS ?? 5 * 60 * 1000);

/** The trailing window for the false-positive rate tile. */
const FALSE_POSITIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The gate the rate is measured against. Matches
 * `PROMOTION_GATE.maxFalsePositiveRate` in
 * `@modules/verification/domain/lifecycle/promotion` — the same 2% bar, for a
 * different population (our own overturns, not one policy's labelled sample).
 * Not imported from there: that constant is about promoting a *policy*, this
 * one is a platform-wide health threshold, and the two are only coincidentally
 * the same number today. Importing it would make a future change to either
 * bar silently move the other.
 */
const FALSE_POSITIVE_GATE = 0.02;

/**
 * The asset `stakeLocked` is denominated in when **no** provider has any known
 * stake at all — an empty map has no asset of its own to report, and
 * `MoneyUtil.sum` refuses an empty list rather than inventing one. Matches the
 * default `PLATFORM_STAKE_ASSET_ID` used elsewhere (`loadMinimumStakeParameters`);
 * see {@link PlatformHealthService.stakeLocked} for why this is a corner case
 * rather than the common path — any real stake carries its own asset.
 */
const FALLBACK_STAKE_ASSET = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;

/**
 * `GET /operator/health` — the six tiles across the top of the operator console.
 *
 * Every figure is read from Postgres except `stakeLocked` /
 * `providersWithStake`, which go through {@link PROVIDER_STAKE_SOURCE} — the
 * same port `GET /providers/me/stake` and the router's stake gate use. See
 * {@link stakeLocked} for why that is also this tile's answer to "the chain is
 * unavailable, degrade rather than 500".
 */
@Injectable()
export class PlatformHealthService {
  private readonly logger = new Logger(PlatformHealthService.name);

  constructor(
    private readonly metrics: PlatformMetricsRepository,
    private readonly slashProposals: SlashProposalRepository,
    private readonly providers: ProviderRepository,
    @Inject(PROVIDER_STAKE_SOURCE) private readonly stakes: ProviderStakePort,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly chainStates: EvmChainStateRepository,
    @Optional() private readonly slashHolds: ProviderSlashHoldRepository | null = null,
  ) {}

  async getHealth(): Promise<PlatformHealthDto> {
    const now = new Date();

    const [
      intentRates,
      backlog,
      falsePositiveRate,
      policies,
      stake,
      oldProcess,
      chainState,
      holds,
      work,
    ] = await Promise.all([
      this.metrics.intentRateCounts(now),
      this.metrics.verificationBacklog(now),
      this.falsePositiveRate(now),
      this.metrics.policyLifecycleCounts(),
      this.stakeLocked(),
      this.metrics.oldProcessCaseCounts(now),
      this.chainState(now),
      (this.slashHolds?.findAllHeld() ?? Promise.resolve([])).catch(() => []),
      // The "Needs you" counts never fail the tiles: unreadable reads as unknown.
      this.metrics
        .operatorWorkCounts()
        .catch(() => ({ pendingToolReviews: null, openCallDisputes: null })),
    ]);

    return {
      intentsPerMinute: intentRates.lastMinute,
      intentsPerMinuteDeltaVsHour: deltaVsHour(intentRates),
      verificationBacklog: backlog.count,
      verificationBacklogP95AgeSeconds: backlog.p95AgeSeconds,
      falsePositiveRate,
      falsePositiveGate: FALSE_POSITIVE_GATE,
      policiesInShadow: policies.shadow,
      policiesTotal: policies.total,
      stakeLocked: stake.locked,
      providersWithStake: stake.providersWithStake,
      oldProcessCases: oldProcess.count,
      oldestOldProcessCaseAgeSeconds: oldProcess.oldestAgeSeconds,
      chainState,
      pendingToolReviews: work.pendingToolReviews,
      openCallDisputes: work.openCallDisputes,
      slashHolds: holds.map((hold) => ({
        providerId: hold.providerId,
        chainId: hold.chainId,
        reasons: [...hold.reasons],
        heldSince: hold.heldSince.toISOString(),
        checkedAt: hold.checkedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * The EVM chain-state cache, per chain, with the indexer's lag. A row is
   * `stale` when the indexer never caught up or is more than
   * `EVM_CHAIN_STATE_MAX_LAG_MS` behind; the indexer logs the same warning.
   * Never fails the tile: an unreadable table reports no rows.
   */
  private async chainState(now: Date): Promise<ChainStateHealthDto[]> {
    try {
      const [states, blocked] = await Promise.all([
        this.chainStates.findAllStates(),
        this.chainStates.findBlocked(),
      ]);
      return states.map((state) => {
        const lagMs = chainStateLagMs(state.caughtUpAt, now.getTime());
        return {
          chainId: state.chainId,
          paused: state.paused,
          arbiter: state.arbiter,
          slashDelaySeconds: state.slashDelaySeconds,
          blockedCount: blocked.filter((row) => row.chainId === state.chainId).length,
          indexedBlock: state.cursorBlock,
          headBlock: state.headBlock,
          lagSeconds: lagMs === null ? null : Math.round(lagMs / 1000),
          stale: lagMs === null || lagMs > CHAIN_STATE_MAX_LAG_MS,
          reconciledAt: state.reconciledAt?.toISOString() ?? null,
        };
      });
    } catch (error) {
      this.logger.warn(`EVM chain-state read failed for the health tile: ${String(error)}`);
      return [];
    }
  }

  /**
   * `falsePositives / resolved`, over the trailing 30 days. `0`, never `NaN`,
   * when nothing has resolved yet — the tile is a rate against a real
   * denominator, and an empty denominator means "no findings against us in
   * the window", not "unmeasurable".
   */
  private async falsePositiveRate(now: Date): Promise<number> {
    const since = new Date(now.getTime() - FALSE_POSITIVE_WINDOW_MS);
    const { resolved, falsePositives } = await this.slashProposals.falsePositiveCounts(since);
    if (resolved <= 0) return 0;
    return falsePositives / resolved;
  }

  /**
   * `stakeLocked` / `providersWithStake` — the routable figure, summed.
   *
   * ## `bonded` alone
   *
   * `PROVIDER_STAKE_SOURCE` resolves to whichever `ProviderStakePort` is bound
   * (`stake-source-g23`'s 3-mode cutover). In every one of its modes the
   * `staked` field it returns is the routing figure — `bonded` alone when it
   * comes from the chain (see `SolanaSettlementStakeReader`'s own doc comment:
   * never `bonded + unbonding`), or the operator-typed stand-in when it does
   * not. That is exactly what `PlatformHealthDto.stakeLocked` asks for, and it
   * is the same number `GET /providers/me/stake` calls `staked` and the router's
   * gate compares against — one source of truth for "how much stake this
   * platform is carrying", not a second copy of the arithmetic.
   *
   * ## It totals every ENABLED chain
   *
   * The tile answers "how much stake this platform is carrying", which is a
   * total, so a provider bonded on two chains contributes both readings. That
   * is the one place a cross-chain sum is the right answer: nobody is deciding
   * whether a call is backed, and the alternative — picking one chain — would
   * under-report the platform's own collateral. The chain set is
   * `ENABLED_CHAINS` because that is what the deployment offers; a reading on a
   * chain it does not offer is not carrying any traffic.
   *
   * Readings in a **different asset** from the running total are skipped rather
   * than added, and counted in the log line. `MoneyUtil.add` refuses to compare
   * across assets and would throw, and a tile that 500s on a second chain being
   * enabled is worse than one that reports the chain it can add up and says so.
   *
   * ## Why this tile has no `chainReadable` flag
   *
   * `ProviderStakePort.stakeOn` is documented as never throwing — the
   * composite source falls back to configuration rather than raising, and the
   * config source has nothing to fail. So there is no exception here to catch
   * and no unknown state to surface: a provider whose stake could not be read
   * off the chain is simply **absent** from the map (see the port's own
   * "absent is not zero"), and this method treats absent exactly like "no
   * known stake" — it contributes nothing to the sum and is not counted in
   * `providersWithStake`. That is a quieter degrade than the provider stake screen's
   * `chainReadable: false`, and it is the one available here: this tile has no
   * per-provider `unbonding`/`exposed` detail to lose, so there is nothing
   * left to report as unreadable once the sum itself has degraded to "missing
   * some providers" rather than "wrong".
   *
   * The `try`/`catch` below is the belt on that suspender, not a contradiction
   * of it: the port promises never to throw, but this tile still must not 500
   * if a future implementation — or a bug in the current one — breaks that
   * promise. On a caught failure the whole read degrades to "no known stake
   * for anyone, this request", which is the same shape a fully-absent map
   * already produces.
   */
  private async stakeLocked(): Promise<{ locked: MoneyDto; providersWithStake: number }> {
    const providers = await this.providers.findAllProviders();
    const keys: ProviderChainStakeKey[] = providers.flatMap((provider) =>
      this.enabled.map((chainId) => ({ providerId: provider.organizationId, chainId })),
    );
    const readings = await this.readStakes(keys);

    let total: Money | null = null;
    let skipped = 0;
    // Counted per PROVIDER, not per reading: the tile says how many providers
    // are carrying stake, and one provider bonded on two chains is one
    // provider. A `Set` rather than a counter for exactly that reason.
    const withStake = new Set<string>();
    for (const stake of readings.values()) {
      if (MoneyUtil.isZero(stake.staked)) continue;
      withStake.add(stake.providerId);
      if (!total) {
        total = stake.staked;
        continue;
      }
      if (total.asset !== stake.staked.asset) {
        skipped += 1;
        continue;
      }
      total = MoneyUtil.add(total, stake.staked);
    }

    if (skipped > 0) {
      this.logger.warn(
        `Stake-locked tile summed in ${total?.asset ?? 'no asset'} and skipped ${skipped} ` +
          `reading(s) denominated in another asset; the figure is that asset's total, not the ` +
          `platform's`,
      );
    }
    const providersWithStake = withStake.size;

    const locked =
      total ??
      MoneyUtil.zero(FALLBACK_STAKE_ASSET, getAssetMetadata(FALLBACK_STAKE_ASSET).decimals);
    return { locked: toMoneyDto(locked), providersWithStake };
  }

  private async readStakes(
    keys: readonly ProviderChainStakeKey[],
  ): Promise<ReadonlyMap<string, ProviderStake>> {
    if (keys.length === 0) return new Map();
    try {
      return await this.stakes.stakeOn(keys);
    } catch (error) {
      this.logger.warn(`Provider stake read failed for the health tile: ${String(error)}`);
      return new Map();
    }
  }
}

/**
 * Change against the same one-minute figure an hour ago, as a share. `null`
 * on a cold start — an hour-ago figure of zero has no percentage to report,
 * and dividing by it would either throw or fabricate an infinite swing.
 */
function deltaVsHour(rates: { lastMinute: number; hourAgoMinute: number }): number | null {
  if (rates.hourAgoMinute <= 0) return null;
  return (rates.lastMinute - rates.hourAgoMinute) / rates.hourAgoMinute;
}

function toMoneyDto(money: Money): MoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}
