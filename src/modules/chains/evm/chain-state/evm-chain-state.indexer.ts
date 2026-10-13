import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getAddress } from 'viem';

import {
  BlockedSetRow,
  EvmChainStateRepository,
} from '@database/postgres/repositories/evm-chain-state.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../../enabled-chains';
import { ChainId, ChainNamespace, namespaceOf } from '../../ports/caip.types';
import { X402_CONFIG_ABI, X402_CONFIG_EVENTS_ABI } from '../abi/x402.abi';
import { readConfigTerms } from '../evm-config-terms';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from '../evm.constants';
import { EvmChainStateService } from './evm-chain-state.service';

/** Every minute: a pause or a block reaches the cache within about one tick. */
export const EVM_CHAIN_STATE_CRON = '0 * * * * *';
/** Most blocks one tick reads per chain; a backlog is caught up over later ticks. */
export const EVM_CHAIN_STATE_MAX_BLOCKS = 10_000n;
/** Blocks per `eth_getLogs` call. */
export const EVM_CHAIN_STATE_CHUNK = 2_000n;

export const EVM_CHAIN_STATE_ALERTS = {
  LAGGING: 'evm_chain_state_lagging',
  CONFIG_LEVER: 'evm_config_lever_pulled',
  ARBITER_BLOCK: 'evm_arbiter_blocked_address',
  DRIFT: 'evm_chain_state_drift',
} as const;

export interface EvmChainStateIndexerConfig {
  /** `EVM_CHAIN_STATE_RECONCILE_MS` (default 5 min): the full `paused()` / `blocked()` re-read. */
  readonly reconcileMs: number;
  /** `EVM_CHAIN_STATE_MAX_LAG_MS` (default 5 min): behind by more, and the log and health warn. */
  readonly maxLagMs: number;
  /**
   * `EVM_CHAIN_STATE_FROM_BLOCK`, per chain: where a chain with no cursor
   * starts. Absent: {@link EVM_CHAIN_STATE_MAX_BLOCKS} behind the head — which
   * is safe because the reconcile reads `paused()` directly and the blocklist
   * has no events before the dispute upgrade lands.
   */
  readonly fromBlock: ReadonlyMap<ChainId, bigint>;
  readonly now: () => number;
}

export const EVM_CHAIN_STATE_INDEXER_CONFIG = 'EVM_CHAIN_STATE_INDEXER_CONFIG';

export interface EvmConfigEventLog {
  readonly eventName?: string;
  readonly args: Record<string, unknown>;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly transactionHash: `0x${string}` | null;
}

export interface EvmChainStateIndexerClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getContractEvents(args: {
    address: `0x${string}`;
    abi: typeof X402_CONFIG_EVENTS_ABI;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly EvmConfigEventLog[]>;
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/**
 * Indexes `X402Config`'s pause and blocklist into Postgres, with a cursor per
 * chain kept in the same transaction as the events it covers (the H-1
 * watcher's shape, with the cursor durable rather than in Redis — a lost
 * blocklist event is not recoverable by re-reading a recent window).
 *
 * - **Every tick:** `PauseToggled` and `BlockedSet` since the cursor, into
 *   `evm_chain_states` / `evm_blocked_addresses`.
 * - **Every `reconcileMs`:** `paused()`, the dispute terms and `blocked()` of
 *   every address ever named, read live; a disagreement is corrected and
 *   logged — the events are the fast path, this is the bound.
 * - **The levers a stolen key pulls** (contract security review): an
 *   `ArbiterSet`, `SlashDelaySet` or `VerifierRegistered` is a CRITICAL alert,
 *   and a `BlockedSet` sent by the arbiter a WARN.
 * - **Lag:** `now − caught_up_at`. Past `maxLagMs` it is a WARN in the log and
 *   an alert, and `GET /operator/health` reports it (`chainState`).
 *
 * Read-only on chain. A cache: the contracts stay the enforcer.
 */
@Injectable()
export class EvmChainStateIndexer {
  private readonly logger = new Logger(EvmChainStateIndexer.name);

  constructor(
    @Inject(EVM_RPC_CLIENTS)
    private readonly clients: ReadonlyMap<ChainId, EvmChainStateIndexerClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly repository: EvmChainStateRepository,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(EVM_CHAIN_STATE_INDEXER_CONFIG) private readonly config: EvmChainStateIndexerConfig,
    // The scheduler's own copy of the cache, refreshed at once after a write.
    @Optional() private readonly cache: EvmChainStateService | null = null,
  ) {}

  @Cron(EVM_CHAIN_STATE_CRON)
  async handleTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(`EVM chain-state index threw: ${describe(error)}`);
    }
  }

  async tick(): Promise<void> {
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      const deployment = this.deployments.get(chainId);
      const client = this.clients.get(chainId);
      if (!deployment || !client) continue;
      try {
        await this.indexChain(chainId, deployment, client);
      } catch (error) {
        // The node's message stays in this log line, never in an alert or a
        // row: an RPC URL can carry an API key.
        this.logger.error(`EVM chain-state index on ${chainId} failed: ${describe(error)}`);
        await this.repository
          .recordError(chainId, 'the chain could not be read')
          .catch(() => undefined);
      }
      try {
        await this.reconcileIfDue(chainId, deployment, client);
      } catch (error) {
        this.logger.error(`EVM chain-state reconcile on ${chainId} failed: ${describe(error)}`);
      }
      await this.reportLag(chainId);
    }
    await this.cache?.refresh().catch(() => undefined);
  }

  private async indexChain(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmChainStateIndexerClient,
  ): Promise<void> {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const state = await this.repository.findState(chainId);
    const start =
      state?.cursorBlock !== null && state?.cursorBlock !== undefined
        ? BigInt(state.cursorBlock) + 1n
        : (this.config.fromBlock.get(chainId) ??
          (head > EVM_CHAIN_STATE_MAX_BLOCKS ? head - EVM_CHAIN_STATE_MAX_BLOCKS : 0n));
    const now = new Date(this.config.now());
    if (start > head) {
      await this.repository.applyIndexedRange({
        chainId,
        cursorBlock: head,
        headBlock: head,
        caughtUp: true,
        now,
        blocked: [],
      });
      return;
    }
    const end =
      head - start + 1n > EVM_CHAIN_STATE_MAX_BLOCKS
        ? start + EVM_CHAIN_STATE_MAX_BLOCKS - 1n
        : head;

    const logs: EvmConfigEventLog[] = [];
    for (let from = start; from <= end; from += EVM_CHAIN_STATE_CHUNK) {
      const to = from + EVM_CHAIN_STATE_CHUNK - 1n < end ? from + EVM_CHAIN_STATE_CHUNK - 1n : end;
      logs.push(
        ...(await client.getContractEvents({
          address: deployment.config,
          abi: X402_CONFIG_EVENTS_ABI,
          fromBlock: from,
          toBlock: to,
        })),
      );
    }
    logs.sort(
      (left, right) =>
        Number((left.blockNumber ?? 0n) - (right.blockNumber ?? 0n)) ||
        (left.logIndex ?? 0) - (right.logIndex ?? 0),
    );

    let paused: boolean | undefined;
    let arbiter: string | null | undefined;
    let knownArbiter = state?.arbiter ?? null;
    const blocked: BlockedSetRow[] = [];
    for (const log of logs) {
      switch (log.eventName) {
        case 'PauseToggled':
          paused = Boolean(log.args.paused);
          break;
        case 'BlockedSet': {
          const by = lower(log.args.by);
          blocked.push({
            address: lower(log.args.account) ?? '',
            blocked: Boolean(log.args.blocked),
            setBy: by,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            transactionHash: log.transactionHash,
          });
          if (by && knownArbiter && by === knownArbiter) {
            await this.alertArbiterBlock(chainId, log);
          }
          break;
        }
        case 'ArbiterSet':
          arbiter = lower(log.args.newArbiter);
          if (arbiter && BigInt(arbiter) === 0n) arbiter = null;
          knownArbiter = arbiter;
          await this.alertLever(chainId, log);
          break;
        case 'SlashDelaySet':
        case 'VerifierRegistered':
          await this.alertLever(chainId, log);
          break;
        default:
          break;
      }
    }

    await this.repository.applyIndexedRange({
      chainId,
      cursorBlock: end,
      headBlock: head,
      caughtUp: end === head,
      now,
      ...(paused !== undefined ? { paused } : {}),
      ...(arbiter !== undefined ? { arbiter } : {}),
      blocked: blocked.filter((row) => row.address !== ''),
    });
  }

  /** The bound behind the events: a full live read every `reconcileMs`. */
  private async reconcileIfDue(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmChainStateIndexerClient,
  ): Promise<void> {
    const state = await this.repository.findState(chainId);
    const nowMs = this.config.now();
    if (state?.reconciledAt && nowMs - state.reconciledAt.getTime() < this.config.reconcileMs) {
      return;
    }
    const terms = await readConfigTerms(client, deployment.config);
    const corrections: BlockedSetRow[] = [];
    if (terms.upgraded) {
      for (const row of await this.repository.findKnownAddresses(chainId)) {
        const live = Boolean(
          await client.readContract({
            address: deployment.config,
            abi: X402_CONFIG_ABI,
            functionName: 'blocked',
            args: [getAddress(row.address)],
          }),
        );
        if (live !== row.blocked) {
          corrections.push({
            address: row.address,
            blocked: live,
            setBy: null,
            blockNumber: null,
            logIndex: null,
            transactionHash: null,
          });
        }
      }
    }
    if ((state && state.paused !== terms.paused) || corrections.length > 0) {
      this.logger.warn(
        `EVM chain state on ${chainId} drifted from the chain and was corrected: ` +
          `paused ${state?.paused}→${terms.paused}, ${corrections.length} blocklist correction(s)`,
      );
      await this.alerts.emit({
        severity: AlertSeverity.WARN,
        name: EVM_CHAIN_STATE_ALERTS.DRIFT,
        summary: `The indexed pause/blocklist on ${chainId} disagreed with the chain and was corrected`,
        details: { chainId, paused: String(terms.paused), corrections: corrections.length },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: chainId,
      });
    }
    await this.repository.applyReconcile(
      chainId,
      {
        upgraded: terms.upgraded,
        paused: terms.paused,
        arbiter: terms.arbiter?.toLowerCase() ?? null,
        slashDelaySeconds: terms.slashDelaySeconds,
      },
      corrections,
      new Date(nowMs),
    );
  }

  private async reportLag(chainId: ChainId): Promise<void> {
    const state = await this.repository.findState(chainId).catch(() => null);
    const lagMs = chainStateLagMs(state?.caughtUpAt ?? null, this.config.now());
    if (lagMs !== null && lagMs <= this.config.maxLagMs) return;
    const behind =
      lagMs === null ? 'has never caught up' : `is ${Math.round(lagMs / 1000)}s behind`;
    this.logger.warn(
      `EVM chain-state index on ${chainId} ${behind}; pause and blocklist refusals may be stale ` +
        `(the contracts still enforce)`,
    );
    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: EVM_CHAIN_STATE_ALERTS.LAGGING,
      summary: `The EVM chain-state index on ${chainId} ${behind}`,
      details: { chainId, lagSeconds: lagMs === null ? -1 : Math.round(lagMs / 1000) },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: chainId,
    });
  }

  private async alertLever(chainId: ChainId, log: EvmConfigEventLog): Promise<void> {
    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: EVM_CHAIN_STATE_ALERTS.CONFIG_LEVER,
      summary:
        `X402Config on ${chainId} emitted ${log.eventName}. This is a lever a stolen admin key ` +
        `pulls (arbiter, slash delay, verifier registry): confirm it was intended`,
      details: { chainId, event: log.eventName, ...stringArgs(log) },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${chainId}:${log.transactionHash}:${log.logIndex}`,
    });
  }

  private async alertArbiterBlock(chainId: ChainId, log: EvmConfigEventLog): Promise<void> {
    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: EVM_CHAIN_STATE_ALERTS.ARBITER_BLOCK,
      summary: `The arbiter set the on-chain block of ${String(log.args.account)} on ${chainId}`,
      details: { chainId, ...stringArgs(log) },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${chainId}:${log.transactionHash}:${log.logIndex}`,
    });
  }
}

/** `now − caught_up_at` in ms, or `null` when the index never caught up. */
export function chainStateLagMs(caughtUpAt: Date | null, nowMs: number): number | null {
  return caughtUpAt ? Math.max(0, nowMs - caughtUpAt.getTime()) : null;
}

function lower(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function stringArgs(log: EvmConfigEventLog): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(log.args).map(([key, value]) => [key, String(value)])),
    transactionHash: log.transactionHash ?? '(unknown)',
    blockNumber: (log.blockNumber ?? 0n).toString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
