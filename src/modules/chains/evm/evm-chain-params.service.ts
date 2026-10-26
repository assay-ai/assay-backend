import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAddress } from 'viem';

import { AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import { getAssetMetadata } from '../ports/asset-registry';
import { AssetId, ChainId, toAssetId } from '../ports/caip.types';
import { ChainParams, ChainParamsPort } from '../ports/chain-params.port';
import { ASSAY_CONFIG_ABI, ERC20_ABI } from './abi/assay.abi';
import { ASSAY_CONFIG_HOLD_ABI } from './abi/assay-hold.abi';
import { ChainParamsFallback } from './chain-params-fallback';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import { EvmDeployment } from './evm.constants';

/** Per chain, one read waits this long. */
export const CHAIN_PARAMS_READ_TIMEOUT_MS = 2_000;
/** How often every chain is read again in the background. */
export const CHAIN_PARAMS_REFRESH_MS = 5 * 60 * 1000;
/** While a chain has never been read (a failed boot read), it is retried this often. */
export const CHAIN_PARAMS_RETRY_MS = 20_000;

export const CHAIN_PARAMS_ALERTS = {
  /** A chain value differs from the env value kept as its fallback. */
  ENV_DRIFT: 'evm_onchain_param_env_drift',
  /** The settlement token's `decimals()` differs from the asset registry. */
  DECIMALS_MISMATCH: 'evm_asset_decimals_mismatch',
} as const;

const TIMED_OUT = Symbol('timed out');

interface ParamSetRead {
  readonly unbondingPeriodSeconds: bigint;
  readonly minimumStake: bigint;
  readonly penaltyAmount: bigint;
  readonly verifierDailyCap: bigint;
  readonly takeRateBps: number;
  readonly slashAgentBps: number;
  readonly slashPlatformBps: number;
  readonly slashCapBps: number;
}

/**
 * The on-chain parameters of every EVM deployment, cached in memory (one
 * {@link ChainParams} per chain, see `ChainParamsPort`).
 *
 * - **One multicall per chain**: `params()`, `slashDelaySeconds()`,
 *   `collectHoldSeconds()`, `paused()`, `arbiter()`, each chain under its own
 *   time budget, so a node that never answers costs `timeoutMs`, and the
 *   chains that answered keep their values.
 * - **When**: before the module finishes starting, every
 *   {@link CHAIN_PARAMS_REFRESH_MS}, and whenever `EvmChainStateService` sees
 *   the indexer record a config-change event (`params_changed_at`).
 * - **Chain first**: a chain that answered once serves its own values from
 *   then on; a failed read keeps the last answer. Only a chain never read
 *   serves the env fallback (`source: 'config'`).
 * - **Drift**: a chain value that differs from its env fallback is logged and
 *   alerted once per distinct difference, not once per read.
 * - **Decimals**: at boot, each settlement token's `decimals()` is compared
 *   with the asset registry; a mismatch is an error log and a CRITICAL alert.
 */
export class EvmChainParamsCache implements ChainParamsPort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmChainParamsCache.name);
  private readonly read = new Map<ChainId, ChainParams>();
  private readonly drift = new Map<ChainId, string>();
  private readonly listeners = new Set<(params: ChainParams) => void>();
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly fieldFailures = new Map<ChainId, string>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly fallback: ChainParamsFallback,
    private readonly alerts: AlertPort | null = null,
    private readonly options: {
      readonly refreshMs?: number;
      readonly retryMs?: number;
      readonly timeoutMs?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.readable().length === 0) return;
    // Not awaited: a slow node must not hold the boot up for a log line.
    void this.checkDecimals();
    await this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      this.options.refreshMs ?? CHAIN_PARAMS_REFRESH_MS,
    );
    this.timer.unref?.();
    this.retryUnread();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  /**
   * A chain that has never answered (a failed or slow boot read) serves the
   * env fallback; it is read again every {@link CHAIN_PARAMS_RETRY_MS} until
   * its first success, not only at the 5-minute refresh.
   */
  private retryUnread(): void {
    if (this.retryTimer) return;
    const unread = this.readable().filter((deployment) => !this.read.has(deployment.chainId));
    if (unread.length === 0) return;
    this.logger.warn(
      `on-chain params never read on ${unread.map((d) => d.chainId).join(', ')}; serving the env ` +
        `fallback and retrying every ${(this.options.retryMs ?? CHAIN_PARAMS_RETRY_MS) / 1000} s`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh().then(() => this.retryUnread());
    }, this.options.retryMs ?? CHAIN_PARAMS_RETRY_MS);
    this.retryTimer.unref?.();
  }

  current(chainId: ChainId): ChainParams | null {
    const deployment = this.deployments.get(chainId);
    if (!deployment) return null;
    return this.read.get(chainId) ?? this.fromConfig(deployment);
  }

  all(): readonly ChainParams[] {
    return [...this.deployments.keys()].map((chainId) => this.current(chainId)!);
  }

  subscribe(listener: (params: ChainParams) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<void> {
    if (!this.running) {
      this.running = Promise.all(this.readable().map((deployment) => this.readOne(deployment)))
        .then(() => undefined)
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private readable(): EvmDeployment[] {
    return [...this.deployments.values()].filter((deployment) =>
      this.clients.has(deployment.chainId),
    );
  }

  private async readOne(deployment: EvmDeployment): Promise<void> {
    const { chainId } = deployment;
    const timeoutMs = this.options.timeoutMs ?? CHAIN_PARAMS_READ_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    let next: ChainParams;
    try {
      const outcome = await Promise.race([this.readChain(deployment), timeout]);
      if (outcome === TIMED_OUT) {
        this.logger.warn(
          `on-chain params read on ${chainId}: no answer within ${timeoutMs} ms; ` +
            `${this.read.has(chainId) ? 'keeping the last reading' : 'serving the env fallback'}`,
        );
        return;
      }
      next = outcome;
    } catch (error) {
      this.logger.warn(
        `on-chain params read on ${chainId} failed; ` +
          `${this.read.has(chainId) ? 'keeping the last reading' : 'serving the env fallback'}: ` +
          `${describe(error)}`,
      );
      return;
    } finally {
      clearTimeout(timer);
    }

    const previous = this.read.get(chainId);
    this.read.set(chainId, next);
    const changed = !previous || fingerprint(previous) !== fingerprint(next);
    if (changed) {
      if (previous) {
        this.logger.log(`on-chain params on ${chainId} changed: ${fingerprint(next)}`);
      }
      for (const listener of this.listeners) {
        try {
          listener(next);
        } catch (error) {
          this.logger.error(`a chain params listener threw: ${describe(error)}`);
        }
      }
    }
    await this.reportDrift(next);
  }

  private async readChain(deployment: EvmDeployment): Promise<ChainParams> {
    const config = getAddress(deployment.config);
    const call = (abi: unknown, functionName: string) => ({
      address: config,
      abi,
      functionName,
      args: [] as const,
    });
    // One failed optional getter (a Config without `collectHoldSeconds()`, say)
    // must not throw the whole chain back to env: each call answers on its
    // own, `params()` is required, and a failed optional field keeps its last
    // chain value, else the env fallback, and is logged.
    const results = (await this.clients.get(deployment.chainId)!.multicall({
      contracts: [
        call(ASSAY_CONFIG_ABI, 'params'),
        call(ASSAY_CONFIG_ABI, 'slashDelaySeconds'),
        call(ASSAY_CONFIG_HOLD_ABI, 'collectHoldSeconds'),
        call(ASSAY_CONFIG_ABI, 'paused'),
        call(ASSAY_CONFIG_ABI, 'arbiter'),
      ],
      allowFailure: true,
    })) as readonly { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];
    const [paramsRead, slashDelayRead, collectHoldRead, pausedRead, arbiterRead] = results;
    if (paramsRead?.status !== 'success') {
      throw paramsRead?.error instanceof Error ? paramsRead.error : new Error('params() failed');
    }
    const params = paramsRead.result as ParamSetRead;
    const previous = this.read.get(deployment.chainId);
    const failed: string[] = [];
    const optional = <T>(
      name: string,
      read: { status: string; result?: unknown } | undefined,
      parse: (value: unknown) => T,
      otherwise: T,
    ): T => {
      if (read?.status === 'success') return parse(read.result);
      failed.push(name);
      return otherwise;
    };
    const slashDelay = optional(
      'slashDelaySeconds',
      slashDelayRead,
      (value) => Number(value as bigint),
      previous?.slashDelaySeconds ?? this.fallback.slashDelaySeconds,
    );
    const collectHold = optional(
      'collectHoldSeconds',
      collectHoldRead,
      (value) => Number(value as bigint),
      previous?.collectHoldSeconds ?? this.fallback.collectHoldSeconds,
    );
    const paused = optional(
      'paused',
      pausedRead,
      (value) => Boolean(value),
      previous?.paused ?? null,
    );
    const arbiter = optional(
      'arbiter',
      arbiterRead,
      (value) => {
        const address = value as `0x${string}` | undefined;
        return !address || BigInt(address) === 0n ? null : getAddress(address);
      },
      previous?.arbiter ?? null,
    );
    this.reportFieldFailures(deployment.chainId, failed);
    const asset = this.assetOf(deployment);
    const money = (amount: bigint) =>
      MoneyUtil.of(BigInt(amount).toString(), asset, getAssetMetadata(asset).decimals);
    return {
      chainId: deployment.chainId,
      source: 'chain',
      readAt: new Date(this.now()),
      contracts: contractsOf(deployment),
      minimumStake: money(params.minimumStake),
      penaltyAmount: money(params.penaltyAmount),
      verifierDailyCap: money(params.verifierDailyCap),
      takeRateBps: Number(params.takeRateBps),
      slashAgentBps: Number(params.slashAgentBps),
      slashPlatformBps: Number(params.slashPlatformBps),
      slashCapBps: Number(params.slashCapBps),
      unbondingPeriodSeconds: Number(params.unbondingPeriodSeconds),
      slashDelaySeconds: slashDelay,
      policySlashDelaySeconds: this.fallback.slashDelaySeconds,
      collectHoldSeconds: collectHold,
      paused,
      arbiter,
    };
  }

  /** A warning once per distinct set of failed optional getters per chain. */
  private reportFieldFailures(chainId: ChainId, failed: readonly string[]): void {
    const signature = failed.join(',');
    if ((this.fieldFailures.get(chainId) ?? '') === signature) return;
    this.fieldFailures.set(chainId, signature);
    if (signature === '') {
      this.logger.log(`every on-chain param getter on ${chainId} answers again`);
      return;
    }
    this.logger.warn(
      `on-chain params on ${chainId}: ${signature} could not be read; those fields keep their ` +
        `last chain value, else the env fallback, and the rest follow the chain`,
    );
  }

  private fromConfig(deployment: EvmDeployment): ChainParams {
    const asset = this.assetOf(deployment);
    return {
      chainId: deployment.chainId,
      source: 'config',
      readAt: null,
      contracts: contractsOf(deployment),
      minimumStake: moneyOrNull(this.fallback.minimumStake, asset),
      penaltyAmount: null,
      verifierDailyCap: null,
      takeRateBps: this.fallback.takeRateBps,
      slashAgentBps: this.fallback.slashAgentBps,
      slashPlatformBps: this.fallback.slashPlatformBps,
      slashCapBps: null,
      unbondingPeriodSeconds: null,
      slashDelaySeconds: this.fallback.slashDelaySeconds,
      policySlashDelaySeconds: this.fallback.slashDelaySeconds,
      collectHoldSeconds: this.fallback.collectHoldSeconds,
      paused: null,
      arbiter: null,
    };
  }

  /**
   * Log and alert every field whose chain value differs from its env
   * fallback, once per distinct set of differences per chain: the same
   * difference on the next read stays quiet, a new one speaks again.
   */
  private async reportDrift(params: ChainParams): Promise<void> {
    const env = this.fallback;
    const differences: string[] = [];
    const compare = (name: string, chain: number | string | null, configured: number | string) => {
      if (chain !== null && String(chain) !== String(configured)) {
        differences.push(`${name} chain=${chain} env=${configured}`);
      }
    };
    compare(
      'minimumStake (PROVIDER_MINIMUM_STAKE_FLOOR)',
      params.minimumStake?.amount ?? null,
      env.minimumStake,
    );
    compare('takeRateBps (PLATFORM_FEE_BPS)', params.takeRateBps, env.takeRateBps);
    if (env.slashAgentBps !== null && env.slashPlatformBps !== null) {
      compare(
        'slashAgentBps/slashPlatformBps (PROVIDER_TERMS_PENALTY_SPLIT)',
        `${params.slashAgentBps}/${params.slashPlatformBps}`,
        `${env.slashAgentBps}/${env.slashPlatformBps}`,
      );
    }
    compare(
      'collectHoldSeconds (CALL_DISPUTE_HOLD_WINDOW_MINUTES)',
      params.collectHoldSeconds,
      env.collectHoldSeconds,
    );
    compare(
      'slashDelaySeconds (SLASH_TIMELOCK_HOURS, kept as the policy floor)',
      params.slashDelaySeconds,
      env.slashDelaySeconds,
    );

    const signature = differences.join('; ');
    if ((this.drift.get(params.chainId) ?? '') === signature) return;
    this.drift.set(params.chainId, signature);
    if (signature === '') {
      this.logger.log(`on-chain params on ${params.chainId} agree with the env fallbacks again`);
      return;
    }
    this.logger.warn(
      `on-chain params on ${params.chainId} differ from the env fallbacks; the chain values are ` +
        `used: ${signature}`,
    );
    await this.alerts
      ?.emit({
        severity: AlertSeverity.WARN,
        name: CHAIN_PARAMS_ALERTS.ENV_DRIFT,
        summary:
          `On-chain parameters on ${params.chainId} differ from the env values kept as their ` +
          `fallback. The chain values are used; update the env so a failed chain read does not ` +
          `fall back to stale numbers`,
        details: { chainId: params.chainId, differences: signature },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${params.chainId}:${signature}`,
      })
      .catch(() => undefined);
  }

  /** The settlement token's `decimals()` against the asset registry, once per chain. */
  private async checkDecimals(): Promise<void> {
    for (const deployment of this.readable()) {
      const asset = this.assetOf(deployment);
      const registered = getAssetMetadata(asset).decimals;
      try {
        const live = Number(
          await this.clients.get(deployment.chainId)!.readContract({
            address: getAddress(deployment.asset),
            abi: ERC20_ABI,
            functionName: 'decimals',
            args: [],
          }),
        );
        if (live === registered) continue;
        this.logger.error(
          `settlement token ${deployment.asset} on ${deployment.chainId} reports ${live} ` +
            `decimals; the asset registry says ${registered}. Every amount on this chain is ` +
            `mis-scaled until they agree`,
        );
        await this.alerts
          ?.emit({
            severity: AlertSeverity.CRITICAL,
            name: CHAIN_PARAMS_ALERTS.DECIMALS_MISMATCH,
            summary:
              `The settlement token on ${deployment.chainId} reports ${live} decimals, the ` +
              `asset registry ${registered}`,
            details: {
              chainId: deployment.chainId,
              asset: deployment.asset,
              live,
              registered,
            },
            aggregation: AlertAggregation.ONCE_PER_INCIDENT,
            dedupeKey: deployment.chainId,
          })
          .catch(() => undefined);
      } catch (error) {
        this.logger.warn(
          `decimals() of ${deployment.asset} on ${deployment.chainId} could not be read at ` +
            `boot: ${describe(error)}`,
        );
      }
    }
  }

  private assetOf(deployment: EvmDeployment): AssetId {
    return toAssetId(deployment.chainId, 'erc20', getAddress(deployment.asset));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** `null` for an asset the registry does not know: `current()` never throws. */
function moneyOrNull(amount: string, asset: AssetId): ChainParams['minimumStake'] {
  try {
    return MoneyUtil.of(amount, asset, getAssetMetadata(asset).decimals);
  } catch {
    return null;
  }
}

function contractsOf(deployment: EvmDeployment): ChainParams['contracts'] {
  return {
    config: getAddress(deployment.config),
    stake: getAddress(deployment.stake),
    escrow: getAddress(deployment.escrow),
    asset: getAddress(deployment.asset),
  };
}

/** Every value of a reading, without its read time: equal fingerprints, equal values. */
function fingerprint(params: ChainParams): string {
  return [
    `minimumStake=${params.minimumStake?.amount}`,
    `penaltyAmount=${params.penaltyAmount?.amount}`,
    `verifierDailyCap=${params.verifierDailyCap?.amount}`,
    `takeRateBps=${params.takeRateBps}`,
    `slashAgentBps=${params.slashAgentBps}`,
    `slashPlatformBps=${params.slashPlatformBps}`,
    `slashCapBps=${params.slashCapBps}`,
    `unbondingPeriodSeconds=${params.unbondingPeriodSeconds}`,
    `slashDelaySeconds=${params.slashDelaySeconds}`,
    `collectHoldSeconds=${params.collectHoldSeconds}`,
    `paused=${params.paused}`,
    `arbiter=${params.arbiter}`,
  ].join(' ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
