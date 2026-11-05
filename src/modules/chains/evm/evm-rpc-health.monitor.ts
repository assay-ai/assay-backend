import { Inject, Injectable, Logger } from '@nestjs/common';

import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ChainId } from '../ports/caip.types';
import { EVM_RPC_CLIENTS } from './evm.constants';
import { EvmRpcEndpointHealth } from './evm-rpc-endpoints';

/** One endpoint failing this long pages WARN: the others carry the load, and it should come back. */
export const EVM_RPC_ENDPOINT_FAILING_WARN_MS = 5 * 60_000;
/** Every endpoint failing this long pages CRITICAL: paid calls and settles stop. */
export const EVM_RPC_ALL_FAILING_CRITICAL_MS = 60_000;

export const EVM_RPC_ENDPOINT_FAILING_ALERT = 'evm_rpc_endpoint_failing';
export const EVM_RPC_ALL_FAILING_ALERT = 'evm_rpc_all_failing';

export interface EvmRpcHealthClient {
  rpcHealth?(): readonly EvmRpcEndpointHealth[];
}

/**
 * Pages on what the scheduler's own RPC traffic saw (prod 2026-11-04: an RPC
 * answering 403 stopped paid calls for five hours). It sends no request of its
 * own: this process reads the chain every minute, so a failure is already known.
 *
 * No `@Cron` of its own: `EvmRelayerFloatMonitor`'s five-minute pass calls it.
 * Never throws. Hosts only: a provider's key lives in the URL's path or query.
 */
@Injectable()
export class EvmRpcHealthMonitor {
  private readonly logger = new Logger(EvmRpcHealthMonitor.name);
  /** The wall clock, in ms. Replaceable in a test. */
  now: () => number = () => Date.now();

  constructor(
    @Inject(EVM_RPC_CLIENTS) private readonly clients: ReadonlyMap<ChainId, EvmRpcHealthClient>,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  async check(): Promise<void> {
    for (const [chainId, client] of this.clients) {
      const endpoints = client.rpcHealth?.() ?? [];
      if (endpoints.length === 0) continue;
      const now = this.now();
      const failingFor = (endpoint: EvmRpcEndpointHealth) =>
        endpoint.failingSince === null ? 0 : now - endpoint.failingSince;
      if (endpoints.every((e) => failingFor(e) >= EVM_RPC_ALL_FAILING_CRITICAL_MS)) {
        await this.emit({
          severity: AlertSeverity.CRITICAL,
          name: EVM_RPC_ALL_FAILING_ALERT,
          summary:
            `Every RPC endpoint of ${chainId} is failing (${describe(endpoints)}): chain reads, ` +
            `paid calls and settles are stopped`,
          details: { chainId, endpoints: describe(endpoints) },
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: chainId,
        });
        continue;
      }
      for (const endpoint of endpoints) {
        if (failingFor(endpoint) < EVM_RPC_ENDPOINT_FAILING_WARN_MS) continue;
        await this.emit({
          severity: AlertSeverity.WARN,
          name: EVM_RPC_ENDPOINT_FAILING_ALERT,
          summary:
            `RPC endpoint ${endpoint.host} of ${chainId} has failed for ` +
            `${Math.floor(failingFor(endpoint) / 60_000)} min (${endpoint.lastFailure}); ` +
            `the other endpoints carry the load`,
          details: { chainId, host: endpoint.host, lastFailure: endpoint.lastFailure ?? '' },
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: `${chainId}:${endpoint.host}`,
        });
      }
    }
  }

  private async emit(alert: Parameters<AlertPort['emit']>[0]): Promise<void> {
    try {
      await this.alerts.emit(alert);
    } catch (error) {
      this.logger.error(
        `the ${alert.name} alert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function describe(endpoints: readonly EvmRpcEndpointHealth[]): string {
  return endpoints.map((e) => `${e.host}: ${e.lastFailure}`).join(', ');
}
