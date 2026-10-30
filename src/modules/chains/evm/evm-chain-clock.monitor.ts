import { Inject, Injectable, Logger } from '@nestjs/common';

import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { EVM_RPC_CLIENTS } from './evm.constants';
import {
  EVM_CLOCK_DRIFT_ALERT,
  EVM_CLOCK_DRIFT_WARN_SECONDS,
} from './evm-voucher-redeemer.service';

/**
 * How far `block.timestamp` may sit from the wall clock before the drift pages
 * as CRITICAL rather than WARN (review 2026-10-23 L-4, owner request
 * 2026-10-30): ten minutes moves every voucher deadline by twice a voucher's
 * whole lifetime.
 */
export const EVM_CLOCK_DRIFT_CRITICAL_SECONDS = 600;

/**
 * The CRITICAL alert's own name. One name per severity, each deduplicated on
 * the chain id: a drift that grows from WARN to CRITICAL still pages again,
 * and neither pages more than once per incident window.
 */
export const EVM_CLOCK_DRIFT_CRITICAL_ALERT = `${EVM_CLOCK_DRIFT_ALERT}_critical`;

/** The one read this monitor makes. */
export interface EvmClockClient {
  getBlock(args: { blockTag: 'latest' }): Promise<{ readonly timestamp: bigint }>;
}

export interface ChainClockReading {
  readonly chainId: ChainId;
  /** `block.timestamp − wall clock`, in seconds; `null` when the block could not be read. */
  readonly driftSeconds: number | null;
  readonly level: 'OK' | 'WARN' | 'CRITICAL' | 'UNREADABLE';
}

/**
 * The chain's clock against this process's, on a schedule (review 2026-10-23
 * L-4). The redeemer already logs a drift it sees while reading state for a
 * pass, but that is a request path: nothing reads it while no voucher waits,
 * and a log line is not a page. This reads the latest block of every enabled
 * eip155 chain and alerts through {@link ALERT_PORT}: WARN past
 * {@link EVM_CLOCK_DRIFT_WARN_SECONDS} (120 s), CRITICAL past
 * {@link EVM_CLOCK_DRIFT_CRITICAL_SECONDS} (600 s), `ONCE_PER_INCIDENT` with
 * the chain id as the dedupe key.
 *
 * No `@Cron` of its own: `EvmRelayerFloatMonitor`'s five-minute pass calls it,
 * in the scheduler only. Never throws: a block that cannot be read is a
 * reading, and an alert sink that is down is logged.
 */
@Injectable()
export class EvmChainClockMonitor {
  private readonly logger = new Logger(EvmChainClockMonitor.name);
  /** The wall clock, in ms. Replaceable in a test. */
  now: () => number = () => Date.now();

  constructor(
    @Inject(EVM_RPC_CLIENTS) private readonly clients: ReadonlyMap<ChainId, EvmClockClient>,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
  ) {}

  async check(): Promise<readonly ChainClockReading[]> {
    const readings: ChainClockReading[] = [];
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      readings.push(await this.checkOne(chainId));
    }
    return readings;
  }

  private async checkOne(chainId: ChainId): Promise<ChainClockReading> {
    const client = this.clients.get(chainId);
    let chainSeconds: number;
    try {
      if (!client) throw new Error('no JSON-RPC client for this chain');
      chainSeconds = Number((await client.getBlock({ blockTag: 'latest' })).timestamp);
    } catch (error) {
      this.logger.warn(
        `${chainId}: the latest block could not be read for the clock check: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { chainId, driftSeconds: null, level: 'UNREADABLE' };
    }
    const wallSeconds = Math.floor(this.now() / 1000);
    const drift = chainSeconds - wallSeconds;
    const magnitude = Math.abs(drift);
    if (magnitude <= EVM_CLOCK_DRIFT_WARN_SECONDS) {
      return { chainId, driftSeconds: drift, level: 'OK' };
    }
    const critical = magnitude > EVM_CLOCK_DRIFT_CRITICAL_SECONDS;
    this.logger.warn(
      `${chainId}: block.timestamp is ${drift}s ${drift > 0 ? 'ahead of' : 'behind'} the wall ` +
        `clock (WARN past ${EVM_CLOCK_DRIFT_WARN_SECONDS}s, CRITICAL past ` +
        `${EVM_CLOCK_DRIFT_CRITICAL_SECONDS}s)`,
    );
    try {
      await this.alerts.emit({
        severity: critical ? AlertSeverity.CRITICAL : AlertSeverity.WARN,
        name: critical ? EVM_CLOCK_DRIFT_CRITICAL_ALERT : EVM_CLOCK_DRIFT_ALERT,
        summary:
          `The latest block on ${chainId} is ${drift}s ${drift > 0 ? 'ahead of' : 'behind'} ` +
          `the wall clock; voucher deadlines, withdrawals and revocations move with the chain's`,
        details: { chainId, driftSeconds: drift, chainSeconds, wallSeconds },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: chainId,
      });
    } catch (error) {
      this.logger.error(
        `the clock drift alert on ${chainId} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { chainId, driftSeconds: drift, level: critical ? 'CRITICAL' : 'WARN' };
  }
}
