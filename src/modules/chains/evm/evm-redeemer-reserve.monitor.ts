import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { EVM_REDEEMER_HOURLY_BUDGET, EvmRedeemerHourlyBudget } from './evm-redeemer-hourly-budget';
import { EVM_REDEEMER, EvmRelayerPort } from './ports/evm-relayer.port';

/** How long a measured hour counts towards the peak. */
const PEAK_WINDOW_MS = 24 * 3_600_000;

export type ReserveLevel = 'OK' | 'LOW' | 'CRITICAL' | 'UNMEASURED' | 'UNREADABLE';

export interface ReserveReading {
  readonly chainId: ChainId;
  readonly balanceWei: bigint | null;
  /** The highest sliding-hour spend measured in the last 24 h. */
  readonly peakHourWei: bigint;
  readonly level: ReserveLevel;
}

/**
 * The redeemer's float reserve, the MONITOR half of G6 (SPEC-W2 §7): every five
 * minutes it samples what the redeemer spent in the sliding hour (its hourly
 * budget's own counters, every lane) and keeps the 24-hour peak; the redeemer's
 * native balance below 2× that peak is `LOW` (WARN), below 1× `CRITICAL`. A
 * channel round, a collect and the per-call door all draw on this one key, so
 * a float that cannot cover two peak hours can strand a deadline settle.
 *
 * The auto top-up half is NOT here: it needs a new funded hot key and spend
 * limits (owner gate, PRE-3). `REDEEMER_FLOAT_RESERVE_MONITOR=false` turns this
 * off (the channel boot check then refuses a slow cadence). Samples live in
 * memory: after a restart the peak is rebuilt within the hour.
 */
@Injectable()
export class EvmRedeemerReserveMonitor {
  private readonly logger = new Logger(EvmRedeemerReserveMonitor.name);
  private readonly samples = new Map<string, { at: number; wei: bigint }[]>();

  constructor(
    @Inject(EVM_REDEEMER) private readonly redeemer: EvmRelayerPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    @Optional()
    @Inject(EVM_REDEEMER_HOURLY_BUDGET)
    private readonly budget: Pick<EvmRedeemerHourlyBudget, 'spentThisHour'> | null = null,
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  @Cron('20 */5 * * * *')
  async tick(): Promise<void> {
    if (process.env.REDEEMER_FLOAT_RESERVE_MONITOR === 'false') return;
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      try {
        await this.check(chainId);
      } catch (error) {
        this.logger.warn(`redeemer reserve on ${chainId}: ${describe(error)}`);
      }
    }
  }

  async check(chainId: ChainId): Promise<ReserveReading> {
    const now = this.now();
    if (this.budget) {
      const spent = await this.budget.spentThisHour(chainId);
      const kept = (this.samples.get(chainId) ?? []).filter((s) => now - s.at < PEAK_WINDOW_MS);
      kept.push({ at: now, wei: spent });
      this.samples.set(chainId, kept);
    }
    const peakHourWei = (this.samples.get(chainId) ?? []).reduce(
      (max, s) => (s.wei > max ? s.wei : max),
      0n,
    );
    let balanceWei: bigint | null = null;
    try {
      balanceWei = await this.redeemer.balanceWei(chainId);
    } catch {
      return { chainId, balanceWei, peakHourWei, level: 'UNREADABLE' };
    }
    if (peakHourWei === 0n) return { chainId, balanceWei, peakHourWei, level: 'UNMEASURED' };
    const level: ReserveLevel =
      balanceWei < peakHourWei ? 'CRITICAL' : balanceWei < peakHourWei * 2n ? 'LOW' : 'OK';
    if (level !== 'OK') {
      await this.alerts.emit({
        severity: level === 'CRITICAL' ? AlertSeverity.CRITICAL : AlertSeverity.WARN,
        name: 'evm_redeemer_reserve_low',
        summary:
          `The redeemer float on ${chainId} (${balanceWei} wei) is below ` +
          `${level === 'CRITICAL' ? 'one' : 'two'} peak hour(s) of its own spend ` +
          `(${peakHourWei} wei in the busiest hour of the last 24 h): top it up.`,
        details: {
          chainId,
          balanceWei: balanceWei.toString(),
          peakHourWei: peakHourWei.toString(),
          level,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${chainId}:${level}`,
      });
    }
    return { chainId, balanceWei, peakHourWei, level };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
